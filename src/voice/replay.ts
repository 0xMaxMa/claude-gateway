import { PCM16, TtsProvider, VoiceError } from './types';
import { pcmToWav } from './wav';

/** Bounded, shared synthesis for explicit replay requests, independent of a microphone lease. */
export class VoiceReplays {
  private readonly pending = new Map<string, { result: Promise<Buffer>; controller: AbortController }>();
  generate(key: string, provider: TtsProvider, voiceId: string, text: string): Promise<Buffer> {
    const existing = this.pending.get(key);
    if (existing) return existing.result;
    if (this.pending.size >= 4) return Promise.reject(new VoiceError('VOICE_REPLAY_BUSY'));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const result = (async () => {
      const chunks: Buffer[] = []; let size = 0, sequence = 0;
      for await (const chunk of provider.synthesize({ text: (async function* () { yield text; })(), voiceId, outputFormat: PCM16, signal: controller.signal })) {
        if (controller.signal.aborted) throw new VoiceError('TTS_UNAVAILABLE');
        if (chunk.chunkSeq !== sequence++ || chunk.format.encoding !== PCM16.encoding || chunk.format.sampleRate !== PCM16.sampleRate || chunk.format.channels !== 1 || chunk.bytes.length % 2) throw new VoiceError('INVALID_AUDIO_CHUNK');
        size += chunk.bytes.length;
        if (size > 16 * 1024 * 1024 - 44) { controller.abort(); throw new VoiceError('VOICE_REPLAY_TOO_LARGE'); }
        chunks.push(Buffer.from(chunk.bytes));
      }
      if (!size || controller.signal.aborted) throw new VoiceError('TTS_UNAVAILABLE');
      return pcmToWav(Buffer.concat(chunks));
    })();
    // A provider must not leave the HTTP request hanging if it ignores cancellation.
    const aborted = new Promise<Buffer>((_, reject) => controller.signal.addEventListener('abort', () => reject(new VoiceError('TTS_UNAVAILABLE')), { once: true }));
    const bounded = Promise.race([result, aborted]).finally(() => { clearTimeout(timer); this.pending.delete(key); });
    this.pending.set(key, { result: bounded, controller });
    return bounded;
  }
  close(): void { for (const job of this.pending.values()) job.controller.abort(); }
}
