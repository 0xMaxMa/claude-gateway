import { VoiceSession } from '../../../src/voice/session';
import { FakeSttProvider } from '../../../src/voice/providers/fake';
import { PCM16, TtsProvider } from '../../../src/voice/types';
import { decodeVoiceFrame } from '../../../src/voice/protocol';
import { BoundedQueue } from '../../../src/orchestration/bounded-queue';

test('approved spoken text produces audio before the final answer and playback receipts bound long provider chunks', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [], consumed: string[] = [], selectedVoices: string[] = [];
  const saved = jest.fn();
  const timing: any[] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(1024, value => Buffer.byteLength(value.text));
  let finish!: (text: string) => void;
  const response = new Promise<string>(resolve => { finish = resolve; });
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { selectedVoices.push(options.voiceId); let sequence = 0; for await (const text of options.text) { consumed.push(text); yield { bytes: Buffer.alloc(6400), format: PCM16, chunkSeq: sequence++ }; } } };
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: c => audio.push(c), bufferedBytes: () => 0 },
    async () => ({ inputId: 'input', response, stream, responseId: () => 'canonical' }), jest.fn(),
    { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 100 }, undefined, saved, event => timing.push(event));
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
    const phases = timing.filter(e => e.operation === 'tts').map(e => e.phase);
    expect(phases).toEqual(['speech_ready', 'synthesis_started', 'first_provider_audio', 'first_audio_sent', 'first_playback_progress', 'audio_sent_complete']);
    expect(timing.filter(e => e.operation === 'stt').map(e => e.phase)).toEqual(['commit_started', 'transcript_ready']);
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
    expect(submit.mock.calls[0]).toEqual(['ช่วยสร้างรูป หมามีปีก', expect.any(String), expect.any(Function)]);
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

