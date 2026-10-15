import { upstreamVoiceConnection } from './providers/upstream';
import { VoiceError } from './types';

export const MANAGED_VOICE_QUOTA_EXHAUSTED = 'MANAGED_VOICE_QUOTA_EXHAUSTED';
/** Retry delays between wallet checks, and the time all attempts may take together. */
export const MANAGED_USAGE_RETRY_DELAYS_MS = [500, 1500];
const MANAGED_USAGE_ATTEMPT_TIMEOUT_MS = 5000, MANAGED_USAGE_BUDGET_MS = 10000;

/** One wallet check, or the last of its retries. Only `exhausted` is a definite answer that
 * stops voice work; `indeterminate` means the check itself could not complete. */
export type ManagedCreditCheck =
  | { outcome: 'available' | 'exhausted'; attempts: number; elapsedMs: number }
  | { outcome: 'indeterminate'; code: string; httpStatus?: number; attempts: number; elapsedMs: number };
export interface ManagedCreditOptions { retryDelaysMs?: number[]; sleep?: (ms: number) => Promise<void>; onDiagnostic?: (event: ManagedCreditCheck & { stage: 'usage_check' }) => void }

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Consult the user's wallet through the existing authenticated provider route, retrying a check
 * that could not complete. Never cache an exhausted wallet across a reset or a credit adjustment. */
export async function checkManagedVoiceCredit(provider: string, request: typeof fetch = fetch, signal?: AbortSignal, options: ManagedCreditOptions = {}): Promise<ManagedCreditCheck> {
  const { base, key } = upstreamVoiceConnection('elevenlabs', true);
  const delays = options.retryDelaysMs ?? MANAGED_USAGE_RETRY_DELAYS_MS, sleep = options.sleep ?? wait, started = Date.now();
  let last: { code: string; httpStatus?: number } = { code: 'MANAGED_VOICE_USAGE_UNAVAILABLE' }, attempts = 0;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt) {
      if (Date.now() - started + delays[attempt - 1] >= MANAGED_USAGE_BUDGET_MS) break;
      await sleep(delays[attempt - 1]);
    }
    if (signal?.aborted) throw new VoiceError('PROVIDER_ABORTED');
    attempts++;
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(MANAGED_USAGE_ATTEMPT_TIMEOUT_MS, MANAGED_USAGE_BUDGET_MS - (Date.now() - started))));
    const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await request(new URL('../usage', base), { headers: { Authorization: `Bearer ${key}` }, signal: effectiveSignal, redirect: 'error' });
    } catch (error) {
      if (signal?.aborted) throw new VoiceError('PROVIDER_ABORTED');
      last = { code: timeout.aborted || (error instanceof Error && error.name === 'TimeoutError') ? 'MANAGED_VOICE_USAGE_TIMEOUT' : 'MANAGED_VOICE_USAGE_NETWORK' };
      continue;
    }
    let usage: unknown;
    try { usage = await response.json(); } catch { usage = undefined; }
    const body = usage && typeof usage === 'object' ? usage as { remaining?: unknown; code?: unknown } : {};
    // A definite "no credit" from the wallet is final; it is never retried or bypassed.
    if (response.status === 402 || body.code === MANAGED_VOICE_QUOTA_EXHAUSTED) return { outcome: 'exhausted', attempts, elapsedMs: Date.now() - started };
    if (!response.ok) {
      last = { code: `MANAGED_VOICE_USAGE_HTTP_${response.status}`, httpStatus: response.status };
      // Other client errors will not change on a retry.
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
      continue;
    }
    if (typeof body.remaining !== 'number' || !Number.isFinite(body.remaining)) { last = { code: 'MANAGED_VOICE_USAGE_INVALID_BODY' }; continue; }
    return { outcome: body.remaining <= 0 ? 'exhausted' : 'available', attempts, elapsedMs: Date.now() - started };
  }
  return { outcome: 'indeterminate', ...last, attempts, elapsedMs: Date.now() - started };
}

/** Stop managed voice work only on a definite exhausted wallet. A check that cannot complete
 * (timeout, network, server error, unreadable body) lets the request through: the provider
 * still refuses work without credit, and that refusal is reported as it already is. */
export async function requireManagedVoiceCredit(provider: string, request: typeof fetch = fetch, signal?: AbortSignal, options: ManagedCreditOptions = {}): Promise<void> {
  if (!provider.startsWith('managed:')) return;
  const check = await checkManagedVoiceCredit(provider, request, signal, options);
  if (check.outcome !== 'available') options.onDiagnostic?.({ stage: 'usage_check', ...check });
  if (check.outcome === 'indeterminate' && !options.onDiagnostic)
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event: 'Managed voice credit check incomplete; continuing', provider, ...check }));
  if (check.outcome === 'exhausted') throw new VoiceError(MANAGED_VOICE_QUOTA_EXHAUSTED);
}
