import { AudioFormat, SttProvider, SttEvent, VoiceError } from '../types';
import { BoundedQueue } from '../queue';
import { pcmToWav } from '../wav';

/** Shared bounded recording/commit lifecycle for file-based STT providers. */
export class RecordedStt implements SttProvider {
  readonly capabilities = { partials: false, manualCommit: true, speechActivityEvents: false, finalizationTimeoutMs: 65000, mode: 'batch' as const };
  constructor(readonly id: string, private readonly model: string, private readonly request: typeof fetch, private readonly transcribe: (audio: Uint8Array, options: { provider: string; model: string; language?: string; signal: AbortSignal }, request: typeof fetch) => Promise<string>, private readonly validate: (language?: string) => void) {}
  async open(options: { format: AudioFormat; language?: string; signal: AbortSignal }) {
    if (options.format.encoding !== 'pcm_s16le' || options.format.channels !== 1 || options.format.sampleRate !== 16000) throw new VoiceError('UNSUPPORTED_AUDIO_FORMAT');
    this.validate(options.language);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, options.signal]);
    const events = new BoundedQueue<SttEvent>(131072, e => JSON.stringify(e).length);
    let frames: Buffer[] = [], size = 0, busy = false, segment = 0;
    const close = () => { frames = []; size = 0; events.close(); };
    signal.addEventListener('abort', close, { once: true });
    return {
      events,
      pushAudio: async (frame: Uint8Array) => {
        signal.throwIfAborted();
        if (size + frame.length > 16000 * 2 * 60) throw new VoiceError('AUDIO_TOO_LARGE');
        frames.push(Buffer.from(frame)); size += frame.length;
      },
      commitSegment: async (commitId: string) => {
        signal.throwIfAborted();
        if (busy) throw new VoiceError('COMMIT_IN_PROGRESS');
        const recording = Buffer.concat(frames); frames = []; size = 0; busy = true;
        try {
          const text = recording.length ? await this.transcribe(pcmToWav(recording), { provider: this.id, model: this.model, language: options.language, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) }, this.request) : '';
          signal.throwIfAborted();
          events.push({ type: 'segment_final', segmentId: String(segment++), text });
          events.push({ type: 'commit_done', commitId });
        } finally { busy = false; }
      },
      close: async () => { abort.abort(); signal.removeEventListener('abort', close); close(); },
    };
  }
}