test.each(['active', 'finalizing', 'pending', 'rapid'] as const)('mute commits %s speech immediately once and allows unmute', async phase => {
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
    if (phase !== 'active' && phase !== 'rapid') committing = session.commit(1);
    let muting: Promise<void> | undefined;
    if (phase !== 'pending') muting = session.mute(true, 'commit', phase === 'active' || phase === 'rapid' ? 1 : undefined);
    const unmuting = phase === 'rapid' ? session.mute(false, 'commit') : undefined;
    while (!stt.sessions[0].commitId) await new Promise(r => setTimeout(r, 1));
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'ช่วยแนะนำตัวหน่อย' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    if (committing) await committing;
    if (phase === 'pending') { expect(submit).not.toHaveBeenCalled(); muting = session.mute(true, 'commit'); }
    await muting;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(controls.filter(c => c.type === 'utterance.accepted')).toHaveLength(1);
    expect(stop).not.toHaveBeenCalled();
    if (unmuting) await unmuting; else await session.mute(false, 'commit');
    expect(controls.at(-1)).toMatchObject({state:'listening'});
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

test.each(['event','throw','end','muted'] as const)('a dead recognizer requests reconnect and closes its session (%s)',async kind=>{
 const stt=new FakeSttProvider(), controls:Record<string,any>[]=[];
 const {FakeTtsProvider}=await import('../../../src/voice/providers/fake');
 const {VoiceError}=await import('../../../src/voice/types');
 const session=new VoiceSession(stt,new FakeTtsProvider(),'fixture',{control:m=>controls.push(m),audio:()=>{},bufferedBytes:()=>0},jest.fn(),jest.fn());
 await session.start();
 if(kind==='muted') await session.mute(true,'commit');
 const provider=stt.sessions[0],close=jest.spyOn(provider,'close');
 if(kind==='throw')provider.events.close(new VoiceError('STT_CONNECTION_CLOSED'));
 else if(kind==='end')provider.events.close();
 else provider.emit({type:'error',code:'STT_CONNECTION_CLOSED',retryable:true});
 await new Promise(resolve=>setImmediate(resolve));
 expect(controls).toContainEqual({type:'voice.error',code:'STT_CONNECTION_CLOSED',retryable:true,reconnect:true});
 expect(close).toHaveBeenCalled();
 await session.close();
});

test('provider authentication failures remain non-retryable',async()=>{
 const stt=new FakeSttProvider(),controls:Record<string,any>[]=[];
 const {FakeTtsProvider}=await import('../../../src/voice/providers/fake');
 const session=new VoiceSession(stt,new FakeTtsProvider(),'fixture',{control:m=>controls.push(m),audio:()=>{},bufferedBytes:()=>0},jest.fn(),jest.fn());
 await session.start();
 stt.sessions[0].emit({type:'error',code:'STT_PROVIDER_ERROR_HTTP_401',retryable:false});
 await new Promise(resolve=>setImmediate(resolve));
 expect(controls).toContainEqual({type:'voice.error',code:'STT_PROVIDER_ERROR_HTTP_401',retryable:false,reconnect:false});
 await session.close();
});

test.each([
 ['STT_PROVIDER_ERROR_HTTP_503',true],
 ['MANAGED_VOICE_USAGE_UNAVAILABLE',true],
 ['STT_PROVIDER_ERROR_HTTP_401',false],
 ['MANAGED_VOICE_QUOTA_EXHAUSTED',false],
])('startup failure %s retires the recognizer with the correct retry policy',async(code,retryable)=>{
 const stt=new FakeSttProvider(),controls:Record<string,any>[]=[];
 const {FakeTtsProvider}=await import('../../../src/voice/providers/fake');
 const {VoiceError}=await import('../../../src/voice/types');
 jest.spyOn(stt,'open').mockRejectedValue(new VoiceError(String(code)));
 const stop=jest.fn();
 const session=new VoiceSession(stt,new FakeTtsProvider(),'fixture',{control:m=>controls.push(m),audio:()=>{},bufferedBytes:()=>0},jest.fn(),stop);
 try {
  await session.start();
  expect(controls).toEqual([{type:'voice.error',code,retryable,reconnect:retryable}]);
  await expect(session.start()).rejects.toThrow('VOICE_ALREADY_STARTED');
  expect(stop).not.toHaveBeenCalled();
 }finally{await session.close();}
});

test.each([false, true])('response rejection only notifies the current voice turn (interrupted=%s)', async interrupted => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [];
  let reject!: (error: Error) => void;
  const response = new Promise<string>((_, fail) => { reject = fail; });
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize: async function* () {} };
  const session = new VoiceSession(stt, tts, 'voice',
    { control: event => controls.push(event), audio: () => {}, bufferedBytes: () => 0 },
    async () => ({ inputId: 'input', response }), jest.fn(),
    { silenceCommitMs: 650, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 100 });
  try {
    await session.start();
    const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    const commit = session.commit(1);
    while (!stt.sessions[0].commitId) await new Promise(resolve => setImmediate(resolve));
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 'segment', text: 'First question' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await commit;
    if (interrupted) session.speechStarted(1);
    reject(Object.assign(new Error('Process failed'), { code: 'INFERENCE_FAILED' }));
    await new Promise(resolve => setImmediate(resolve));
    expect(controls.filter(event => event.type === 'voice.error')).toEqual(interrupted ? [] : [{ type: 'voice.error', code: 'INFERENCE_FAILED' }]);
  } finally { await session.close(); }
});


