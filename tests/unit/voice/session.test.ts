import { VoiceSession } from '../../../src/voice/session';
import { FakeSttProvider } from '../../../src/voice/providers/fake';
import { PCM16, TtsProvider } from '../../../src/voice/types';
import { decodeVoiceFrame } from '../../../src/voice/protocol';
import { BoundedQueue } from '../../../src/orchestration/bounded-queue';

test('approved spoken text produces audio before the final answer and playback receipts bound long provider chunks', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [], consumed: string[] = [], selectedVoices: string[] = [];
  const saved = jest.fn();
  const stream = new BoundedQueue<{ responseId: string; text: string }>(1024, value => Buffer.byteLength(value.text));
  let finish!: (text: string) => void;
  const response = new Promise<string>(resolve => { finish = resolve; });
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { selectedVoices.push(options.voiceId); let sequence = 0; for await (const text of options.text) { consumed.push(text); yield { bytes: Buffer.alloc(6400), format: PCM16, chunkSeq: sequence++ }; } } };
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: c => audio.push(c), bufferedBytes: () => 0 },
    async () => ({ inputId: 'input', response, stream, responseId: () => 'canonical' }), jest.fn(),
    { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 100 }, undefined, saved);
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };
  try {
    session.setVoice('alternate');
    await session.start();
    const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    const commit = session.commit(1);
    await waitFor(() => !!stt.sessions[0].commitId);
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'ทำงาน' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await commit;
    expect(controls).toContainEqual({ type: 'stt.final', utterance_id: listening.utterance_id, text: 'ทำงาน' });
    stream.push({ responseId: 'canonical', text: 'รับงานแล้ว' });
    await waitFor(() => audio.length === 1);
    expect(consumed).toEqual(['รับงานแล้ว']);
    expect(selectedVoices).toEqual(['alternate']);
    expect(controls.some(c => c.type === 'response.text' && c.final === true)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(audio).toHaveLength(1); // The second 100 ms frame waits for a played-sample receipt.
    const frame = decodeVoiceFrame(audio[0]);
    session.progress(frame.epoch, 1600);
    await waitFor(() => audio.length === 2);
    stream.close(); finish('รับงานแล้ว');
    await waitFor(() => controls.some(c => c.type === 'playback.end'));
    expect(audio.map(bytes => decodeVoiceFrame(bytes).sequence)).toEqual([0, 1]);
    expect(saved).toHaveBeenCalledTimes(1);
    const wav = saved.mock.calls[0][1] as Buffer;
    expect(wav.subarray(0,4).toString()).toBe('RIFF');
    expect(wav.subarray(44)).toEqual(Buffer.concat(audio.map(bytes => Buffer.from(decodeVoiceFrame(bytes).audio))));
    expect(consumed).toHaveLength(1);
    expect(controls).toContainEqual(expect.objectContaining({ type: 'response.text', response_id: 'canonical', text: 'รับงานแล้ว', final: true }));
    expect(stt.sessions).toHaveLength(1);
  } finally { stream.close(); finish('รับงานแล้ว'); await session.close(); }
});

