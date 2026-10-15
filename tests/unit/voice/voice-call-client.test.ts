import { decodeVoiceFrame } from '../../../src/voice/protocol';
import { VOICE_CALL_VAD, createResampler, createVoiceCallPlayhead, createVoiceCallUplink, createVoiceCallVad, encodeVoiceCallFrame, voiceCallLevel } from '../../../src/ui/voice-call-client';
import { generateVoiceCallPage } from '../../../src/ui/voice-call-ui';

const sine = (frequency: number, rate: number, samples: number, amplitude = 0.5) =>
  Float32Array.from({ length: samples }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate));
const rms = (pcm: Int16Array) => Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);

describe('resampler', () => {
  test('48 kHz → 16 kHz keeps duration and level across chunk boundaries', () => {
    const resample = createResampler(48000, 16000), input = sine(1000, 48000, 48000);
    const chunks: Int16Array[] = [];
    for (let offset = 0; offset < input.length; offset += 1920) chunks.push(resample(input.subarray(offset, offset + 1920)));
    const output = Int16Array.from(chunks.flatMap(chunk => [...chunk]));
    expect(Math.abs(output.length - 16000)).toBeLessThanOrEqual(1);
    // A 0.5 sine has RMS 0.354 of full scale; the anti-alias filter barely touches 1 kHz.
    expect(rms(output.subarray(1600)) / 32767).toBeGreaterThan(0.33);
    expect(rms(output.subarray(1600)) / 32767).toBeLessThan(0.36);
    // No discontinuity where chunks meet: neighbouring samples differ by one 1 kHz step at most.
    const maxStep = Math.max(...output.subarray(1600).slice(1).map((value, i) => Math.abs(value - output[1600 + i])));
    expect(maxStep / 32767).toBeLessThan(0.5 * 2 * Math.PI * 1000 / 16000 * 1.05);
  });

  test('a 16 kHz context passes through and clips to PCM16 range', () => {
    const out = createResampler(16000, 16000)(Float32Array.from([0, 0.5, -0.5, 2, -2, 0]));
    expect(out.length).toBe(5); // the last sample waits for the next chunk
    expect(out[0]).toBe(0);
  });
});

