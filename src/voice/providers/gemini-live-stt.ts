import { BoundedQueue } from '../queue';
import {
  SttProvider,
  SttSession,
  SttEvent,
  AudioFormat,
  VoiceError,
} from '../types';
import { providerVoiceError } from '../errors';
import { geminiConnection } from './gemini';
import { openProviderSocket, SocketFactory } from './socket';

/** Dedicated transcription, not Gemini's audio-to-audio agent. */
export class GeminiLiveStt implements SttProvider {
  readonly capabilities = {
    partials: true,
    manualCommit: true,
    speechActivityEvents: false,
    mode: 'realtime' as const,
  };
  constructor(
    readonly id: string,
    private readonly model: string,
    private readonly connect: SocketFactory = openProviderSocket
  ) {}
  async open(options: {
    format: AudioFormat;
    language?: string;
    signal: AbortSignal;
  }): Promise<SttSession> {
    if (
      options.format.encoding !== 'pcm_s16le' ||
      options.format.sampleRate !== 16000 ||
      options.format.channels !== 1
    )
      throw new VoiceError('UNSUPPORTED_AUDIO_FORMAT');
    const { base, key, headers } = geminiConnection(this.id);
    if (!key) throw new VoiceError('STT_CREDENTIALS_MISSING');
    const url = this.id.startsWith('upstream:')
      ? new URL('live', base)
      : new URL(
          '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
          base
        );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const socket = await this.connect(url.toString(), headers, signal);
    const events = new BoundedQueue<SttEvent>(
      131072,
      (e) => JSON.stringify(e).length
    );
    let closed = false,
      segment = 0,
      commitId: string | undefined,
      started = false;
    let readyResolve!: () => void, readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => {});
    const timeout = setTimeout(() => {
      readyReject(new VoiceError('STT_SETUP_TIMEOUT'));
      socket.close();
    }, 10000);
    timeout.unref();
    const consuming = (async () => {
      try {
        for await (const message of socket.messages) {
          if (message.error)
            throw providerVoiceError('STT', message.error.code, message.error);
          if (message.setupComplete) {
            clearTimeout(timeout);
            readyResolve();
          }
          const content = message.serverContent;
          if (content?.interimInputTranscription?.text)
            events.push({
              type: 'partial',
              segmentId: String(segment),
              text: content.interimInputTranscription.text,
            });
          if (content?.inputTranscription)
            events.push({
              type: 'segment_final',
              segmentId: String(segment++),
              text: String(content.inputTranscription.text ?? ''),
            });
          if (
            (content?.generationComplete || content?.turnComplete) &&
            commitId
          ) {
            events.push({ type: 'commit_done', commitId });
            commitId = undefined;
            started = false;
          }
          if (message.goAway) throw new VoiceError('STT_CONNECTION_CLOSED');
        }
        if (!closed) throw new VoiceError('STT_CONNECTION_CLOSED');
      } catch (error) {
        readyReject(error);
        events.close(
          error instanceof VoiceError
            ? error
            : new VoiceError('STT_PROVIDER_ERROR')
        );
      } finally {
        clearTimeout(timeout);
        readyReject(new VoiceError('STT_CONNECTION_CLOSED'));
        socket.close();
        events.close();
      }
    })();
    try {
      await socket.send({
        setup: {
          model: `models/${this.model}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: {
            ...(options.language ? { languageCodes: [options.language] } : {}),
          },
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: true },
          },
        },
      });
      await ready;
    } catch (error) {
      closed = true;
      abort.abort();
      socket.close();
      await consuming;
      throw error;
    }
    return {
      events,
      pushAudio: async (bytes) => {
        signal.throwIfAborted();
        if (!started) {
          await socket.send({ realtimeInput: { activityStart: {} } });
          started = true;
        }
        await socket.send({
          realtimeInput: {
            audio: {
              data: Buffer.from(bytes).toString('base64'),
              mimeType: 'audio/pcm;rate=16000',
            },
          },
        });
      },
      commitSegment: async (id) => {
        if (commitId) throw new VoiceError('COMMIT_IN_PROGRESS');
        commitId = id;
        if (!started) {
          events.push({ type: 'commit_done', commitId: id });
          commitId = undefined;
          return;
        }
        await socket.send({ realtimeInput: { audioStreamEnd: true } });
      },
      close: async () => {
        closed = true;
        abort.abort();
        socket.close();
        await consuming;
        events.close();
      },
    };
  }
}
