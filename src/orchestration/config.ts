import { CHAT_CHANNELS } from '../history/types';
import { OrchestrationError } from './types';
import { isAbsolute } from 'path';

export interface OrchestrationConfig {
  /** Derived runtime fields. Configure the mode only at gateway.orchestration. */
  enabled?: boolean;
  channels?: string[];
  conversation?: {
    backend?: 'inherit';
    maxActiveSessions?: number;
    notificationPolicy?: 'next_user_turn' | 'existing_receive_path';
    /** Legacy alias; the original 15000ms template value uses the modern default. */
    decisionTimeoutMs?: number;
    /** Maximum silence after inference starts, renewed by meaningful progress. */
    idleTimeoutMs?: number;
    startupTimeoutMs?: number;
    firstResponseTimeoutMs?: number;
    maxDecisionDurationMs?: number;
    preemptionGraceMs?: number;
    maxPendingInputs?: number;
  };
  tasks?: {
    maxConcurrentPerAgent?: number;
    workerIdleTtlMs?: number;
    maxConcurrentPerConversation?: number;
    maxQueuedPerConversation?: number;
    maxQueuedPerAgent?: number;
    /** Legacy alias for the inactivity budget, no longer a wall-clock limit. */
    defaultTimeoutMs?: number;
    idleTimeoutMs?: number;
    /** Optional total worker deadline; zero disables it. */
    maxDurationMs?: number;
    interruptAckTimeoutMs?: number;
    workspaceMode?: 'isolated-worktree' | 'shared-lock' | 'host' | 'container';
    /** Optional starting directory; empty uses the agent workspace. */
    projectRoot?: string;
    resourceRetentionDays?: number;
  };
  events?: { retentionDays?: number; maxSubscriberBufferBytes?: number };
  /** @deprecated Read only when migrating old config documents. Use AgentConfig.voice. */
  voice?: {
    enabled?: boolean;
    notes?: { enabled?: boolean; provider?: string; model?: string; replyWithVoice?: boolean };
    transport?: 'websocket';
    maxActiveSessionsPerConversation?: number;
    /** @deprecated Ignored; voice uses authenticated, origin-bound tickets. */
    allowedOrigins?: string[];
    language?: string;
    stt?: { provider?: string; model?: string };
    tts?: { provider?: string; model?: string; voiceId?: string };
    turns?: { silenceCommitMs?: number; finalizationTimeoutMs?: number; maxUtteranceMs?: number };
    playback?: { maxBufferedAudioMs?: number; bargeIn?: boolean };
  };
}
export type AgentVoiceConfig = NonNullable<OrchestrationConfig['voice']>;

export const ORCHESTRATION_DEFAULTS = {
  enabled: false,
  channels: ['api'],
  conversation: { backend: 'inherit' as const, maxActiveSessions: 2, notificationPolicy: 'existing_receive_path' as const,
    decisionTimeoutMs: 120000, idleTimeoutMs: 120000, startupTimeoutMs: 120000, firstResponseTimeoutMs: 120000, maxDecisionDurationMs: 600000, preemptionGraceMs: 250, maxPendingInputs: 100 },
  tasks: { maxConcurrentPerAgent: 10, maxConcurrentPerConversation: 10, workerIdleTtlMs: 600000, maxQueuedPerConversation: 20,
    maxQueuedPerAgent: 100, defaultTimeoutMs: 1800000, idleTimeoutMs: 300000, maxDurationMs: 0, interruptAckTimeoutMs: 5000, workspaceMode: 'host' as const, projectRoot: '', resourceRetentionDays: 7 },
  events: { retentionDays: 7, maxSubscriberBufferBytes: 1048576 },
  voice: { enabled: false, notes: { enabled: true, provider: 'elevenlabs', model: 'scribe_v2', replyWithVoice: true }, transport: 'websocket' as const, maxActiveSessionsPerConversation: 1, allowedOrigins: [] as string[], language: '',
    stt: { provider: 'elevenlabs', model: 'scribe_v2_realtime' },
    tts: { provider: 'elevenlabs', model: 'eleven_v3_conversational', voiceId: '' },
    turns: { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000 },
    playback: { maxBufferedAudioMs: 1500, bargeIn: true } },
};
// New agents start disabled and choose models explicitly from connected providers.
export const AGENT_VOICE_DEFAULTS = {
  ...ORCHESTRATION_DEFAULTS.voice,
  stt: { provider: '', model: '' },
  tts: { provider: '', model: '', voiceId: '' },
  notes: { ...ORCHESTRATION_DEFAULTS.voice.notes, provider: '', model: '' },
};
export type ResolvedOrchestrationConfig = ReturnType<typeof resolveOrchestrationConfig>;

