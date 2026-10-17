import { ManagedCreditCheck, requireManagedVoiceCredit } from './managed-quota';
import { hasSpokenWords, VoiceError } from './types';
import { describeVoiceError, providerHttpError, voiceProviderRequest } from './errors';
import { canonicalVoiceProvider, nativeVoiceModel } from './providers/model-ref';
import { transcribeOpenRouter } from './providers/openrouter';
import { transcribeGemini } from './providers/gemini';
import { transcribePaxa } from './providers/paxalabs-stt';
import { upstreamVoiceConnection } from './providers/upstream';
import { readFile, stat } from 'fs/promises';
import { basename } from 'path';
import { OrchestrationError } from '../orchestration/types';

/** Delays before the 2nd and 3rd transcription attempt, and the time all attempts may take. */
export const TRANSCRIPTION_RETRY_DELAYS_MS = [1000, 3000];
const TRANSCRIPTION_ATTEMPT_TIMEOUT_MS = 60000, TRANSCRIPTION_BUDGET_MS = 120000;
export type VoiceNoteDiagnostic =
  | (ManagedCreditCheck & { stage: 'usage_check' })
  | { stage: 'transcription'; outcome: 'retry' | 'failed'; code: string; attempt: number; elapsedMs: number; httpStatus?: number };
export interface VoiceNoteOptions { provider: string; model: string; language?: string; retryDelaysMs?: number[]; sleep?: (ms: number) => Promise<void>; onDiagnostic?: (event: VoiceNoteDiagnostic) => void }

/** A transcription failure worth another attempt: no answer in time, no connection, a server
 * error, a plain rate limit, or no words for audio that the same provider usually transcribes on
 * the next attempt. Auth, payment, quota, format and other client errors are final. */
export function retryableTranscriptionError(code: string): boolean {
  if (code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_CONNECTION_FAILED' || code === 'VOICE_NOTE_NO_TRANSCRIPT') return true;
  const match = /_HTTP_(\d{3})(?:_REASON_([A-Z_]+))?$/.exec(code);
  if (!match) return false;
  const status = Number(match[1]), reason = match[2];
  if (status === 429) return !reason || reason === 'RATE_LIMIT';
  return (status >= 500 || status === 408) && (!reason || reason === 'UNAVAILABLE' || reason === 'TIMEOUT');
}

/** Uploaded voice notes use the file API, not a realtime PCM socket. */
export async function transcribeVoiceNote(path: string, options: VoiceNoteOptions, request: typeof fetch = fetch): Promise<string> {
  options = { ...options, provider: canonicalVoiceProvider(options.provider), model: nativeVoiceModel(options.provider, options.model) };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  await requireManagedVoiceCredit(options.provider, request, undefined, { sleep, ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}) });
  const delays = options.retryDelaysMs ?? TRANSCRIPTION_RETRY_DELAYS_MS, started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const remaining = TRANSCRIPTION_BUDGET_MS - (Date.now() - started);
    try { return await transcribeOnce(path, options, request, AbortSignal.timeout(Math.max(1, Math.min(TRANSCRIPTION_ATTEMPT_TIMEOUT_MS, remaining)))); }
    catch (error) {
      const code = error instanceof VoiceError || error instanceof OrchestrationError ? error.code : '';
      const delay = delays[attempt - 1];
      const retry = retryableTranscriptionError(code) && delay !== undefined && Date.now() - started + delay < TRANSCRIPTION_BUDGET_MS;
      const httpStatus = Number(/_HTTP_(\d{3})/.exec(code)?.[1]) || undefined;
      options.onDiagnostic?.({ stage: 'transcription', outcome: retry ? 'retry' : 'failed', code: code || 'VOICE_NOTE_STT_FAILED', attempt, elapsedMs: Date.now() - started, ...(httpStatus ? { httpStatus } : {}) });
      if (!retry) throw error;
      await sleep(delay);
    }
  }
}

async function transcribeOnce(path: string, options: VoiceNoteOptions, request: typeof fetch, signal: AbortSignal): Promise<string> {
  if (['paxalabs', 'upstream:paxalabs', 'managed:paxalabs', 'gemini', 'upstream:gemini', 'openrouter', 'upstream:openrouter'].includes(options.provider)) {
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.size > 25 * 1024 * 1024) throw new OrchestrationError('VOICE_NOTE_SIZE_LIMIT');
    const text = await (options.provider.includes('gemini') ? transcribeGemini : options.provider.includes('openrouter') ? transcribeOpenRouter : transcribePaxa)(await readFile(path), { ...options, signal }, request);
    if (!hasSpokenWords(text)) throw new OrchestrationError('VOICE_NOTE_NO_TRANSCRIPT');
    return text.trim();
  }
  if (!['elevenlabs','upstream:elevenlabs','managed:elevenlabs'].includes(options.provider)) throw new OrchestrationError('VOICE_NOTE_PROVIDER_UNSUPPORTED');
  const upstream = options.provider === 'managed:elevenlabs' ? upstreamVoiceConnection('elevenlabs', true) : options.provider === 'upstream:elevenlabs' ? upstreamVoiceConnection() : undefined;
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
    method: 'POST', headers: upstream ? { Authorization: `Bearer ${key}` } : { 'xi-api-key': key }, body: data, signal, redirect: 'error',
  }, request);
  if (!response.ok) throw await providerHttpError('STT', response);
  const result = await response.json() as { text?: unknown };
  // A malformed or oversized body is not "no words": retrying it would only repeat the same answer.
  if (typeof result.text !== 'string' || Buffer.byteLength(result.text) > 60000) throw new VoiceError('STT_INVALID_RESPONSE');
  if (!hasSpokenWords(result.text)) throw new OrchestrationError('VOICE_NOTE_NO_TRANSCRIPT');
  return result.text.trim();
}

/** A stored voice-note failure that a retry from the kept audio can fix: the provider or the
 * credit check could not finish, the run was interrupted, or no words were recognized. Missing
 * credit, auth and format failures are final. */
export function retryableVoiceNoteFailure(code: string): boolean {
  if (code === 'VOICE_NOTE_INTERRUPTED' || code === 'VOICE_NOTE_STT_FAILED') return true;
  const diagnostic = describeVoiceError(code);
  return diagnostic.retryable || diagnostic.category === 'quota_or_rate_limit';
}

/** Keep provider diagnostics consistent across chat channels and browser voice. */
export function voiceNoteFailureMessage(code: string): string {
  const local: Record<string, string> = {
    VOICE_NOTE_NO_TRANSCRIPT: 'No words could be recognized in the voice note. Please try again, record it again or type your message.',
    VOICE_NOTE_SIZE_LIMIT: 'The voice note is empty or exceeds the provider file size limit. Please send a shorter recording.',
    VOICE_NOTES_DISABLED: 'Voice message transcription is disabled for this agent.',
    VOICE_NOTE_ATTACHMENT_MISSING: 'The voice note attachment is missing. Please resend it or type your message.',
    VOICE_NOTE_PROVIDER_UNSUPPORTED: 'The selected provider does not support voice message transcription. Check the voice message STT settings.',
    VOICE_NOTE_INTERRUPTED: 'Voice note transcription was interrupted. Please resend it or type your message.',
  };
  if (Object.prototype.hasOwnProperty.call(local, code)) return local[code];
  return `Voice note could not be transcribed. ${describeVoiceError(code).message}`;
}