test('full duplex keeps the next mic turn open; barge-in aborts TTS and drops delayed old chunks', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [];
  let release!: () => void, signal!: AbortSignal;
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { signal = options.signal; yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: 0 }; await new Promise<void>(resolve => { release = resolve; }); yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: 1 }; } };
  let respond!: (value: string) => void;
  const stream = new BoundedQueue<{ responseId: string; text: string }>(1024, value => value.text.length);
  const submit = jest.fn(async () => ({ inputId: 'input', stream, response: new Promise<string>(resolve => { respond = resolve; }), responseId: () => 'canonical-response' }));
  const stopResponse = jest.fn(), receipts = jest.fn();
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: c => audio.push(c), bufferedBytes: () => 0 }, submit, stopResponse, undefined, receipts);
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  try {
    await session.start(); const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(640) });
    stt.sessions[0].emit({ type: 'partial', segmentId: 's', text: 'แก้' }); await settle(); expect(submit).not.toHaveBeenCalled();
    const committing = session.commit(1); await settle();
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'แก้ login' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await committing; expect(stt.sessions).toHaveLength(1);
    stream.push({ responseId: 'canonical-response', text: 'Task queued.' }); stream.close();
    respond('Task queued. Full detailed report only on screen.'); await settle();
    expect(audio).toHaveLength(1); expect(controls.find(c => c.type === 'response.text')!.response_id).toBe('canonical-response');
    const old = decodeVoiceFrame(audio[0]);
    session.progress(old.epoch, 100); session.speechStarted(old.epoch + 1);
    expect(signal.aborted).toBe(true); expect(stopResponse).toHaveBeenCalledTimes(1);
    const next = [...controls].reverse().find(c => c.type === 'voice.state' && c.state === 'listening')!;
    await session.audio({ generation: next.generation, epoch: old.epoch + 1, sequence: 1, segmentId: next.utterance_id, audio: Buffer.alloc(320) });
    expect(stt.sessions[0].frames).toHaveLength(2);
    release(); await settle(); expect(audio).toHaveLength(1);
    expect(receipts).toHaveBeenCalledWith('canonical-response', expect.objectContaining({ playedSamples: 100 }), 'interrupted');
  } finally { stream.close(); release?.(); await session.close(); }
});


test.each(['missing', 'empty'] as const)('%s speech summary keeps the full report on screen without calling TTS', async mode => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [];
  const synthesize = jest.fn(async function* () { throw new Error('Full report must never reach TTS'); });
  const report = 'Detailed code review: ' + 'evidence and code. '.repeat(400);
  const session = new VoiceSession(stt, { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize }, 'voice',
    { control: c => controls.push(c), audio: jest.fn(), bufferedBytes: () => 0 },
    async () => ({ inputId: 'input', response: Promise.resolve(report), responseId: () => 'report',
      stream: mode === 'empty' ? (async function* () {})() : undefined }), jest.fn());
  try {
    await session.start();
    const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    const committing = session.commit(1);
    while (!stt.sessions[0].commitId) await new Promise(resolve => setTimeout(resolve, 1));
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'Review please' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await committing;
    expect(controls).toContainEqual(expect.objectContaining({ type: 'response.text', text: report, final: true }));
    expect(synthesize).not.toHaveBeenCalled();
    if (mode === 'empty') expect(controls).toContainEqual({ type: 'voice.notice', code: 'SPEECH_SUMMARY_UNAVAILABLE' });
  } finally { await session.close(); }
});

test('inference timeout is reported once without a false missing-summary error and next microphone turn stays open', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(1024, v => v.text.length);
  let reject!: (error: Error) => void;
  const response = new Promise<string>((_, r) => { reject = r; });
  const synthesize = jest.fn(async function* () {});
  const session = new VoiceSession(stt, { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize }, 'voice',
    { control: c => controls.push(c), audio: jest.fn(), bufferedBytes: () => 0 }, async () => ({ inputId: 'i', response, stream }), jest.fn());
  try {
    await session.start(); const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    const committing = session.commit(1);
    while (!stt.sessions[0].commitId) await new Promise(r => setTimeout(r, 1));
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'Hello' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! }); await committing;
    const error = Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' }); stream.close(error); reject(error);
    await new Promise(r => setTimeout(r, 10));
    expect(controls.filter(c => c.type === 'voice.error')).toEqual([{ type: 'voice.error', code: 'TIMEOUT' }]);
    expect(stt.sessions).toHaveLength(1); expect(synthesize).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

