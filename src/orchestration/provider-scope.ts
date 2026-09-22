import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { claudeConfigDir, readClaudeSettings } from '../config/claude-settings';
import type { AgentConfig, GatewayConfig } from '../types';
import { resolveWorkerHarness } from './worker-harness';
import { parse as parseToml } from 'smol-toml';

const credentialKeys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ResolvedCodexProviderIdentity { fingerprint: string; model: string; contextWindow?: number; }
/** The readiness resolver already fingerprints native API keys or the stable
 * ChatGPT account identity. Access-token refresh must not create a new scope. */
export function resolvedCodexProviderScope(identity: ResolvedCodexProviderIdentity, recoveryGeneration = 1): string {
  return hash([hash(['codex', identity.fingerprint, identity.model, identity.contextWindow]), recoveryGeneration]);
}
const clean = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\0\r\n]/.test(value);
function endpoint(value: unknown): string | undefined {
  if (!clean(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) return;
    return url.toString(); // Preserve path: it can select a different tenant or route.
  } catch { return; }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Inputs are transient; only the opaque return value belongs in persisted state. */
export interface ProviderScopeInputs {
  env: NodeJS.ProcessEnv;
  settings: Record<string, unknown> | null;
  nativeIdentity?: unknown;
}

/** Pure scope calculation. Unknown native routes remain isolated by agent and
 * execution context, never by session: new notifications must share cooldown.
 * An uncertain identity must not impose an outage on an unrelated account. */
export function providerScopeFromInputs(agent: AgentConfig, gateway: GatewayConfig, model: string | undefined,
  role: 'agent' | 'worker', workspace: string | undefined, inputs: ProviderScopeInputs): string {
  const selectedModel = model ?? agent.claude.model;
  const harness = role === 'worker' ? resolveWorkerHarness(agent, gateway, selectedModel) : undefined;
  const env = inputs.env;
  const selectedEnv = Object.fromEntries(Object.entries(env).filter(([key]) => /^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|AWS_|GOOGLE_|CLOUD_ML_)/.test(key) || key === 'HOME'));
  const fallback = (kind: string, extra?: unknown) => hash(canonical({ kind, agent: agent.id, role,
    workspace: workspace ?? agent.workspace, container: agent.container, model: selectedModel,
    settings: inputs.settings, env: selectedEnv, nativeIdentity: inputs.nativeIdentity, extra }));
  if (harness?.harness === 'codex') {
    const config = harness.config;
    // Match resolveCodexCredentials' explicit override branch without invoking
    // native app-server inspection, keyring access, login or token refresh.
    if (config.baseUrl !== undefined || config.apiKeyEnv !== undefined) {
      const rawBase = config.baseUrl ?? 'https://api.openai.com/v1';
      const base = endpoint(rawBase);
      const key = env[config.apiKeyEnv ?? 'OPENAI_API_KEY'];
      // credentials() fingerprints the raw configured URL, not URL.toString().
      if (base && clean(key)) return hash(['codex', hash([rawBase, key]), config.model, config.contextWindow]);
    }
    return fallback('codex-native', config);
  }
  const raw = inputs.settings?.env;
  const settingsEnv = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const declaresIdentity = credentialKeys.some(key => key in settingsEnv);
  const credentials = declaresIdentity ? settingsEnv : env;
  const present = credentialKeys.filter(key => key in credentials && credentials[key] !== undefined);
  const base = endpoint('ANTHROPIC_BASE_URL' in settingsEnv ? settingsEnv.ANTHROPIC_BASE_URL : env.ANTHROPIC_BASE_URL);
  // Only container execution has the narrow, explicit forwarded identity group
  // and suppressed native setting sources. Host workers can load project
  // settings/helpers, and host agents can retain alternative inherited keys.
  const alternateRoute = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    .some(key => env[key] || settingsEnv[key]);
  if (agent.type === 'app-agent' && base && present.length === 1 && clean(credentials[present[0]]) && !alternateRoute) {
    return hash(['claude-explicit', base, present[0], credentials[present[0]], selectedModel]);
  }
  return fallback('claude-native');
}

function fileIdentity(path: string): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) return 'unavailable';
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch { return 'unavailable'; }
}

/** Native providers may name an API-key variable outside the usual prefixes.
 * Hash that value too so rotating it invalidates a persisted route hint. */
export function nativeCodexConfigIdentity(content: string, env: NodeJS.ProcessEnv): string {
  let credential: unknown;
  try {
    const config = parseToml(content) as Record<string, any>;
    const key = config.model_providers?.[config.model_provider ?? 'openai']?.env_key;
    if (typeof key === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(key)) credential = env[key];
  } catch { /* The readiness resolver owns malformed/unsupported config errors. */ }
  return hash([content, credential]);
}
function nativeCodexConfigFile(path: string, env: NodeJS.ProcessEnv): string {
  try {
    if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024) return 'unavailable';
    return nativeCodexConfigIdentity(readFileSync(path, 'utf8'), env);
  } catch { return 'unavailable'; }
}

/** Read-only discovery, never a native CLI probe. Hash file contents immediately;
 * native/keyring routes cannot be proven equivalent and use conservative scope.
 * Retain the returned scope on the launched process: later credential rotation
 * must not reattribute an old process's failure to a newly configured account. */
export function resolveProviderScope(agent: AgentConfig, gateway: GatewayConfig, model: string | undefined,
  role: 'agent' | 'worker', workspace?: string): string {
  const env = process.env;
  const claudeRoot = claudeConfigDir();
  const codexRoot = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  const cwd = workspace ?? agent.workspace;
  const codex = role === 'worker' && resolveWorkerHarness(agent, gateway, model ?? agent.claude.model).harness === 'codex';
  const nativeIdentity = codex ? {
    config: nativeCodexConfigFile(join(codexRoot, 'config.toml'), env),
    auth: fileIdentity(join(codexRoot, 'auth.json')),
  } : {
    auth: fileIdentity(join(claudeRoot, '.credentials.json')),
    project: fileIdentity(join(cwd, '.claude', 'settings.json')),
    local: fileIdentity(join(cwd, '.claude', 'settings.local.json')),
  };
  return hash([providerScopeFromInputs(agent, gateway, model, role, workspace, { env, settings: codex ? null : readClaudeSettings(), nativeIdentity }), agent.orchestration?.providerAdmission?.recoveryGeneration ?? 1]);
}
