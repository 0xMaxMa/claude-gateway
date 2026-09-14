import { providerVoiceError } from '../errors';
import { EncodedAudioTts } from './encoded-audio-tts';
import { PCM16, TtsProvider, VoiceError } from '../types';
import { openBinaryProviderSocket, SocketFactory } from './socket';
import { upstreamVoiceConnection } from './upstream';

export function paxaConnection(provider = 'paxalabs'): { base: URL; key: string } {
  if (provider === 'managed:paxalabs') return upstreamVoiceConnection('paxalabs', true);
  if (provider === 'upstream:paxalabs') return upstreamVoiceConnection('paxalabs');
  return { base: new URL('https://api.paxalabs.com/v1/'), key: process.env.PAXALABS_API_KEY ?? '' };
}

export class PaxaLabsTts extends EncodedAudioTts {
  readonly capabilities = { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] };
  constructor(private readonly connection: { base: URL; key: string }, private readonly model = 'paxa-tts-flash-v1', private readonly connect: SocketFactory = openBinaryProviderSocket, id = 'paxalabs') { super(id); }
  protected async *audio(options: Pick<Parameters<TtsProvider['synthesize']>[0], 'text' | 'voiceId' | 'signal'>): AsyncIterable<Buffer> {
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
