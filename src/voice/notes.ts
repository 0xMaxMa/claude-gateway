import { describeVoiceError, providerHttpError, voiceProviderRequest } from './errors';
import { nativeVoiceModel } from './providers/model-ref';
import { transcribeGemini } from './providers/gemini';
import { transcribePaxa } from './providers/paxalabs-stt';
import { upstreamVoiceConnection } from './providers/upstream';
import { readFile, stat } from 'fs/promises';
import { basename } from 'path';
import { OrchestrationError } from '../orchestration/types';

/** Uploaded voice notes use the file API, not a realtime PCM socket. */
export async function transcribeVoiceNote(path: string, options: { provider: string; model: string; language?: string }, request: typeof fetch = fetch): Promise<string> {
  options = { ...options, model: nativeVoiceModel(options.provider, options.model) };
  if (['paxalabs', 'upstream:paxalabs', 'gemini', 'upstream:gemini'].includes(options.provider)) {
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.size > 25 * 1024 * 1024) throw new OrchestrationError('VOICE_NOTE_SIZE_LIMIT');
    const text = await (options.provider.includes('gemini') ? transcribeGemini : transcribePaxa)(await readFile(path), { ...options, signal: AbortSignal.timeout(60000) }, request);
    if (!text) throw new OrchestrationError('VOICE_NOTE_NO_TRANSCRIPT');
    return text;
  }
  if (!['elevenlabs','upstream'].includes(options.provider)) throw new OrchestrationError('VOICE_NOTE_PROVIDER_UNSUPPORTED');
  const upstream = options.provider === 'upstream' ? upstreamVoiceConnection() : undefined;
  const key = upstream?.key || process.env.ELEVENLABS_API_KEY;
  if (!key) throw new OrchestrationError('STT_CREDENTIALS_MISSING');
  const info = await stat(path);
  if (!info.isFile() || !info.size || info.size > 20 * 1024 * 1024) throw new OrchestrationError('VOICE_NOTE_SIZE_LIMIT');
  const data = new FormData();
  data.set('model_id', options.model);
  data.set('file', new Blob([new Uint8Array(await readFile(path))]), basename(path));
  data.set('tag_audio_events', 'false'); data.set('diarize', 'false');
  if (options.language) data.set('language_code', options.language);
  const response = await voiceProviderRequest(upstream ? new URL('speech-to-text', upstream.base).toString() : 'https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: upstream ? { Authorization: `Bearer ${key}` } : { 'xi-api-key': key }, body: data, signal: AbortSignal.timeout(60000), redirect: 'error',
  }, request);
  if (!response.ok) throw await providerHttpError('STT', response);
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== 'string' || !result.text.trim() || Buffer.byteLength(result.text) > 60000) throw new OrchestrationError('VOICE_NOTE_NO_TRANSCRIPT');
  return result.text.trim();
}

/** Keep provider diagnostics consistent across chat channels and browser voice. */
export function voiceNoteFailureMessage(code: string): string {
  const local: Record<string, string> = {
    VOICE_NOTE_NO_TRANSCRIPT: 'No speech was detected in the voice note. Please record it again or type your message.',
    VOICE_NOTE_SIZE_LIMIT: 'The voice note is empty or exceeds the provider file size limit. Please send a shorter recording.',
    VOICE_NOTES_DISABLED: 'Voice message transcription is disabled for this agent.',
    VOICE_NOTE_ATTACHMENT_MISSING: 'The voice note attachment is missing. Please resend it or type your message.',
    VOICE_NOTE_PROVIDER_UNSUPPORTED: 'The selected provider does not support voice message transcription. Check the voice message STT settings.',
    VOICE_NOTE_INTERRUPTED: 'Voice note transcription was interrupted. Please resend it or type your message.',
  };
  if (Object.prototype.hasOwnProperty.call(local, code)) return local[code];
  return `Voice note could not be transcribed. ${describeVoiceError(code).message}`;
}
