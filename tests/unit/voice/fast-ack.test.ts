import { VoiceSession } from '../../../src/voice/session';
import { FakeSttProvider } from '../../../src/voice/providers/fake';
import { PCM16, TtsProvider } from '../../../src/voice/types';
import { BoundedQueue } from '../../../src/orchestration/bounded-queue';
import { fastAckText, fastAcknowledgement } from '../../../src/voice/fast-ack';
import { resolveOrchestrationConfig, ORCHESTRATION_DEFAULTS } from '../../../src/orchestration/config';
import { VOICE_CALL_VAD } from '../../../src/ui/voice-call-client';

/** One admitted turn with a fast acknowledgement wired in; the reply speaks when the test pushes to `stream`. */
async function call(ackAfterMs: number, ackReply: string | undefined) {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [], spoken: string[] = [], timing: any[] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(4096, value => Buffer.byteLength(value.text));
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { let sequence = 0; for await (const text of options.text) { spoken.push(text); yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: sequence++ }; } } };
  const acknowledge = jest.fn(async () => ackReply);
  const submit = jest.fn(async () => ({ inputId: 'input', response: new Promise<string>(() => {}), stream }));
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: c => audio.push(c), bufferedBytes: () => 0 }, submit, jest.fn(),
    { silenceCommitMs: 0, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 0, acknowledge, fastAckAfterMs: ackAfterMs },
    undefined, undefined, event => timing.push(event));
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };
  await session.start();
  const listening = controls.at(-1)!;
  await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
  session.speechEnded(1);
  await waitFor(() => !!stt.sessions[0].commitId);
  stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'ราคา Bitcoin ตอนนี้เท่าไหร่' });
  stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
  await waitFor(() => controls.some(c => c.type === 'utterance.accepted'));
  const phases = () => timing.filter(e => e.operation === 'turn').map(e => e.phase);
  return { session, stream, spoken, controls, acknowledge, submit, phases, waitFor, audio };
}

test('a slow reply gets the acknowledgement first, as audio only, then the reply itself', async () => {
  const { session, stream, spoken, controls, acknowledge, submit, phases, waitFor } = await call(30, 'รับทราบค่ะ กำลังเช็คให้นะคะ');
  try {
    expect(acknowledge).toHaveBeenCalledWith('ราคา Bitcoin ตอนนี้เท่าไหร่', expect.any(AbortSignal));
    await waitFor(() => spoken.length === 1);
    expect(spoken).toEqual(['รับทราบค่ะ กำลังเช็คให้นะคะ']);
    expect(phases()).toContain('fast_ack_sent');
    expect(controls.find(c => c.type === 'playback.start')).toMatchObject({ phase: 'acknowledgement', response_id: undefined });
    stream.push({ responseId: 'reply', text: 'ตอนนี้ราคาอยู่ที่ประมาณหกหมื่นเจ็ดพันดอลลาร์ค่ะ' });
    // The reply follows once the acknowledgement has been heard.
    session.progress(session.playback.epoch, 320);
    await waitFor(() => spoken.length === 2);
    // Not part of the conversation: no turn submitted, no response text, nothing for the chat.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(controls.filter(c => c.type === 'response.text' || c.type === 'response.speech').map(c => c.text)).toEqual(['ตอนนี้ราคาอยู่ที่ประมาณหกหมื่นเจ็ดพันดอลลาร์ค่ะ']);
  } finally { stream.close(); await session.close(); }
});

test('a reply that starts speaking within the threshold skips the acknowledgement', async () => {
  const { session, stream, spoken, phases, waitFor } = await call(200, 'รับทราบค่ะ');
  try {
    stream.push({ responseId: 'reply', text: 'ได้ค่ะ' });
    await waitFor(() => spoken.length === 1);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(spoken).toEqual(['ได้ค่ะ']);
    expect(phases()).not.toContain('fast_ack_sent');
  } finally { stream.close(); await session.close(); }
});

