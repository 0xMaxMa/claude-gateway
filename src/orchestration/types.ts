import type { ChatChannelOrApi } from '../history/types';

export type SessionRole = 'legacy' | 'agent' | 'worker';
export type InputModality = 'text' | 'voice_note' | 'live_voice';
export type TaskState = 'queued' | 'starting' | 'running' | 'waiting_input' |
  'interrupting' | 'cancel_requested' | 'recovering' | 'needs_reconciliation' |
  'completed' | 'failed' | 'cancelled';
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'cancelled']);
export type ChangeMode = 'when_ready' | 'interrupt_and_resume';

/** Resolved by authenticated ingress, never copied from model arguments. */
export interface ConversationScope {
  agentId: string;
  agentSessionId: string;
  source: ChatChannelOrApi;
  accountId: string;
  chatId: string;
  threadKey: string;
  principalId: string;
}
export interface ExecutionCapabilities {
  execute: boolean;
  writeMemory: boolean;
}
export interface CommandContext extends ExecutionCapabilities {
  model?: string;
  conversationId: string;
  principalId: string;
  inputId: string;
  decisionId: string;
  epoch: number;
  actionId: string;
}
export interface TaskFailure { code: string; message: string; observedAt: number; }
export type WorkerOutcome = {type: 'completed'; result: TaskResult} | {type: 'stopped' | 'failed' | 'unknown'; failure?: TaskFailure};
export interface TaskResult {
  summary: string;
  artifactIds: string[];
  diff?: { text: string; truncated: boolean };
}
export interface TaskSnapshot {
  continueTaskId?: string;
  continuationPolicy?: 'after_success' | 'after_terminal';
  workstreamId?: string;
  workerId?: string;
  skill?: import('./skills').TaskSkill;
  model?: string;
  resourceProfile?: { projectRoot: string; mode: 'isolated-worktree' | 'shared-lock' | 'host' | 'container' };
  taskId: string;
  conversationId: string;
  agentId: string;
  agentSessionId: string;
  ownerPrincipalId: string;
  initiatingInputId: string;
  title: string;
  targetProfile: string;
  state: TaskState;
  stateVersion: number;
  revision: number;
  appliedRevision: number;
  activeAttemptId?: string;
  replacedByTaskId?: string;
  workspaceEvidence?: { registered: Array<{ mode: string; path: string; lifecycleState: string }>; observedFilePaths: string[]; currentFilesystemVerified: false };
  execution?: import('./execution-observation').ExecutionObservation;
  recentTools?: Array<{name: string; description?: string; type: string; isError?: boolean; occurredAt: number}>;
  latestProgress?: { text: string; observedAt: number; source: 'worker' | 'runtime' };
  cancellation?: { requestedBy: 'user' | 'agent'; requestedAt: number };
  pendingQuestion?: { questionId: string; text: string; revision: number };
  result?: TaskResult;
  failure?: TaskFailure;
  capabilities: ExecutionCapabilities;
  createdAt: number;
  updatedAt: number;
}
export interface TaskRevision {
  answers?: Array<{ questionId: string; text: string; inputId: string }>;
  taskId: string;
  revision: number;
  instructions: string;
  contextRefs: string[];
  mode: ChangeMode;
  originatingInputId: string;
}
export interface TaskAttempt {
  workerId?: string;
  resumeSession?: boolean;
  attemptId: string;
  taskId: string;
  generation: number;
  revision: number;
  sessionId: string;
  state: 'starting' | 'running' | 'ended' | 'unknown';
  processIdentity?: { pid: number; startedAt: number; instanceId: string; bootId?: string; startTicks?: string };
  result?: TaskResult;
  failure?: TaskFailure;
}
export interface OrchestrationEvent<T = unknown> {
  schema_version: 1;
  event_id: string;
  conversation_id: string;
  stream_id: string;
  seq: number;
  type: string;
  occurred_at: number;
  task_id?: string;
  payload: T;
}
export class OrchestrationError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'OrchestrationError';
  }
}
