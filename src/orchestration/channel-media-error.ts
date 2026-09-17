import { OrchestrationError } from './types';

/** Safe admission diagnostics: never expose provider URLs, bodies, or credentials. */
export class ChannelMediaError extends OrchestrationError {
  constructor(code: string, readonly retryable: boolean, readonly status?: number, readonly retryAfterMs?: number) {
    super(code);
  }
}

export function classifyChannelMediaError(error: unknown): ChannelMediaError {
  if (error instanceof ChannelMediaError) return error;
  if (error instanceof OrchestrationError && ['INVALID_ATTACHMENT', 'ATTACHMENT_TOO_LARGE', 'ATTACHMENT_NOT_CONFIGURED'].includes(error.code)) {
    return new ChannelMediaError(error.code, false);
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // Missing source files cannot be recovered by retrying the same reference.
  // Disk, permission and reconciliation errors may recover after operator action.
  return new ChannelMediaError('ATTACHMENT_UNAVAILABLE', !['ENOENT', 'ENOTDIR', 'EISDIR'].includes(code ?? ''));
}

export function channelMediaHttpError(status: number, retryAfter?: string | null): ChannelMediaError {
  let retryAfterMs: number | undefined;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) retryAfterMs = Math.min(delay, 24 * 60 * 60 * 1000);
  }
  return new ChannelMediaError('ATTACHMENT_UNAVAILABLE', status === 408 || status === 429 || status >= 500, status, retryAfterMs);
}
