import { describeVoiceError } from './errors';
import { voiceTrace, tracedAudio, VoiceDiagnosticSink, VoiceTraceIds } from './diagnostics';
import { pcmToWav } from './wav';
import { resolveVoiceId } from './providers/voice-catalog';
import { randomUUID } from 'crypto';
import { VoiceTurnManager } from './turn-manager';
import { VoicePlayback } from './playback';
import { SttProvider, SttSession, TtsProvider, TtsAudioChunk, PCM16, VoiceError } from './types';
import { VoiceFrame, encodeVoiceFrame } from './protocol';
import { fillerOnly, type FastAckContext } from './fast-ack';

export interface VoiceClient {
  control(message: Record<string, unknown>): void;
  audio(frame: Buffer): void;
  bufferedBytes(): number;
}
/** The `turn` trace of one utterance; its ids fill in as the turn is admitted and answered. */
type TurnTrace = { ids: VoiceTraceIds & { utteranceId: string }; trace: ReturnType<typeof voiceTrace> };
export interface VoiceSessionOptions { silenceCommitMs: number; finalizationTimeoutMs: number; maxUtteranceMs: number; maxBufferedAudioMs: number; language?: string; mergeWindowMs?: number;
  /** A short spoken acknowledgement of the caller's words, played when the reply has not started speaking
   * within fastAckAfterMs of admission. Undefined when no acknowledgement fits. */
  acknowledge?: (transcript: string, signal: AbortSignal, context: FastAckContext) => Promise<string | undefined>; fastAckAfterMs?: number; }
/** Per-turn facts the conversation turn is told. fastAck: a short acknowledgement may play before the reply. */
export interface VoiceTurnHints { fastAck: boolean }
/** Acknowledgements more alike than this (character-bigram Dice) are heard as the same phrase. */
const ACK_SIMILARITY = 0.6;
function bigrams(text: string): string[] {
  const letters = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
  return Array.from({ length: Math.max(0, letters.length - 1) }, (_, i) => letters.slice(i, i + 2));
}
/** An acknowledgement repeats an earlier one when the two are nearly the same phrase and the new
 * one adds nothing from the caller's words: "เดี๋ยวเช็คเมลให้นะคะ" after "เดี๋ยวเช็คปฏิทินให้นะคะ" names a
 * new request, a second "รับทราบค่ะ กำลังดูให้นะคะ" does not. */
