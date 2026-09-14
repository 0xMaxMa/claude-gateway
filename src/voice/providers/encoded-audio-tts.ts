import { spawn } from 'child_process';
import { once } from 'events';
import { PCM16, TtsProvider, VoiceError, validateAudioFormat } from '../types';

/** Shared bounded MP3-to-PCM streaming for encoded-audio TTS providers. */
export abstract class EncodedAudioTts implements TtsProvider {
  abstract readonly capabilities: TtsProvider['capabilities'];
  constructor(readonly id: string) {}
  protected get pcmSampleRate(): number | undefined {
    return undefined;
  }
  private get inputArgs(): string[] {
    return this.pcmSampleRate
      ? ['-f', 's16le', '-ar', String(this.pcmSampleRate), '-ac', '1']
      : ['-f', 'mp3'];
  }
  async *synthesize(options: Parameters<TtsProvider['synthesize']>[0]) {
    validateAudioFormat(options.outputFormat);
    if (options.outputFormat.sampleRate !== 16000)
      throw new VoiceError('UNSUPPORTED_AUDIO_FORMAT');
    // Normalize the provider audio to the voice transport format.
    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const decoder = spawn(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-probesize',
        '32768',
        '-analyzeduration',
        '0',
        ...this.inputArgs,
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        '16000',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] }
    );
    let failure: unknown;
    decoder.on('error', () => {
      failure = new VoiceError('TTS_DECODER_UNAVAILABLE');
      abort.abort();
    });
    decoder.stdin.on('error', () => {
      failure ??= new VoiceError('TTS_DECODE_FAILED');
      abort.abort();
    });
    const exited = new Promise<void>((resolve) =>
      decoder.once('close', (code) => {
        if (code && !options.signal.aborted)
          failure ??= new VoiceError('TTS_DECODE_FAILED');
        resolve();
      })
    );
    const stop = () => {
      decoder.kill('SIGKILL');
    };
    signal.addEventListener('abort', stop, { once: true });
    const feeding = (async () => {
      for await (const bytes of this.audio({ ...options, signal })) {
        if (!decoder.stdin.write(bytes))
          await once(decoder.stdin, 'drain', { signal });
      }
      decoder.stdin.end();
    })().catch((error) => {
      failure ??= error;
      abort.abort();
    });
    let chunkSeq = 0,
      pending = Buffer.alloc(0);
    try {
      for await (const chunk of decoder.stdout) {
        const bytes = Buffer.concat([pending, chunk]);
        const length = bytes.length - (bytes.length % 2);
        pending = bytes.subarray(length);
        if (length)
          yield {
            bytes: bytes.subarray(0, length),
            format: options.outputFormat,
            chunkSeq: chunkSeq++,
          };
      }
      await feeding;
      await exited;
      if (failure) throw failure;
      if (!chunkSeq && !options.signal.aborted)
        throw new VoiceError('TTS_INCOMPLETE');
    } finally {
      abort.abort();
      signal.removeEventListener('abort', stop);
      decoder.kill('SIGKILL');
      await feeding;
      await exited;
    }
  }
  async synthesizeFile(
    options: Parameters<NonNullable<TtsProvider['synthesizeFile']>>[0]
  ) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.audio({
      ...options,
      text: (async function* () {
        yield options.text;
      })(),
    })) {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) throw new VoiceError('TTS_AUDIO_TOO_LARGE');
      chunks.push(chunk);
    }
    if (!size || options.signal.aborted) throw new VoiceError('TTS_INCOMPLETE');
    let bytes: Buffer = Buffer.concat(chunks);
    if (this.pcmSampleRate) {
      if (bytes.length % 2) throw new VoiceError('TTS_INCOMPLETE');
      bytes = await new Promise<Buffer>((resolve, reject) => {
        const encoder = spawn(
          'ffmpeg',
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            ...this.inputArgs,
            '-i',
            'pipe:0',
            '-f',
            'mp3',
            'pipe:1',
          ],
          { stdio: ['pipe', 'pipe', 'ignore'] }
        );
        const stop = () => {
          encoder.kill('SIGKILL');
        };
        const output: Buffer[] = [];
        let length = 0,
          failure: unknown;
        options.signal.addEventListener('abort', stop, { once: true });
        encoder.on('error', () => {
          failure = new VoiceError('TTS_DECODER_UNAVAILABLE');
        });
        encoder.stdin.on('error', () => {
          failure ??= new VoiceError('TTS_DECODE_FAILED');
          stop();
        });
        encoder.stdout.on('data', (chunk) => {
          length += chunk.length;
          if (length > 5 * 1024 * 1024) {
            failure = new VoiceError('TTS_AUDIO_TOO_LARGE');
            stop();
          } else output.push(chunk);
        });
        encoder.once('close', (code) => {
          options.signal.removeEventListener('abort', stop);
          if (failure || code || options.signal.aborted)
            reject(failure ?? new VoiceError('TTS_INCOMPLETE'));
          else resolve(Buffer.concat(output));
        });
        if (options.signal.aborted) stop();
        else encoder.stdin.end(bytes);
      });
    }
    return { bytes, mime: 'audio/mpeg' as const, name: 'reply.mp3' };
  }
  protected abstract audio(
    options: Pick<
      Parameters<TtsProvider['synthesize']>[0],
      'text' | 'voiceId' | 'signal'
    >
  ): AsyncIterable<Buffer>;
}
