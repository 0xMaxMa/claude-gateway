import { VoiceSession } from '../../../src/voice/session';
import { FakeSttProvider } from '../../../src/voice/providers/fake';
import { PCM16, TtsProvider } from '../../../src/voice/types';
import { fastAcknowledgement, fastAckText, fillerOnly } from '../../../src/voice/fast-ack';

/** A live call of several turns. Every reply is slow (it never speaks), so each eligible turn reaches the
 * acknowledgement deadline; the fake model returns `ackReply` for every request, like the canned phrase
 * observed in issue #625. */
async function call(ackReply: (transcript: string) => string | undefined, ackAfterMs = 20) {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], spoken: string[] = [], timing: any[] = [];
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { let sequence = 0; for await (const text of options.text) { spoken.push(text); yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: sequence++ }; } } };
  const acknowledge = jest.fn(async (transcript: string, _signal: AbortSignal, _context?: unknown) => ackReply(transcript));
  const finish: Array<() => void> = [];
  let submitted = 0;
  const submit = jest.fn(async (_text: string, _utteranceId: string, _mark?: unknown, _hints?: unknown): Promise<{ inputId: string; response: Promise<string> }> =>
    ({ inputId: `input-${++submitted}`, response: new Promise<string>(resolve => finish.push(() => resolve('answer'))) }));
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: () => {}, bufferedBytes: () => 0 }, submit, jest.fn(),
    { silenceCommitMs: 0, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 0, acknowledge, fastAckAfterMs: ackAfterMs },
    undefined, undefined, event => timing.push(event));
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };
  const decisions = () => timing.filter(e => e.operation === 'turn' && /^fast_ack_(sent|skipped)$/.test(e.phase));
  await session.start();
  let turns = 0;
  /** One caller turn: speak, wait for the acknowledgement decision, let any acknowledgement finish playing, end the reply. */
  const say = async (text: string) => {
    const before = decisions().length, previousCommit = stt.sessions[0].commitId;
    const listening = controls.filter(c => c.type === 'voice.state' && c.state === 'listening').at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    session.speechEnded(1);
    await waitFor(() => !!stt.sessions[0].commitId && stt.sessions[0].commitId !== previousCommit);
    stt.sessions[0].emit({ type: 'segment_final', segmentId: `s${++turns}`, text });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await waitFor(() => decisions().length > before);
    const decision = decisions().at(-1);
    if (decision.phase === 'fast_ack_sent') { await waitFor(() => session.playback.snapshot().generatedSamples > 0); session.progress(session.playback.epoch, session.playback.snapshot().generatedSamples); }
    finish.shift()?.();
    await new Promise(resolve => setTimeout(resolve, 20));
    return decision;
  };
  return { session, spoken, controls, timing, acknowledge, submit, say, waitFor };
}

const REQUESTS = ['ช่วยเปิด PR 623 ให้หน่อย', 'สรุป issue 625 ให้ฟังหน่อย', 'เช็คสถานะ CI ของ main ให้หน่อย', 'อ่านอีเมลล่าสุดให้ฟังหน่อย', 'ตั้งเตือนประชุมพรุ่งนี้เก้าโมง'];

test('a model that repeats the same canned phrase is not heard twice in one call (#625)', async () => {
  const { session, spoken, say } = await call(() => 'รับทราบค่ะ กำลังดูให้นะคะ');
  try {
    for (const request of REQUESTS) await say(request);
    expect(spoken).toEqual(['รับทราบค่ะ กำลังดูให้นะคะ']);
  } finally { await session.close(); }
});

test('near-identical acknowledgements are suppressed as duplicates, not only exact repeats (#625)', async () => {
  const phrases = ['รับทราบค่ะ กำลังดูให้นะคะ', 'รับทราบค่ะ กำลังดูให้เลยนะคะ', 'รับทราบนะคะ กำลังดูให้ค่ะ', 'รับทราบค่ะ, กำลังดูให้อยู่นะคะ'];
  let n = 0;
  const { session, spoken, say } = await call(() => phrases[n++ % phrases.length]);
  try {
    const decisions = [];
    for (const request of REQUESTS) decisions.push(await say(request));
    expect(decisions.map(d => d.code)).toEqual([undefined, 'cooldown', 'duplicate', 'duplicate', 'duplicate']);
    expect(spoken).toEqual(['รับทราบค่ะ กำลังดูให้นะคะ']);
  } finally { await session.close(); }
});

