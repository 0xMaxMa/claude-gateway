import { randomUUID } from 'crypto';
import { SttEvent, SttSession, VoiceError } from './types';

/** An STT final segment is not a complete utterance. Acceptance waits for both
 * the audio sequence boundary and the provider's normalized finalization ack. */
export class VoiceTurnManager {
  readonly utteranceId = randomUUID();
  private lastAudioSeq = 0;
  private readonly finals = new Map<string, string>();
  private state: 'listening' | 'finalizing' | 'accepted' | 'closed' = 'listening';
  private commitId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private resolveCommit?: (text: string) => void;
  private rejectCommit?: (error: Error) => void;
  private commitResult?: Promise<string>;
  private durationSamples = 0;
  private inFlight: Promise<void> = Promise.resolve();
  constructor(private readonly stt: SttSession, private readonly sampleRate: number, private readonly timeoutMs = 5000, private readonly maxUtteranceMs = 60000) {}
  pushAudio(sequence: number, bytes: Uint8Array): Promise<void> {
    if (this.state !== 'listening') return Promise.reject(new VoiceError('UTTERANCE_FINALIZING'));
    if (sequence !== this.lastAudioSeq + 1 || !bytes.length || bytes.length % 2 || bytes.length > this.sampleRate * 2) return Promise.reject(new VoiceError('INVALID_AUDIO_FRAME'));
    if ((this.durationSamples + bytes.length / 2) / this.sampleRate * 1000 > this.maxUtteranceMs) return Promise.reject(new VoiceError('UTTERANCE_TOO_LONG'));
    this.lastAudioSeq = sequence; this.durationSamples += bytes.length / 2;
    this.inFlight = this.inFlight.then(() => this.stt.pushAudio(bytes));
    return this.inFlight;
  }
  commit(lastAudioSeq: number): Promise<string> {
    if (this.commitResult) return this.commitResult;
    if (this.state !== 'listening' || lastAudioSeq !== this.lastAudioSeq || !lastAudioSeq) return Promise.reject(new VoiceError('AUDIO_BOUNDARY_MISMATCH'));
    this.state = 'finalizing'; this.commitId = randomUUID();
    this.commitResult = new Promise<string>((resolve, reject) => { this.resolveCommit = resolve; this.rejectCommit = reject; });
    this.timer = setTimeout(() => this.fail(new VoiceError('TRANSCRIPTION_INCOMPLETE')), this.timeoutMs);
    void this.inFlight.then(() => this.stt.commitSegment(this.commitId!)).catch(error => this.fail(error));
    return this.commitResult;
  }
  event(event: SttEvent): void {
    if (this.state === 'closed' || this.state === 'accepted') return;
    if (event.type === 'segment_final') {
      if (this.finals.size >= 256 && !this.finals.has(event.segmentId)) { this.fail(new VoiceError('TRANSCRIPT_TOO_LARGE')); return; }
      this.finals.set(event.segmentId, event.text);
      if ([...this.finals.values()].join(' ').length > 65536) this.fail(new VoiceError('TRANSCRIPT_TOO_LARGE'));
    } else if (event.type === 'commit_done' && this.state === 'finalizing' && event.commitId === this.commitId) {
      const text = [...this.finals.values()].join(' ').trim();
      if (!text) { this.fail(new VoiceError('EMPTY_TRANSCRIPT')); return; }
      this.state = 'accepted'; clearTimeout(this.timer); this.resolveCommit?.(text);
    } else if (event.type === 'error') this.fail(new VoiceError(event.code));
  }
  private fail(error: Error): void { this.state = 'closed'; clearTimeout(this.timer); this.rejectCommit?.(error); }
  async close(closeProvider = true): Promise<void> { this.fail(new VoiceError('VOICE_CLOSED')); if (closeProvider) await this.stt.close(); }
}
