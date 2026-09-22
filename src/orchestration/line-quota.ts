/**
 * LINE push messages are quota-metered per channel, and LINE returns HTTP 429 for
 * both true quota exhaustion and ordinary rate limiting — the response alone does
 * not say which. This module turns a 429 into one of three classifications using
 * only signals that never carry message content or recipient identity (status,
 * `Retry-After`, a bounded rejection message, and the channel's own quota/
 * consumption totals), so operator logs stay safe to read and act on.
 */

export type LineFailureClass = 'quota_exhausted' | 'rate_limited' | 'unclassified';
export type LineQuotaState = { status: 'ok'; remaining: number } | { status: 'unavailable' };

const QUOTA_EXHAUSTED_PATTERN = /monthly limit|quota/i;

/** Bound the rejection message before it ever reaches a regex or a log line. */
function boundedMessage(message: unknown): string | undefined {
  return typeof message === 'string' ? message.slice(0, 200) : undefined;
}

/**
 * A known-empty cached quota is the strongest signal and overrides the response
 * body. Otherwise fall back to the body's own wording, then to `Retry-After`
 * (LINE sets it for ordinary rate limiting, not for quota exhaustion). Anything
 * left over is reported as unclassified rather than guessed.
 */
export function classifyLineRejection(status: number, quota: LineQuotaState, retryAfter: string | null, rejectionMessage: unknown): LineFailureClass {
  if (status !== 429) return 'unclassified';
  if (quota.status === 'ok' && quota.remaining <= 0) return 'quota_exhausted';
  const message = boundedMessage(rejectionMessage);
  if (message && QUOTA_EXHAUSTED_PATTERN.test(message)) return 'quota_exhausted';
  if (retryAfter) return 'rate_limited';
  return 'unclassified';
}

// Base wait before retrying a rate-limited LINE push, doubling per attempt up to
// the cap. Quota exhaustion never retries — see LINE_RATE_LIMIT_MAX_ATTEMPTS.
const LINE_RETRY_BASE_MS = 2000;
const LINE_RETRY_CAP_MS = 30000;
export const LINE_RATE_LIMIT_MAX_ATTEMPTS = 3;

export function lineRetryBackoffMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 8);
  return Math.min(LINE_RETRY_BASE_MS * 2 ** exponent, LINE_RETRY_CAP_MS);
}

const LINE_RETRY_AFTER_CAP_MS = 5 * 60 * 1000;

/** LINE's own Retry-After, when present, says exactly how long the block lasts — a
 * better signal than the fixed backoff schedule, which can retry well before a
 * longer cooldown actually clears and burn the whole bounded attempt budget for
 * nothing. Falls back to the exponential schedule when absent or unparseable. */
export function parseLineRetryAfterMs(retryAfter: string | null): number | undefined {
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, LINE_RETRY_AFTER_CAP_MS) : undefined;
}

// Bounds how many distinct agents' state these module-level caches hold at once —
// without this, an agent deleted or reconfigured (no eviction hook exists for that)
// would leave a permanent entry for the life of the process. Mirrors the same
// cap-and-evict-oldest convention already used by context-footprint.ts and
// dashboard-reader.ts's caches in this same directory.
const MAX_CACHED_AGENTS = 64;
function evictOldest<K, V>(cache: Map<K, V>): void {
  if (cache.size >= MAX_CACHED_AGENTS) cache.delete(cache.keys().next().value!);
}

const quotaCache = new Map<string, { state: LineQuotaState; expiresAt: number }>();
const QUOTA_CACHE_TTL_MS = 60000;

async function fetchLineQuotaState(token: string, request: typeof fetch): Promise<LineQuotaState> {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    // Kept short: this can run inline in DeliveryOutbox's single shared per-agent send
    // loop, so a slow quota probe would otherwise delay unrelated channels' deliveries.
    const [quotaRes, consumptionRes] = await Promise.all([
      request('https://api.line.me/v2/bot/message/quota', { headers, signal: AbortSignal.timeout(1500) }),
      request('https://api.line.me/v2/bot/message/quota/consumption', { headers, signal: AbortSignal.timeout(1500) }),
    ]);
    if (!quotaRes.ok || !consumptionRes.ok) return { status: 'unavailable' };
    const quota = await quotaRes.json() as { type?: string; value?: number };
    const consumption = await consumptionRes.json() as { totalUsage?: number };
    if (quota.type !== 'limited' || typeof quota.value !== 'number' || typeof consumption.totalUsage !== 'number') return { status: 'unavailable' };
    return { status: 'ok', remaining: quota.value - consumption.totalUsage };
  } catch { return { status: 'unavailable' }; }
}

