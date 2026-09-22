import type { JevRequest, JevResult } from './types';

/** Consumer protocol v1. No provider keys, executable code or URLs in task arguments. */
export interface BrowserScope { device_id: string; grant_id: string; tab_id: string }
export interface BrowserProgress { contractVersion?: 1; phase?: 'evaluating'|'decided'|'acting'|'acted'; requestId?: string; operationId?: string; steps: number; evaluations: number; model?: string; decision_ms?: number; operation_confidence?: number; target_confidence?: number }
export interface BrowserExecutionResult {
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
  goal: string;
  fields?: Array<{label:string;text:string}>;
  signal: AbortSignal;
  authorized(): boolean;
  evaluate(request: JevRequest, signal: AbortSignal): Promise<JevResult>;
  progress(event: BrowserProgress): void;
}
export interface BrowserConnectorConfig {
  id: string; name: string; agentId: string; principalId: string; conversationId: string;
  endpoint?: string; apiKeyEnv?: string; apiKeyFile?: string; connectorId?: string;
  scope: BrowserScope;
  fields?: Array<{label: string; text: string}>;
  budget?: { maxSteps?: number; maxEvaluations?: number; timeoutMs?: number; maxTextCalls?: number; maxStaleRetries?: number; operationConfidence?: number; targetConfidence?: number };
}
export interface BrowserIntegrationConfig { runnerModule: string; bindings: BrowserConnectorConfig[] }
export type BrowserToolCall = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export interface BrowserRunnerModule {
  BROWSER_RUNNER_CONTRACT_VERSION: 1;
  runBrowserTask(input: { contractVersion: 1; goal: string; scope: BrowserScope; fields?: BrowserConnectorConfig['fields'] } & BrowserConnectorConfig['budget'], dependencies: {
    call: BrowserToolCall;
    evaluate(request: JevRequest, signal: AbortSignal): Promise<{model: string; answers: JevResult['answers']}>;
    progress(event: BrowserProgress): void;
    verify?: (observation: unknown, signal: AbortSignal) => Promise<boolean>;
    resolveFieldText?: (request: unknown, signal: AbortSignal) => Promise<{text: string | null}>;
  }, signal: AbortSignal): Promise<BrowserExecutionResult>;
  mcpBrowserTransport(invoke: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<{content: unknown[]; isError?: boolean}>): BrowserToolCall;
  /** Optional trusted integration hooks. Never generated from page/model code. */
  verifyBrowserTask?: (goal: string, observation: unknown, signal: AbortSignal) => Promise<boolean>;
  resolveFieldText?: (request: unknown, signal: AbortSignal) => Promise<{text: string | null}>;
}

export interface BrowserEvidence {
  requestId: string;
  recordedAt: number;
  evidenceId?: string;
  result?: BrowserExecutionResult;
  executionState: 'ended' | 'interrupted';
  fresh?: { observedAt: number; observation: unknown; operationStatus?: unknown };
}
export interface BrowserProviderFailure { code: string; status?: number; retryAfter?: string; resetAt?: string }

export type BrowserTaskReport = Omit<BrowserExecutionResult, 'observation'>;
