import { providerHttpError, providerVoiceError, voiceProviderRequest } from '../errors';
import { randomUUID } from 'crypto';
import { PCM16, TtsProvider, TtsAudioChunk, VoiceError, validateAudioFormat } from '../types';
import { openProviderSocket, SocketFactory } from './socket';

export class CartesiaTts implements TtsProvider {
  readonly id = 'cartesia';
  readonly capabilities = { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] };
  constructor(private readonly key: string, private readonly model: string, private readonly connect: SocketFactory = openProviderSocket, private readonly request: typeof fetch = fetch) {}
  async synthesizeFile(options: {text:string;voiceId:string;signal:AbortSignal}): Promise<{bytes:Uint8Array;mime:'audio/mpeg';name:string}> {
    if (!this.key) throw new VoiceError('TTS_CREDENTIALS_MISSING');
    const response=await voiceProviderRequest('https://api.cartesia.ai/tts/bytes',{
      method:'POST',headers:{Authorization:`Bearer ${this.key}`,'Cartesia-Version':'2026-08-14','Content-Type':'application/json'},signal:options.signal,
      body:JSON.stringify({model_id:this.model,transcript:options.text,voice:options.voiceId,output_format:{container:'mp3',sample_rate:44100,bit_rate:128000}}),
    }, this.request);
    if (!response.ok) throw await providerHttpError('TTS', response);
    if (!response.body) throw new VoiceError('TTS_INCOMPLETE');
    const reader=response.body.getReader(), chunks:Uint8Array[]=[];let size=0;
    try { while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>5*1024*1024)throw new VoiceError('TTS_AUDIO_TOO_LARGE');chunks.push(chunk.value);} }
    finally {await reader.cancel().catch(()=>{});}
    if(!size||options.signal.aborted)throw new VoiceError('TTS_INCOMPLETE');
    return {bytes:Buffer.concat(chunks),mime:'audio/mpeg',name:'reply.mp3'};
  }
  async *synthesize(options: Parameters<TtsProvider['synthesize']>[0]): AsyncIterable<TtsAudioChunk> {
    validateAudioFormat(options.outputFormat);
    if (options.outputFormat.sampleRate !== 16000) throw new VoiceError('UNSUPPORTED_AUDIO_FORMAT');
    if (!this.key) throw new VoiceError('TTS_CREDENTIALS_MISSING');
    const socket = await this.connect('wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14', { 'X-API-Key': this.key }, options.signal);
    const contextId = randomUUID();
    const request = (transcript: string, more: boolean) => ({ model_id: this.model, transcript, voice: options.voiceId,
      context_id: contextId, language: options.language ?? 'en', output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 }, continue: more });
    let sendError: unknown, done = false;
    const sending = (async () => {
      for await (const text of options.text) { if (options.signal.aborted) return; await socket.send(request(text, true)); }
      await socket.send(request('', false));
    })().catch(error => { sendError = error; socket.close(); });
    let chunkSeq = 0;
    try {
      for await (const message of socket.messages) {
        if (options.signal.aborted) return;
        if (message.context_id && message.context_id !== contextId) continue;
        if (message.type === 'error') throw providerVoiceError('TTS', undefined, message);
        if (message.type === 'chunk' && typeof message.data === 'string') yield { bytes: Buffer.from(message.data, 'base64'), format: options.outputFormat, chunkSeq: chunkSeq++ };
        if (message.type === 'done') { done = true; break; }
      }
      await sending; if (sendError) throw sendError;
      if (!done && !options.signal.aborted) throw new VoiceError('TTS_INCOMPLETE');
    } finally { socket.close(); }
  }
}
