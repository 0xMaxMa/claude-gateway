import { sanitizeProviderMessage } from './provider-message';
import { inferenceFailureMessage } from './inference-errors';
import { OrchestrationError } from './types';

// Used only when replaying an already-rendered terminal frame from the server buffer.
export class PresentedResponseError extends Error {}

/** Public explanations, independent of exception prose and transport. Never echo internal messages. */
const explanations: Readonly<Record<string, string>> = {
  MODEL_MAX_TURNS: 'The model reached its configured turn limit before completing the request.',
  MODEL_BUDGET_EXCEEDED: 'The model reached its configured spending limit before completing the request.',
  MODEL_OUTPUT_INVALID: 'The model could not produce the required response format after retrying.',
  INFERENCE_FAILED: 'The model request failed without a usable provider diagnostic. Check the gateway logs.',
  PROCESS_EXITED: 'The agent process exited before completing the response. Check the gateway logs before retrying.',
  PROCESS_START_FAILED: 'The agent process could not start. Check the Claude installation and gateway logs.',
  CLAUDE_BINARY_NOT_FOUND: 'The Claude executable was not found. Check the Claude installation or CLAUDE_BIN setting.',
  PROCESS_PERMISSION_DENIED: 'The gateway does not have permission to start the Claude executable.',
  RESPONSE_PERSISTENCE_FAILED: 'The gateway could not save the response. Check storage and gateway logs before retrying.',
  RESPONSE_TOO_LARGE: 'The response exceeded the gateway size limit. Try a smaller request.',
  PROFILE_INVENTORY_MISMATCH: 'The agent tool configuration does not match the running gateway. Check that the gateway and MCP server use the same deployment.',
  CAPACITY_EXCEEDED: 'The gateway has reached its active-session limit. Wait for current work to finish and try again.',
  CONFLICT: 'This session already has a pending request.',
  ORCHESTRATION_CLOSING: 'The gateway is shutting down. Try again after it restarts.',
  GATEWAY_SHUTDOWN: 'The gateway shut down before the response completed.',
  TASK_RESULT_TIMEOUT: 'Scheduled work did not produce a final report before its deadline. Check /tasks before retrying.',
  INTERRUPTED: 'Response stopped.',
  UNSUPPORTED_ORCHESTRATION_BACKEND: 'Orchestration requires the headless backend. Check the gateway configuration.',
  UNSUPPORTED_PROCESS_SUPERVISOR: 'This platform does not support the configured orchestration process supervisor.',
  PROFILE_FLAGS_CONFLICT: 'Custom Claude flags conflict with the orchestration runtime profile. Check the agent configuration.',
  ACKNOWLEDGEMENT_DELIVERY_PENDING: 'The acknowledgement has not been delivered yet. Work has not been started; check channel delivery.',
  VOICE_NOTES_DISABLED: 'Voice-note transcription is disabled for this agent.',
  VOICE_NOTE_ATTACHMENT_MISSING: 'The voice-note attachment is missing. Please resend it.',
  ENOSPC: 'The gateway has run out of storage space. Free disk space before retrying.',
  EACCES: 'The gateway could not access a required resource because permission was denied. Check the gateway logs.',
  EPERM: 'The gateway was not permitted to access a required resource. Check the gateway logs.',
  ENOENT: 'A required gateway file or executable is missing. Check the gateway logs.',
  SQLITE_FULL: 'The gateway database could not be written because storage is full.',
  SQLITE_BUSY: 'The gateway database is busy. Try again shortly.',
  ECONNREFUSED: 'The gateway could not connect to a required service. Check service availability.',
  ECONNRESET: 'The connection to a required service was interrupted. Please try again.',
  ETIMEDOUT: 'The connection to a required service timed out. Please try again.',
};

export function responseFailureMessage(error: unknown, legacyMessage = false): string {
  if (error instanceof PresentedResponseError) return sanitizeProviderMessage(error.message) ?? 'The gateway response failed.';
  const provider = inferenceFailureMessage(error);
  if (provider) return provider;
  const failure = error as { code?: string; timeout?: { phase?: string } } | null;
  const code = typeof failure?.code === 'string' ? failure.code : '';
  if (code === 'TIMEOUT' || code === 'TIMEOUT_SOFT') {
    const phase = failure?.timeout?.phase;
    const message = code === 'TIMEOUT_SOFT' ? 'The request wait time elapsed; the agent may still be working.'
      : phase === 'startup' ? 'The agent could not finish starting in time.'
      : phase === 'first_response' ? 'The model did not begin responding in time.'
      : phase === 'idle' ? 'The agent stopped making progress before completing the reply.'
      : 'The agent reached its response time limit before completing the reply.';
    return `${message} Please check /tasks for any pending work. (${code})`;
  }
  if (Object.prototype.hasOwnProperty.call(explanations, code)) return `${explanations[code]} (${code})`;
  // Legacy stream/command callbacks historically carry uncoded public errors.
  // Preserve that contract, with redaction; orchestration/internal callers fail closed.
  if (legacyMessage && !code && error instanceof Error) {
    const text = sanitizeProviderMessage(error.message);
    if (text) return text;
  }
  // New orchestration codes remain diagnosable without exposing arbitrary exception text.
  const publicCode = error instanceof OrchestrationError && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'GATEWAY_INTERNAL_ERROR';
  return `The gateway could not complete the response (${publicCode}). Check the gateway logs for details.`;
}
