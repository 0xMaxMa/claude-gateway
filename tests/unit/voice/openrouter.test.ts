jest.mock('../../../src/config/claude-settings', () => ({
  claudeSettingsEnv: () => ({}),
}));
import {
  OpenRouterTts,
  openRouterVoiceModels,
  transcribeOpenRouter,
} from '../../../src/voice/providers/openrouter';
import { nativeVoiceModel } from '../../../src/voice/providers/model-ref';
import {
  resolveVoiceId,
  voiceChoices,
} from '../../../src/voice/providers/voice-catalog';
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  jest.restoreAllMocks();
});
test('OpenRouter keeps nested model IDs on its own billing route', () => {
  expect(
    nativeVoiceModel(
      'upstream:openrouter',
      'openrouter/google/gemini-3.1-flash-tts-preview'
    )
  ).toBe('google/gemini-3.1-flash-tts-preview');
  expect(
    nativeVoiceModel('openrouter', 'google/gemini-3.1-flash-tts-preview')
  ).toBe('google/gemini-3.1-flash-tts-preview');
  expect(() => nativeVoiceModel('gemini', 'openrouter/google/test')).toThrow();
  expect(() => nativeVoiceModel('openrouter', '../test')).toThrow();
});
test('OpenRouter synthesis requests MP3 with the selected model and voice', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  const request = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => new Response(Buffer.from('mp3-fixture'))
  );
  const tts = new OpenRouterTts('openrouter', 'deepgram/aura-2', request);
  const file = await tts.synthesizeFile({
    text: 'こんにちは',
    voiceId: 'aura-2-thalia-en',
    signal: new AbortController().signal,
  });
  expect(Buffer.from(file.bytes).toString()).toBe('mp3-fixture');
  expect(String(request.mock.calls[0][0])).toBe(
    'https://openrouter.ai/api/v1/audio/speech'
  );
  expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({
    model: 'deepgram/aura-2',
    input: 'こんにちは',
    voice: 'aura-2-thalia-en',
    response_format: 'mp3',
  });
});
test('OpenRouter STT uses dedicated multipart transcription and preserves language', async () => {
  process.env.OPENROUTER_API_KEY = 'test';
  const request = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => new Response(JSON.stringify({ text: 'こんにちは' }))
  );
  expect(
    await transcribeOpenRouter(
      Buffer.from('RIFF012345'),
      {
        provider: 'openrouter',
        model: 'openai/whisper-1',
        language: 'ja',
        signal: new AbortController().signal,
      },
      request
    )
  ).toBe('こんにちは');
  expect(String(request.mock.calls[0][0])).toBe(
    'https://openrouter.ai/api/v1/audio/transcriptions'
  );
  const form = request.mock.calls[0][1]!.body as FormData;
  expect(form.get('model')).toBe('openai/whisper-1');
  expect(form.get('language')).toBe('ja');
});
test('catalog distinguishes dedicated transcription from general audio reasoning and Auto stays model-specific', async () => {
  process.env.OPENROUTER_API_KEY = 'catalog-fixture';
  const models = [
    {
      id: 'google/tts',
      architecture: { output_modalities: ['speech'] },
      supported_voices: ['Kore'],
    },
    {
      id: 'other/tts',
      architecture: { output_modalities: ['speech'] },
      supported_voices: ['Alpha'],
    },
    {
      id: 'openai/stt',
      architecture: {
        input_modalities: ['audio'],
        output_modalities: ['transcription'],
      },
    },
    {
      id: 'audio/reasoner',
      architecture: {
        input_modalities: ['audio'],
        output_modalities: ['text'],
      },
    },
  ];
  jest
    .spyOn(global, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify({ data: models }))
    );
  expect((await openRouterVoiceModels('openrouter')).map((m) => m.id)).toEqual([
    'google/tts',
    'other/tts',
    'openai/stt',
  ]);
  expect(
    await resolveVoiceId({
      provider: 'openrouter',
      voiceId: '',
      model: 'openrouter/google/tts',
    })
  ).toBe('Kore');
  expect(
    await resolveVoiceId({
      provider: 'openrouter',
      voiceId: '',
      model: 'openrouter/other/tts',
    })
  ).toBe('Alpha');
  expect(
    (
      await voiceChoices({
        provider: 'openrouter',
        voiceId: '',
        model: 'google/tts',
      })
    ).map((v) => v.id)
  ).toEqual(['Kore']);
});
