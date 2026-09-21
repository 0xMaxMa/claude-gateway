/** Lifecycle policy for file and API configuration changes. Unknown fields never
 * silently become live: they are reported as restart-required. */
export type ReloadMode = 'live' | 'next-process' | 'component' | 'restart' | 'ignored';
const gateway: Record<string, ReloadMode> = {
  'gateway.jev': 'live',
  'safemode': 'next-process', 'safemode.allowedAgentIds': 'live',
  'gateway.orchestration': 'component', 'gateway.headless': 'next-process',
  'gateway.logs': 'live', 'gateway.api': 'live', 'gateway.processLimits': 'live',
  'gateway.models': 'next-process', 'gateway.workers': 'next-process',
  'gateway.customConnectors': 'next-process', 'gateway.connectorsDefaultEnabled': 'next-process',
  'gateway.publicUrl': 'live', 'gateway.oauthReturnUrl': 'live',
  'gateway.timezone': 'component', 'gateway.selfHealing': 'next-process',
  'gateway.history': 'component', 'gateway.memory': 'component',
  'gateway.skillLearning': 'component', 'gateway.dreaming': 'component',
  'gateway.sessionCompaction': 'component', 'gateway.knowledge': 'component',
  'gateway.knowledge.shared.root': 'restart', 'gateway.knowledge.shared.project': 'restart',
  'gateway.knowledge.archive.tokenizer': 'restart',
  'gateway.appHousekeeping': 'component', 'gateway.appBackup': 'component', 'gateway.appRestore': 'component',
};
const agent: Record<string, ReloadMode> = {
  jev: 'live', orchestration: 'component', voice: 'component', workers: 'next-process',
  'claude.model': 'next-process', 'claude.extraFlags': 'next-process',
  'claude.dangerouslySkipPermissions': 'ignored', claudeBin: 'next-process',
  session: 'live', heartbeat: 'live', connectors: 'next-process', allow_tools: 'live',
  telegram: 'component', discord: 'component', line: 'component', slack: 'component',
  whatsapp: 'component', whatsapp_cloud: 'component', wechat: 'component',
  name: 'live', description: 'live', avatar: 'live', signatureEmoji: 'live',
  history: 'component', memory: 'component', dreaming: 'component', skillLearning: 'component',
  sessionCompaction: 'component', knowledge: 'component',
  'knowledge.shared.root': 'restart', 'knowledge.shared.project': 'restart', 'knowledge.archive.tokenizer': 'restart',
  env: 'restart', workspace: 'restart', id: 'restart', type: 'restart', container: 'restart',
};
export function reloadMode(agentId: string, field: string): ReloadMode {
  const policies = agentId ? agent : gateway;
  const key = Object.keys(policies).filter(k => field === k || field.startsWith(k + '.')).sort((a, b) => b.length - a.length)[0];
  return key ? policies[key] : 'restart';
}
/** Object fields recurse; arrays/maps with arbitrary IDs are atomic leaf values. */
export function changedConfigPaths(before: any, after: any, prefix = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if ((before === undefined || before === null || typeof before === 'object') && (after === undefined || after === null || typeof after === 'object') && !Array.isArray(before) && !Array.isArray(after) && (before || after)) {
    return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].flatMap(key => changedConfigPaths(before?.[key], after?.[key], prefix ? prefix + '.' + key : key));
  }
  return prefix ? [prefix] : [];
}
export function configValue(value: any, field: string): any { return field.split('.').reduce((v, k) => v?.[k], value); }
export function setConfigValue(value: any, field: string, next: any): void {
  const keys = field.split('.');
  if (keys.some(k => !k || ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('Unsafe configuration path');
  let target = value;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  if (next === undefined) delete target[keys.at(-1)!]; else target[keys.at(-1)!] = structuredClone(next);
}
