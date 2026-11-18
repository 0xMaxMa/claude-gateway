/** Classifies a failed agent callback (or the Telegram call after it) so a
 * command handler can log why it failed and tell the user what to expect. */
export type CallbackFailureKind = 'busy' | 'unavailable' | 'failed';

/** A non-OK HTTP response from the agent callback server. */
export class CallbackHttpError extends Error {
  constructor(readonly status: number) {
    super(`callback HTTP ${status}`);
    this.name = 'CallbackHttpError';
  }
}

// Socket errors that mean nothing is listening, usually because the agent is
// restarting and its callback port has not come back yet.
const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET']);

export interface CallbackFailure {
  kind: CallbackFailureKind;
  name: string;
  timeout: boolean;
  status?: number;
  code?: string;
  message: string;
}

export function classifyCallbackFailure(error: unknown): CallbackFailure {
  const e = error as { name?: unknown; message?: unknown; cause?: { code?: unknown }; code?: unknown; error_code?: unknown; description?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'UnknownError';
  const status = error instanceof CallbackHttpError ? error.status
    : typeof e?.error_code === 'number' ? e.error_code : undefined;
  const rawCode = e?.cause?.code ?? e?.code;
  const code = typeof rawCode === 'string' ? rawCode : undefined;
  const timeout = name === 'TimeoutError';
  const raw = typeof e?.description === 'string' ? e.description : typeof e?.message === 'string' ? e.message : String(error);
  // Never log a callback URL; the message is bounded so a large body cannot flood the log.
  const message = raw.replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').slice(0, 160);
  const fromCallback = error instanceof CallbackHttpError;
  const kind: CallbackFailureKind =
    timeout || (fromCallback && status === 429) ? 'busy'
    : message === 'not_configured' || (code !== undefined && UNREACHABLE.has(code)) || (fromCallback && (status === 502 || status === 503 || status === 504)) ? 'unavailable'
    : 'failed';
  return { kind, name, timeout, ...(status !== undefined ? { status } : {}), ...(code ? { code } : {}), message };
}

export function formatCallbackFailure(command: string, f: CallbackFailure): string {
  return `telegram channel: /${command} failed (kind=${f.kind} name=${f.name} timeout=${f.timeout}` +
    `${f.status !== undefined ? ` status=${f.status}` : ''}${f.code ? ` code=${f.code}` : ''} message=${JSON.stringify(f.message)})`;
}

export function callbackFailureReply(kind: CallbackFailureKind, what: string, command: string): string {
  if (kind === 'busy') return `The agent is busy and did not answer in time. Please try /${command} again in a moment.`;
  if (kind === 'unavailable') return `The agent is restarting or unavailable. Please try /${command} again shortly.`;
  return `Could not load ${what}. Please try /${command} again.`;
}
