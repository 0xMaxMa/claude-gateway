import { upstreamVoiceConnection } from './providers/upstream';
import { VoiceError } from './types';

export const MANAGED_VOICE_QUOTA_EXHAUSTED = 'MANAGED_VOICE_QUOTA_EXHAUSTED';
/** Consult the user's wallet through the existing authenticated provider route.
 * Never cache an exhausted wallet across a reset or a plan/credit adjustment. */
export async function requireManagedVoiceCredit(provider: string, request: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  if (!provider.startsWith('managed:')) return;
  const { base, key } = upstreamVoiceConnection('elevenlabs', true);
  let usage: unknown;
  try {
    const timeout = AbortSignal.timeout(5000);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    effectiveSignal.throwIfAborted();
    const response = await request(new URL('../usage', base), {
      headers: { Authorization: `Bearer ${key}` }, signal: effectiveSignal, redirect: 'error',
    });
    if (!response.ok) throw new VoiceError('MANAGED_VOICE_USAGE_UNAVAILABLE');
    usage = await response.json();
  } catch {
    throw new VoiceError(signal?.aborted ? 'PROVIDER_ABORTED' : 'MANAGED_VOICE_USAGE_UNAVAILABLE');
  }
  const remaining = usage && typeof usage === 'object' ? (usage as { remaining?: unknown }).remaining : undefined;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) throw new VoiceError('MANAGED_VOICE_USAGE_UNAVAILABLE');
  if (remaining <= 0) throw new VoiceError(MANAGED_VOICE_QUOTA_EXHAUSTED);
}
