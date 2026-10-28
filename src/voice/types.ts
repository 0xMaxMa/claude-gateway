export interface AudioFormat { encoding: 'pcm_s16le'; sampleRate: number; channels: 1; }
export type SttEvent =
  | { type: 'partial' | 'segment_final'; segmentId: string; text: string }
  | { type: 'speech_start' | 'speech_end'; atMs: number }
  | { type: 'commit_done'; commitId: string }
  | { type: 'error'; code: string; retryable: boolean };
export interface SttSession {
  pushAudio(frame: Uint8Array): Promise<void>;
  commitSegment(commitId: string): Promise<void>;
  events: AsyncIterable<SttEvent>;
  close(): Promise<void>;
}
export interface SttProvider {
  readonly id: string;
  readonly capabilities: { partials: boolean; manualCommit: boolean; speechActivityEvents: boolean; mode?: 'realtime' | 'batch'; finalizationTimeoutMs?: number };
  open(options: { format: AudioFormat; language?: string; signal: AbortSignal }): Promise<SttSession>;
}
export interface TtsAudioChunk { bytes: Uint8Array; format: AudioFormat; chunkSeq: number; textEndOffset?: number; }
export interface TtsProvider {
  readonly id: string;
  readonly capabilities: { textStreaming: boolean; wordAlignment: boolean; outputFormats: AudioFormat[] };
  synthesizeFile?(options: { text: string; voiceId: string; signal: AbortSignal }): Promise<{ bytes: Uint8Array; mime: 'audio/mpeg'; name: string }>;
  synthesize(options: { text: AsyncIterable<string>; voiceId: string; language?: string; outputFormat: AudioFormat; signal: AbortSignal }): AsyncIterable<TtsAudioChunk>;
}
export class VoiceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'VoiceError'; }
}
/** Whether a transcript holds any spoken word. Providers sometimes return only punctuation such
 * as "." or "…" for clear speech, which carries nothing for the agent to answer. */
export function hasSpokenWords(text: string): boolean { return /[\p{L}\p{N}]/u.test(text); }
export const PCM16: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 };
export function validateAudioFormat(format: AudioFormat): void {
  if (format.encoding !== 'pcm_s16le' || format.channels !== 1 || ![8000, 16000, 22050, 24000, 44100, 48000].includes(format.sampleRate)) throw new VoiceError('UNSUPPORTED_AUDIO_FORMAT');
}

/** The `/call` page's acoustic tuning for endpointing. These are microphone-level heuristics,
 * not protocol timing: the server then waits `voice.turns.silenceCommitMs`
 * (0 commits at once) after `speech.ended` before it commits an utterance. Levels are RMS of
 * float samples in [-1, 1]. */
export const VOICE_CALL_VAD = { startMs: 120, endMs: 350, ratio: 3, minLevel: 0.012, initialNoise: 0.004, noiseAdapt: 0.05, bargeInRatio: 2, bargeInMs: 250 };
