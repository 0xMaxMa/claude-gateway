/** Classifies a failed agent callback (or the Telegram call after it) so a
 * command handler can log why it failed and tell the user what to expect. */
export type CallbackFailureKind = 'busy' | 'unavailable' | 'failed';

/** A non-OK HTTP response from the agent callback server. */
export class CallbackHttpError extends Error {
  constructor(readonly status: number, body?: unknown) {
    const reason = rejectionReason(body);
    super(`callback HTTP ${status}${reason ? `: ${reason}` : ''}`);
    this.name = 'CallbackHttpError';
  }
}

function rejectionReason(body: unknown): string {
  const b = body as { error?: unknown; text?: unknown } | null;
  return typeof b?.error === 'string' && b.error ? b.error : typeof b?.text === 'string' && b.text ? b.text : '';
}

/** A `{success:false}` callback reply, keeping the agent's own reason and
 * error code (e.g. STOP_MENU_EXPIRED) for the log and the caller. */
export function callbackRejection(body: unknown, fallback = 'unavailable'): Error {
  const reason = rejectionReason(body);
  const code = (body as { code?: unknown } | null)?.code;
  return Object.assign(new Error(reason ? `${fallback}: ${reason}` : fallback), typeof code === 'string' && code ? { code } : {});
}

/** Reads a /command reply, throwing with the HTTP status or the agent's own
 * reason so a failure log keeps them. */
export async function readCallbackResult<T extends { success?: boolean }>(response: Response): Promise<T> {
  const result = await response.json().catch(error => { throw response.ok ? error : new CallbackHttpError(response.status); }) as T;
  if (!response.ok) throw new CallbackHttpError(response.status, result);
  if (!result?.success) throw callbackRejection(result);
  return result;
}

// Socket errors that mean nothing is listening on the callback port, usually
// because the agent is restarting. Node/undici put the code on `cause`; Bun,
// which runs the receiver, puts its own code (e.g. ConnectionRefused) on the error.
const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'ConnectionRefused', 'ConnectionClosed']);

export interface CallbackFailure {
  kind: CallbackFailureKind;
  name: string;
  timeout: boolean;
  /** HTTP status from the agent callback. */
  status?: number;
  /** Telegram Bot API error code, kept apart from the callback status. */
  telegramCode?: number;
  code?: string;
  message: string;
}

export function classifyCallbackFailure(error: unknown): CallbackFailure {
  const e = error as { name?: unknown; message?: unknown; cause?: { code?: unknown }; code?: unknown; error?: { code?: unknown }; error_code?: unknown; description?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'UnknownError';
  const status = error instanceof CallbackHttpError ? error.status : undefined;
  const telegramCode = typeof e?.error_code === 'number' ? e.error_code : undefined;
  const rawCode = e?.cause?.code ?? e?.code;
  const callbackCode = typeof rawCode === 'string' ? rawCode : undefined;
  // grammy's HttpError wraps a Telegram network failure in `.error`: log its
  // code, but it says nothing about the agent, so it never means restarting.
  const code = callbackCode ?? (typeof e?.error?.code === 'string' ? e.error.code : undefined);
  const timeout = name === 'TimeoutError';
  const raw = typeof e?.description === 'string' ? e.description : typeof e?.message === 'string' ? e.message : String(error);
  // Never log a callback URL; the message is bounded so a large body cannot flood the log.
  const message = raw.replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').slice(0, 160);
  // /command answers only 200/400/500, so status never means busy or restarting.
  const kind: CallbackFailureKind = timeout ? 'busy'
    : callbackCode !== undefined && UNREACHABLE.has(callbackCode) ? 'unavailable'
    : 'failed';
  return { kind, name, timeout, ...(status !== undefined ? { status } : {}), ...(telegramCode !== undefined ? { telegramCode } : {}), ...(code ? { code } : {}), message };
}

export function formatCallbackFailure(command: string, f: CallbackFailure): string {
  return `telegram channel: /${command} failed (kind=${f.kind} name=${f.name} timeout=${f.timeout}` +
    `${f.status !== undefined ? ` status=${f.status}` : ''}${f.telegramCode !== undefined ? ` telegram_code=${f.telegramCode}` : ''}${f.code ? ` code=${f.code}` : ''} message=${JSON.stringify(f.message)})`;
}

/** `telegramCode`: Telegram itself rejected the reply, so the agent is fine and
 * the user is told that instead of a generic failure. */
export function callbackFailureReply(kind: CallbackFailureKind, what: string, command: string, telegramCode?: number): string {
  if (telegramCode === 429) return `Telegram is rate-limiting this chat. Please wait a minute, then try /${command} again.`;
  if (telegramCode !== undefined) return `Telegram rejected the /${command} reply (error ${telegramCode}). Please try /${command} again; if it keeps failing, report it.`;
  if (kind === 'busy') return `The agent is busy and did not answer in time. Please try /${command} again in a moment.`;
  if (kind === 'unavailable') return `The agent is restarting or unavailable. Please try /${command} again shortly.`;
  return `Could not load ${what}. Please try /${command} again.`;
}

/** Logs a failed callback-backed command or button without replying. */
export function logCallbackFailure(command: string, error: unknown): void {
  process.stderr.write(formatCallbackFailure(command, classifyCallbackFailure(error)) + '\n');
}
