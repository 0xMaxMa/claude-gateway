import { AudioFormat, PCM16, SttEvent, SttProvider, SttSession, TtsProvider } from '../types';
import { BoundedQueue } from '../queue';

export class FakeSttSession implements SttSession {
  readonly events = new BoundedQueue<SttEvent>(65536, item => JSON.stringify(item).length);
  readonly frames: Uint8Array[] = [];
  commitId?: string;
  async pushAudio(frame: Uint8Array): Promise<void> { this.frames.push(frame.slice()); }
  async commitSegment(commitId: string): Promise<void> { this.commitId = commitId; }
  emit(event: SttEvent): void { this.events.push(event); }
  async close(): Promise<void> { this.events.close(); }
}
export class FakeSttProvider implements SttProvider {
  readonly id = 'fake';
  readonly capabilities = { partials: true, manualCommit: true, speechActivityEvents: true };
  readonly sessions: FakeSttSession[] = [];
  async open(): Promise<FakeSttSession> { const session = new FakeSttSession(); this.sessions.push(session); return session; }
}
export class FakeTtsProvider implements TtsProvider {
  readonly id = 'fake';
  readonly capabilities = { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] };
  async *synthesize(options: { text: AsyncIterable<string>; outputFormat: AudioFormat; signal: AbortSignal }) {
    let chunkSeq = 0;
    for await (const _text of options.text) {
      if (options.signal.aborted) return;
      yield { bytes: new Uint8Array(640), format: options.outputFormat, chunkSeq: chunkSeq++ };
    }
  }
}
