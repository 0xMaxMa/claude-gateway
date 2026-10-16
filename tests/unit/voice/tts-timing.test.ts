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
