import { VoiceError } from '../voice/types';
import { resolveVoiceId } from '../voice/providers/voice-catalog';
import type { AgentConfig } from '../types';
import type { Row } from './store';
import type { DeliveryOutcome } from './delivery';
import { ttsProvider } from '../voice/providers/registry';

/** Preserve normalized provider codes, never raw exceptions or credentials. */
export function speechSynthesisFailure(error: unknown): DeliveryOutcome {
  return { state: 'failed', code: error instanceof VoiceError ? error.code : 'TTS_SYNTHESIS_FAILED', speechSynthesisFailed: true };
}

export interface SpeechDelivery { text: string; provider: string; model: string; voiceId: string; voiceOrigin?: boolean; }

/** TTS errors are independent of the already queued text reply. Synthesis is
 * bounded and happens before the Telegram request; uncertain sends are not retried. */
export async function sendTelegramSpeech(agent: AgentConfig, binding: Row, speech: SpeechDelivery,
  request: typeof fetch = fetch, provider: typeof ttsProvider = ttsProvider, enabled: () => boolean = () => true): Promise<DeliveryOutcome> {
  if (!enabled()) return { state: 'failed', code: 'VOICE_REPLY_DISABLED' };
  if (binding.channel !== 'telegram' || !agent.telegram?.botToken) return { state: 'failed', code: 'VOICE_DELIVERY_NOT_CONFIGURED' };
  if (!speech.text?.trim() || speech.text.length > 600 || speech.text.includes('```')) return { state: 'failed', code: 'INVALID_SPEECH_SUMMARY' };
  let audio;
  try {
    const tts = provider(speech);
    if (!tts.synthesizeFile) return { state: 'failed', code: 'TTS_FILE_UNSUPPORTED', speechSynthesisFailed: true };
    audio = await tts.synthesizeFile({ text: speech.text, voiceId: await resolveVoiceId(speech), signal: AbortSignal.timeout(60000) });
    if (!audio.bytes.length || audio.bytes.length > 5 * 1024 * 1024) return { state: 'failed', code: 'INVALID_SPEECH_AUDIO', speechSynthesisFailed: true };
  } catch (error) { return enabled() ? speechSynthesisFailure(error) : { state: 'failed', code: 'VOICE_REPLY_DISABLED' }; }
  if (!enabled()) return { state: 'failed', code: 'VOICE_REPLY_DISABLED' };
  const form = new FormData();
  form.set('chat_id', String(binding.chat_id));
  if (binding.thread_key) form.set('message_thread_id', String(binding.thread_key));
  form.set('voice', new Blob([new Uint8Array(audio.bytes)], { type: audio.mime }), audio.name);
  try {
    const response = await request(`https://api.telegram.org/bot${agent.telegram.botToken}/sendVoice`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    if (!response.ok) return { state: response.status >= 500 ? 'unknown' : 'failed', code: `PROVIDER_HTTP_${response.status}` };
    const receipt = await response.json() as { ok?: boolean; result?: { message_id?: number } };
    if (!receipt.ok || !receipt.result?.message_id) return { state: 'failed', code: 'PROVIDER_REJECTED' };
    return { state: 'delivered', providerId: String(receipt.result.message_id) };
  } catch { return { state: 'unknown', code: 'PROVIDER_RECEIPT_UNKNOWN' }; }
}