test('batch STT only interrupts completed response playback after confirmed words; empty noise preserves it', async () => {
  const { FakeTtsProvider } = await import('../../../src/voice/providers/fake');
  const stt=new FakeSttProvider(), controls:any[]=[], audio:Buffer[]=[], stop=jest.fn(), receipts=jest.fn();
  const session=new VoiceSession(stt,new FakeTtsProvider(),'voice',{
    control:m=>controls.push(m),audio:b=>audio.push(b),bufferedBytes:()=>0,
  },async()=>({inputId:'next',response:Promise.resolve('')}),stop,undefined,receipts);
  const waitFor=async(fn:()=>boolean)=>{for(let i=0;i<100&&!fn();i++)await new Promise(r=>setTimeout(r,5));expect(fn()).toBe(true);};
  const commit=async(text:string)=>{
    const turn=[...controls].reverse().find(c=>c.state==='listening'&&c.utterance_id);
    await session.audio({generation:turn.generation,epoch:session.playback.epoch,sequence:1,segmentId:turn.utterance_id,audio:Buffer.alloc(640)});
    stt.sessions[0].commitId=undefined;
    const pending=session.commit(1);
    const outcome=pending.then(()=>undefined,error=>error);
    await waitFor(()=>!!stt.sessions[0].commitId);
    if(text)stt.sessions[0].emit({type:'segment_final',segmentId:'words',text});
    stt.sessions[0].emit({type:'commit_done',commitId:stt.sessions[0].commitId!});
    return outcome;
  };
  try {
    await session.start();
    session.notifyResult({responseId:'completed',text:'Answer',spoken:'Approved answer'});
    await waitFor(()=>controls.some(c=>c.type==='playback.end'));
    const epoch=session.playback.epoch;
    expect((await commit(''))?.code).toBe('EMPTY_TRANSCRIPT');
    expect(session.playback.epoch).toBe(epoch);expect(stop).not.toHaveBeenCalled();
    await commit('please wait');
    expect(session.playback.epoch).toBeGreaterThan(epoch);expect(stop).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveBeenCalledWith('completed',expect.anything(),'interrupted');
  } finally {await session.close();}
});

test('manual replay stops the old audio without cancelling an agent task', async () => {
  const {FakeTtsProvider}=await import('../../../src/voice/providers/fake');
  const stop=jest.fn(),controls:any[]=[],receipts=jest.fn();
  const session=new VoiceSession(new FakeSttProvider(),new FakeTtsProvider(),'voice',{
    control:m=>controls.push(m),audio:()=>{},bufferedBytes:()=>0,
  },async()=>({inputId:'next',response:Promise.resolve('')}),stop,undefined,receipts);
  try {
    session.notifyResult({responseId:'original',text:'Answer',spoken:'Answer'});
    for(let i=0;i<100&&!controls.some(c=>c.type==='playback.end');i++)await new Promise(r=>setTimeout(r,5));
    expect(controls.some(c=>c.type==='playback.end')).toBe(true);
    session.stopPlayback(session.playback.epoch+1);
    expect(stop).not.toHaveBeenCalled();
    expect(receipts).toHaveBeenCalledWith('original',expect.anything(),'interrupted');
    expect(session.speechClaims()).toContain('original');
  } finally {await session.close();}
});


test('manual stop advances beyond an unseen server epoch and acknowledges the request', async () => {
  const {FakeTtsProvider}=await import('../../../src/voice/providers/fake');
  const controls:any[]=[],stop=jest.fn();
  const session=new VoiceSession(new FakeSttProvider(),new FakeTtsProvider(),'voice',{
    control:m=>controls.push(m),audio:()=>{},bufferedBytes:()=>0,
  },async()=>({inputId:'i',response:Promise.resolve('')}),stop);
  try {
    session.notifyResult({responseId:'r',text:'Answer',spoken:'Answer'});
    for(let i=0;i<100&&!controls.some(c=>c.type==='playback.start');i++)await new Promise(r=>setTimeout(r,5));
    const unseen=controls.find(c=>c.type==='playback.start');expect(unseen).toBeDefined();
    session.stopPlayback(unseen.epoch,42);
    expect(session.playback.epoch).toBeGreaterThan(unseen.epoch);
    expect(controls.at(-1)).toMatchObject({type:'playback.stopped',request_id:42,epoch:session.playback.epoch});
    expect(stop).not.toHaveBeenCalled();
  }finally{await session.close();}
});