test('acknowledgements are sparse: back-to-back slow turns are not all acknowledged (#625)', async () => {
  const { session, spoken, say, acknowledge } = await call(transcript => transcript);
  try {
    const decisions = [];
    for (const request of REQUESTS) decisions.push(await say(request));
    expect(spoken.length).toBeLessThanOrEqual(Math.ceil(REQUESTS.length / 2));
    expect(decisions.map(d => d.phase)).toEqual(['fast_ack_sent', 'fast_ack_skipped', 'fast_ack_sent', 'fast_ack_skipped', 'fast_ack_sent']);
    expect(decisions.filter(d => d.phase === 'fast_ack_skipped').every(d => d.code === 'cooldown')).toBe(true);
    // A cooled-down turn costs no model request.
    expect(acknowledge).toHaveBeenCalledTimes(3);
  } finally { await session.close(); }
});

test.each(['เอ่อ เอาใหม่', 'um', 'อืม', 'Uh, wait…', 'เดี๋ยวนะ'])('a filler or restart fragment (%s) gets no acknowledgement and no model call (#625)', async fragment => {
  const { session, spoken, say, acknowledge } = await call(() => 'รับทราบค่ะ');
  try {
    const decision = await say(fragment);
    expect(decision).toMatchObject({ phase: 'fast_ack_skipped', code: 'filler' });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(spoken).toEqual([]);
  } finally { await session.close(); }
});

test('the acknowledgement request carries the recent caller turns and the acknowledgements already spoken', async () => {
  const { session, say, acknowledge } = await call(transcript => transcript.includes('PR') ? 'เดี๋ยวเปิด PR 623 ดูให้นะคะ' : undefined);
  try {
    await say('ช่วยเปิด PR 623 ให้หน่อย');
    await say('แล้วก็สรุปให้ฟังด้วย');
    await say('ดูเรื่อง CI ด้วยนะ');
    await say('อ่านอีเมลล่าสุดด้วย');
    // Turn 2 follows an acknowledged turn, so it makes no request.
    expect(acknowledge.mock.calls.map(c => c[0])).toEqual(['ช่วยเปิด PR 623 ให้หน่อย', 'ดูเรื่อง CI ด้วยนะ', 'อ่านอีเมลล่าสุดด้วย']);
    expect(acknowledge.mock.calls[0][2]).toEqual({ recentTurns: [], recentAcks: [] });
    expect(acknowledge.mock.calls[1][2]).toEqual({ recentTurns: ['ช่วยเปิด PR 623 ให้หน่อย', 'แล้วก็สรุปให้ฟังด้วย'], recentAcks: ['เดี๋ยวเปิด PR 623 ดูให้นะคะ'] });
    // Only the last two caller turns are context.
    expect(acknowledge.mock.calls[2][2]).toEqual({ recentTurns: ['แล้วก็สรุปให้ฟังด้วย', 'ดูเรื่อง CI ด้วยนะ'], recentAcks: ['เดี๋ยวเปิด PR 623 ดูให้นะคะ'] });
  } finally { await session.close(); }
});

test('the main turn is told an acknowledgement may already be spoken only when one can be', async () => {
  const { session, say, submit } = await call(() => 'เดี๋ยวดูให้นะคะ');
  try {
    await say('ช่วยเปิด PR 623 ให้หน่อย');
    await say('เอ่อ');
    await say('สรุป issue 625 ให้ฟังหน่อย');
    expect(submit.mock.calls.map(c => c[3])).toEqual([{ fastAck: true }, { fastAck: false }, { fastAck: true }]);
  } finally { await session.close(); }
});

test('the timing journal never carries the transcript or the acknowledgement text', async () => {
  const { session, timing, say } = await call(() => 'เดี๋ยวเปิด PR ดูให้นะคะ');
  try {
    await say('ช่วยเปิด PR 623 ให้หน่อย');
    await say('เอ่อ เอาใหม่');
    const journal = JSON.stringify(timing);
    for (const secret of ['ช่วยเปิด', 'เอาใหม่', 'เดี๋ยวเปิด']) expect(journal).not.toContain(secret);
  } finally { await session.close(); }
});

