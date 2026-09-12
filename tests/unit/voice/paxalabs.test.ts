jest.mock('../../../src/config/claude-settings', () => ({claudeSettingsEnv: () => ({})}));
import { PaxaLabsStt, transcribePaxa } from '../../../src/voice/providers/paxalabs-stt';
import { PCM16 } from '../../../src/voice/types';
import { VoiceTurnManager } from '../../../src/voice/turn-manager';

describe('Paxa batch recognition', () => {
  const previous = process.env.PAXALABS_API_KEY;
  beforeEach(() => { process.env.PAXALABS_API_KEY = 'fixture-key'; });
  afterAll(() => { if (previous === undefined) delete process.env.PAXALABS_API_KEY; else process.env.PAXALABS_API_KEY = previous; });
  test('waits for commit, sends WAV and does not reuse audio across turns', async () => {
    const request = jest.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify({ text: 'สวัสดี' }))) as jest.MockedFunction<typeof fetch>;
    const provider = new PaxaLabsStt('paxalabs', 'paxa-stt-lite-v1-preview', request);
    expect(provider.capabilities.partials).toBe(false);
    const stt = await provider.open({ format: PCM16, language: 'th', signal: new AbortController().signal });
    let turn = new VoiceTurnManager(stt, 16000);
    const consuming = (async () => { for await (const event of stt.events) turn.event(event); })();
    await turn.pushAudio(1, Buffer.alloc(640, 1));
    expect(request).not.toHaveBeenCalled();
    await expect(turn.commit(1)).resolves.toBe('สวัสดี');
    const body = JSON.parse(request.mock.calls[0][1]!.body as string);
    const wav = Buffer.from(body.audio, 'base64');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.length).toBe(684);
    expect(body.language).toBe('th');
    turn = new VoiceTurnManager(stt, 16000);
    await turn.pushAudio(1, Buffer.alloc(320, 2));
    await expect(turn.commit(1)).resolves.toBe('สวัสดี');
    expect(Buffer.from(JSON.parse(request.mock.calls[1][1]!.body as string).audio, 'base64').length).toBe(364);
    await stt.close(); await consuming;
  });
  test('rejects unsupported language before recording', async () => {
    await expect(new PaxaLabsStt().open({ format: PCM16, language: 'ja', signal: new AbortController().signal })).rejects.toThrow('STT_LANGUAGE_UNSUPPORTED');
  });
  test('provider failures reject the turn instead of submitting invented text', async () => {
    const request = jest.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response('', { status: 503 })) as jest.MockedFunction<typeof fetch>;
    const stt = await new PaxaLabsStt('paxalabs', undefined, request).open({ format: PCM16, signal: new AbortController().signal });
    const turn = new VoiceTurnManager(stt, 16000);
    await turn.pushAudio(1, Buffer.alloc(640));
    await expect(turn.commit(1)).rejects.toThrow('STT_PROVIDER_ERROR_HTTP_503');
    await stt.close();
  });
  test('closing aborts an in-flight transcription', async () => {
    const request = jest.fn((_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true }))) as jest.MockedFunction<typeof fetch>;
    const stt = await new PaxaLabsStt('paxalabs', undefined, request).open({ format: PCM16, signal: new AbortController().signal });
    await stt.pushAudio(Buffer.alloc(640));
    const pending = stt.commitSegment('commit');
    const check = expect(pending).rejects.toThrow('PROVIDER_ABORTED');
    await stt.close(); await check;
  });
  test('batch voice notes preserve provider and model', async () => {
    const request = jest.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify({ text: 'hello' }))) as jest.MockedFunction<typeof fetch>;
    await expect(transcribePaxa(Buffer.from('recording'), { provider: 'paxalabs', model: 'paxa-stt-lite-v1-preview', signal: AbortSignal.timeout(1000) }, request)).resolves.toBe('hello');
    expect(String(request.mock.calls[0][0])).toBe('https://api.paxalabs.com/v1/stt');
  });
});

test('Paxa TTS keeps the chosen voice and binary MP3 frames', async () => {
  const { PaxaLabsTts } = await import('../../../src/voice/providers/paxalabs-tts');
  const { BoundedQueue } = await import('../../../src/voice/queue');
  const messages = new BoundedQueue<Record<string, unknown>>(65536, e => JSON.stringify(e).length);
  const send = jest.fn(async (_value: unknown) => {});
  const close = jest.fn(() => messages.close());
  const connect = jest.fn(async () => ({ messages, send, audio: async () => {}, close }));
  const tts = new PaxaLabsTts({ base: new URL('https://provider.test/v1/voice/paxalabs/'), key: 'fixture' }, undefined, connect, 'upstream:paxalabs');
  expect(tts.id).toBe('upstream:paxalabs');
  const result = tts.synthesizeFile({ text: 'hello', voiceId: 'nomyen', signal: new AbortController().signal });
  messages.push({ binaryAudio: Buffer.from('mp3') });
  messages.push({ type: 'done' });
  expect((await result).bytes).toEqual(Buffer.from('mp3'));
  expect(send).toHaveBeenCalledWith({ type: 'start', model: 'paxa-tts-flash-v1', voice: 'nomyen', format: 'mp3' });
  expect(close).toHaveBeenCalled();
});

test('Paxa cancellation does not wait for the next Agent text chunk', async () => {
  const { PaxaLabsTts } = await import('../../../src/voice/providers/paxalabs-tts');
  const { BoundedQueue } = await import('../../../src/voice/queue');
  const messages = new BoundedQueue<Record<string, unknown>>(65536, () => 1);
  const controller = new AbortController();
  const connect = async () => ({ messages, send: async () => {}, audio: async () => {}, close: () => messages.close() });
  const tts = new PaxaLabsTts({ base: new URL('https://api.paxalabs.com/v1/'), key: 'fixture' }, undefined, connect);
  async function* text() { yield 'hello'; await new Promise(() => {}); }
  const iterator = tts.synthesize({ text: text(), voiceId: 'nomyen', outputFormat: PCM16, signal: controller.signal })[Symbol.asyncIterator]();
  const result = iterator.next();
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await expect(result).resolves.toMatchObject({ done: true });
});
