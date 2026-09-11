import { providerVoiceError } from '../errors';
import { spawn } from 'child_process';
import { once } from 'events';
import { PCM16, TtsProvider, VoiceError, validateAudioFormat } from '../types';
import { openBinaryProviderSocket, SocketFactory } from './socket';
import { upstreamVoiceConnection } from './upstream';

export function paxaConnection(provider = 'paxalabs'): { base: URL; key: string } {
  if (provider === 'upstream:paxalabs') return upstreamVoiceConnection('paxalabs');
  return { base: new URL('https://api.paxalabs.com/v1/'), key: process.env.PAXALABS_API_KEY ?? '' };
}

export class PaxaLabsTts implements TtsProvider {
  readonly capabilities = { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] };
  constructor(private readonly connection: { base: URL; key: string }, private readonly model = 'paxa-tts-flash-v1', private readonly connect: SocketFactory = openBinaryProviderSocket, readonly id = 'paxalabs') {}
  async *synthesize(options: Parameters<TtsProvider['synthesize']>[0]) {
    validateAudioFormat(options.outputFormat);
    if (options.outputFormat.sampleRate !== 16000) throw new VoiceError('UNSUPPORTED_AUDIO_FORMAT');
    // Paxa supplies compressed/container audio; the voice transport requires raw PCM.
    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const decoder = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-probesize', '32768', '-analyzeduration', '0', '-f', 'mp3', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let failure: unknown;
    decoder.on('error', () => { failure = new VoiceError('TTS_DECODER_UNAVAILABLE'); abort.abort(); });
    decoder.stdin.on('error', () => { failure ??= new VoiceError('TTS_DECODE_FAILED'); abort.abort(); });
    const exited = new Promise<void>(resolve => decoder.once('close', code => { if (code && !options.signal.aborted) failure ??= new VoiceError('TTS_DECODE_FAILED'); resolve(); }));
    const stop = () => { decoder.kill('SIGKILL'); };
    signal.addEventListener('abort', stop, { once: true });
    const feeding = (async () => {
      for await (const bytes of this.audio({ ...options, signal })) {
        if (!decoder.stdin.write(bytes)) await once(decoder.stdin, 'drain', { signal });
      }
      decoder.stdin.end();
    })().catch(error => { failure ??= error; abort.abort(); });
    let chunkSeq = 0, pending = Buffer.alloc(0);
    try {
      for await (const chunk of decoder.stdout) {
        const bytes = Buffer.concat([pending, chunk]);
        const length = bytes.length - bytes.length % 2;
        pending = bytes.subarray(length);
        if (length) yield { bytes: bytes.subarray(0, length), format: options.outputFormat, chunkSeq: chunkSeq++ };
      }
      await feeding; await exited;
      if (failure) throw failure;
      if (!chunkSeq && !options.signal.aborted) throw new VoiceError('TTS_INCOMPLETE');
    } finally { abort.abort(); signal.removeEventListener('abort', stop); decoder.kill('SIGKILL'); await feeding; await exited; }
  }
  async synthesizeFile(options: Parameters<NonNullable<TtsProvider['synthesizeFile']>>[0]) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of this.audio({ ...options, text: (async function* () { yield options.text; })() })) {
      size += chunk.length; if (size > 5 * 1024 * 1024) throw new VoiceError('TTS_AUDIO_TOO_LARGE');
      chunks.push(chunk);
    }
    if (!size || options.signal.aborted) throw new VoiceError('TTS_INCOMPLETE');
    return { bytes: Buffer.concat(chunks), mime: 'audio/mpeg' as const, name: 'reply.mp3' };
  }
  private async *audio(options: Pick<Parameters<TtsProvider['synthesize']>[0], 'text' | 'voiceId' | 'signal'>): AsyncIterable<Buffer> {
    if (!this.connection.key) throw new VoiceError('TTS_CREDENTIALS_MISSING');
    const url = new URL('tts/live', this.connection.base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = await this.connect(url.toString(), { Authorization: `Bearer ${this.connection.key}` }, options.signal);
    let sendError: unknown, done = false;
    let cancel!: () => void;
    const cancelled = new Promise<IteratorResult<string>>(resolve => { cancel = () => { socket.close(); resolve({ done: true, value: undefined }); }; });
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    const input = options.text[Symbol.asyncIterator]();
    const sending = (async () => {
      await socket.send({ type: 'start', model: this.model, voice: options.voiceId, format: 'mp3' });
      while (!options.signal.aborted) {
        const next = await Promise.race([input.next(), cancelled]);
        if (next.done || options.signal.aborted) break;
        const text = next.value;
        // Respect the provider's per-frame ceiling without splitting surrogate pairs.
        const chars = Array.from(text);
        for (let i = 0; i < chars.length; i += 5000) await socket.send({ type: 'text', text: chars.slice(i, i + 5000).join('') });
      }
      if (!options.signal.aborted) await socket.send({ type: 'end' });
    })().catch(error => { sendError = error; socket.close(); });
    try {
      for await (const event of socket.messages) {
        if (options.signal.aborted) return;
        if (event.type === 'error') throw providerVoiceError('TTS', undefined, event);
        if (event.binaryAudio) yield Buffer.from(event.binaryAudio);
        if (event.type === 'done') { done = true; break; }
      }
      await sending;
      if (sendError) throw sendError;
      if (!done && !options.signal.aborted) throw new VoiceError('TTS_INCOMPLETE');
    } finally {
      options.signal.removeEventListener('abort', cancel);
      cancel();
      void input.return?.().catch(() => {});
    }
  }
}
