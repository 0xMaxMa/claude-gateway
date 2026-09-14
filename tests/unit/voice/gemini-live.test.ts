jest.mock('../../../src/config/claude-settings', () => ({
  claudeSettingsEnv: () => ({}),
}));
import { GeminiLiveStt } from '../../../src/voice/providers/gemini-live-stt';
import { BoundedQueue } from '../../../src/voice/queue';
import { PCM16 } from '../../../src/voice/types';
import { VoiceTurnManager } from '../../../src/voice/turn-manager';
import { SocketFactory } from '../../../src/voice/providers/socket';
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});
test('live Gemini partial/final + generationComplete commits once and supports the next utterance', async () => {
  process.env.GEMINI_API_KEY = 'key';
  const messages = new BoundedQueue<Record<string, any>>(10000, () => 1);
  const sent: any[] = [];
  const connect: SocketFactory = async () => ({
    messages,
    audio: async () => {},
    close: () => messages.close(),
    send: async (value: any) => {
      sent.push(value);
      if (value.setup) messages.push({ setupComplete: {} });
      if (value.realtimeInput?.audio) {
        messages.push({
          serverContent: { interimInputTranscription: { text: 'Hello' } },
        });
      }
      if (value.realtimeInput?.audioStreamEnd) {
        messages.push({
          serverContent: { inputTranscription: { text: 'Hello world' } },
        });
        messages.push({ serverContent: { generationComplete: true } });
      }
    },
  });
  const session = await new GeminiLiveStt(
    'gemini',
    'gemini-3.5-transcribe-live',
    connect
  ).open({ format: PCM16, signal: new AbortController().signal });
  let turn = new VoiceTurnManager(session, 16000, 500);
  const events: any[] = [];
  const reading = (async () => {
    for await (const event of session.events) {
      events.push(event);
      turn.event(event);
    }
  })();
  for (let i = 0; i < 2; i++) {
    turn = new VoiceTurnManager(session, 16000, 500);
    await turn.pushAudio(1, Buffer.alloc(3200));
    expect(await turn.commit(1)).toBe('Hello world');
  }
  expect(events.filter((e) => e.type === 'commit_done')).toHaveLength(2);
  expect(events.some((e) => e.type === 'partial')).toBe(true);
  expect(sent.filter((v) => v.realtimeInput?.audioStreamEnd)).toHaveLength(2);
  await session.close();
  await reading;
});
test('Gemini rejects setup errors promptly rather than leaving an open voice session', async () => {
  process.env.GEMINI_API_KEY = 'key';
  const messages = new BoundedQueue<Record<string, any>>(10000, () => 1);
  const close = jest.fn(() => messages.close());
  const connect: SocketFactory = async () => ({
    messages,
    audio: async () => {},
    close,
    send: async () => {
      messages.push({ error: { code: 429, message: 'quota exceeded' } });
    },
  });
  await expect(
    new GeminiLiveStt('gemini', 'gemini-3.5-transcribe-live', connect).open({
      format: PCM16,
      signal: new AbortController().signal,
    })
  ).rejects.toThrow();
  expect(close).toHaveBeenCalled();
});