test('waits for contextual Agent speech, streams it before inference ends, then speaks the worker result in order', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [], spoken: string[] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(1024, v => v.text.length);
  let finish!: (text: string) => void;
  const response = new Promise<string>(r => { finish = r; });
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { for await (const text of options.text) { spoken.push(text); yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: 0 }; } } };
  const receipts = jest.fn();
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: a => audio.push(a), bufferedBytes: () => 0 },
    async () => ({ inputId: 'i', response, stream, responseId: () => 'initial' }), jest.fn(),
    { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500 }, receipts);
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 5)); expect(predicate()).toBe(true); };
  try {
    await session.start(); const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    const commit = session.commit(1); await until(() => !!stt.sessions[0].commitId);
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'Run task' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! }); await commit;
    expect(audio).toHaveLength(0); // Admission alone must never generate a stock phrase.
    stream.push({ responseId: 'initial', text: 'I will run Python to check the sum' }); stream.close();
    await until(() => audio.length === 1);
    expect(spoken).toEqual(['I will run Python to check the sum']);
    expect(controls.some(c => c.type === 'response.text')).toBe(false);
    finish('Worker queued, details on screen');
    await new Promise(r => setTimeout(r, 20)); expect(audio).toHaveLength(1);
    session.notifyResult({ responseId: 'final', text: 'Detailed verified report', spoken: 'Worker finished' });
    session.progress(decodeVoiceFrame(audio[0]).epoch, 320);
    await until(() => audio.length === 2);
    expect(spoken).toEqual(['I will run Python to check the sum', 'Worker finished']);
    expect(controls).toContainEqual(expect.objectContaining({ type: 'response.text', response_id: 'final', text: 'Detailed verified report' }));
    session.progress(decodeVoiceFrame(audio[1]).epoch, 320);
  } finally { stream.close(); finish('done'); await session.close(); }
});

test('does not acknowledge rejected admission or synthesize detached worker reports', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [];
  const synthesize = jest.fn(async function* () {});
  const session = new VoiceSession(stt, { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize }, 'voice',
    { control: c => controls.push(c), audio: jest.fn(), bufferedBytes: () => 0 }, async () => { throw Error('ACCESS_DENIED'); }, jest.fn(),
    { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500 });
  await session.start(); const listening = controls.at(-1)!;
  await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
  const commit = session.commit(1); const rejected = expect(commit).rejects.toThrow('ACCESS_DENIED');
  while (!stt.sessions[0].commitId) await new Promise(r => setTimeout(r, 1));
  stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'Run work' });
  stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! }); await rejected;
  expect(controls.some(c => c.type === 'response.acknowledged')).toBe(false);
  await session.close();
  session.notifyResult({ responseId: 'late', text: 'Detailed report', spoken: 'Done' });
  await new Promise(r => setTimeout(r, 10));
  expect(synthesize).not.toHaveBeenCalled();
  expect(controls.some(c => c.response_id === 'late')).toBe(false);
});

test('short speech segments merge once; resuming speech defers admission and manual finish flushes the whole thought', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [];
  const submit = jest.fn(async () => ({ inputId: 'joined', response: Promise.resolve('One answer') }));
  const session = new VoiceSession(stt, { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize: async function* () {} }, 'v',
    { control: c => controls.push(c), audio: jest.fn(), bufferedBytes: () => 0 }, submit, jest.fn(),
    { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 50 });
  const say = async (text: string, flush = false) => {
    const listening = controls.filter(c => c.type === 'voice.state').at(-1)!;
    const provider = stt.sessions.at(-1)!;
    const previousCommit = provider.commitId;
    session.speechActivity();
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    const commit = session.commit(1, flush);
    while (!provider.commitId || provider.commitId === previousCommit) await new Promise(r => setTimeout(r, 1));
    provider.emit({ type: 'segment_final', segmentId: 's', text }); provider.emit({ type: 'commit_done', commitId: provider.commitId! }); await commit;
  };
  try {
    await session.start(); await say('ช่วยสร้างรูป');
    expect(submit).not.toHaveBeenCalled();
    session.speechActivity(); await new Promise(r => setTimeout(r, 80));
    expect(submit).not.toHaveBeenCalled(); // Candidate speech is still being transcribed.
    await say('หมามีปีก', true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]).toEqual(['ช่วยสร้างรูป หมามีปีก', expect.any(String)]);
    expect(controls.filter(c => c.type === 'stt.final').map(c => c.text)).toEqual(['ช่วยสร้างรูป หมามีปีก']);
    expect(controls.filter(c => c.type === 'utterance.accepted')).toHaveLength(1);
  } finally { await session.close(); }
});

