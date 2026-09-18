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