test('STT candidate pause preserves backpressured audio past the normal client timeout', async () => {
  jest.useFakeTimers();
  const controls:any[]=[],audio:Buffer[]=[];
  const tts:TtsProvider={id:'fake',capabilities:{textStreaming:true,wordAlignment:false,outputFormats:[PCM16]},
    synthesize:async function*(){yield {bytes:Buffer.alloc(6400),format:PCM16,chunkSeq:0};}};
  const session=new VoiceSession(new FakeSttProvider(),tts,'voice',{
    control:m=>controls.push(m),audio:b=>audio.push(b),bufferedBytes:()=>0,
  },async()=>({inputId:'i',response:Promise.resolve('')}),jest.fn(),
    {silenceCommitMs:650,finalizationTimeoutMs:5000,maxUtteranceMs:60000,maxBufferedAudioMs:100});
  try{
    session.notifyResult({responseId:'r',text:'Answer',spoken:'Answer'});
    await jest.advanceTimersByTimeAsync(20);
    expect(audio).toHaveLength(1);
    const epoch=session.playback.epoch;
    session.pausePlayback(epoch,true);
    await jest.advanceTimersByTimeAsync(15000);
    expect(audio).toHaveLength(1);
    expect(controls.some(c=>c.type==='voice.error')).toBe(false);
    session.pausePlayback(epoch,false);session.progress(epoch,1600);
    await jest.advanceTimersByTimeAsync(20);
    expect(audio).toHaveLength(2);
    expect(controls.some(c=>c.type==='playback.end')).toBe(true);
  }finally{await session.close();jest.useRealTimers();}
});

test('turn timing correlates utterance, input and response ids from the end of speech to the first heard audio', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [], timing: any[] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(1024, value => Buffer.byteLength(value.text));
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { let sequence = 0; for await (const _ of options.text) yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: sequence++ }; } };
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: c => audio.push(c), bufferedBytes: () => 0 },
    async () => ({ inputId: 'input-1', response: new Promise<string>(() => {}), stream }), jest.fn(),
    { silenceCommitMs: 1, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 0 }, undefined, undefined, event => timing.push(event));
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };
  try {
    await session.start();
    const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    session.speechEnded(1);
    await waitFor(() => !!stt.sessions[0].commitId);
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'hello' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await waitFor(() => controls.some(c => c.type === 'utterance.accepted'));
    stream.push({ responseId: 'response-1', text: 'Hi.' });
    await waitFor(() => audio.length === 1);
    const frame = decodeVoiceFrame(audio[0]);
    session.progress(frame.epoch, 320);
    const turn = timing.filter(e => e.operation === 'turn');
    expect(turn.map(e => e.phase)).toEqual(['speech_ended', 'transcript_ready', 'turn_admitted', 'agent_first_spoken', 'spoken_sentence_sent', 'e2e_first_audio']);
    expect(new Set(turn.map(e => e.operationId)).size).toBe(1);
    expect(turn.at(-1)).toMatchObject({ utteranceId: listening.utterance_id, inputId: 'input-1', responseId: 'response-1' });
    expect(turn.at(-1).elapsedMs).toBeGreaterThanOrEqual(turn[0].elapsedMs);
    expect(timing.find(e => e.operation === 'tts' && e.phase === 'first_playback_progress')).toMatchObject({ utteranceId: listening.utterance_id, inputId: 'input-1', responseId: 'response-1' });
  } finally { stream.close(); await session.close(); }
});

