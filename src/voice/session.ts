import { pcmToWav } from './wav';
import { resolveVoiceId } from './providers/voice-catalog';
import { randomUUID } from 'crypto';
import { VoiceTurnManager } from './turn-manager';
import { VoicePlayback } from './playback';
import { SttProvider, SttSession, TtsProvider, PCM16, VoiceError } from './types';
import { VoiceFrame, encodeVoiceFrame } from './protocol';

export interface VoiceClient {
  control(message: Record<string, unknown>): void;
  audio(frame: Buffer): void;
  bufferedBytes(): number;
}
export interface VoiceSessionOptions { silenceCommitMs: number; finalizationTimeoutMs: number; maxUtteranceMs: number; maxBufferedAudioMs: number; language?: string; mergeWindowMs?: number; }
export class VoiceSession {
  readonly playback = new VoicePlayback();
  private readonly controller = new AbortController();
  private turn?: VoiceTurnManager;
  private sttSession?: SttSession;
  private finalizing = false;
  private pendingCommit?: Promise<void>;
  private closed = false;
  private speaking = false;
  private muted = false;
  private playingResponseId?: string;
  private interruption = 0;
  private speechQueue: Promise<void> = Promise.resolve();
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private admissionTimer?: ReturnType<typeof setTimeout>;
  private pendingText: Array<{ text: string; utteranceId: string }> = [];
  /** Speech candidates defer admission; only confirmed words interrupt inference. */
  speechActivity(): void {
    if (this.closed) return;
    this.speaking = true;
    clearTimeout(this.admissionTimer);
  }
  private scheduleAdmission(): void {
    clearTimeout(this.admissionTimer);
    if (!this.pendingText.length || this.closed || this.speaking) return;
    this.admissionTimer = setTimeout(() => { void this.flushPending().catch(error => this.error(error.code ?? 'CONVERSATION_FAILED')); }, this.options.mergeWindowMs ?? 0);
  }
  private async flushPending(): Promise<void> {
    clearTimeout(this.admissionTimer);
    if (!this.pendingText.length || this.closed) return;
    const parts = this.pendingText.splice(0);
    await this.admit(parts.map(p => p.text).join(' '), parts[0].utteranceId);
  }
  private readonly responses = new Set<Promise<void>>();
  setVoice(voiceId: string): void { this.voiceId = voiceId; }
  constructor(private readonly stt: SttProvider, private readonly tts: TtsProvider, private voiceId: string,
    private readonly client: VoiceClient,
    private readonly submit: (text: string, utteranceId: string) => Promise<{ inputId: string; response: Promise<string>; stream?: AsyncIterable<{ responseId: string; text: string }>; responseId?(): string | undefined }>,
    private readonly stopResponse: () => void,
    private readonly options: VoiceSessionOptions = { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500 },
    private readonly record?: (responseId: string, progress: ReturnType<VoicePlayback['snapshot']>, state: string) => void,
    private readonly saveAudio?: (responseId: string, audio: Buffer) => void) {}
  async start(): Promise<void> {
    if (this.closed || this.turn) throw new VoiceError('VOICE_ALREADY_STARTED');
    if (!this.sttSession) {
      const stt = await this.stt.open({ format: PCM16, language: this.options.language || undefined, signal: this.controller.signal });
      if (this.closed) { await stt.close(); return; }
      this.sttSession = stt;
      void (async () => {
        try {
          for await (const event of stt.events) {
            if (this.closed || this.sttSession !== stt) break;
            const turn = this.turn;
            if (!turn) continue;
            turn.event(event);
            if (event.type === 'partial') this.client.control({ type: 'stt.partial', utterance_id: turn.utteranceId, text: event.text });
            else if (event.type === 'error') this.error(event.code);
          }
        } catch (error) { if (!this.closed && this.sttSession === stt) this.error(error instanceof VoiceError ? error.code : 'STT_PROVIDER_ERROR'); }
      })();
    }
    const turn = new VoiceTurnManager(this.sttSession, 16000, Math.max(this.options.finalizationTimeoutMs, this.stt.capabilities.finalizationTimeoutMs ?? 0), this.options.maxUtteranceMs);
    this.turn = turn;
    this.client.control({ type: 'voice.state', state: 'listening', stt_mode: this.stt.capabilities.mode ?? 'realtime', generation: this.playback.generation, epoch: this.playback.epoch, utterance_id: turn.utteranceId, format: PCM16 });
  }
  async audio(frame: VoiceFrame): Promise<void> {
    if (frame.generation !== this.playback.generation) return;
    if (this.closed || this.muted || !this.turn || frame.segmentId !== this.turn.utteranceId) throw new VoiceError('INVALID_UTTERANCE');
    await this.turn.pushAudio(frame.sequence, frame.audio);
  }
  speechStarted(epoch: number): void {
    if (this.closed) return;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 0xffffffff) throw new VoiceError('INVALID_EPOCH');
    if (epoch <= this.playback.epoch) return;
    clearTimeout(this.silenceTimer); clearTimeout(this.admissionTimer); this.speaking = true; this.interruption++;
    const previous = this.playback.epoch;
    this.recordPlayback('interrupted');
    this.playingResponseId = undefined;
    const current = this.playback.clear(epoch);
    this.client.control({ type: 'playback.clear', epoch: current, generation: this.playback.generation });
    if (current > previous) this.stopResponse();
  }
  speechEnded(lastAudioSeq: number): void {
    if (!Number.isSafeInteger(lastAudioSeq) || lastAudioSeq < 0) throw new VoiceError('INVALID_AUDIO_SEQUENCE');
    this.speaking = false; clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => { void this.commit(lastAudioSeq).catch(error => this.error(error.code ?? 'VOICE_ERROR')); }, this.options.silenceCommitMs);
  }
  async commit(lastAudioSeq: number, flush = false): Promise<void> {
    if (this.pendingCommit) {
      await this.pendingCommit;
      if (flush) await this.flushPending();
      return;
    }
    const pending = this.commitTurn(lastAudioSeq, flush);
    this.pendingCommit = pending;
    try { await pending; } finally { if (this.pendingCommit === pending) this.pendingCommit = undefined; }
  }
  private async commitTurn(lastAudioSeq: number, flush: boolean): Promise<void> {
    if (this.finalizing || !this.turn || this.closed) return;
    this.finalizing = true; this.speaking = false; clearTimeout(this.silenceTimer);
    const turn = this.turn;
    try {
      const text = await turn.commit(lastAudioSeq);
      if (this.closed) return;
      // Some providers deliver no partial words. A confirmed continuation still
      // supersedes the previous reply before this text is admitted. Tasks survive.
      if (this.responses.size) { this.speechStarted(this.playback.epoch + 1); this.speaking = false; }
      if (this.options.mergeWindowMs) {
        if (this.pendingText.reduce((n, p) => n + p.text.length, text.length) > 65536) throw new VoiceError('TRANSCRIPT_TOO_LARGE');
        this.pendingText.push({ text, utteranceId: turn.utteranceId });
        this.client.control({ type: 'stt.segment', utterance_id: turn.utteranceId, text, pending_text: this.pendingText.map(p => p.text).join(' ') });
        if (flush) await this.flushPending();
      } else await this.admit(text, turn.utteranceId);
    } finally {
      await turn.close(false); if (this.turn === turn) this.turn = undefined; this.finalizing = false;
      if (!this.closed && !this.muted) await this.start();
      this.scheduleAdmission();
    }
  }
  private async admit(text: string, utteranceId: string): Promise<void> {
    this.client.control({ type: 'stt.final', utterance_id: utteranceId, text });
    const accepted = await this.submit(text, utteranceId);
    this.client.control({ type: 'utterance.accepted', utterance_id: utteranceId, input_id: accepted.inputId });
    const epoch = this.interruption;
    const streaming = accepted.stream ? this.speakStream(accepted.stream, epoch, accepted.response) : undefined;
    const response = accepted.response.then(async answer => {
      if (this.closed || epoch !== this.interruption) return;
      if (streaming) { this.client.control({ type: 'response.text', input_id: accepted.inputId, response_id: accepted.responseId?.(), text: answer, final: true }); await streaming; }
      else this.client.control({ type: 'response.text', input_id: accepted.inputId, response_id: accepted.responseId?.(), text: answer, final: true });
    }).catch(error => this.error(error.code ?? 'CONVERSATION_FAILED'));
    void streaming?.catch(() => {}); // response chain reports the original failure once
    this.responses.add(response); void response.finally(() => this.responses.delete(response));
  }
  private async speakStream(stream: AsyncIterable<{ responseId: string; text: string }>, epoch: number, response: Promise<string>): Promise<void> {
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (this.closed) return;
    if (first.done) { await response; if (!this.closed && epoch === this.interruption) this.speechUnavailable(); return; }
    const client = this.client;
    async function* source() {
      let chunk = first;
      while (!chunk.done) {
        client.control({ type: 'response.speech', response_id: chunk.value.responseId, text: chunk.value.text });
        yield chunk.value.text;
        chunk = await iterator.next();
      }
    }
    try { await this.enqueueSpeech(source(), first.value.responseId, epoch); }
    finally { await iterator.return?.(); }
  }
  /** Only approved summaries from authenticated automatic task reports enter here. */
  notifyResult(result: { responseId: string; text: string; spoken: string; requestId?: string; speechOnly?: boolean }): void {
    if (this.closed) return;
    if (!result.speechOnly) this.client.control({ type: 'response.text', response_id: result.responseId, request_id: result.requestId, text: result.text, final: true });
    if (!result.spoken) { this.speechUnavailable(); return; }
    const client = this.client;
    void this.enqueueSpeech((async function* () {
      client.control({ type: 'response.speech', response_id: result.responseId, request_id: result.requestId, text: result.spoken });
      yield result.spoken;
    })(), result.responseId);
  }
  private enqueueSpeech(text: AsyncIterable<string>, responseId?: string, interruption = this.interruption): Promise<void> {
    const queued = this.speechQueue.then(async () => {
      if (this.closed || interruption !== this.interruption) return;
      while (!this.closed && interruption === this.interruption && (this.speaking || this.finalizing || this.pendingText.length)) await new Promise(resolve => setTimeout(resolve, 10));
      if (this.closed || interruption !== this.interruption) return;
      await this.speak(text, this.playback.epoch, responseId);
      // Synthesis completion is not playback completion. Preserve the tail before
      // the next utterance clears the playback epoch.
      const epoch = this.playback.epoch, deadline = Date.now() + 10000;
      while (!this.closed && interruption === this.interruption && epoch === this.playback.epoch) {
        const progress = this.playback.snapshot();
        if (progress.playedSamples >= progress.generatedSamples) break;
        if (Date.now() > deadline) { this.error('CLIENT_TOO_SLOW'); break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    this.speechQueue = queued.catch(() => { this.error('TTS_UNAVAILABLE'); });
    return this.speechQueue;
  }
  private async speak(spokenText: AsyncIterable<string>, expectedEpoch: number, responseId?: string): Promise<void> {
    if (this.closed) return;
    if (this.speaking || expectedEpoch !== this.playback.epoch) return;
    const epoch = this.playback.clear(), segmentId = randomUUID();
    let voiceId = this.voiceId;
    if (!voiceId.trim()) {
      try { voiceId = await resolveVoiceId({provider: this.tts.id, voiceId}); }
      catch { this.error('TTS_UNAVAILABLE'); return; }
      if (this.closed || epoch !== this.playback.epoch) return;
      // A user may have configured a voice while catalog lookup was in flight.
      voiceId = this.voiceId || voiceId;
      this.voiceId = voiceId;
    }
    this.playingResponseId = responseId;
    this.recordPlayback('streaming');
    this.client.control({ type: 'playback.start', voice_id: voiceId, phase: responseId ? 'response' : 'acknowledgement', response_id: responseId, segment_id: segmentId, epoch, generation: this.playback.generation, format: PCM16 });
    try {
      const recording: Buffer[] = []; let recordedBytes = 0; let recordable = true;
      let sequence = 0;
      let providerSequence = 0;
      const signal = this.playback.signal;
      // The recognition hint belongs to microphone input. Let TTS follow the
      // approved response text, which can intentionally use another language.
      for await (const chunk of this.tts.synthesize({ text: spokenText, voiceId, outputFormat: PCM16, signal: this.playback.signal })) {
        if (this.closed || epoch !== this.playback.epoch || signal.aborted) break;
        if (chunk.chunkSeq !== providerSequence++ || chunk.format.encoding !== PCM16.encoding || chunk.format.sampleRate !== PCM16.sampleRate || chunk.format.channels !== 1) throw new VoiceError('INVALID_AUDIO_CHUNK');
        if (chunk.bytes.length % 2) throw new VoiceError('INVALID_AUDIO_CHUNK');
        // Provider chunk sizes are unrelated to our wire chunks. Bound playback
        // by acknowledged sample offsets as well as the socket's byte queue.
        const bytesPerFrame = Math.min(3200, Math.max(2, Math.floor(this.options.maxBufferedAudioMs * 16) * 2));
        for (let offset = 0; offset < chunk.bytes.length; offset += bytesPerFrame) {
          const bytes = chunk.bytes.subarray(offset, offset + bytesPerFrame);
          const deadline = Date.now() + 10000;
          while (!signal.aborted && epoch === this.playback.epoch) {
            const progress = this.playback.snapshot();
            if (progress.generatedSamples - progress.playedSamples + bytes.length / 2 <= this.options.maxBufferedAudioMs * 16 && this.client.bufferedBytes() <= this.options.maxBufferedAudioMs * 32) break;
            if (Date.now() > deadline) throw new VoiceError('CLIENT_TOO_SLOW');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          if (signal.aborted || this.closed || epoch !== this.playback.epoch) break;
          if (!this.playback.accept(epoch, { ...chunk, chunkSeq: sequence, bytes })) break;
          if (this.saveAudio && responseId && recordable) {
            recordedBytes += bytes.length;
            if (recordedBytes <= 16 * 1024 * 1024 - 44) recording.push(Buffer.from(bytes));
            else { recording.length = 0; recordable = false; }
          }
          this.client.audio(encodeVoiceFrame({ generation: this.playback.generation, epoch, sequence: sequence++, segmentId, audio: bytes }));
        }
      }
      if (!signal.aborted && epoch === this.playback.epoch) {
        if (this.saveAudio && responseId && recordable && recordedBytes) {
          try { this.saveAudio(responseId, pcmToWav(Buffer.concat(recording))); } catch { /* Playback remains usable if storage is full. */ }
        }
        this.recordPlayback('streamed'); this.client.control({ type: 'playback.end', response_id: responseId, epoch, generated_samples: this.playback.snapshot().generatedSamples }); }
    } catch (error) { if (!this.closed && epoch === this.playback.epoch) this.error(error instanceof VoiceError ? error.code : 'TTS_UNAVAILABLE'); }
  }
  progress(epoch: number, sampleOffset: number): void { this.playback.progress(epoch, sampleOffset); if (epoch === this.playback.epoch) this.recordPlayback('playback_progress'); }
  private recordPlayback(state: string): void { if (this.playingResponseId) this.record?.(this.playingResponseId, this.playback.snapshot(), state); }
  async mute(muted: boolean, policy: 'discard' | 'commit', lastAudioSeq?: number): Promise<void> {
    this.muted = muted;
    try {
      if (muted) {
        if (policy === 'commit') {
          try {
            // Join an automatic commit already in flight; never close its STT socket.
            if (this.pendingCommit) await this.commit(lastAudioSeq ?? 0, true);
            else if (lastAudioSeq !== undefined && lastAudioSeq > 0) await this.commit(lastAudioSeq, true);
          } finally {
            this.speaking = false;
            await this.turn?.close(false); this.turn = undefined;
            await this.flushPending();
          }
        } else {
          await this.turn?.close(false); this.turn = undefined;
          const stt = this.sttSession; this.sttSession = undefined; await stt?.close();
          this.speaking = false; this.scheduleAdmission();
        }
      } else if (!this.turn) await this.start();
    } finally {
      this.client.control({ type: 'voice.state', state: muted ? 'muted' : 'listening' });
    }
  }
  private speechUnavailable(): void { if (!this.closed) this.client.control({ type: 'voice.notice', code: 'SPEECH_SUMMARY_UNAVAILABLE' }); }
  private error(code: string): void { if (!this.closed) this.client.control({ type: 'voice.error', code }); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.recordPlayback('detached');
    this.closed = true; clearTimeout(this.silenceTimer); clearTimeout(this.admissionTimer); this.pendingText = []; this.controller.abort(); this.playback.close();
    await this.turn?.close(false); this.turn = undefined; const stt = this.sttSession; this.sttSession = undefined; await stt?.close();
    // Detaching voice playback does not cancel committed tasks or responses.
  }
}