test('frames decode with the server protocol, byte for byte', () => {
  const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
  const frame = Buffer.from(encodeVoiceCallFrame('11111111-2222-4333-8444-555555555555', 7, 3, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', pcm));
  const decoded = decodeVoiceFrame(frame);
  expect(decoded).toMatchObject({ generation: '11111111-2222-4333-8444-555555555555', epoch: 7, sequence: 3, segmentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  expect(Buffer.from(decoded.audio)).toEqual(Buffer.from(pcm.buffer));
  expect(() => encodeVoiceCallFrame('not-a-uuid', 0, 1, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', pcm)).toThrow('INVALID_FRAME_ID');
});

describe('VAD', () => {
  const quiet = 0.003, loud = 0.2;
  test('starts after sustained speech, ignores a click, and ends after the hangover', () => {
    const vad = createVoiceCallVad(VOICE_CALL_VAD);
    const feed = (level: number, ms: number) => { const edges: string[] = []; for (let t = 0; t < ms; t += 40) { const edge = vad(level, 40); if (edge) edges.push(edge); } return edges; };
    expect(feed(quiet, 400)).toEqual([]);
    expect(feed(loud, 40)).toEqual([]); // a single 40 ms click
    expect(feed(quiet, 40)).toEqual([]);
    expect(feed(loud, 200)).toEqual(['start']);
    expect(feed(quiet, 200)).toEqual([]); // a pause inside speech
    expect(feed(loud, 80)).toEqual([]);
    expect(feed(quiet, 400)).toEqual(['end']);
  });

  test('while the agent is audible, echo below the barge-in level never starts speech; a clear voice does', () => {
    const vad = createVoiceCallVad(VOICE_CALL_VAD);
    for (let i = 0; i < 10; i++) vad(quiet, 40);
    const echo: (string | undefined)[] = [];
    for (let i = 0; i < 25; i++) echo.push(vad(0.02, 40, true)); // above the normal threshold, below twice it
    expect(echo.filter(Boolean)).toEqual([]);
    expect(vad(0.02, 200, false)).toBe('start'); // the same level counts once playback stops
    const barge = createVoiceCallVad(VOICE_CALL_VAD);
    const edges: (string | undefined)[] = [];
    for (let i = 0; i < 7; i++) edges.push(barge(loud, 40, true));
    expect(edges.indexOf('start')).toBe(6); // 7 × 40 ms ≥ bargeInMs
  });

  test('learns a noisy room so steady background noise does not start speech', () => {
    const vad = createVoiceCallVad(VOICE_CALL_VAD);
    const edges: (string | undefined)[] = [];
    for (let i = 0; i < 200; i++) edges.push(vad(0.011 + (i % 2) * 0.001, 40));
    expect(edges.filter(Boolean)).toEqual([]);
    expect(voiceCallLevel(Float32Array.from([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

describe('uplink', () => {
  const setup = () => {
    const json: Record<string, unknown>[] = [], frames: Array<[string, number, number]> = [];
    const uplink = createVoiceCallUplink({ json: message => json.push(message), frame: (id, sequence, pcm) => frames.push([id, sequence, pcm.length]) },
      { preRollSamples: 640, maxHeldSamples: 3200, maxUtteranceSamples: 4800 });
    return { uplink, json, frames, chunk: (n = 320) => new Int16Array(n) };
  };

  test('sends pre-roll then speech under the current utterance, and names the last sequence on speech.ended', () => {
    const { uplink, json, frames, chunk } = setup();
    uplink.listening('u1');
    for (let i = 0; i < 4; i++) uplink.audio(chunk()); // silence: only the latest 640 samples are kept
    uplink.speechStart({ playing: false, epoch: 0 });
    uplink.audio(chunk());
    uplink.speechEnd();
    expect(json).toEqual([{ type: 'speech.activity' }, { type: 'speech.ended', last_audio_seq: 3 }]);
    expect(frames).toEqual([['u1', 1, 320], ['u1', 2, 320], ['u1', 3, 320]]);
    expect(uplink.pendingSequence()).toBe(3);
  });

  test('speech during audible playback interrupts it with the next epoch', () => {
    const { uplink, json } = setup();
    uplink.listening('u1');
    uplink.speechStart({ playing: true, epoch: 4 });
    expect(json).toEqual([{ type: 'speech.started', epoch: 5 }]);
  });

  test('words spoken before the next utterance opens are held and sent first, in order', () => {
    const { uplink, json, frames, chunk } = setup();
    uplink.listening('u1');
    uplink.speechStart({ playing: false, epoch: 0 }); uplink.audio(chunk()); uplink.speechEnd();
    // The server is committing u1; the user keeps talking.
    uplink.speechStart({ playing: false, epoch: 0 });
    uplink.audio(chunk(100)); uplink.audio(chunk(200));
    uplink.speechEnd();
    expect(frames).toEqual([['u1', 1, 320]]);
    uplink.listening('u2');
    expect(frames.slice(1)).toEqual([['u2', 1, 100], ['u2', 2, 200]]);
    expect(json.at(-1)).toEqual({ type: 'speech.ended', last_audio_seq: 2 });
    expect(uplink.pendingSequence()).toBe(2);
    uplink.listening('u3');
    expect(uplink.pendingSequence()).toBeUndefined();
  });

  test('ends a turn before the utterance budget instead of overrunning it, and drops audio when reset', () => {
    const { uplink, json, frames, chunk } = setup();
    uplink.listening('u1');
    uplink.speechStart({ playing: false, epoch: 0 });
    for (let i = 0; i < 6; i++) uplink.audio(chunk(1000));
    expect(frames.map(frame => frame[1])).toEqual([1, 2, 3, 4]);
    expect(json.at(-1)).toEqual({ type: 'speech.ended', last_audio_seq: 4 });
    uplink.reset();
    uplink.speechStart({ playing: false, epoch: 0 }); uplink.audio(chunk());
    expect(frames).toHaveLength(4);
  });
});

test('playhead reports monotonic heard samples, never more than received', () => {
  const playhead = createVoiceCallPlayhead();
  expect(playhead.schedule(1600, 16000, 10)).toBe(10);
  expect(playhead.schedule(1600, 16000, 10.05)).toBeCloseTo(10.1);
  expect(playhead.played(16000, 10.05)).toBe(800);
  expect(playhead.played(16000, 10.04)).toBe(800);
  expect(playhead.playing(10.15)).toBe(true);
  expect(playhead.played(16000, 11)).toBe(3200);
  expect(playhead.playing(11)).toBe(false);
  playhead.reset();
  expect(playhead.played(16000, 11)).toBe(0);
});

describe('page', () => {
  const html = generateVoiceCallPage({ pairingId: 'a'.repeat(36), agentId: '<agent>', basePath: '/gateway', maxUtteranceMs: 60000 });
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];

  test('the inline script is valid JavaScript with every client function embedded', () => {
    expect(() => new Function(script)).not.toThrow();
    for (const name of ['createResampler', 'encodeVoiceCallFrame', 'createVoiceCallVad', 'createVoiceCallUplink', 'createVoiceCallPlayhead', 'voiceCallLevel']) expect(script).toContain(`function ${name}(`);
  });

  test('URLs derive from the base path and the agent id is escaped', () => {
    expect(script).toContain('"basePath":"/gateway"');
    expect(script).toContain("CFG.basePath + '/voice-call/' + CFG.pairingId");
    expect(script).toContain('CFG.basePath + issued.stream_path');
    expect(html).toContain('&lt;agent&gt;');
    expect(html).not.toContain('<agent>');
    expect(html).toContain('https://telegram.org/js/telegram-web-app.js');
  });
});