test('interrupted inference without speech is not a missing-summary error or a stale reply', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(1024, v => v.text.length);
  let finish!: (value: string) => void;
  const response = new Promise<string>(r => { finish = r; });
  const session = new VoiceSession(stt, { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize: async function* () {} }, 'v',
    { control: c => controls.push(c), audio: jest.fn(), bufferedBytes: () => 0 }, async () => ({ inputId: 'old', response, stream }), jest.fn());
  try {
    await session.start(); const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    const commit = session.commit(1); while (!stt.sessions[0].commitId) await new Promise(r => setTimeout(r, 1));
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'Create an image' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! }); await commit;
    session.speechStarted(session.playback.epoch + 1);
    stream.close(); finish('Response stopped.'); await new Promise(r => setTimeout(r, 20));
    expect(controls.some(c => c.code === 'SPEECH_SUMMARY_UNAVAILABLE')).toBe(false);
    expect(controls.some(c => c.type === 'response.text')).toBe(false);
  } finally { stream.close(); finish('done'); await session.close(); }
});

test('discard mute resets STT so discarded speech cannot leak into the next utterance', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [];
  const session = new VoiceSession(stt, { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize: async function* () {} }, 'v',
    { control: c => controls.push(c), audio: jest.fn(), bufferedBytes: () => 0 }, async () => ({ inputId: 'i', response: Promise.resolve('done') }), jest.fn());
  try {
    await session.start(); const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    await session.mute(true, 'discard'); await session.mute(false, 'discard');
    expect(stt.sessions).toHaveLength(2); expect(stt.sessions[1].frames).toHaveLength(0);
  } finally { await session.close(); }
});

test.each(['active', 'finalizing', 'pending'] as const)('mute commits %s speech immediately once and allows unmute', async phase => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [];
  const submit = jest.fn(async () => ({ inputId: 'one', response: Promise.resolve('done') }));
  const stop = jest.fn();
  const session = new VoiceSession(stt, { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize: async function* () {} }, 'v',
    { control: c => controls.push(c), audio: jest.fn(), bufferedBytes: () => 0 }, submit, stop,
    { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 10000 });
  try {
    await session.start(); const turn = controls.at(-1)!;
    session.speechActivity();
    await session.audio({ generation: turn.generation, epoch: 0, sequence: 1, segmentId: turn.utterance_id, audio: Buffer.alloc(320) });
    let committing: Promise<void> | undefined;
    if (phase !== 'active') committing = session.commit(1);
    let muting: Promise<void> | undefined;
    if (phase !== 'pending') muting = session.mute(true, 'commit', phase === 'active' ? 1 : undefined);
    while (!stt.sessions[0].commitId) await new Promise(r => setTimeout(r, 1));
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'ช่วยแนะนำตัวหน่อย' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    if (committing) await committing;
    if (phase === 'pending') { expect(submit).not.toHaveBeenCalled(); muting = session.mute(true, 'commit'); }
    await muting;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(controls.filter(c => c.type === 'utterance.accepted')).toHaveLength(1);
    expect(stop).not.toHaveBeenCalled();
    await session.mute(false, 'commit');
    expect(controls.some(c => c.type === 'voice.state' && c.state === 'listening' && c.utterance_id !== turn.utterance_id && c.utterance_id)).toBe(true);
  } finally { await session.close(); }
});

test('recognition language does not force a different language onto a typed response', async () => {
  const stt = new FakeSttProvider();
  const open = jest.spyOn(stt, 'open');
  const spoken: string[] = [];
  const synthesize = jest.fn(async function* (options: Parameters<TtsProvider['synthesize']>[0]) {
    for await (const text of options.text) { spoken.push(text); yield { bytes: Buffer.alloc(320), format: PCM16, chunkSeq: 0 }; }
  });
  const session = new VoiceSession(stt, { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize }, 'voice',
    { control: () => {}, audio: () => {}, bufferedBytes: () => 0 }, jest.fn(), jest.fn(),
    { language: 'th', silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1000 });
  try {
    await session.start(); await session.mute(true, 'discard');
    session.notifyResult({ responseId: 'jp', text: 'こんにちは。', spoken: 'こんにちは。' });
    for (let i = 0; i < 50 && !spoken.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ language: 'th' }));
    expect(spoken).toEqual(['こんにちは。']);
    expect(synthesize.mock.calls[0][0].language).toBeUndefined();
  } finally { await session.close(); }
});
