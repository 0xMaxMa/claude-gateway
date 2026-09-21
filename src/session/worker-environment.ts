import type { AgentConfig, GatewayConfig } from '../types';

/** Explicit administrator settings only. Host settings never flow into app containers. */
export function workerEnvironment(agent: AgentConfig, gateway: GatewayConfig): Record<string, string> {
  const field = agent.type === 'app-agent' ? 'containerEnvironment' : 'environment';
  return { ...gateway.gateway?.workers?.[field], ...agent.workers?.[field] };
}

export function validateWorkerEnvironment(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(field + ' must be an environment map');
  if (Object.keys(value).length > 64) throw new Error(field + ' has too many variables');
  for (const [key, setting] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        /^(GATEWAY_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_)/.test(key) ||
        ['HOME', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES'].includes(key)) {
      throw new Error(field + ': reserved or invalid variable name ' + key);
    }
    if (typeof setting !== 'string' || setting.includes('\0') || Buffer.byteLength(setting) > 16384) throw new Error(field + ': invalid value for ' + key);
  }
}
