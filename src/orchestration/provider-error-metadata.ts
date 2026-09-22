export interface ProviderErrorMetadata { status?: number; retryAfterMs?: number; resetAt?: number; }
/** Read only explicitly structured error fields. Never infer reset clocks from
 * prose or retain arbitrary response headers/bodies. Call only on error envelopes. */
export function providerErrorMetadata(value: unknown, now = Date.now(), depth = 0): ProviderErrorMetadata {
  if (depth > 4 || !value || typeof value !== 'object') return {};
  if (Array.isArray(value)) return Object.assign({}, ...value.slice(0, 16).map(v => providerErrorMetadata(v, now, depth + 1)));
  const row = value as Record<string, unknown>;
  const result: ProviderErrorMetadata = providerErrorMetadata(row.error, now, depth + 1);
  if (typeof row.status === 'number' && Number.isInteger(row.status) && row.status >= 400 && row.status <= 599) result.status = row.status;
  if (typeof row.retryAfterMs === 'number' && Number.isSafeInteger(row.retryAfterMs) && row.retryAfterMs >= 0 && row.retryAfterMs <= 30 * 86400000) result.retryAfterMs = row.retryAfterMs;
  if (typeof row.resetAt === 'number' && Number.isSafeInteger(row.resetAt) && row.resetAt > now && row.resetAt <= now + 30 * 86400000) result.resetAt = row.resetAt;
  const headers = row.headers as Record<string, unknown> | undefined;
  const retry = headers && (headers['retry-after'] ?? headers['Retry-After']);
  if (typeof retry === 'string' && retry.length <= 64) {
    const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now;
    if (Number.isSafeInteger(delay) && delay >= 0 && delay <= 30 * 86400000) result.retryAfterMs = delay;
  }
  return result;
}
