jest.mock('../../../src/config/claude-settings', () => ({ claudeSettingsEnv: () => ({ ANTHROPIC_BASE_URL: 'https://provider.test', ANTHROPIC_AUTH_TOKEN: 'pod-token' }) }));
const mockSocket = { connect: undefined as any };
jest.mock('../../../src/voice/providers/upstream', () => ({ ...jest.requireActual('../../../src/voice/providers/upstream'), managedVoiceSocket: (...args: unknown[]) => mockSocket.connect(...args) }));
import { BoundedQueue } from '../../../src/voice/queue';
import { PCM16 } from '../../../src/voice/types';
import { ttsProvider } from '../../../src/voice/providers/registry';
import { tracedAudio, voiceTrace } from '../../../src/voice/diagnostics';

afterEach(() => jest.restoreAllMocks());

test('managed TTS marks the wallet check and the provider socket opening on the TTS trace', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ remaining: 10 }), { headers: { 'content-type': 'application/json' } }));
  const messages = new BoundedQueue<Record<string, any>>(65536, value => JSON.stringify(value).length);
  mockSocket.connect = jest.fn(async () => ({ messages, send: async () => {}, audio: async () => {}, close: () => messages.close() }));
  const phases: string[] = [];
  const trace = voiceTrace('tts', event => phases.push(event.phase));
  const tts = ttsProvider({ provider: 'managed:elevenlabs', model: 'getpod-voice/elevenlabs/eleven_v3_conversational' });
  async function* text() { yield 'hello'; }
  const iterator = tracedAudio(tts.synthesize({ text: text(), voiceId: 'voice', outputFormat: PCM16, signal: new AbortController().signal }), trace)[Symbol.asyncIterator]();
  const first = iterator.next();
  messages.push({ audio: Buffer.alloc(320).toString('base64') });
  await first;
  messages.push({ is_final: true });
  expect((await iterator.next()).done).toBe(true);
  expect(phases).toEqual(['tts_credit_check_started', 'tts_credit_check_finished', 'tts_socket_open']);
});

test('managed TTS checks the wallet once per reply: its spoken pieces share the reply signal, and the next reply checks again', async () => {
  const usage = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ remaining: 10 }), { headers: { 'content-type': 'application/json' } }));
  mockSocket.connect = jest.fn(async () => {
    const messages = new BoundedQueue<Record<string, any>>(65536, value => JSON.stringify(value).length);
    messages.push({ audio: Buffer.alloc(320).toString('base64') }); messages.push({ is_final: true });
    return { messages, send: async () => {}, audio: async () => {}, close: () => messages.close() };
  });
  const tts = ttsProvider({ provider: 'managed:elevenlabs', model: 'getpod-voice/elevenlabs/eleven_v3_conversational' });
  const speak = async (text: string, signal: AbortSignal) => {
    async function* pieces() { yield text; }
    for await (const _chunk of tts.synthesize({ text: pieces(), voiceId: 'voice', outputFormat: PCM16, signal })) { /* drain */ }
  };
  const reply = new AbortController().signal;
  for (const sentence of ['One.', 'Two.', 'Three.']) await speak(sentence, reply);
  expect(usage).toHaveBeenCalledTimes(1);
  expect(mockSocket.connect).toHaveBeenCalledTimes(3);
  await speak('Next reply.', new AbortController().signal);
  expect(usage).toHaveBeenCalledTimes(2);
});

test('an exhausted wallet is never reused: the next reply checks again and plays once credit is back', async () => {
  const usage = jest.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(async () => new Response(JSON.stringify({ remaining: 0 })))
    .mockImplementation(async () => new Response(JSON.stringify({ remaining: 10 })));
  mockSocket.connect = jest.fn(async () => {
    const messages = new BoundedQueue<Record<string, any>>(65536, value => JSON.stringify(value).length);
    messages.push({ is_final: true });
    return { messages, send: async () => {}, audio: async () => {}, close: () => messages.close() };
  });
  const tts = ttsProvider({ provider: 'managed:elevenlabs', model: 'getpod-voice/elevenlabs/eleven_v3_conversational' });
  const speak = async (signal: AbortSignal) => { async function* pieces() { yield 'Hello.'; } for await (const _chunk of tts.synthesize({ text: pieces(), voiceId: 'voice', outputFormat: PCM16, signal })) { /* drain */ } };
  await expect(speak(new AbortController().signal)).rejects.toMatchObject({ code: 'MANAGED_VOICE_QUOTA_EXHAUSTED' });
  await expect(speak(new AbortController().signal)).resolves.toBeUndefined();
  expect(usage).toHaveBeenCalledTimes(2);
});
