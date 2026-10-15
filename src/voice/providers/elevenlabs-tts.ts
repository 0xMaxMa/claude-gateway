import { providerVoiceError } from '../errors';
import { PCM16, TtsProvider, VoiceError, TtsAudioChunk, validateAudioFormat } from '../types';
import { openProviderSocket, SocketFactory } from './socket';

// v3 and v4 models are only served by the Text-to-Dialogue socket; the classic
// stream-input socket rejects v4 with HTTP 400. An explicit list, so an unknown future
// variant fails on the socket it was documented for rather than on a guessed one.
const DIALOGUE_MODELS = new Set(['eleven_v3_conversational', 'eleven_v3', 'eleven_v4_turbo', 'eleven_v4']);
export const isElevenLabsDialogueModel = (model: string): boolean => DIALOGUE_MODELS.has(model);
// Both sockets close after 20s without a message. The classic socket accepts a longer
// inactivity_timeout; the dialogue socket ignores it and needs keep_alive messages
// (1008 input_timeout_exceeded otherwise). Either way a stalled reply is bounded.
const MAX_IDLE_SECONDS = 180, KEEP_ALIVE_MS = 10000;
// How long a send rejected by the same close may take to report its own cause.
const SEND_SETTLE_MS = 250;

export class ElevenLabsTts implements TtsProvider {
  readonly capabilities = { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] };
  constructor(private readonly key: string, private readonly model = 'eleven_v3_conversational', private readonly connect: SocketFactory = openProviderSocket, readonly id: string = 'elevenlabs') {}
  async *synthesize(options: Parameters<TtsProvider['synthesize']>[0]): AsyncIterable<TtsAudioChunk> {
    validateAudioFormat(options.outputFormat);
    if (options.outputFormat.sampleRate !== 16000) throw new VoiceError('UNSUPPORTED_AUDIO_FORMAT');
    let chunkSeq = 0;
    for await (const bytes of this.audio(options, 'pcm_16000')) yield { bytes, format: options.outputFormat, chunkSeq: chunkSeq++ };
  }
  async synthesizeFile(options: { text: string; voiceId: string; signal: AbortSignal }): Promise<{ bytes: Uint8Array; mime: 'audio/mpeg'; name: string }> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const bytes of this.audio({ ...options, text: (async function* () { yield options.text; })() }, 'mp3_44100_128')) {
      size += bytes.length; if (size > 5 * 1024 * 1024) throw new VoiceError('TTS_AUDIO_TOO_LARGE');
      chunks.push(bytes);
    }
    if (!size || options.signal.aborted) throw new VoiceError('TTS_INCOMPLETE');
    return { bytes: Buffer.concat(chunks), mime: 'audio/mpeg', name: 'reply.mp3' };
  }
  private async *audio(options: { text: AsyncIterable<string>; voiceId: string; signal: AbortSignal; language?: string }, format: string): AsyncIterable<Buffer> {
    if (!this.key) throw new VoiceError('TTS_CREDENTIALS_MISSING');
    const dialogue = isElevenLabsDialogueModel(this.model);
    const url = new URL(dialogue ? 'wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input' : `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.voiceId)}/stream-input`);
    url.searchParams.set('seed', '42');
    url.searchParams.set('model_id', this.model); url.searchParams.set('output_format', format);
    if (options.language) url.searchParams.set('language_code', options.language);
    if (!dialogue) url.searchParams.set('inactivity_timeout', String(MAX_IDLE_SECONDS));
    const socket = await this.connect(url.toString(), { 'xi-api-key': this.key }, options.signal);
    let sendError: unknown, finished = false, closing = false, keepAlive: NodeJS.Timeout | undefined;
    const fail = (error: unknown) => { sendError ??= error; socket.close(); };
    // Re-armed after every send, so keep-alives only go out while the reply text stalls,
    // and stop after MAX_IDLE_SECONDS so the provider closes an abandoned stream.
    const live = () => !closing && !options.signal.aborted;
    let idleSince = 0;
    const send = async (message: unknown, idle = false) => {
      clearTimeout(keepAlive);
      if (!idle) idleSince = Date.now();
      await socket.send(message);
      clearTimeout(keepAlive);
      if (dialogue && live() && Date.now() - idleSince < MAX_IDLE_SECONDS * 1000) (keepAlive = setTimeout(() => {
        if (live()) send({ keep_alive: true }, true).catch(error => { if (live()) fail(error); });
      }, KEEP_ALIVE_MS)).unref();
    };
    // Held so teardown can release the reply text source while it is stalled.
    const reply = options.text[Symbol.asyncIterator]();
    let textDone = false;
    const sending = (async () => {
      await send(dialogue ? { voices: [options.voiceId], voice_settings: { stability: 1 } } : { text: ' ', voice_settings: { stability: 0.5 }, generation_config: { chunk_length_schedule: [50,120,160,290] } });
      for await (const text of { [Symbol.asyncIterator]: () => reply }) {
        if (options.signal.aborted) return;
        await send(dialogue ? { inputs: [{ text, voice_id: options.voiceId }] } : { text, try_trigger_generation: true });
      }
      textDone = closing = true;
      await send(dialogue ? { close_socket: true } : { text: '' });
    })().catch(fail).finally(() => { closing = true; clearTimeout(keepAlive); });
    try {
      for await (const message of socket.messages) {
        if (options.signal.aborted) return;
        if (message.error) throw providerVoiceError('TTS', undefined, message);
        if (typeof message.audio === 'string') yield Buffer.from(message.audio, 'base64');
        if (message.is_final === true || message.isFinal === true) { finished = closing = true; break; }
      }
      if (finished) await sending;
      else if (!options.signal.aborted) {
        // The provider closed without a terminal event. Report now, since `sending` may be waiting
        // on stalled text, but give a send rejected by that close a moment to report its cause.
        let settle: NodeJS.Timeout | undefined;
        if (!sendError) await Promise.race([sending, new Promise(resolve => { settle = setTimeout(resolve, SEND_SETTLE_MS); })]);
        clearTimeout(settle);
        throw sendError ?? new VoiceError('TTS_INCOMPLETE');
      }
      if (sendError) throw sendError;
    } finally {
      closing = true; clearTimeout(keepAlive); socket.close();
      if (!textDone) void Promise.resolve(reply.return?.()).catch(() => {});
    }
  }
}
