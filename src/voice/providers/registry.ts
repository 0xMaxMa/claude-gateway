import { nativeVoiceModel } from './model-ref';
import { GeminiStt, GeminiTts } from './gemini';
import { PaxaLabsStt } from './paxalabs-stt';
import { PaxaLabsTts, paxaConnection } from './paxalabs-tts';
import { upstreamVoiceConnection, upstreamVoiceSocket } from './upstream';
import { SttProvider, TtsProvider, VoiceError } from '../types';
import { ElevenLabsStt } from './elevenlabs-stt';
import { ElevenLabsTts } from './elevenlabs-tts';
import { DeepgramStt } from './deepgram-stt';
import { CartesiaTts } from './cartesia-tts';

export function sttProvider(config: { provider: string; model: string }): SttProvider {
  config = { ...config, model: nativeVoiceModel(config.provider, config.model) };
  if (['gemini', 'upstream:gemini'].includes(config.provider)) return new GeminiStt(config.provider, config.model);
  if (config.provider === 'upstream') return new ElevenLabsStt(upstreamVoiceConnection().key, config.model, upstreamVoiceSocket);
  if (config.provider === 'elevenlabs') return new ElevenLabsStt(process.env.ELEVENLABS_API_KEY ?? '', config.model);
  if (['paxalabs', 'upstream:paxalabs'].includes(config.provider)) return new PaxaLabsStt(config.provider, config.model);
  if (config.provider === 'deepgram') return new DeepgramStt(process.env.DEEPGRAM_API_KEY ?? '', config.model);
  throw new VoiceError('UNKNOWN_STT_PROVIDER');
}
export function ttsProvider(config: { provider: string; model: string }): TtsProvider {
  config = { ...config, model: nativeVoiceModel(config.provider, config.model) };
  if (['gemini', 'upstream:gemini'].includes(config.provider)) return new GeminiTts(config.provider, config.model);
  if (config.provider === 'upstream') return new ElevenLabsTts(upstreamVoiceConnection().key, config.model, upstreamVoiceSocket);
  if (config.provider === 'elevenlabs') return new ElevenLabsTts(process.env.ELEVENLABS_API_KEY ?? '', config.model);
  if (['paxalabs', 'upstream:paxalabs'].includes(config.provider)) return new PaxaLabsTts(paxaConnection(config.provider), config.model, undefined, config.provider);
  if (config.provider === 'cartesia') return new CartesiaTts(process.env.CARTESIA_API_KEY ?? '', config.model);
  throw new VoiceError('UNKNOWN_TTS_PROVIDER');
}
