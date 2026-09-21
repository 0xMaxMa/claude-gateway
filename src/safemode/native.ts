import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { resolveClaudeBin } from '../session/claude-bin';
import { codexPolicyArgs } from '../session/codex-policy';

export type SafemodeCli = 'claude' | 'codex';
export interface NativeOptions {
  cli: SafemodeCli;
  mode: 'interactive' | 'headless';
  cwd: string;
  prompt?: string;
  context?: string;
  model?: string;
  nativeSessionId?: string;
  resume?: boolean;
  nativeArgs?: string[];
  nativeResumeIndex?: number;
  env?: NodeJS.ProcessEnv;
}
export interface NativeInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeSessionId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only credentials used by the selected native provider belong in its environment. */
export function nativeEnvironment(cli: SafemodeCli, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const common = /^(HOME|USER|LOGNAME|PATH|SHELL|TERM|COLORTERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|COLORFGBG|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|TMUX|TMUX_PANE|LANG|LC_[A-Z_]+|TZ|TMPDIR|TEMP|TMP|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;
  const provider = cli === 'claude'
    ? /^(CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|AWS_[A-Z_]+|GOOGLE_APPLICATION_CREDENTIALS|ANTHROPIC_VERTEX_PROJECT_ID|CLOUD_ML_REGION|ANTHROPIC_FOUNDRY_[A-Z_]+)$/
    : /^(CODEX_HOME|CODEX_ACCESS_TOKEN|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID)$/;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (common.test(key) || provider.test(key))) env[key] = value;
  }
  // Never propagate gateway leases, SDK nesting, shell injection or GitHub credentials.
  return env;
}

