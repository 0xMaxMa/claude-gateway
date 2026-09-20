import { spawn } from 'child_process';
import { readFile, stat } from 'fs/promises';
import { parse as parseToml } from 'smol-toml';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

export interface CodexCredentials { baseUrl: string; key: string; fingerprint: string; }
export class CodexReadinessError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const unavailable = (code: string, message: string): never => { throw new CodexReadinessError(code, message); };

/** Native config/account discovery only: no thread, tool server or model request. */
export function inspectCodexAccount(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<{ config: any; account: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
      cwd: env.HOME || homedir(), env, stdio: 'pipe',
    });
    let buffer = '', config: any, settled = false;
    const finish = (error?: Error, account?: any) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      child.kill('SIGTERM');
      const kill = setTimeout(() => { child.kill('SIGKILL'); child.unref(); }, 1000);
      kill.unref(); child.once('close', () => clearTimeout(kill));
      if (error) reject(error); else resolve({ config, account });
    };
    const timer = setTimeout(() => finish(new CodexReadinessError('CODEX_PROBE_TIMEOUT', 'Codex native configuration/auth check timed out. Check Codex under the gateway service user.')), 10000);
    const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    child.on('error', () => finish(new CodexReadinessError('CODEX_UNAVAILABLE', 'Codex cannot start. Install it separately and check the gateway service PATH.')));
    child.on('close', () => finish(new CodexReadinessError('CODEX_CONFIG_UNAVAILABLE', 'Codex could not read its native configuration. Run codex login status as the gateway service user.')));
    child.stdin.on('error', () => finish(new CodexReadinessError('CODEX_CONFIG_UNAVAILABLE', 'Codex configuration probe closed unexpectedly.')));
    child.stderr.resume(); // Native diagnostics may contain account/credential information.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) return finish(new CodexReadinessError('CODEX_CONFIG_UNAVAILABLE', 'Codex configuration exceeded the inspection limit.'));
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.error) return finish(new CodexReadinessError('CODEX_CONFIG_UNAVAILABLE', 'Codex rejected the native configuration/auth probe. Update Codex or check its native configuration.'));
        if (event.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          send(2, 'config/read', { includeLayers: false });
        } else if (event.id === 2) {
          config = event.result?.config;
          if (!config) return finish(new CodexReadinessError('CODEX_CONFIG_UNAVAILABLE', 'Codex omitted effective configuration.'));
          send(3, 'account/read', { refreshToken: false });
        } else if (event.id === 3) finish(undefined, event.result);
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'gateway_readiness', version: '1.0.0' } });
  });
}

function credentials(baseUrl: string, key: unknown, allowDockerHost = false): CodexCredentials {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return unavailable('CODEX_PROVIDER_INVALID', 'Codex Responses provider URL is invalid.'); }
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', ...(allowDockerHost ? ['host.docker.internal'] : [])].includes(url.hostname))) {
    return unavailable('CODEX_PROVIDER_INVALID', 'Codex requires an HTTPS Responses provider (local HTTP is allowed).');
  }
  if (typeof key !== 'string' || !key.trim() || /[\r\n\0]/.test(key)) return unavailable('CODEX_AUTH_REQUIRED', 'Codex has no usable native API key. Run codex login under the gateway service user, or use Claude workers.');
  return { baseUrl, key, fingerprint: createHash('sha256').update(JSON.stringify([baseUrl, key])).digest('hex') };
}

/** Resolve only the selected native provider. Never inspect Claude credentials. */
export async function resolveCodexCredentials(options: { bin: string; baseUrl?: string; apiKeyEnv?: string; env?: NodeJS.ProcessEnv; allowDockerHost?: boolean }): Promise<CodexCredentials> {
  const env = options.env ?? process.env;
  // Existing explicit worker overrides remain explicit, not silently replaced by native login.
  if (options.baseUrl !== undefined || options.apiKeyEnv !== undefined) {
    const name = options.apiKeyEnv ?? 'OPENAI_API_KEY';
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || /^(ANTHROPIC_|CLAUDE_)/.test(name)) return unavailable('CODEX_PROVIDER_INVALID', 'Codex requires its own API-key environment variable.');
    return credentials(options.baseUrl ?? 'https://api.openai.com/v1', env[name], options.allowDockerHost);
  }
  const { config, account } = await inspectCodexAccount(options.bin, env);
  const id = config.model_provider ?? 'openai';
  const provider = config.model_providers?.[id] ?? (id === 'openai' ? { requires_openai_auth: true } : undefined);
  if (!provider || provider.wire_api && provider.wire_api !== 'responses' || provider.auth ||
      Object.keys(provider.http_headers ?? {}).length || Object.keys(provider.env_http_headers ?? {}).length || Object.keys(provider.query_params ?? {}).length || provider.experimental_bearer_token) {
    return unavailable('CODEX_PROVIDER_UNSUPPORTED', 'This native Codex provider needs settings that isolated workers cannot safely transfer. Use native Codex safemode or Claude workers.');
  }
  const base = provider.base_url ?? (id === 'openai' ? env.OPENAI_BASE_URL || 'https://api.openai.com/v1' : '');
  if (!provider.requires_openai_auth && provider.env_key) return credentials(base, env[provider.env_key], options.allowDockerHost);
  if (account?.account?.type === 'chatgpt') return unavailable('CODEX_AUTH_NOT_PORTABLE', 'Native ChatGPT authentication is available for Codex safemode, but isolated workers cannot share its refresh state. Use Claude workers or a native API-key provider.');
  // Respect the selected storage backend. A stale file must never override keyring auth.
  if (config.cli_auth_credentials_store && config.cli_auth_credentials_store !== 'file') return unavailable('CODEX_AUTH_NOT_PORTABLE', 'Codex keyring authentication cannot be transferred into isolated workers. Native safemode remains available; use a file/API-key provider for workers.');
  let auth: any;
  try { auth = JSON.parse(await readFile(join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'auth.json'), 'utf8')); }
  catch { return unavailable('CODEX_AUTH_REQUIRED', 'Codex native API-key login is unavailable. Run codex login under the gateway service user.'); }
  if (auth.auth_mode && auth.auth_mode !== 'apikey') return unavailable('CODEX_AUTH_NOT_PORTABLE', 'This Codex authentication mode cannot be transferred into isolated workers. Use native safemode or Claude workers.');
  return credentials(base, auth.OPENAI_API_KEY, options.allowDockerHost);
}

