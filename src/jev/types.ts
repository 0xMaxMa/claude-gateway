export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JevContent = string | JsonValue[] | { [key: string]: JsonValue };
export type JevQuestion =
  | { type: 'noul'; instructions: JevContent; criteria?: { true?: JevContent; false?: JevContent } }
  | { type: 'choice'; instructions: JevContent; criteria: Record<string, JevContent | null> }
  | { type: 'score'; instructions: JevContent; criteria: JevContent[] };
export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
export interface JevRequest { state: JevContent; questions: Record<string, JevQuestion>; requestId?: string }
export interface JevConfig {
  thinking?: import('./browser-contract').BrowserTextHelperConfig;
  browser?: import('./browser-contract').BrowserIntegrationConfig;
  enabled?: boolean; provider?: 'typesafe' | 'upstream'; model?: string; baseUrl?: string;
  apiKeyFile?: string; apiKeyEnv?: string; timeoutMs?: number; maxConcurrentRequests?: number;
  maxQueueSize?: number; maxInputBytes?: number; maxQuestions?: number;
  allowedAgentIds?: string[];
  features?: Partial<Record<'computerTasks' | 'browserTasks' | 'skillRouting' | 'progressFiltering' | 'conversationIntake', { enabled?: boolean }>>;
}
export interface JevResult {
  requestId: string; requestedModel: string; model: string; answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  billing?: { charged_credits: number; rate_version?: string };
}
export interface JevContext {
  principalId: string; consumer: string; agentId?: string; sessionId?: string; taskId?: string;
  signal?: AbortSignal; deadlineMs?: number; authorize?: () => boolean;
}
export interface JevConnection { baseUrl: string; apiKey: string }
export type JevErrorCode = 'DISABLED' | 'ACCESS_DENIED' | 'INVALID_CONFIG' | 'INVALID_REQUEST' | 'QUEUE_FULL' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'AUTHENTICATION_FAILED' | 'MODEL_UNAVAILABLE' | 'QUOTA_EXCEEDED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'INVALID_RESPONSE' | 'REQUEST_CONFLICT' | 'OUTCOME_UNKNOWN';
export class JevError extends Error {
  constructor(public readonly code: JevErrorCode, message: string, public readonly metadata: { status?: number; retryAfter?: string; resetAt?: string; validationReason?: string } = {}) { super(message); this.name = 'JevError'; }
}
export interface JevEvaluationEvent {
  requestId: string; principalId: string; consumer: string; agentId?: string; sessionId?: string; taskId?: string;
  requestedModel: string; model?: string; startedAt: number; elapsedMs: number; outcome: 'completed' | 'failed';
  errorCode?: JevErrorCode; validationReason?: string; usage?: JevResult['usage']; billing?: JevResult['billing'];
}