// Validate the complete tree, including unknown keys: a misspelled capacity or
// secret field must not be silently accepted as a working configuration.
export function validateTree(value: unknown, template: unknown, prefix: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrchestrationError('INVALID_CONFIG', `${prefix} must be an object`);
  const shape = template as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    const where = `${prefix}.${key}`;
    if (!(key in shape)) throw new OrchestrationError('INVALID_CONFIG', `Unknown field ${where}`);
    const expected = shape[key];
    if (Array.isArray(expected)) {
      if (!Array.isArray(item) || (!item.length && key !== 'allowedOrigins') || item.some(v => typeof v !== 'string')) throw new OrchestrationError('INVALID_CONFIG', `${where} must be a string array`);
    } else if (expected && typeof expected === 'object') validateTree(item, expected, where);
    else if (typeof item !== typeof expected) throw new OrchestrationError('INVALID_CONFIG', `Invalid ${where}`);
    else if (typeof item === 'number' && (!Number.isSafeInteger(item) || item < (key === 'maxDurationMs' ? 0 : 1) || item > 2147483647)) throw new OrchestrationError('INVALID_CONFIG', `${where} must be a positive bounded integer`);
  }
}
export function resolveOrchestrationConfig(config?: OrchestrationConfig, agentVoice?: AgentVoiceConfig) {
  if (agentVoice !== undefined) validateTree(agentVoice, ORCHESTRATION_DEFAULTS.voice, 'voice');
  const voice = agentVoice ?? config?.voice;
  if (config !== undefined) validateTree(config, ORCHESTRATION_DEFAULTS, 'orchestration');
  const d = { ...ORCHESTRATION_DEFAULTS, voice: agentVoice === undefined ? ORCHESTRATION_DEFAULTS.voice : AGENT_VOICE_DEFAULTS };
  const result = {
    enabled: config?.enabled ?? d.enabled,
    channels: [...(config?.channels ?? d.channels)],
    conversation: { ...d.conversation, ...config?.conversation,
      idleTimeoutMs: config?.conversation?.idleTimeoutMs ??
        (config?.conversation?.decisionTimeoutMs === 15000 ? d.conversation.idleTimeoutMs : config?.conversation?.decisionTimeoutMs ?? d.conversation.idleTimeoutMs) },
    tasks: { ...d.tasks, ...config?.tasks, idleTimeoutMs: config?.tasks?.idleTimeoutMs ?? config?.tasks?.defaultTimeoutMs ?? d.tasks.idleTimeoutMs },
    events: { ...d.events, ...config?.events },
    voice: { ...d.voice, ...voice, notes: { ...d.voice.notes, ...voice?.notes },
      stt: { ...d.voice.stt, ...voice?.stt }, tts: { ...d.voice.tts, ...voice?.tts },
      turns: { ...d.voice.turns, ...voice?.turns }, playback: { ...d.voice.playback, ...voice?.playback } },
  };
  if (result.channels.some(c => !['api', ...CHAT_CHANNELS].includes(c)) || new Set(result.channels).size !== result.channels.length) throw new OrchestrationError('INVALID_CONFIG', 'Invalid orchestration.channels');
  if (result.conversation.backend !== 'inherit' || !['isolated-worktree', 'shared-lock', 'host', 'container'].includes(result.tasks.workspaceMode) || result.voice.transport !== 'websocket') throw new OrchestrationError('INVALID_CONFIG', 'Unsupported orchestration backend, workspace mode or transport');
  if (!['next_user_turn', 'existing_receive_path'].includes(result.conversation.notificationPolicy)) throw new OrchestrationError('INVALID_CONFIG', 'Invalid notification policy');
  if (result.tasks.maxConcurrentPerConversation > result.tasks.maxConcurrentPerAgent || result.tasks.maxQueuedPerConversation > result.tasks.maxQueuedPerAgent) throw new OrchestrationError('INVALID_CONFIG', 'Conversation task limits exceed agent limits');
  if (result.tasks.projectRoot && (!isAbsolute(result.tasks.projectRoot) || result.tasks.projectRoot.includes('\0') || Buffer.byteLength(result.tasks.projectRoot) > 4096)) throw new OrchestrationError('INVALID_CONFIG', 'tasks.projectRoot must be an absolute bounded filesystem path');
  if (result.voice.maxActiveSessionsPerConversation !== 1) throw new OrchestrationError('INVALID_CONFIG', 'Only one active voice session per conversation is supported');
  if (!result.voice.playback.bargeIn) throw new OrchestrationError('INVALID_CONFIG', 'Voice currently requires playback.bargeIn:true');
  if (result.voice.language && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(result.voice.language)) throw new OrchestrationError('INVALID_CONFIG', 'Invalid voice.language');
  for (const origin of result.voice.allowedOrigins) {
    try { if (new URL(origin).origin !== origin || !/^https?:\/\//.test(origin)) throw new Error(); }
    catch { throw new OrchestrationError('INVALID_CONFIG', 'voice.allowedOrigins must contain exact HTTP(S) origins'); }
  }
  if (result.voice.enabled && (!result.voice.stt.provider.trim() || !result.voice.tts.provider.trim())) throw new OrchestrationError('INVALID_CONFIG', 'Voice requires configured providers');
  if (result.voice.enabled && result.voice.notes.replyWithVoice && !['elevenlabs','cartesia','upstream','paxalabs','upstream:paxalabs','gemini','upstream:gemini'].includes(result.voice.tts.provider)) throw new OrchestrationError('INVALID_CONFIG', 'Voice replies require a supported TTS provider');
  if (result.voice.enabled && (!result.voice.tts.model.trim() || !result.voice.stt.model.trim() || (result.voice.notes.enabled && (!result.voice.notes.provider.trim() || !result.voice.notes.model.trim())))) throw new OrchestrationError('INVALID_CONFIG', 'Choose TTS and STT models before enabling voice');
  return result;
}
