import type {BrowserTrace, BrowserTraceEvent} from '@0xmaxma/jev-loop/browser-trace';
import type { JevRequest, JevResult } from './types';

/** Consumer protocol v1. No provider keys, executable code or URLs in task arguments. */
export interface BrowserScope { device_id: string; grant_id: string; tab_id: string }
export interface BrowserProgress { contractVersion?: 1; phase?: 'waiting_consent'|'evaluating'|'decided'|'acting'|'acted'; requestId?: string; operationId?: string; steps: number; evaluations: number; model?: string; decision_ms?: number; operation_confidence?: number; target_confidence?: number }
export interface BrowserExecutionResult {
  trace?: BrowserTrace;
  status: 'succeeded' | 'blocked' | 'cancelled' | 'failed' | 'needs_verification';
  reason: string;
  providerFailure?: BrowserProviderFailure;
  verification?: { source: 'parent'; evidence: string; at: number };
  steps: number; evaluations: number; staleRetries?: number; textCalls?: number;
  lastAction?: { operationId: string; operation: string; outcome: 'confirmed' | 'unknown' | 'not_executed' };
  observation?: unknown;
  contractVersion?: 1;
  fieldRequest?: {ref:string;label:string;reason:'missing'|'ambiguous'};
  lastEvaluation?: {requestId:string;model?:string};
  lastConfirmedAction?: {operationId:string;operation:string;outcome:'confirmed'};
}
export interface BrowserExecutionContext {
  requestConsent?: boolean;
  interruptSignal?:AbortSignal;
  trace?: (event:BrowserTraceEvent)=>void;
  startUrl?: string;
  goal: string;
  fields?: Array<{label:string;text:string}>;
  signal: AbortSignal;
  authorized(): boolean;
  evaluate(request: JevRequest, signal: AbortSignal): Promise<JevResult>;
  progress(event: BrowserProgress): void;
  /** Synchronous durable fence in the MCP transport, before any page mutation. */
  beforeMutation?(operationId: string, operation: string): void;
}
export interface BrowserConnectorConfig {
  id: string; name: string; agentId: string; principalId: string; conversationId: string;
  endpoint?: string; apiKeyEnv?: string; apiKeyFile?: string; connectorId?: string;
  scope: BrowserScope;
  fields?: Array<{label: string; text: string}>;
  budget?: { maxSteps?: number; maxEvaluations?: number; timeoutMs?: number; maxTextCalls?: number; maxStaleRetries?: number; operationConfidence?: number; targetConfidence?: number };
}
/** @deprecated Accepted only for upgrade compatibility; never invokes inference. */
export interface BrowserTextHelperConfig { api?:'openai-chat'|'anthropic-messages'; baseUrl:string; model:string; apiKeyEnv?:string; apiKeyFile?:string }
export interface BrowserIntegrationConfig { bindings: BrowserConnectorConfig[]; textHelper?: BrowserTextHelperConfig }
export type BrowserToolCall = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export interface BrowserLogicModule {
  BROWSER_USE_CONTRACT_VERSION: 1;
  runBrowserUse(input: { contractVersion: 1; goal: string; startUrl?: string; scope: BrowserScope; fields?: BrowserConnectorConfig['fields'] } & BrowserConnectorConfig['budget'], dependencies: {
    interruptSignal?:AbortSignal;
    trace?: (event:BrowserTraceEvent)=>void;
    call: BrowserToolCall;
    evaluate(request: JevRequest, signal: AbortSignal): Promise<{model: string; answers: JevResult['answers']}>;
    progress(event: BrowserProgress): void;
  /** Synchronous durable fence in the MCP transport, before any page mutation. */
  beforeMutation?(operationId: string, operation: string): void;
    verify?: (observation: unknown, signal: AbortSignal) => Promise<boolean>;
    resolveFieldText?: (request: unknown, signal: AbortSignal) => Promise<{text: string | null}>;
  }, signal: AbortSignal): Promise<BrowserExecutionResult>;
  mcpBrowserTransport(invoke: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<{content: unknown[]; isError?: boolean}>): BrowserToolCall;
  /** Optional trusted integration hooks. Never generated from page/model code. */
  verifyBrowserTask?: (goal: string, observation: unknown, signal: AbortSignal) => Promise<boolean>;
  resolveFieldText?: (request: unknown, signal: AbortSignal) => Promise<{text: string | null}>;
}

export interface BrowserMutationCheckpoint { operationId: string; operation: string; recordedAt: number }
export interface BrowserEvidence {
  trace?: BrowserTrace;
  lastDispatchedMutation?: BrowserMutationCheckpoint;
  requestId: string;
  recordedAt: number;
  evidenceId?: string;
  result?: BrowserExecutionResult;
  executionState: 'ended' | 'interrupted';
  fresh?: { observedAt: number; observation: unknown; operationStatus?: unknown; screenshot?: {type:'image';mimeType:'image/png';data:string} };
}
export interface BrowserProviderFailure { code: string; validationReason?: string; status?: number; retryAfter?: string; resetAt?: string }

export type BrowserTaskReport = Omit<BrowserExecutionResult, 'observation' | 'trace'>;

/** Independent parent verification is valid only after a known non-ambiguous stop. */
export function parentVerifiableBrowserResult(result: BrowserExecutionResult | undefined): boolean {
  return Boolean(result && !result.providerFailure && result.lastAction?.outcome !== 'unknown' &&
    ((result.status === 'needs_verification' && ['COMPLETION_CANDIDATE','VERIFICATION_FAILED'].includes(result.reason)) ||
     (result.status === 'blocked' && ['LOW_OPERATION_CONFIDENCE','LOW_TARGET_CONFIDENCE'].includes(result.reason))));
}
