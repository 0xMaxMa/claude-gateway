import { requireManagedVoiceCredit } from '../managed-quota';
import { OpenRouterStt, OpenRouterTts } from './openrouter';
import { canonicalVoiceProvider, nativeVoiceModel } from './model-ref';
import { GeminiStt, GeminiTts } from './gemini';
import { GeminiLiveStt } from './gemini-live-stt';
import { PaxaLabsStt } from './paxalabs-stt';
import { PaxaLabsLiveStt, isPaxaRealtimeSttModel } from './paxalabs-live-stt';
import { PaxaLabsTts, paxaConnection } from './paxalabs-tts';
import { upstreamVoiceConnection, upstreamVoiceSocket, managedVoiceSocket } from './upstream';
import { SttProvider, TtsProvider, VoiceError } from '../types';
import { ElevenLabsStt } from './elevenlabs-stt';
import { ElevenLabsTts } from './elevenlabs-tts';
import { DeepgramStt } from './deepgram-stt';
import { CartesiaTts } from './cartesia-tts';

function makeSttProvider(config: { provider: string; model: string }): SttProvider {
  config = { ...config, provider: canonicalVoiceProvider(config.provider), model: nativeVoiceModel(config.provider, config.model) };
  if (['openrouter','upstream:openrouter'].includes(config.provider)) return new OpenRouterStt(config.provider,config.model);
  if (['gemini', 'upstream:gemini'].includes(config.provider)) return config.model === 'gemini-3.5-transcribe-live' ? new GeminiLiveStt(config.provider, config.model) : new GeminiStt(config.provider, config.model);
  if (config.provider === 'managed:elevenlabs') return new ElevenLabsStt(upstreamVoiceConnection('elevenlabs', true).key, config.model, managedVoiceSocket, config.provider);
  if (config.provider === 'upstream:elevenlabs') return new ElevenLabsStt(upstreamVoiceConnection().key, config.model, upstreamVoiceSocket, 'upstream:elevenlabs');
  if (config.provider === 'elevenlabs') return new ElevenLabsStt(process.env.ELEVENLABS_API_KEY ?? '', config.model);
  if (['paxalabs', 'upstream:paxalabs', 'managed:paxalabs'].includes(config.provider)) return isPaxaRealtimeSttModel(config.model) ? new PaxaLabsLiveStt(config.provider, config.model) : new PaxaLabsStt(config.provider, config.model);
  if (config.provider === 'deepgram') return new DeepgramStt(process.env.DEEPGRAM_API_KEY ?? '', config.model);
  throw new VoiceError('UNKNOWN_STT_PROVIDER');
}
function makeTtsProvider(config: { provider: string; model: string }): TtsProvider {
  config = { ...config, provider: canonicalVoiceProvider(config.provider), model: nativeVoiceModel(config.provider, config.model) };
  if (['openrouter','upstream:openrouter'].includes(config.provider)) return new OpenRouterTts(config.provider,config.model);
  if (['gemini', 'upstream:gemini'].includes(config.provider)) return new GeminiTts(config.provider, config.model);
  if (config.provider === 'managed:elevenlabs') return new ElevenLabsTts(upstreamVoiceConnection('elevenlabs', true).key, config.model, managedVoiceSocket, config.provider);
  if (config.provider === 'upstream:elevenlabs') return new ElevenLabsTts(upstreamVoiceConnection().key, config.model, upstreamVoiceSocket, 'upstream:elevenlabs');
  if (config.provider === 'elevenlabs') return new ElevenLabsTts(process.env.ELEVENLABS_API_KEY ?? '', config.model);
  if (['paxalabs', 'upstream:paxalabs', 'managed:paxalabs'].includes(config.provider)) return new PaxaLabsTts(paxaConnection(config.provider), config.model, undefined, config.provider);
  if (config.provider === 'cartesia') return new CartesiaTts(process.env.CARTESIA_API_KEY ?? '', config.model);
  throw new VoiceError('UNKNOWN_TTS_PROVIDER');
}

export function sttProvider(config: { provider: string; model: string }): SttProvider {
  const provider = makeSttProvider(config);
  if (!config.provider.startsWith('managed:')) return provider;
  return { id: provider.id, capabilities: provider.capabilities, async open(options) {
    await requireManagedVoiceCredit(config.provider, undefined, options.signal);
    return provider.open(options);
  }};
}
export function ttsProvider(config: { provider: string; model: string }): TtsProvider {
  const provider = makeTtsProvider(config);
  if (!config.provider.startsWith('managed:')) return provider;
  return { id: provider.id, capabilities: provider.capabilities,
    synthesizeFile: provider.synthesizeFile ? async options => {
      await requireManagedVoiceCredit(config.provider, undefined, options.signal);
      return provider.synthesizeFile!(options);
    } : undefined,
    async *synthesize(options) {
      await requireManagedVoiceCredit(config.provider, undefined, options.signal);
      yield* provider.synthesize(options);
    },
  };
}