test('the agent turn reports its phases on the voice turn trace, and every spoken sentence handed to TTS is marked', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [], timing: any[] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(1024, value => Buffer.byteLength(value.text));
  let mark!: (phase: string) => void;
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { let sequence = 0; for await (const _ of options.text) yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: sequence++ }; } };
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: c => audio.push(c), bufferedBytes: () => 0 },
    async (_text, _utterance, onMark) => { mark = onMark!; return { inputId: 'input-1', response: new Promise<string>(() => {}), stream }; }, jest.fn(),
    { silenceCommitMs: 1, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 0 }, undefined, undefined, event => timing.push(event));
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };
  try {
    await session.start();
    const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    session.speechEnded(1);
    await waitFor(() => !!stt.sessions[0].commitId);
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'hello' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await waitFor(() => controls.some(c => c.type === 'utterance.accepted'));
    for (const phase of ['process_spawned', 'first_model_token', 'first_spoken_delta']) mark(phase);
    stream.push({ responseId: 'response-1', text: 'One.' });
    stream.push({ responseId: 'response-1', text: 'Two.' });
    await waitFor(() => timing.filter(e => e.phase === 'spoken_sentence_sent').length === 2);
    const turn = timing.filter(e => e.operation === 'turn');
    expect(turn.map(e => e.phase)).toEqual(['speech_ended', 'transcript_ready', 'turn_admitted', 'process_spawned', 'first_model_token', 'first_spoken_delta', 'agent_first_spoken', 'spoken_sentence_sent', 'spoken_sentence_sent']);
    expect(new Set(turn.map(e => e.operationId)).size).toBe(1);
    expect(turn.find(e => e.phase === 'process_spawned')).toMatchObject({ utteranceId: listening.utterance_id, inputId: 'input-1' });
  } finally { stream.close(); await session.close(); }
});

test('silenceCommitMs 0 commits on speech.ended without a pause, after the last audio frame reaches the recognizer', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [];
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] }, synthesize: async function* () {} };
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: () => {}, bufferedBytes: () => 0 },
    async () => ({ inputId: 'input', response: new Promise<string>(() => {}) }), jest.fn(),
    { silenceCommitMs: 0, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 0 });
  try {
    await session.start();
    const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 2, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    session.speechEnded(2);
    await jest.advanceTimersByTimeAsync(0);
    expect(stt.sessions[0].commitId).toBeDefined();
    expect(stt.sessions[0].frames).toHaveLength(2);
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'สวัสดี' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await jest.advanceTimersByTimeAsync(0);
    expect(controls).toContainEqual(expect.objectContaining({ type: 'stt.final', text: 'สวัสดี' }));
  } finally { await session.close(); jest.useRealTimers(); }
});

test('barge-in while spoken sentences are still streaming cancels the rest: later sentences never reach TTS', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [], consumed: string[] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(4096, value => Buffer.byteLength(value.text));
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { let sequence = 0; for await (const text of options.text) { consumed.push(text); yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: sequence++ }; } } };
  const stop = jest.fn();
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: c => audio.push(c), bufferedBytes: () => 0 },
    async () => ({ inputId: 'input', response: new Promise<string>(() => {}), stream }), stop,
    { silenceCommitMs: 0, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 0 });
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };
  try {
    await session.start();
    const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    session.speechEnded(1);
    await waitFor(() => !!stt.sessions[0].commitId);
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'ราคาเท่าไหร่' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await waitFor(() => controls.some(c => c.type === 'utterance.accepted'));
    stream.push({ responseId: 'reply', text: 'ได้ค่ะ ตอนนี้ราคาอยู่ที่ประมาณหกหมื่นเจ็ดพันดอลลาร์' });
    await waitFor(() => audio.length === 1);
    session.speechStarted(session.playback.epoch + 1);
    expect(stop).toHaveBeenCalled();
    try { stream.push({ responseId: 'reply', text: 'ขึ้นมาราวสองเปอร์เซ็นต์จากเมื่อวานค่ะ' }); } catch { /* the queue may already be closed */ }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(consumed).toEqual(['ได้ค่ะ ตอนนี้ราคาอยู่ที่ประมาณหกหมื่นเจ็ดพันดอลลาร์']);
    expect(audio).toHaveLength(1);
  } finally { stream.close(); await session.close(); }
});

