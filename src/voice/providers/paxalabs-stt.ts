import { providerHttpError, voiceProviderRequest } from '../errors';
import { VoiceError } from '../types';
import { RecordedStt } from './recorded-stt';
import { paxaConnection } from './paxalabs-tts';

/** Paxa accepts completed recordings, not a realtime transcription stream. */
export async function transcribePaxa(audio: Uint8Array, options: { provider: string; model: string; language?: string; signal: AbortSignal }, request: typeof fetch = fetch): Promise<string> {
  const { base, key } = paxaConnection(options.provider);
  if (!key) throw new VoiceError('STT_CREDENTIALS_MISSING');
  if (!audio.length || audio.length > 25 * 1024 * 1024) throw new VoiceError('VOICE_NOTE_SIZE_LIMIT');
  if (options.language && !['th', 'en'].includes(options.language)) throw new VoiceError('STT_LANGUAGE_UNSUPPORTED');
  const response = await voiceProviderRequest(new URL('stt', base), {
    method: 'POST', redirect: 'error', signal: options.signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: Buffer.from(audio).toString('base64'), model: options.model, ...(options.language ? { language: options.language } : {}) }),
  }, request);
  if (!response.ok) throw await providerHttpError('STT', response);
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== 'string' || Buffer.byteLength(result.text) > 60000) throw new VoiceError('STT_INVALID_RESPONSE');
  return result.text.trim();
}

export class PaxaLabsStt extends RecordedStt {
  constructor(id = 'paxalabs', model = 'paxa-stt-lite-v1-preview', request: typeof fetch = fetch) {
    super(id, model, request, transcribePaxa, language => {
      if (!paxaConnection(id).key) throw new VoiceError('STT_CREDENTIALS_MISSING');
      if (language && !['th', 'en'].includes(language)) throw new VoiceError('STT_LANGUAGE_UNSUPPORTED');
    });
  }
}
