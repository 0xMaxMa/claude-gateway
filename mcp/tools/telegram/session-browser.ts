import { CallbackHttpError } from './callback-failure';

/** A successful empty session is a status, not a transport failure. The empty
 * ID binds its live message until a real session appears, when it is retired. */
export function parseSessionInfo(ok: boolean, value: unknown): { sessionId: string; text: string } {
  const result = value as { success?: unknown; sessionId?: unknown; text?: unknown } | null;
  if (!ok || result?.success !== true || typeof result.text !== 'string' ||
      !(result.sessionId === null || (typeof result.sessionId === 'string' && result.sessionId.length > 0))) {
    throw new Error('Session info unavailable');
  }
  return { sessionId: result.sessionId ?? '', text: result.text };
}

/** Reads `session_info` from the agent callback. A non-OK response throws
 * CallbackHttpError with its status so the caller can tell restart from failure. */
export async function requestSessionInfo(base: string | undefined, chatId: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10000) {
  if (!base) throw new Error('not_configured');
  const response = await fetchImpl(base + '/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ command: 'session_info', chat_id: chatId }),
  });
  if (!response.ok) throw new CallbackHttpError(response.status);
  return parseSessionInfo(true, await response.json());
}
