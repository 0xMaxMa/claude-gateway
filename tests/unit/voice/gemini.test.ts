jest.mock('../../../src/config/claude-settings', () => ({claudeSettingsEnv: () => ({})}));
import { GeminiStt, GeminiTts, geminiConnection, geminiGenerate } from '../../../src/voice/providers/gemini';
import { PCM16 } from '../../../src/voice/types';
import { VoiceTurnManager } from '../../../src/voice/turn-manager';

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
test('Gemini batch STT commits each recording once and preserves Japanese', async () => {
  process.env.GEMINI_API_KEY = 'test';
  const request = jest.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'こんにちは' }] } }] }))) as jest.MockedFunction<typeof fetch>;
  const provider = new GeminiStt('gemini', 'gemini-2.5-flash', request);
  expect(provider.capabilities.mode).toBe('batch');
  const session = await provider.open({ format: PCM16, language: 'ja', signal: new AbortController().signal });
  let turn = new VoiceTurnManager(session, 16000);
  const consuming = (async () => { for await (const event of session.events) turn.event(event); })();
  await turn.pushAudio(1, Buffer.alloc(640));
  expect(request).not.toHaveBeenCalled();
  expect(await turn.commit(1)).toBe('こんにちは');
  const body = JSON.parse(request.mock.calls[0][1]!.body as string);
  expect(body.contents[0].parts[1].inlineData.mimeType).toBe('audio/wav');
  expect(Buffer.from(body.contents[0].parts[1].inlineData.data, 'base64').length).toBe(684);
  turn = new VoiceTurnManager(session, 16000);
  await turn.pushAudio(1, Buffer.alloc(320));
  expect(await turn.commit(1)).toBe('こんにちは');
  expect(Buffer.from(JSON.parse(request.mock.calls[1][1]!.body as string).contents[0].parts[1].inlineData.data, 'base64').length).toBe(364);
  await session.close(); await consuming;
});
test('Gemini TTS preserves selected voice and converts 24kHz PCM to transport rate', async () => {
  process.env.GEMINI_API_KEY = 'test';
  const pcm = Buffer.alloc(4800); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  const request = jest.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] }))) as jest.MockedFunction<typeof fetch>;
  const bytes: Buffer[] = [];
  for await (const chunk of new GeminiTts('gemini', 'gemini-3.1-flash-tts-preview', request).synthesize({ text: (async function* () { yield 'Hello'; })(), voiceId: 'Kore', outputFormat: PCM16, signal: new AbortController().signal })) bytes.push(Buffer.from(chunk.bytes));
  expect(Buffer.concat(bytes).length).toBe(3200);
  expect(bytes[0].readInt16LE(0)).toBe(1000);
  expect(JSON.parse(request.mock.calls[0][1]!.body as string).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
});
test('upstream Gemini sends pod credentials only to configured provider proxy', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://provider.test'; process.env.ANTHROPIC_AUTH_TOKEN = 'pod'; process.env.GEMINI_API_KEY = 'byok';
  const connection = geminiConnection('upstream:gemini');
  expect(connection.base.href).toBe('https://provider.test/v1/voice/gemini/');
  expect(connection.headers).toEqual({ Authorization: 'Bearer pod' });
});

test('BYOK namespace is stripped only for its selected provider', () => {
  const { nativeVoiceModel } = require('../../../src/voice/providers/model-ref');
  expect(nativeVoiceModel('upstream:gemini', 'gemini/gemini-2.5-flash')).toBe('gemini-2.5-flash');
  expect(nativeVoiceModel('upstream', 'elevenlabs/eleven_v3')).toBe('eleven_v3');
  expect(nativeVoiceModel('upstream', 'eleven_v3')).toBe('eleven_v3');
  expect(() => nativeVoiceModel('upstream:gemini', 'elevenlabs/eleven_v3')).toThrow('VOICE_MODEL_PROVIDER_MISMATCH');
});

test('Gemini preserves HTTP status without exposing provider response content', async () => {
  process.env.GEMINI_API_KEY = 'test';
  const request = jest.fn(async () => new Response('private upstream detail', {status:429})) as unknown as typeof fetch;
  await expect(geminiGenerate('gemini', 'gemini-3.1-flash-tts-preview', {}, new AbortController().signal, request)).rejects.toThrow('VOICE_PROVIDER_ERROR_HTTP_429');
});