test('each streamed piece of a reply is synthesized on its own provider stream, as one playback with continuous chunk numbers', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [], calls: string[][] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(4096, value => Buffer.byteLength(value.text));
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { const texts: string[] = []; calls.push(texts); let sequence = 0; for await (const text of options.text) { texts.push(text); yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: sequence++ }; } } };
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: c => audio.push(c), bufferedBytes: () => 0 },
    async () => ({ inputId: 'input', response: new Promise<string>(() => {}), stream }), jest.fn(),
    { silenceCommitMs: 0, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 0 });
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };
  try {
    await session.start();
    const listening = controls.at(-1)!;
    await session.audio({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    session.speechEnded(1);
    await waitFor(() => !!stt.sessions[0].commitId);
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 's', text: 'ราคาเท่าไหร่' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await waitFor(() => controls.some(c => c.type === 'utterance.accepted'));
    stream.push({ responseId: 'reply', text: 'ได้ค่ะ ตอนนี้ราคาอยู่ที่ประมาณหกหมื่นเจ็ดพันดอลลาร์' });
    await waitFor(() => audio.length === 1);
    stream.push({ responseId: 'reply', text: 'ขึ้นมาราวสองเปอร์เซ็นต์จากเมื่อวานค่ะ' });
    stream.close();
    await waitFor(() => controls.some(c => c.type === 'playback.end'));
    expect(calls).toEqual([['ได้ค่ะ ตอนนี้ราคาอยู่ที่ประมาณหกหมื่นเจ็ดพันดอลลาร์'], ['ขึ้นมาราวสองเปอร์เซ็นต์จากเมื่อวานค่ะ']]);
    expect(controls.filter(c => c.type === 'playback.start')).toHaveLength(1);
    expect(audio.map(bytes => decodeVoiceFrame(bytes).sequence)).toEqual([0, 1]);
  } finally { stream.close(); await session.close(); }
});

test('mute right after speech answers it without the silence timer, and the reply still plays while muted; mute with no speech admits nothing', async () => {
  const stt = new FakeSttProvider(), controls: Record<string, any>[] = [], audio: Buffer[] = [];
  const stream = new BoundedQueue<{ responseId: string; text: string }>(1024, value => Buffer.byteLength(value.text));
  const submit = jest.fn(async () => ({ inputId: 'input', response: new Promise<string>(() => {}), stream, responseId: () => 'reply' }));
  const tts: TtsProvider = { id: 'fixture', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [PCM16] },
    synthesize: async function* (options) { for await (const _ of options.text) yield { bytes: Buffer.alloc(640), format: PCM16, chunkSeq: 0 }; } };
  // A long silence timer and merge window: an answer within the test proves mute did not wait for either.
  const session = new VoiceSession(stt, tts, 'voice', { control: c => controls.push(c), audio: c => audio.push(c), bufferedBytes: () => 0 }, submit, jest.fn(),
    { silenceCommitMs: 60000, finalizationTimeoutMs: 5000, maxUtteranceMs: 60000, maxBufferedAudioMs: 1500, mergeWindowMs: 60000 });
  const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };
  try {
    await session.start();
    await session.mute(true, 'commit', 0);
    await session.mute(false, 'commit');
    expect(submit).not.toHaveBeenCalled();

    const listening = controls.filter(c => c.state === 'listening' && c.utterance_id).at(-1)!;
    session.speechActivity();
    for (const sequence of [1, 2]) await session.audio({ generation: listening.generation, epoch: 0, sequence, segmentId: listening.utterance_id, audio: Buffer.alloc(320) });
    session.speechEnded(2);
    const muting = session.mute(true, 'commit', 2);
    await waitFor(() => !!stt.sessions.at(-1)!.commitId);
    stt.sessions.at(-1)!.emit({ type: 'segment_final', segmentId: 's', text: 'สรุปให้หน่อย' });
    stt.sessions.at(-1)!.emit({ type: 'commit_done', commitId: stt.sessions.at(-1)!.commitId! });
    await muting;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('สรุปให้หน่อย', listening.utterance_id, expect.any(Function));
    expect(controls.at(-1)).toMatchObject({ type: 'voice.state', state: 'muted' });
    stream.push({ responseId: 'reply', text: 'ได้ครับ' });
    await waitFor(() => audio.length === 1);
  } finally { await session.close(); }
});