function repeats(earlier: string, reply: string, heard: string): boolean {
  const left = bigrams(earlier), right = bigrams(reply);
  if (!left.length || !right.length) return earlier.trim() === reply.trim();
  const pool = new Map<string, number>();
  for (const pair of left) pool.set(pair, (pool.get(pair) ?? 0) + 1);
  const added: string[] = [];
  for (const pair of right) { const n = pool.get(pair); if (n) pool.set(pair, n - 1); else added.push(pair); }
  const caller = new Set(bigrams(heard));
  if (added.filter(pair => caller.has(pair)).length >= 2 || added.some(pair => /\d\d/.test(pair) && caller.has(pair))) return false;
  return 2 * (right.length - added.length) / (left.length + right.length) >= ACK_SIMILARITY;
}
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
  private pausedUntil = 0;
  private playbackTrace?: { epoch: number; firstProgress: boolean; trace: ReturnType<typeof voiceTrace>; turn?: TurnTrace };
  private endpoint?: TurnTrace;
  private readonly claimedSpeech = new Set<string>();
  private completedPlaybackEpoch?: number;
  private muteQueue: Promise<void> = Promise.resolve();
  private speechQueue: Promise<void> = Promise.resolve();
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private admissionTimer?: ReturnType<typeof setTimeout>;
  private pendingText: Array<{ text: string; utteranceId: string; turn: TurnTrace }> = [];
  /** This call's acknowledgement memory: the last caller turns, the acknowledgements actually spoken,
   * and the admitted turn that was last acknowledged. */
  private readonly acks: { turns: string[]; spoken: string[]; admitted: number; lastAcked?: number } = { turns: [], spoken: [], admitted: 0 };
  /** Drops the current turn's acknowledgement if it has not begun playing. */
  private supersedeAck?: () => void;
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
    // The merged turn is answered once the user stops speaking: time it from the last part.
    await this.admit(parts.map(p => p.text).join(' '), parts[0].utteranceId, parts[parts.length - 1].turn);
  }
  private readonly responses = new Set<Promise<void>>();
  setVoice(voiceId: string): void { this.voiceId = voiceId; }
  constructor(private readonly stt: SttProvider, private readonly tts: TtsProvider, private voiceId: string,
    private readonly client: VoiceClient,
    private readonly submit: (text: string, utteranceId: string, mark?: (phase: string) => void, hints?: VoiceTurnHints) => Promise<{ inputId: string; response: Promise<string>; stream?: AsyncIterable<{ responseId: string; text: string }>; responseId?(): string | undefined }>,
    private readonly stopResponse: () => void,
    private readonly options: VoiceSessionOptions = { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500 },
    private readonly record?: (responseId: string, progress: ReturnType<VoicePlayback['snapshot']>, state: string) => void,
    private readonly saveAudio?: (responseId: string, audio: Buffer) => void,
    private readonly diagnostic?: VoiceDiagnosticSink) {}
  async start(): Promise<void> {
    if (this.closed || this.turn) throw new VoiceError('VOICE_ALREADY_STARTED');
    if (!this.sttSession) {
      let stt: SttSession;
      try {
        stt = await this.stt.open({ format: PCM16, language: this.options.language || undefined, signal: this.controller.signal });
      } catch (error) {
        this.failStt(error instanceof VoiceError ? error.code : 'STT_PROVIDER_ERROR');
        return;
      }
      if (this.closed) { await stt.close(); return; }
      this.sttSession = stt;
      void (async () => {
        try {
          for await (const event of stt.events) {
            if (this.closed || this.sttSession !== stt) break;
            if (event.type === 'error') { this.failStt(event.code, event.retryable); return; }
            const turn = this.turn;
            if (!turn) continue;
            turn.event(event);
            if (event.type === 'partial') this.client.control({ type: 'stt.partial', utterance_id: turn.utteranceId, text: event.text });
          }
          if (!this.closed && this.sttSession === stt) this.failStt('STT_CONNECTION_CLOSED', true);
        } catch (error) {
          if (!this.closed && this.sttSession === stt) this.failStt(error instanceof VoiceError ? error.code : 'STT_PROVIDER_ERROR');
        }
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
    clearTimeout(this.silenceTimer); clearTimeout(this.admissionTimer); this.speaking = true;
    this.clearPlayback(epoch);
    this.stopResponse();
  }
  stopPlayback(epoch: number, requestId?: number): void {
    if (this.closed) return;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= 0xffffffff) throw new VoiceError('INVALID_EPOCH');
    if (requestId !== undefined && (!Number.isSafeInteger(requestId) || requestId < 1)) throw new VoiceError('INVALID_CONTROL');
    // The browser may not have received our latest playback.start yet.
    this.clearPlayback(Math.max(epoch, this.playback.epoch + 1));
    this.client.control({ type: 'playback.stopped', request_id: requestId, epoch: this.playback.epoch, generation: this.playback.generation });
  }
  pausePlayback(epoch: number, paused: boolean): void {
    if (typeof paused !== 'boolean' || !Number.isSafeInteger(epoch)) throw new VoiceError('INVALID_CONTROL');
    if (this.closed || epoch !== this.playback.epoch) return;
    // A paused recognizer is bounded by its utterance and finalization budgets.
    // Repeated pause messages cannot extend that budget indefinitely.
    if (!paused) this.pausedUntil = 0;
    else if (!this.pausedUntil) this.pausedUntil = Date.now() + this.options.maxUtteranceMs + Math.max(this.options.finalizationTimeoutMs, this.stt.capabilities.finalizationTimeoutMs ?? 0) + 1000;
  }
  private clearPlayback(epoch: number): void {
    this.pausedUntil = 0;
    this.interruption++;
    this.recordPlayback('interrupted');
    this.playingResponseId = undefined;
    const current = this.playback.clear(epoch);
    this.client.control({ type: 'playback.clear', epoch: current, generation: this.playback.generation });
  }
  speechEnded(lastAudioSeq: number): void {
    if (!Number.isSafeInteger(lastAudioSeq) || lastAudioSeq < 0) throw new VoiceError('INVALID_AUDIO_SEQUENCE');
    this.speaking = false; clearTimeout(this.silenceTimer);
    if (this.turn) { this.endpoint = this.turnTrace(this.turn.utteranceId); this.endpoint.trace.emit('speech_ended'); }
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
  private turnTrace(utteranceId: string): TurnTrace {
    const ids = { utteranceId };
    return { ids, trace: voiceTrace('turn', this.diagnostic, ids) };
  }
  private async commitTurn(lastAudioSeq: number, flush: boolean): Promise<void> {
    if (this.finalizing || !this.turn || this.closed) return;
    this.finalizing = true; this.speaking = false; clearTimeout(this.silenceTimer);
    const turn = this.turn;
    // An explicit commit without speech.ended starts its timing here.
    let turnTrace = this.endpoint;
    if (turnTrace?.ids.utteranceId !== turn.utteranceId) { turnTrace = this.turnTrace(turn.utteranceId); turnTrace.trace.emit('commit_received'); }
    this.endpoint = undefined;
    try {
      const trace = voiceTrace('stt', this.diagnostic, { utteranceId: turn.utteranceId });
      trace.emit('commit_started');
      const text = await trace.run(() => turn.commit(lastAudioSeq)).then(text => { trace.emit('transcript_ready'); return text; }, error => { trace.emit('failed', { code: error instanceof VoiceError ? error.code : 'STT_PROVIDER_ERROR' }); throw error; });
      if (this.closed) return;
      turnTrace.trace.emit('transcript_ready');
      // Some providers deliver no partial words. A confirmed continuation still
      // supersedes the previous reply before this text is admitted. Tasks survive.
      const playback = this.playback.snapshot();
      if (this.responses.size || (this.playingResponseId && (this.completedPlaybackEpoch !== playback.epoch || playback.playedSamples < playback.generatedSamples))) { this.speechStarted(this.playback.epoch + 1); this.speaking = false; }
      if (this.options.mergeWindowMs) {
        if (this.pendingText.reduce((n, p) => n + p.text.length, text.length) > 65536) throw new VoiceError('TRANSCRIPT_TOO_LARGE');
        this.pendingText.push({ text, utteranceId: turn.utteranceId, turn: turnTrace });
        this.client.control({ type: 'stt.segment', utterance_id: turn.utteranceId, text, pending_text: this.pendingText.map(p => p.text).join(' ') });
        if (flush) await this.flushPending();
      } else await this.admit(text, turn.utteranceId, turnTrace);
    } finally {
      await turn.close(false); if (this.turn === turn) this.turn = undefined; this.finalizing = false;
      if (!this.closed && !this.muted) await this.start();
      this.scheduleAdmission();
    }
  }
  private async admit(text: string, utteranceId: string, turn: TurnTrace): Promise<void> {
    this.client.control({ type: 'stt.final', utterance_id: utteranceId, text });
    const index = this.acks.admitted++;
    const context: FastAckContext = { recentTurns: [...this.acks.turns], recentAcks: [...this.acks.spoken] };
    this.acks.turns = [...this.acks.turns, text].slice(-2);
    // Decided before submitting, so the turn knows whether an acknowledgement may precede its reply.
    const skip = !this.options.acknowledge ? 'disabled' : fillerOnly(text) ? 'filler' : this.acks.lastAcked === index - 1 ? 'cooldown' : undefined;
    // The agent turn reports its own phases (process, first token, first spoken words) on this trace.
    const accepted = await this.submit(text, utteranceId, phase => turn.trace.emit(phase), { fastAck: !skip });
    turn.ids.inputId = accepted.inputId; turn.trace.emit('turn_admitted');
    this.client.control({ type: 'utterance.accepted', utterance_id: utteranceId, input_id: accepted.inputId });
    const epoch = this.interruption;
    const ack = this.fastAck(text, epoch, turn, index, context, skip);
    void accepted.response.finally(() => ack.cancel()).catch(() => {});
    const streaming = accepted.stream ? this.speakStream(accepted.stream, epoch, accepted.response, turn, ack.cancel) : undefined;
    const response = accepted.response.then(async answer => {
      if (this.closed || epoch !== this.interruption) return;
      if (streaming) { this.client.control({ type: 'response.text', input_id: accepted.inputId, response_id: accepted.responseId?.(), text: answer, final: true }); await streaming; }
      else this.client.control({ type: 'response.text', input_id: accepted.inputId, response_id: accepted.responseId?.(), text: answer, final: true });
    }).catch(error => {
      // A previous response may reject as its process exits after barge-in.
      // Match the success path: only the current voice turn may notify the client.
      if (this.closed || epoch !== this.interruption) return;
      this.error(error.code ?? 'CONVERSATION_FAILED');
    });
    void streaming?.catch(() => {}); // response chain reports the original failure once
    this.responses.add(response); void response.finally(() => this.responses.delete(response));
  }
  private async speakStream(stream: AsyncIterable<{ responseId: string; text: string }>, epoch: number, response: Promise<string>, turn: TurnTrace, firstSpoken: (spoken: boolean) => void): Promise<void> {
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    firstSpoken(!first.done);
    if (this.closed) return;
    if (first.done) { await response; if (!this.closed && epoch === this.interruption) this.speechUnavailable(); return; }
    turn.ids.responseId = first.value.responseId; turn.trace.emit('agent_first_spoken');
    const client = this.client, session = this;
    async function* source() {
      let chunk = first;
      // Barge-in or hang-up ends this reply: sentences still streaming in are never spoken.
      while (!chunk.done && !session.closed && epoch === session.interruption) {
        client.control({ type: 'response.speech', response_id: chunk.value.responseId, text: chunk.value.text });
        turn.trace.emit('spoken_sentence_sent');
        yield chunk.value.text;
        chunk = await iterator.next();
      }
    }
    try { await this.enqueueSpeech(source(), first.value.responseId, epoch, turn); }
    finally { await iterator.return?.(); }
  }
  /** Starts the acknowledgement call with the turn. It is spoken only if the reply has not begun
   * speaking `fastAckAfterMs` after admission, and never after barge-in, the reply's own speech or
   * another spoken response such as the turn's contextual acknowledgement. It is skipped on filler,
   * right after an acknowledged turn, and when it repeats one already spoken in this call.
   * It is audio only: no response text, chat message or history entry. */
  private fastAck(text: string, interruption: number, turn: TurnTrace, index: number, context: FastAckContext, skip?: string): { cancel: (spoken?: boolean) => void } {
    const acknowledge = this.options.acknowledge;
    if (!acknowledge || skip === 'disabled') return { cancel: () => {} };
    if (skip) { turn.trace.emit('fast_ack_skipped', { code: skip }); return { cancel: () => {} }; }
    const controller = new AbortController(), due = Date.now() + (this.options.fastAckAfterMs ?? 0);
    let settled = false, superseded = false;
    // Before it is due the acknowledgement is simply cancelled; once queued, only speech that
    // actually reaches the caller (`spoken`) replaces it.
    const cancel = (spoken = false) => { if (spoken) superseded = true; if (!settled) { settled = true; controller.abort(); } };
    this.supersedeAck = () => cancel(true);
    void (async () => {
      const reply = await acknowledge(text, controller.signal, context).catch(() => undefined);
      if (!settled && reply) await new Promise(resolve => setTimeout(resolve, Math.max(0, due - Date.now())));
      if (settled || this.closed || interruption !== this.interruption) return;
      settled = true;
      const code = !reply ? 'no_fit' : this.acks.spoken.some(spoken => repeats(spoken, reply, text)) ? 'duplicate' : undefined;
      if (code) { turn.trace.emit('fast_ack_skipped', { code }); return; }
      void this.enqueueSpeech((async function* () { yield reply!; })(), undefined, interruption, turn, () => {
        if (superseded) { turn.trace.emit('fast_ack_skipped', { code: 'superseded' }); return false; }
        this.acks.spoken = [...this.acks.spoken, reply!].slice(-3); this.acks.lastAcked = index;
        turn.trace.emit('fast_ack_sent');
        return true;
      });
    })();
    return { cancel };
  }
  speechClaims(): string[] { return [...this.claimedSpeech]; }
  /** Only approved summaries from authenticated automatic task reports enter here. */
  notifyResult(result: { responseId: string; text: string; spoken: string; requestId?: string; speechOnly?: boolean }): void {
    if (this.closed || this.claimedSpeech.has(result.responseId)) return;
    // The agent's own spoken acknowledgement or clarification replaces a generic one that has not played yet.
    if (result.speechOnly && result.spoken) this.supersedeAck?.();
    if (!result.speechOnly) this.client.control({ type: 'response.text', response_id: result.responseId, request_id: result.requestId, text: result.text, final: true });
    if (!result.spoken) { this.speechUnavailable(); return; }
    const client = this.client;
    void this.enqueueSpeech((async function* () {
      client.control({ type: 'response.speech', response_id: result.responseId, request_id: result.requestId, text: result.spoken });
      yield result.spoken;
    })(), result.responseId);
  }
  /** `begin`, when given, is asked as playback would start; false drops the speech unplayed. */
  private enqueueSpeech(text: AsyncIterable<string>, responseId?: string, interruption = this.interruption, turn?: TurnTrace, begin?: () => boolean): Promise<void> {
    if (responseId) {
      if (this.claimedSpeech.has(responseId)) return Promise.resolve();
      this.claimedSpeech.add(responseId);
    }
    const trace = voiceTrace('tts', this.diagnostic, { responseId, utteranceId: turn?.ids.utteranceId, inputId: turn?.ids.inputId });
    trace.emit('speech_ready');
    const queued = this.speechQueue.then(async () => {
      while (!this.closed && interruption === this.interruption && (this.speaking || this.finalizing || this.pendingText.length)) await new Promise(resolve => setTimeout(resolve, 10));
      if (this.closed || interruption !== this.interruption) {
        // This response never began playback. Let catch-up reserve it again;
        // the interrupted response that actually played keeps its claim/receipt.
        if (responseId) this.claimedSpeech.delete(responseId);
        return;
      }
      if (begin && !begin()) return;
      await this.speak(text, this.playback.epoch, responseId, trace, turn);
      // Synthesis completion is not playback completion. Preserve the tail before
      // the next utterance clears the playback epoch.
      const epoch = this.playback.epoch; let deadline = Date.now() + 10000;
      while (!this.closed && interruption === this.interruption && epoch === this.playback.epoch) {
        const progress = this.playback.snapshot();
        if (progress.playedSamples >= progress.generatedSamples) break;
        if (Date.now() < this.pausedUntil) deadline = Date.now() + 10000;
        if (Date.now() > deadline) { this.error('CLIENT_TOO_SLOW'); break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    this.speechQueue = queued.catch(() => { this.error('TTS_UNAVAILABLE'); });
    return this.speechQueue;
  }
  private async speak(spokenText: AsyncIterable<string>, expectedEpoch: number, responseId: string | undefined, trace: ReturnType<typeof voiceTrace>, turn?: TurnTrace): Promise<void> {
    if (this.closed) return;
    if (this.speaking || expectedEpoch !== this.playback.epoch) return;
    const epoch = this.playback.clear(), segmentId = randomUUID();
    this.pausedUntil = 0;
    this.playingResponseId = responseId;
    let voiceId = this.voiceId;
    if (!voiceId.trim()) {
      try { voiceId = await resolveVoiceId({provider: this.tts.id, voiceId}); }
      catch { this.recordPlayback('failed'); this.error('TTS_UNAVAILABLE'); return; }
      if (this.closed || epoch !== this.playback.epoch) return;
      // A user may have configured a voice while catalog lookup was in flight.
      voiceId = this.voiceId || voiceId;
      this.voiceId = voiceId;
    }
    this.playingResponseId = responseId;
    this.playbackTrace = { epoch, firstProgress: false, trace, turn };
    trace.emit('synthesis_started');
    this.recordPlayback('streaming');
    this.client.control({ type: 'playback.start', voice_id: voiceId, phase: responseId ? 'response' : 'acknowledgement', response_id: responseId, segment_id: segmentId, epoch, generation: this.playback.generation, format: PCM16 });
    try {
      const recording: Buffer[] = []; let recordedBytes = 0; let recordable = true;
      let sequence = 0;
      let providerSequence = 0;
      const signal = this.playback.signal;
      // The recognition hint belongs to microphone input. Let TTS follow the
      // approved response text, which can intentionally use another language.
      for await (const chunk of tracedAudio(this.synthesizePieces(spokenText, voiceId, signal), trace)) {
        if (this.closed || epoch !== this.playback.epoch || signal.aborted) break;
        if (providerSequence === 0) trace.emit('first_provider_audio');
        if (chunk.chunkSeq !== providerSequence++ || chunk.format.encoding !== PCM16.encoding || chunk.format.sampleRate !== PCM16.sampleRate || chunk.format.channels !== 1) throw new VoiceError('INVALID_AUDIO_CHUNK');
        if (chunk.bytes.length % 2) throw new VoiceError('INVALID_AUDIO_CHUNK');
        // Provider chunk sizes are unrelated to our wire chunks. Bound playback
        // by acknowledged sample offsets as well as the socket's byte queue.
        const bytesPerFrame = Math.min(3200, Math.max(2, Math.floor(this.options.maxBufferedAudioMs * 16) * 2));
        for (let offset = 0; offset < chunk.bytes.length; offset += bytesPerFrame) {
          const bytes = chunk.bytes.subarray(offset, offset + bytesPerFrame);
          let deadline = Date.now() + 10000;
          while (!signal.aborted && epoch === this.playback.epoch) {
            const progress = this.playback.snapshot();
            const paused = Date.now() < this.pausedUntil;
            if (paused) deadline = Date.now() + 10000;
            if (!paused && progress.generatedSamples - progress.playedSamples + bytes.length / 2 <= this.options.maxBufferedAudioMs * 16 && this.client.bufferedBytes() <= this.options.maxBufferedAudioMs * 32) break;
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
          if (sequence === 1) { trace.emit('first_audio_sent'); this.recordPlayback('streaming'); }
        }
      }
      if (!signal.aborted && epoch === this.playback.epoch) {
        if (this.saveAudio && responseId && recordable && recordedBytes) {
          try { this.saveAudio(responseId, pcmToWav(Buffer.concat(recording))); } catch { /* Playback remains usable if storage is full. */ }
        }
        trace.emit('audio_sent_complete');
        this.completedPlaybackEpoch = epoch;
        this.recordPlayback('streamed'); this.client.control({ type: 'playback.end', response_id: responseId, epoch, generated_samples: this.playback.snapshot().generatedSamples }); }
    } catch (error) { if (!this.closed && epoch === this.playback.epoch) { trace.emit('failed', { code: error instanceof VoiceError ? error.code : 'TTS_UNAVAILABLE' }); this.recordPlayback('failed'); this.error(error instanceof VoiceError ? error.code : 'TTS_UNAVAILABLE'); } }
  }
  /** Each piece of spoken text is synthesized on its own provider stream, which ends as soon as the
   * piece is sent. A streaming TTS socket otherwise holds short text (ElevenLabs dialogue: under ~40
   * characters and 8 words, typical of Thai) until the socket closes, and the managed relay accepts
   * no flush. One reply is still one playback: chunks are numbered across its pieces. */
  private async *synthesizePieces(spokenText: AsyncIterable<string>, voiceId: string, signal: AbortSignal): AsyncGenerator<TtsAudioChunk> {
    let chunkSeq = 0;
    for await (const text of spokenText) {
      if (signal.aborted) return;
      let pieceSeq = 0;
      for await (const chunk of this.tts.synthesize({ text: (async function* () { yield text; })(), voiceId, outputFormat: PCM16, signal })) {
        if (chunk.chunkSeq !== pieceSeq++) throw new VoiceError('INVALID_AUDIO_CHUNK');
        yield { ...chunk, chunkSeq: chunkSeq++ };
      }
    }
  }
  progress(epoch: number, sampleOffset: number): void { this.playback.progress(epoch, sampleOffset);
    const state = this.playbackTrace;
    if (state && state.epoch === epoch && epoch === this.playback.epoch && !state.firstProgress && this.playback.snapshot().playedSamples > 0) { state.firstProgress = true; state.trace.emit('first_playback_progress'); state.turn?.trace.emit('e2e_first_audio'); }
    if (epoch === this.playback.epoch) this.recordPlayback('playback_progress'); }
  private recordPlayback(state: string): void {
    const progress = this.playback.snapshot();
    if (this.completedPlaybackEpoch === progress.epoch && progress.generatedSamples > 0 && progress.playedSamples >= progress.generatedSamples) state = 'played';
    if (this.playingResponseId) this.record?.(this.playingResponseId, progress, state);
  }
  mute(muted: boolean, policy: 'discard' | 'commit', lastAudioSeq?: number): Promise<void> {
    const operation = this.muteQueue.then(() => this.applyMute(muted, policy, lastAudioSeq));
    this.muteQueue = operation.catch(() => {});
    return operation;
  }
  private async applyMute(muted: boolean, policy: 'discard' | 'commit', lastAudioSeq?: number): Promise<void> {
    if (this.closed) return;
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
      if (!this.closed) this.client.control({ type: 'voice.state', state: muted ? 'muted' : 'listening' });
    }
  }
  private speechUnavailable(): void { if (!this.closed) this.client.control({ type: 'voice.notice', code: 'SPEECH_SUMMARY_UNAVAILABLE' }); }
  private failStt(code: string, retryable = describeVoiceError(code).retryable): void {
    if (this.closed) return;
    // A dead recognizer cannot be reused. The transport reconnects with a fresh
    // ticket, preserving conversation ownership and any committed tasks.
    this.client.control({ type: 'voice.error', code, retryable, reconnect: retryable });
    void this.close().catch(() => {});
  }
  private error(code: string): void { if (!this.closed) this.client.control({ type: 'voice.error', code }); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.recordPlayback('detached');
    this.closed = true; clearTimeout(this.silenceTimer); clearTimeout(this.admissionTimer); this.pendingText = []; this.controller.abort(); this.playback.close();
    await this.turn?.close(false); this.turn = undefined; const stt = this.sttSession; this.sttSession = undefined; await stt?.close();
    // Detaching voice playback does not cancel committed tasks or responses.
  }
}
