import { providerVoiceError } from '../errors';
import { SttProvider, SttEvent, SttSession, AudioFormat, VoiceError, validateAudioFormat } from '../types';
import { BoundedQueue } from '../queue';
import { openProviderSocket, SocketFactory } from './socket';

export class ElevenLabsStt implements SttProvider {
  readonly id = 'elevenlabs';
  readonly capabilities = { partials: true, manualCommit: true, speechActivityEvents: false };
  constructor(private readonly key: string, private readonly model = 'scribe_v2_realtime', private readonly connect: SocketFactory = openProviderSocket) {}
  async open(options: { format: AudioFormat; language?: string; signal: AbortSignal }): Promise<SttSession> {
    validateAudioFormat(options.format);
    if (!this.key) throw new VoiceError('STT_CREDENTIALS_MISSING');
    const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    url.searchParams.set('model_id', this.model); url.searchParams.set('audio_format', `pcm_${options.format.sampleRate}`);
    url.searchParams.set('commit_strategy', 'manual'); url.searchParams.set('include_timestamps', 'false');
    if (options.language) url.searchParams.set('language_code', options.language);
    const socket = await this.connect(url.toString(), { 'xi-api-key': this.key }, options.signal);
    const events = new BoundedQueue<SttEvent>(65536, e => JSON.stringify(e).length);
    let commitId: string | undefined, segment = 0, closed = false;
    let lastAudioAt = Date.now();
    const sendAudio = async (frame: Uint8Array) => {
      lastAudioAt = Date.now();
      await socket.send({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(frame).toString('base64'), sample_rate: options.format.sampleRate });
    };
    // The browser gates uplink during silence. A small silent audio chunk keeps
    // the recognizer alive while the worker runs; it never commits an input.
    const keepAlive = setInterval(() => {
      if (closed || options.signal.aborted || commitId || Date.now() - lastAudioAt < 5000) return;
      void sendAudio(Buffer.alloc(options.format.sampleRate / 10 * 2)).catch(() => {
        if (!closed) { events.close(new VoiceError('STT_CONNECTION_CLOSED')); socket.close(); }
      });
    }, 5000);
    keepAlive.unref();
    void (async () => {
      try {
        for await (const message of socket.messages) {
          if (closed) break;
          if (message.message_type === 'partial_transcript') events.push({ type: 'partial', segmentId: String(segment), text: String(message.text ?? '') });
          else if (message.message_type === 'committed_transcript') {
            events.push({ type: 'segment_final', segmentId: String(segment++), text: String(message.text ?? '') });
            if (commitId) { events.push({ type: 'commit_done', commitId }); commitId = undefined; }
          } else if (message.error) throw providerVoiceError('STT', undefined, message);
        }
        if (!closed) events.push({ type: 'error', code: 'STT_CONNECTION_CLOSED', retryable: true });
        events.close();
      } catch (error) { events.close(error instanceof VoiceError ? error : new VoiceError('STT_PROVIDER_ERROR')); socket.close(); }
      finally { closed = true; clearInterval(keepAlive); }
    })();
    return {
      events,
      pushAudio: sendAudio,
      commitSegment: async id => {
        if (commitId) throw new VoiceError('COMMIT_IN_PROGRESS');
        commitId = id;
        await socket.send({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: options.format.sampleRate });
      },
      close: async () => { closed = true; clearInterval(keepAlive); socket.close(); events.close(); },
    };
  }
}