/** Overlay native config data without inheriting object prototypes. */
function overlayConfig(base: any, next: any): any {
  const result = Object.assign(Object.create(null), base);
  for (const [name, value] of Object.entries(next ?? {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(name)) continue;
    result[name] = value && typeof value === 'object' && !Array.isArray(value)
      ? overlayConfig(result[name], value) : value;
  }
  return result;
}

/** Select auth using the same profile then CLI-override precedence as native Codex.
 * Only configuration is read; interactive permission flags are never used by the probe. */
async function safemodeProviderConfig(config: any, args: string[], source: NodeJS.ProcessEnv): Promise<any> {
  let profile: string | undefined;
  const overrides: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '-p' || arg === '--profile') profile = args[++i];
    else if (arg.startsWith('--profile=')) profile = arg.slice(10);
    else if (/^-p.+/.test(arg)) profile = arg.slice(2).replace(/^=/, '');
    else if (arg === '-c' || arg === '--config') overrides.push(args[++i]);
    else if (arg.startsWith('--config=')) overrides.push(arg.slice(9));
    else if (/^-c.+/.test(arg)) overrides.push(arg.slice(2).replace(/^=/, ''));
  }
  if (profile) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(profile)) return unavailable('CODEX_PROVIDER_INVALID', 'Invalid native Codex profile name.');
    const home = source.CODEX_HOME || join(source.HOME || homedir(), '.codex');
    const file = join(home, `${profile}.config.toml`);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid profile');
      config = overlayConfig(config, parseToml(await readFile(file, 'utf8')));
    } catch (error) {
      // Older native CLIs store named profiles inside config.toml.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && config.profiles?.[profile]) config = overlayConfig(config, config.profiles[profile]);
      else return unavailable('CODEX_CONFIG_UNAVAILABLE', 'Cannot inspect the selected native Codex profile safely. Check its configuration file.');
    }
  }
  for (const override of overrides) {
    if (typeof override !== 'string' || !override.includes('=')) return unavailable('CODEX_PROVIDER_INVALID', 'Invalid native Codex configuration override.');
    let parsed: unknown;
    try { parsed = parseToml(override); }
    catch {
      // Native -c treats non-TOML values as literal strings.
      const at = override.indexOf('=');
      try { parsed = parseToml(`${override.slice(0, at)} = ${JSON.stringify(override.slice(at + 1))}`); }
      catch { return unavailable('CODEX_PROVIDER_INVALID', 'Invalid native Codex configuration override.'); }
    }
    config = overlayConfig(config, parsed);
  }
  return config;
}

/** Safemode stays in the native HOME, so OAuth/keyring refresh remains CLI-owned.
 * Explicit params delegate login validation, but never drop selected provider credentials. */
export async function codexSafemodeEnvironment(bin: string, env: NodeJS.ProcessEnv,
  options: { nativeArgs?: string[]; source?: NodeJS.ProcessEnv } = {}): Promise<NodeJS.ProcessEnv> {
  const source = options.source ?? process.env;
  const inspected = await inspectCodexAccount(bin, source);
  const config = await safemodeProviderConfig(inspected.config, options.nativeArgs ?? [], source);
  const id = config.model_provider ?? 'openai';
  const provider = config.model_providers?.[id];
  const result = { ...env };
  const names = new Set<string>(Object.values(provider?.env_http_headers ?? {}) as string[]);
  if (provider?.env_key && !provider.requires_openai_auth) names.add(provider.env_key);
  for (const name of names) {
    if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name) || /^(GH_|GITHUB_|GATEWAY_|ANTHROPIC_|CLAUDE_|LD_|DYLD_)/.test(name) || ['NODE_OPTIONS','BASH_ENV','ENV','SHELLOPTS'].includes(name)) {
      return unavailable('CODEX_AUTH_REQUIRED', 'The selected native Codex credential variable is not permitted in safemode.');
    }
    if (source[name]) result[name] = source[name];
    else if (options.nativeArgs === undefined) return unavailable('CODEX_AUTH_REQUIRED', 'The native Codex provider credential is unavailable to safemode. Check its env_key under the gateway service user.');
  }
  if (options.nativeArgs === undefined && !(provider?.env_key && !provider.requires_openai_auth) && !inspected.account?.account) {
    return unavailable('CODEX_AUTH_REQUIRED', 'Codex is not logged in. Run codex login first, or start safemode --cli claude. An existing session will not switch harnesses.');
  }
  return result;
}
