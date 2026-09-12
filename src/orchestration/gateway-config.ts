import type {AgentConfig,GatewayConfig} from '../types';
import {OrchestrationConfig,ORCHESTRATION_DEFAULTS,resolveOrchestrationConfig,validateTree} from './config';
import {CHAT_CHANNELS} from '../history/types';
export type GatewayOrchestration = boolean | Omit<OrchestrationConfig,'channels'>;
const overrides=Symbol('agent-orchestration-overrides');
export const ORCHESTRATION_CHANNELS=['api',...CHAT_CHANNELS];
export function gatewayOrchestrationEnabled(value:GatewayOrchestration|undefined):boolean {return typeof value==='boolean'?value:value?.enabled===true;}
export function validateGatewayOrchestration(value:unknown):void {
  if(value===undefined||typeof value==='boolean')return;
  validateTree(value,ORCHESTRATION_DEFAULTS,'gateway.orchestration');
  if(Object.prototype.hasOwnProperty.call(value,'channels'))throw Error('gateway.orchestration applies to every channel; channels is not configurable');
}
function merge(base:any,override:any):any {
  const result={...base};
  for(const [key,value] of Object.entries(override??{}))result[key]=value&&typeof value==='object'&&!Array.isArray(value)?merge(base?.[key]??{},value):value;
  return result;
}
/** Derived mode is non-enumerable: serializing settings never writes per-Agent switches back to config.json. */
export function effectiveOrchestration(settings:OrchestrationConfig|undefined,global:GatewayOrchestration|undefined):OrchestrationConfig {
  validateGatewayOrchestration(global);
  if(settings!==undefined)validateTree(settings,ORCHESTRATION_DEFAULTS,'agents[].orchestration');
  const raw={...((settings as any)?.[overrides]??settings)};delete raw.enabled;delete raw.channels;
  const defaults=typeof global==='object'?{...global}:{};delete defaults.enabled;
  const result=merge(defaults,raw);
  // Reply permission belongs to the Agent. Accept old gateway keys for config
  // compatibility, but never inherit their value into an Agent's policy.
  if (result.voice) {
    result.voice.notes ??= {};
    result.voice.notes.replyWithVoice = raw.voice?.notes?.replyWithVoice ?? true;
  }
  Object.defineProperties(result,{enabled:{value:gatewayOrchestrationEnabled(global)},channels:{value:ORCHESTRATION_CHANNELS},[overrides]:{value:raw},toJSON:{value:()=>raw}});
  resolveOrchestrationConfig(result);
  return result;
}
export function applyGatewayOrchestration(agent:AgentConfig,gateway:GatewayConfig):AgentConfig {
  // Normalize legacy in-memory callers too; loaded config is already migrated.
  const document = { gateway: { orchestration: gateway.gateway.orchestration }, agents: [agent] };
  migrateAgentVoiceConfig(document);
  agent.orchestration=effectiveOrchestration(agent.orchestration,document.gateway.orchestration);
  resolveOrchestrationConfig(agent.orchestration, agent.voice ?? { enabled: false });
  return agent;
}

/** One-time structural migration. New documents have no inherited voice settings.
 * Merge raw values, never environment-expanded credentials, and preserve explicit
 * per-agent overrides (including false). Calling this again is a no-op. */
export function migrateAgentVoiceConfig(document: { gateway?: any; agents?: any[] }): boolean {
  const global = document.gateway?.orchestration;
  validateGatewayOrchestration(global);
  const legacyGlobal = global && typeof global === 'object' ? global : undefined;
  let changed = false;
  for (const agent of document.agents ?? []) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue;
    const legacy = agent.orchestration;
    if (!legacyGlobal && !legacy?.voice) continue;
    // Reuse the old precedence rules before removing the inherited layer.
    let effective: OrchestrationConfig;
    try { effective = effectiveOrchestration(legacy, global); }
    catch { continue; } // The loader reports/skips malformed agents individually.

    const settings = JSON.parse(JSON.stringify(effective));
    if (legacyGlobal) {
      for (const field of ['conversation', 'tasks', 'events']) {
        if (legacyGlobal[field] || legacy?.[field]) settings[field] = merge(legacyGlobal[field], legacy?.[field]);
      }
    }
    if (legacyGlobal?.voice || legacy?.voice) {
      const rawVoice = merge(merge(legacyGlobal?.voice, legacy?.voice), agent.voice);
      const resolvedVoice = resolveOrchestrationConfig(effective).voice;
      // Disabled, never-configured voice must not acquire fictional ElevenLabs
      // selections merely because the previous runtime supplied defaults.
      const hasSelection = ['tts', 'stt', 'notes'].some(field =>
        ['provider', 'model', 'voiceId'].some(key => Boolean(rawVoice[field]?.[key])));
      const voice = rawVoice.enabled !== true && !resolvedVoice.enabled && !hasSelection
        ? rawVoice
        : merge(resolvedVoice, agent.voice);
      delete voice.allowedOrigins;
      agent.voice = voice;
    }
    delete settings.voice;
    if (Object.keys(settings).length) agent.orchestration = settings;
    else delete agent.orchestration;
    changed = true;
  }
  if (legacyGlobal) {
    document.gateway.orchestration = global.enabled === true;
    changed = true;
  }
  return changed;
}
