import { providerVoiceError } from '../errors';
import { SttProvider, SttSession, SttEvent, AudioFormat, VoiceError, validateAudioFormat } from '../types';
import { BoundedQueue } from '../queue';
import { openProviderSocket, SocketFactory } from './socket';

export class DeepgramStt implements SttProvider {
  readonly id = 'deepgram';
  readonly capabilities = { partials: true, manualCommit: true, speechActivityEvents: true };
  constructor(private readonly key: string, private readonly model: string, private readonly connect: SocketFactory = openProviderSocket) {}
  async open(options: { format: AudioFormat; language?: string; signal: AbortSignal }): Promise<SttSession> {
    validateAudioFormat(options.format);
    if (!this.key) throw new VoiceError('STT_CREDENTIALS_MISSING');
    const url = new URL('wss://api.deepgram.com/v1/listen');
    for (const [key, value] of Object.entries({ model: this.model, encoding: 'linear16', sample_rate: String(options.format.sampleRate), channels: '1', interim_results: 'true', vad_events: 'true' })) url.searchParams.set(key, value);
    if (options.language) url.searchParams.set('language', options.language);
    const socket = await this.connect(url.toString(), { Authorization: `Token ${this.key}` }, options.signal);
    const events = new BoundedQueue<SttEvent>(65536, e => JSON.stringify(e).length);
    let commitId: string | undefined, closed = false;
    void (async () => {
      try {
        for await (const message of socket.messages) {
          if (closed) break;
          if (message.type === 'Results') {
            const text = String(message.channel?.alternatives?.[0]?.transcript ?? '');
            if (text) events.push({ type: message.is_final ? 'segment_final' : 'partial', segmentId: String(message.start), text });
            // Silence/speech_final is not the explicit flush acknowledgment.
            if (message.from_finalize && commitId) { events.push({ type: 'commit_done', commitId }); commitId = undefined; }
          } else if (message.type === 'SpeechStarted') events.push({ type: 'speech_start', atMs: Number(message.timestamp) * 1000 });
          else if (message.type === 'UtteranceEnd') events.push({ type: 'speech_end', atMs: Number(message.last_word_end) * 1000 });
          else if (message.type === 'Error') throw providerVoiceError('STT', undefined, message);
        }
        if (!closed) events.push({ type: 'error', code: 'STT_CONNECTION_CLOSED', retryable: true });
        events.close();
      } catch (error) { events.close(error instanceof VoiceError ? error : new VoiceError('STT_PROVIDER_ERROR')); socket.close(); }
    })();
    return { events, pushAudio: frame => socket.audio(frame),
      commitSegment: async id => { if (commitId) throw new VoiceError('COMMIT_IN_PROGRESS'); commitId = id; await socket.send({ type: 'Finalize' }); },
      close: async () => { closed = true; socket.close(); events.close(); } };
  }
}