test('no acknowledgement fits (greeting, small talk): nothing is spoken and the skip is marked', async () => {
  const { session, stream, spoken, phases, waitFor } = await call(10, undefined);
  try {
    await waitFor(() => phases().includes('fast_ack_skipped'));
    expect(spoken).toEqual([]);
  } finally { stream.close(); await session.close(); }
});

test('an acknowledgement is spoken only if it is one short phrase without facts', () => {
  expect(fastAckText(' รับทราบค่ะ กำลังเช็คให้นะคะ ')).toBe('รับทราบค่ะ กำลังเช็คให้นะคะ');
  for (const reply of ['-', '', 'ราคาอยู่ที่ 67,240 ดอลลาร์', 'See https://example.com', '**OK**', 'line one\nline two', 'x'.repeat(81), 'ราคา ๖๗ บาท']) expect(fastAckText(reply)).toBeUndefined();
});

test('the call goes to the agent model endpoint with thinking off, and reports tokens', async () => {
  const fetch = jest.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: 'text', text: 'รับทราบค่ะ' }], usage: { input_tokens: 120, output_tokens: 9 } }), { headers: { 'content-type': 'application/json' } }));
  const result = await fastAcknowledgement('ราคาเท่าไหร่', { model: 'claude-haiku-5-5', timeoutMs: 1000, gender: 'female', signal: new AbortController().signal,
    connection: () => ({ baseUrl: 'https://provider.test', apiKey: 'token', scheme: 'oauth' }), fetch: fetch as unknown as typeof globalThis.fetch });
  expect(result).toMatchObject({ text: 'รับทราบค่ะ', outcome: 'ready', inputTokens: 120, outputTokens: 9 });
  const [url, init] = fetch.mock.calls[0];
  expect(String(url)).toBe('https://provider.test/v1/messages');
  const body = JSON.parse(String(init!.body));
  expect(body).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'ราคาเท่าไหร่' }] });
  expect(body.system).toContain('ค่ะ');
  // A subscription token is never sent straight to Anthropic.
  const direct = await fastAcknowledgement('x', { model: 'claude-haiku-5-5', timeoutMs: 1000, signal: new AbortController().signal,
    connection: () => ({ baseUrl: 'https://api.anthropic.com', apiKey: 'token', scheme: 'oauth' }), fetch: fetch as unknown as typeof globalThis.fetch });
  expect(direct.outcome).toBe('failed');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('voice.live.fastAck is on by default, explicit false turns it off, and settings are validated', () => {
  const live = (value: Record<string, unknown>) => resolveOrchestrationConfig(undefined, { ...ORCHESTRATION_DEFAULTS.voice, live: value as never }).voice.live;
  expect(live({})).toEqual({ fastAck: true, fastAckModel: 'claude-haiku-5-5', fastAckAfterMs: 1500, fastAckTimeoutMs: 3000, vad: VOICE_CALL_VAD });
  // An agent with no voice.live block at all, as most saved configs are.
  expect(resolveOrchestrationConfig(undefined, { enabled: false }).voice.live.fastAck).toBe(true);
  expect(resolveOrchestrationConfig(undefined).voice.live.fastAck).toBe(true);
  expect(live({ fastAck: false })).toEqual({ fastAck: false, fastAckModel: 'claude-haiku-5-5', fastAckAfterMs: 1500, fastAckTimeoutMs: 3000, vad: VOICE_CALL_VAD });
  expect(live({ fastAck: true, fastAckAfterMs: 1200 })).toMatchObject({ fastAck: true, fastAckAfterMs: 1200 });
  expect(() => live({ fastAck: 'yes' })).toThrow('voice.live.fastAck');
  expect(() => live({ fastAckAfterMs: 0 })).toThrow('voice.live.fastAckAfterMs');
  expect(() => live({ unknown: true })).toThrow('voice.live.unknown');
});

test('speaking again before the acknowledgement is due cancels it', async () => {
  const { session, stream, spoken, phases } = await call(100, 'รับทราบค่ะ');
  try {
    session.speechStarted(session.playback.epoch + 1);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(spoken).toEqual([]);
    expect(phases()).not.toContain('fast_ack_sent');
  } finally { stream.close(); await session.close(); }
});
