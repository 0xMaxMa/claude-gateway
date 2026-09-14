import { upstreamVoiceConnection } from './providers/upstream';
import { VoiceError } from './types';

export const MANAGED_VOICE_QUOTA_EXHAUSTED = 'MANAGED_VOICE_QUOTA_EXHAUSTED';
/** Consult the user's wallet through the existing authenticated provider route.
 * Never cache an exhausted wallet across a reset or a plan/credit adjustment. */
export async function requireManagedVoiceCredit(provider: string, request: typeof fetch = fetch): Promise<void> {
  if (!provider.startsWith('managed:')) return;
  const { base, key } = upstreamVoiceConnection('elevenlabs', true);
  const response = await request(new URL('../usage', base), {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new VoiceError('MANAGED_VOICE_USAGE_UNAVAILABLE');
  const usage = await response.json() as { remaining?: unknown };
  if (typeof usage.remaining !== 'number' || !Number.isFinite(usage.remaining)) throw new VoiceError('MANAGED_VOICE_USAGE_UNAVAILABLE');
  if (usage.remaining <= 0) throw new VoiceError(MANAGED_VOICE_QUOTA_EXHAUSTED);
}
