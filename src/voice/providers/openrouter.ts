import { providerHttpError, voiceProviderRequest } from '../errors';
import { PCM16, TtsProvider, VoiceError } from '../types';
import { EncodedAudioTts } from './encoded-audio-tts';
import { RecordedStt } from './recorded-stt';
import { upstreamVoiceConnection } from './upstream';

export function openRouterConnection(provider: string) {
  if (provider === 'upstream:openrouter')
    return upstreamVoiceConnection('openrouter');
  return {
    base: new URL('https://openrouter.ai/api/v1/'),
    key: process.env.OPENROUTER_API_KEY ?? '',
  };
}
export type OpenRouterVoiceModel = {
  id: string;
  name?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_voices?: string[];
};
export async function openRouterVoiceModels(
  provider: string,
  request: typeof fetch = fetch
): Promise<OpenRouterVoiceModel[]> {
  const { base, key } = openRouterConnection(provider);
  const url = new URL('models', base);
  url.searchParams.set('output_modalities', 'all');
  const r = await voiceProviderRequest(
    url,
    {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    },
    request
  );
  if (!r.ok) throw await providerHttpError('VOICE', r);
  const body = (await r.json()) as { data?: OpenRouterVoiceModel[] };
  if (!Array.isArray(body.data))
    throw new VoiceError('VOICE_CATALOG_UNAVAILABLE');
  return body.data.filter(
    (m) =>
      m.architecture?.output_modalities?.includes('speech') ||
      m.architecture?.output_modalities?.includes('transcription')
  );
}
export async function transcribeOpenRouter(
  audio: Uint8Array,
  options: {
    provider: string;
    model: string;
    language?: string;
    signal: AbortSignal;
  },
  request: typeof fetch = fetch
): Promise<string> {
  if (!audio.length || audio.length > 25 * 1024 * 1024)
    throw new VoiceError('VOICE_NOTE_SIZE_LIMIT');
  const { base, key } = openRouterConnection(options.provider);
  if (!key) throw new VoiceError('STT_CREDENTIALS_MISSING');
  const data = new FormData();
  data.set('model', options.model);
  const bytes = Buffer.from(audio);
  const wav = bytes.toString('ascii', 0, 4) === 'RIFF',
    ogg = bytes.toString('ascii', 0, 4) === 'OggS';
  const ext = wav
    ? 'wav'
    : ogg
      ? 'ogg'
      : bytes.toString('ascii', 0, 4) === 'fLaC'
        ? 'flac'
        : bytes.toString('ascii', 4, 8) === 'ftyp'
          ? 'mp4'
          : bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
            ? 'webm'
            : 'mp3';
  data.set(
    'file',
    new Blob([new Uint8Array(audio)], {
      type: ext === 'mp3' ? 'audio/mpeg' : 'audio/' + ext,
    }),
    'speech.' + ext
  );
  if (options.language) data.set('language', options.language);
  const r = await voiceProviderRequest(
    new URL('audio/transcriptions', base),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: data,
      signal: options.signal,
      redirect: 'error',
    },
    request
  );
  if (!r.ok) throw await providerHttpError('STT', r);
  const body = (await r.json()) as { text?: unknown };
  if (typeof body.text !== 'string' || body.text.length > 60000)
    throw new VoiceError('STT_PROVIDER_ERROR');
  return body.text.trim();
}
export class OpenRouterStt extends RecordedStt {
  constructor(provider: string, model: string, request: typeof fetch = fetch) {
    super(provider, model, request, transcribeOpenRouter, () => {
      if (!openRouterConnection(provider).key)
        throw new VoiceError('STT_CREDENTIALS_MISSING');
    });
  }
}
export class OpenRouterTts extends EncodedAudioTts {
  readonly capabilities = {
    textStreaming: false,
    wordAlignment: false,
    outputFormats: [PCM16],
  };
  constructor(
    id: string,
    private readonly model: string,
    private readonly request: typeof fetch = fetch
  ) {
    super(id);
  }
  protected get pcmSampleRate() {
    return this.model.startsWith('google/gemini-') ? 24000 : undefined;
  }
  protected async *audio(
    options: Pick<
      Parameters<TtsProvider['synthesize']>[0],
      'text' | 'voiceId' | 'signal'
    >
  ): AsyncIterable<Buffer> {
    const { base, key } = openRouterConnection(this.id);
    if (!key) throw new VoiceError('TTS_CREDENTIALS_MISSING');
    let text = '';
    for await (const part of options.text) {
      options.signal.throwIfAborted();
      text += part;
      if (text.length > 12000) throw new VoiceError('TTS_TEXT_TOO_LARGE');
    }
    if (!text.trim()) return;
    const r = await voiceProviderRequest(
      new URL('audio/speech', base),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice: options.voiceId,
          response_format: this.pcmSampleRate ? 'pcm' : 'mp3',
        }),
        signal: options.signal,
        redirect: 'error',
      },
      this.request
    );
    if (!r.ok) throw await providerHttpError('TTS', r);
    if (!r.body) throw new VoiceError('TTS_INCOMPLETE');
    const reader = r.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024)
          throw new VoiceError('TTS_AUDIO_TOO_LARGE');
        yield Buffer.from(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!size) throw new VoiceError('TTS_INCOMPLETE');
  }
}