function disabledCodexServers(command: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
  // Empty TOML tables merge with user config; setting mcp_servers={} is NOT isolation.
  // Listing parses configuration only and never starts an MCP server.
  let servers: unknown;
  try {
    servers = JSON.parse(execFileSync(command, ['mcp', 'list', '--json'], {
      cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch {
    throw new Error('Cannot inspect Codex MCP configuration safely. Check `codex mcp list --json` before starting safemode.');
  }
  if (!Array.isArray(servers) || servers.some(server => typeof server?.name !== 'string')) {
    throw new Error('Unsupported Codex MCP configuration output; safemode did not launch.');
  }
  return servers.flatMap(server => ['-c', `mcp_servers.${JSON.stringify(server.name)}.enabled=false`]);
}

/** Args are passed directly to spawn, never evaluated by a shell. */
export function buildNativeInvocation(options: NativeOptions): NativeInvocation {
  if (options.nativeArgs !== undefined && options.mode !== 'interactive') throw new Error('Native params are interactive-only');
  if (options.resume && !options.nativeSessionId) throw new Error('Native session ID is required to resume.');
  if (options.nativeSessionId && !UUID.test(options.nativeSessionId)) throw new Error('Invalid native session ID.');
  let env = nativeEnvironment(options.cli, options.env);
  let model = options.model && options.model !== 'inherit' ? options.model : undefined;
  if (options.cli === 'claude' && options.mode === 'headless') {
    // --restricted excludes settings customizations. Preserve only native auth
    // environment and model preference, never hooks, commands or permission grants.
    let nativeModel: string | undefined;
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude'), 'settings.json'), 'utf8'));
      const auth: NodeJS.ProcessEnv = {};
      if (settings.env && typeof settings.env === 'object') {
        for (const [key, value] of Object.entries(settings.env)) {
          if (/^(ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|USE_)|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_REGION$)/.test(key) && typeof value === 'string') auth[key] = value;
        }
      }
      env = { ...nativeEnvironment('claude', auth), ...env };
      if (typeof settings.model === 'string' && settings.model.trim()) nativeModel = settings.model;
    } catch { /* No explicit native settings: CLI chooses its own defaults/auth. */ }
    if (!model) model = env.ANTHROPIC_MODEL || nativeModel;
  }
  const prompt = [options.context, options.prompt].filter(Boolean).join('\n\n');
  if (options.nativeArgs !== undefined) {
    // Explicit operator options replace interactive defaults, never headless restrictions.
    const args = [...options.nativeArgs];
    let prefix = 0;
    if (model && !args.some(a => a === '--model' || a === '-m' || a.startsWith('--model=') || a.startsWith('-m='))) { args.unshift('--model', model); prefix = 2; }
    const nativeSessionId = options.nativeSessionId || (options.cli === 'claude' ? randomUUID() : undefined);
    if (options.cli === 'claude') args.push(options.resume ? '--resume' : '--session-id', nativeSessionId!);
    else if (options.resume) args.splice(prefix + (options.nativeResumeIndex ?? 0), 0, 'resume', nativeSessionId!);
    if (options.cli === 'codex') args.push('--cd', options.cwd);
    if (prompt) args.push('--', prompt);
    const command = options.cli === 'claude' ? options.env?.CLAUDE_BIN || process.env.CLAUDE_BIN || resolveClaudeBin(env).bin : options.env?.CODEX_BIN || process.env.CODEX_BIN || 'codex';
    return { command, args, env, cwd: options.cwd, nativeSessionId };
  }
  if (options.cli === 'claude') {
    const command = options.env?.CLAUDE_BIN || process.env.CLAUDE_BIN || resolveClaudeBin(env).bin;
    const nativeSessionId = options.nativeSessionId || randomUUID();
    const args = ['--safe-mode', '--strict-mcp-config', '--permission-mode', options.mode === 'headless' ? 'dontAsk' : 'manual'];
    if (options.mode === 'headless') args.push('--restricted', '--print', '--output-format', 'stream-json', '--verbose', '--tools', 'Read,Glob,Grep');
    args.push(options.resume ? '--resume' : '--session-id', nativeSessionId);
    if (model) args.push('--model', model);
    if (prompt) args.push('--', prompt);
    return { command, args, env, cwd: options.cwd, nativeSessionId };
  }
  const command = options.env?.CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const args = [
    ...codexPolicyArgs(),
    '-c', 'shell_environment_policy.inherit="none"',
    '-c', 'shell_environment_policy.set={}',
    '-c', 'sandbox_mode="read-only"',
    '-c', `approval_policy="${options.mode === 'headless' ? 'never' : 'on-request'}"`,
    ...disabledCodexServers(command, options.cwd, env),
  ];
  if (model) args.push('--model', model);
  if (options.mode === 'headless') {
    args.push('exec', '--cd', options.cwd, '--json', '--ignore-rules', '--skip-git-repo-check');
    if (options.resume) args.push('resume', options.nativeSessionId!);
  } else {
    if (options.resume) args.push('resume', options.nativeSessionId!);
    args.push('--cd', options.cwd);
  }
  if (prompt) args.push('--', prompt);
  return { command, args, env, cwd: options.cwd, nativeSessionId: options.nativeSessionId };
}

/** Only authoritative init events identify a conversation; arbitrary tool JSON cannot. */
export function extractNativeSessionId(cli: SafemodeCli, line: string): string | undefined {
  try {
    const event = JSON.parse(line);
    const id = cli === 'codex'
      ? event.type === 'thread.started' ? event.thread_id : undefined
      : event.type === 'system' && event.subtype === 'init' ? event.session_id : undefined;
    return typeof id === 'string' && UUID.test(id) ? id : undefined;
  } catch { return undefined; }
}

/**
 * Codex interactive has no --session-id. Match the persisted session_meta to the
 * dedicated safemode cwd and launch time, never `resume --last` or global history.
 * Read only today's/newer date directories and a bounded first line per rollout.
 */
export function discoverCodexSession(options: { cwd: string; startedAt: number | string; codexHome?: string }): string | undefined {
  const start = typeof options.startedAt === 'number' ? options.startedAt : Date.parse(options.startedAt);
  if (!Number.isFinite(start)) throw new Error('Invalid session start time.');
  const root = path.join(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const day = new Date(start).toISOString().slice(0, 10).replace(/-/g, '/');
  const ids = new Set<string>();
  const readDirs = (dir: string): fs.Dirent[] => {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  };
  let inspected = 0;
  for (const year of readDirs(root).filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))) {
    for (const month of readDirs(path.join(root, year.name)).filter(e => e.isDirectory() && /^\d{2}$/.test(e.name))) {
      for (const date of readDirs(path.join(root, year.name, month.name)).filter(e => e.isDirectory() && /^\d{2}$/.test(e.name))) {
        const relative = `${year.name}/${month.name}/${date.name}`;
        if (relative < day) continue;
        for (const file of readDirs(path.join(root, relative))) {
          if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
          if (++inspected > 5000) throw new Error('Too many Codex rollouts to identify safemode session safely.');
          let fd: number | undefined;
          try {
            fd = fs.openSync(path.join(root, relative, file.name), 'r');
            const buffer = Buffer.alloc(65536);
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
            const text = buffer.toString('utf8', 0, bytes);
            const newline = text.indexOf('\n');
            if (newline === -1 && bytes === buffer.length) continue;
            const event = JSON.parse(newline === -1 ? text : text.slice(0, newline));
            const meta = event.payload;
            if (event.type !== 'session_meta' || !meta || meta.cwd !== options.cwd || !UUID.test(meta.id || '')) continue;
            if (Date.parse(meta.timestamp || event.timestamp) < start) continue;
            if (!Number.isFinite(Date.parse(meta.timestamp || event.timestamp))) continue;
            // Child investigations are separate native conversations.
            if (typeof meta.source === 'object') continue;
            ids.add(meta.id);
          } catch { /* Concurrent append or unrelated/corrupt rollout; retry on next poll. */ }
          finally { if (fd !== undefined) fs.closeSync(fd); }
        }
      }
    }
  }
  if (ids.size > 1) throw new Error('Multiple native Codex sessions match this safemode workspace; refusing ambiguous resume.');
  return [...ids][0];
}