/** Cached per agent so a burst of deliveries costs one quota/consumption read, not one per message. */
export async function lineQuotaState(agentId: string, token: string, request: typeof fetch, now = Date.now()): Promise<LineQuotaState> {
  const cached = quotaCache.get(agentId);
  if (cached && cached.expiresAt > now) return cached.state;
  const state = await fetchLineQuotaState(token, request);
  if (!quotaCache.has(agentId)) evictOldest(quotaCache);
  quotaCache.set(agentId, { state, expiresAt: now + QUOTA_CACHE_TTL_MS });
  return state;
}

export function resetLineQuotaCache(): void { quotaCache.clear(); }

const LOW_QUOTA_THRESHOLD = 100;
const warnedLow = new Map<string, boolean>();

/**
 * A one-shot transition so operators see exactly one warning per drop below the
 * threshold and one recovery notice per rise back above it — never a warning
 * every tick while the channel stays low, never silence once it recovers.
 */
export function lowQuotaTransition(agentId: string, quota: LineQuotaState, threshold = LOW_QUOTA_THRESHOLD): 'warn' | 'recovered' | 'none' {
  if (quota.status !== 'ok') return 'none';
  const isLow = quota.remaining < threshold;
  const wasWarned = warnedLow.get(agentId) ?? false;
  if (isLow && !wasWarned) { if (!warnedLow.has(agentId)) evictOldest(warnedLow); warnedLow.set(agentId, true); return 'warn'; }
  if (!isLow && wasWarned) { warnedLow.set(agentId, false); return 'recovered'; }
  return 'none';
}

export function resetLowQuotaWarnings(): void { warnedLow.clear(); }

function logLine(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event, channel: 'line', ...fields }));
}

/** Structured, credential/content/recipient-free operator log for a classified LINE 429. */
export function logLineDeliveryFailure(agentId: string | undefined, classification: LineFailureClass, quota: LineQuotaState): void {
  logLine('LINE delivery failed', { agentId, classification, quotaAvailable: quota.status === 'ok', quotaRemaining: quota.status === 'ok' ? quota.remaining : undefined });
}

export function logLowLineQuota(agentId: string | undefined, remaining: number): void {
  logLine('LINE quota low', { agentId, remaining });
}

export function logLineQuotaRecovered(agentId: string | undefined, remaining: number): void {
  logLine('LINE quota recovered', { agentId, remaining });
}

/** Known remaining allowance cannot cover the pushes still queued for this agent right
 * now — distinct from the flat low-quota threshold, which fires even with plenty of
 * pending sends left to go. Unknown quota or an empty queue never triggers this. */
export function insufficientForGroup(quota: LineQuotaState, groupSize: number): boolean {
  return quota.status === 'ok' && groupSize > 0 && quota.remaining < groupSize;
}

export function logInsufficientLineQuotaForGroup(agentId: string | undefined, remaining: number, groupSize: number): void {
  logLine('LINE quota insufficient for pending group delivery', { agentId, remaining, groupSize });
}

/** The single place that turns a LINE 429 response into a DeliveryOutcome-shaped
 * {code, retryAfterMs} — classification, every log line, and the group-quota check,
 * shared by every LINE push path (text, image/file, and audio, which routes through
 * the same image/file push) so they can never drift out of sync with each other. */
export async function handleLineRejection(agentId: string, token: string, request: typeof fetch, response: Response, pendingLineGroupSize: () => number = () => 0): Promise<{ code: string; retryAfterMs?: number }> {
  const retryAfter = response.headers.get('retry-after');
  const [rejection, quota] = await Promise.all([
    response.json().catch(() => ({})) as Promise<{ message?: unknown }>,
    lineQuotaState(agentId, token, request),
  ]);
  const remaining = quota.status === 'ok' ? quota.remaining : 0;
  const classification = classifyLineRejection(429, quota, retryAfter, rejection.message);
  logLineDeliveryFailure(agentId, classification, quota);
  const transition = lowQuotaTransition(agentId, quota);
  if (transition === 'warn') logLowLineQuota(agentId, remaining);
  if (transition === 'recovered') logLineQuotaRecovered(agentId, remaining);
  // The group-size check needs a real quota number to compare against; skip the
  // pending-count query entirely when there's nothing to compare it to.
  if (quota.status === 'ok') {
    const groupSize = pendingLineGroupSize();
    if (insufficientForGroup(quota, groupSize)) logInsufficientLineQuotaForGroup(agentId, remaining, groupSize);
  }
  return {
    code: classification === 'quota_exhausted' ? 'LINE_QUOTA_EXHAUSTED' : classification === 'rate_limited' ? 'LINE_RATE_LIMITED' : 'PROVIDER_HTTP_429',
    retryAfterMs: classification === 'rate_limited' ? parseLineRetryAfterMs(retryAfter) : undefined,
  };
}