test('a contextual spoken acknowledgement that arrives before the deadline cancels the generic one', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], spoken: string[] = [], timing: any[] = [];
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { let sequence = 0; for await (const text of options.text) { spoken.push(text); yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: sequence++ }; } } };
  const submit = jest.fn(async () => ({ inputId: 'input', response: new Promise<string>(() => {}) }));
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: () => {}, bufferedBytes: () => 0 }, submit, jest.fn(),
    { silenceCommitMs: 0, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 0, acknowledge: async () => 'รับทราบค่ะ', fastAckAfterMs: 150 },
    undefined, undefined, event => timing.push(event));
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };
  try {
    await session.start();
    const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    session.speechEnded(1);
    await waitFor(() => !!stt.sessions[0].commitId);
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'ช่วยเปิด PR 623 ให้หน่อย' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await waitFor(() => controls.some(c => c.type === 'utterance.accepted'));
    // The intake/task_spawn acknowledgement reaches a live call through the voice listener.
    session.notifyResult({ responseId: 'ack-response', text: 'เดี๋ยวเปิด PR 623 ดูให้นะคะ', spoken: 'เดี๋ยวเปิด PR 623 ดูให้นะคะ', speechOnly: true });
    await waitFor(() => spoken.length === 1);
    session.progress(session.playback.epoch, session.playback.snapshot().generatedSamples);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(spoken).toEqual(['เดี๋ยวเปิด PR 623 ดูให้นะคะ']);
    expect(timing.filter(e => e.operation === 'turn' && e.phase === 'fast_ack_sent')).toEqual([]);
  } finally { await session.close(); }
});

test('fastAcknowledgement sends the voice style, recent caller turns and recent acknowledgements', async () => {
  const fetch = jest.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: 'text', text: 'เดี๋ยวเปิด PR 623 ดูให้นะคะ' }], usage: { input_tokens: 200, output_tokens: 12 } }), { headers: { 'content-type': 'application/json' } }));
  const result = await fastAcknowledgement('ช่วยเปิด PR 623 ให้หน่อย', { model: 'claude-haiku-5-5', timeoutMs: 1000, gender: 'female', signal: new AbortController().signal,
    context: { recentTurns: ['สวัสดีค่ะ', 'วันนี้มีงานอะไรบ้าง'], recentAcks: ['รับทราบค่ะ กำลังดูให้นะคะ'] },
    connection: () => ({ baseUrl: 'https://provider.test', apiKey: 'token', scheme: 'oauth' }), fetch: fetch as unknown as typeof globalThis.fetch });
  // The caller said 623, so the acknowledgement may repeat it.
  expect(result).toMatchObject({ text: 'เดี๋ยวเปิด PR 623 ดูให้นะคะ', outcome: 'ready' });
  const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
  expect(body.system).toContain('TTS voice style');
  expect(body.system).toContain('ค่ะ');
  const content = body.messages[0].content as string;
  for (const part of ['สวัสดีค่ะ', 'วันนี้มีงานอะไรบ้าง', 'รับทราบค่ะ กำลังดูให้นะคะ', 'ช่วยเปิด PR 623 ให้หน่อย']) expect(content).toContain(part);
  expect(content.indexOf('ช่วยเปิด PR 623')).toBeGreaterThan(content.indexOf('วันนี้มีงานอะไรบ้าง'));
});

test('an acknowledgement may repeat a number the caller said, never one it invented', () => {
  expect(fastAckText('เดี๋ยวเปิด PR 623 ดูให้นะคะ', 'ช่วยเปิด PR 623 ให้หน่อย')).toBe('เดี๋ยวเปิด PR 623 ดูให้นะคะ');
  expect(fastAckText('ราคาอยู่ที่ 67,240 ดอลลาร์', 'ราคา Bitcoin เท่าไหร่')).toBeUndefined();
  expect(fastAckText('เปิด PR 62 ให้ค่ะ', 'เปิด PR 623')).toBeUndefined();
  expect(fastAckText('PR 623', undefined)).toBeUndefined();
});

test('filler detection keeps real short requests', () => {
  for (const text of ['เอ่อ เอาใหม่', 'เอ่อเอาใหม่', 'um', 'uh huh', 'อ่า', 'เดี๋ยวนะ', 'แป๊บนึงนะ', 'hmm...', '', 'Wait.', 'hold on']) expect(fillerOnly(text)).toBe(true);
  for (const text of ['เปิด PR', 'ราคาทองเท่าไหร่', 'อาหารกลางวันกินอะไรดี', 'เอ่อ ช่วยเปิด PR หน่อย', 'what time is it', 'wait for the build to finish', 'um, what is the weather']) expect(fillerOnly(text)).toBe(false);
});
