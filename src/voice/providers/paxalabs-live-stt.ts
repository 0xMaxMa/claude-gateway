import { providerVoiceError } from '../errors';
import { SttProvider, SttSession, SttEvent, AudioFormat, VoiceError } from '../types';
import { BoundedQueue } from '../queue';
import { openProviderSocket, ProviderSocket, SocketFactory } from './socket';
import { paxaConnection } from './paxalabs-tts';

export const PAXA_REALTIME_STT_MODEL = 'paxa-stt-lite-realtime-v1-preview';
/** Realtime Paxa STT model ids stream over `stt/live`; batch ids POST to `stt`. */
export function isPaxaRealtimeSttModel(model: string): boolean {
  return /-realtime-/.test(model);
}

/** Paxa Labs' realtime speech-to-text WebSocket (`stt/live`), the streaming
 * sibling of the batch endpoint in `paxalabs-stt.ts`. The server detects turns
 * itself — a pause ends a turn and each turn yields its own final `transcript`
 * — and closes the connection after `done`. A gateway voice session keeps one
 * SttSession across utterances, so a fresh socket is opened per commit cycle
 * while a single events queue spans the whole session. */
export class PaxaLabsLiveStt implements SttProvider {
  readonly capabilities = { partials: true, manualCommit: true, speechActivityEvents: false, mode: 'realtime' as const };
  constructor(readonly id = 'paxalabs', private readonly model = PAXA_REALTIME_STT_MODEL, private readonly connect: SocketFactory = openProviderSocket) {}
  async open(options: { format: AudioFormat; language?: string; signal: AbortSignal }): Promise<SttSession> {
    if (options.format.encoding !== 'pcm_s16le' || options.format.channels !== 1 || options.format.sampleRate !== 16000) throw new VoiceError('UNSUPPORTED_AUDIO_FORMAT');
    const { base, key } = paxaConnection(this.id);
    if (!key) throw new VoiceError('STT_CREDENTIALS_MISSING');
    if (options.language && !['th', 'en'].includes(options.language)) throw new VoiceError('STT_LANGUAGE_UNSUPPORTED');
    const url = new URL('stt/live', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const events = new BoundedQueue<SttEvent>(131072, e => JSON.stringify(e).length);
    let socket: ProviderSocket | undefined, segment = 0, commitId: string | undefined, closed = false;
    // Runs one socket's message loop for a single utterance. A `done` frame ends
    // the cycle gracefully; any other early close mid-utterance fails the session.
    const run = (active: ProviderSocket) => void (async () => {
      const turns: string[] = [];
      let graceful = false;
      try {
        for await (const message of active.messages) {
          if (closed) { graceful = true; break; }
          if (message.type === 'transcript') {
            const text = String(message.text ?? '');
            if (message.is_final) { turns.push(text); events.push({ type: 'segment_final', segmentId: String(segment++), text }); }
            else events.push({ type: 'partial', segmentId: String(segment), text: [...turns, text].filter(Boolean).join(' ') });
          } else if (message.type === 'done') {
            if (commitId) { events.push({ type: 'commit_done', commitId }); commitId = undefined; }
            graceful = true; break;
          } else if (message.type === 'error') throw providerVoiceError('STT', undefined, message);
          // `started`, `speech_started`, `speech_ended` and `charged` carry
          // nothing this session acts on; the transcripts and `done` suffice.
        }
      } catch (error) {
        if (!closed) events.close(error instanceof VoiceError ? error : new VoiceError('STT_PROVIDER_ERROR'));
        active.close(); if (socket === active) socket = undefined; return;
      }
      active.close(); if (socket === active) socket = undefined;
      if (!graceful && !closed) events.push({ type: 'error', code: 'STT_CONNECTION_CLOSED', retryable: true });
    })();
    const ensureSocket = async (): Promise<ProviderSocket> => {
      if (socket) return socket;
      const active = await this.connect(url.toString(), { Authorization: `Bearer ${key}` }, signal);
      socket = active;
      await active.send({ type: 'start', model: this.model, audio: { encoding: 'pcm_s16le', sample_rate: options.format.sampleRate }, ...(options.language ? { language: options.language } : {}) });
      run(active);
      return active;
    };
    return {
      events,
      pushAudio: async frame => { signal.throwIfAborted(); await (await ensureSocket()).audio(frame); },
      commitSegment: async id => {
        if (commitId) throw new VoiceError('COMMIT_IN_PROGRESS');
        // No audio pushed this utterance: nothing was recorded to finalize.
        if (!socket) { events.push({ type: 'commit_done', commitId: id }); return; }
        commitId = id;
        await socket.send({ type: 'end' });
      },
      close: async () => { closed = true; abort.abort(); socket?.close(); events.close(); },
    };
  }
}
