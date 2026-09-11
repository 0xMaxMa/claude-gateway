import { randomUUID } from 'crypto';
import { TtsAudioChunk, VoiceError } from './types';

export class VoicePlayback {
  readonly generation = randomUUID();
  private epochValue = 0;
  private controller = new AbortController();
  private sentSamples = 0;
  private playedSamples = 0;
  private lastChunkSeq = -1;
  get epoch(): number { return this.epochValue; }
  get signal(): AbortSignal { return this.controller.signal; }
  clear(incomingEpoch = this.epochValue + 1): number {
    if (!Number.isSafeInteger(incomingEpoch) || incomingEpoch < 0 || incomingEpoch > 0xffffffff) throw new VoiceError('INVALID_EPOCH');
    if (incomingEpoch <= this.epochValue) return this.epochValue;
    this.controller.abort(); this.controller = new AbortController();
    this.epochValue = incomingEpoch; this.sentSamples = 0; this.playedSamples = 0; this.lastChunkSeq = -1;
    return this.epochValue;
  }
  accept(epoch: number, chunk: TtsAudioChunk): boolean {
    if (epoch !== this.epochValue) return false;
    if (chunk.chunkSeq !== this.lastChunkSeq + 1 || chunk.bytes.length % 2) throw new VoiceError('INVALID_AUDIO_CHUNK');
    this.lastChunkSeq = chunk.chunkSeq; this.sentSamples += chunk.bytes.length / 2;
    return true;
  }
  progress(epoch: number, samples: number): void {
    if (epoch !== this.epochValue) return;
    if (!Number.isSafeInteger(samples) || samples < this.playedSamples || samples > this.sentSamples) throw new VoiceError('INVALID_PLAYBACK_PROGRESS');
    this.playedSamples = samples;
  }
  snapshot(): { generation: string; epoch: number; generatedSamples: number; playedSamples: number } {
    return { generation: this.generation, epoch: this.epochValue, generatedSamples: this.sentSamples, playedSamples: this.playedSamples };
  }
  close(): void { this.controller.abort(); }
}
