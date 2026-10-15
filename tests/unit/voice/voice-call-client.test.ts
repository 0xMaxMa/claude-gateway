import { decodeVoiceFrame } from '../../../src/voice/protocol';
import { VOICE_CALL_VAD, createResampler, createVoiceCallPlayhead, createVoiceCallUplink, createVoiceCallVad, encodeVoiceCallFrame, voiceCallLevel, voiceCallTicketFailure, voiceCallTheme } from '../../../src/ui/voice-call-client';
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
  const script = inlineScripts(html);

  test('the inline script is valid JavaScript with every client function embedded', () => {
    expect(() => new Function(script)).not.toThrow();
    for (const name of ['createResampler', 'encodeVoiceCallFrame', 'createVoiceCallVad', 'createVoiceCallUplink', 'createVoiceCallPlayhead', 'voiceCallLevel', 'voiceCallTicketFailure', 'formatCallDuration', 'voiceCallErrorView']) expect(script).toContain(`function ${name}(`);
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

describe('ticket refusals', () => {
  test('a 401 or 403 without a gateway error came from a proxy and needs a fresh sign-in', () => {
    const signIn = { message: 'You need to sign in again to continue the call.', fatal: true, signIn: true };
    expect(voiceCallTicketFailure(401, {})).toEqual(signIn);
    expect(voiceCallTicketFailure(403, {})).toEqual(signIn);
  });

  test("the gateway's own refusals keep their meaning", () => {
    expect(voiceCallTicketFailure(401, { error: 'Invalid initData' })).toEqual({ message: 'Telegram could not verify you. Reopen the call from the /call button.', fatal: true, signIn: false });
    expect(voiceCallTicketFailure(403, { error: 'Not allowed' })).toEqual({ message: 'You are not allowed to call this agent.', fatal: true, signIn: false });
    expect(voiceCallTicketFailure(409, { error: 'Voice session already active' })).toMatchObject({ fatal: false, signIn: false });
    expect(voiceCallTicketFailure(409, { error: 'Call link already used', code: 'CALL_LINK_USED' })).toMatchObject({ fatal: true, message: 'This call link was already used. Send /call again.' });
    expect(voiceCallTicketFailure(503, { error: 'Voice call unavailable' })).toMatchObject({ fatal: false, signIn: false });
    expect(voiceCallTicketFailure(410, { error: 'Call link expired' })).toMatchObject({ fatal: true, message: 'This call link has expired. Send /call again.' });
  });
});

/** A stub WebSocket the test drives as the gateway. */
class FakeSocket {
  readyState = 0; binaryType = ''; sent: any[] = [];
  onopen: null | (() => void) = null; onmessage: null | ((event: { data: unknown }) => void) = null; onclose: null | ((event: { code: number }) => void) = null;
  constructor(readonly url: string, readonly list: FakeSocket[]) { list.push(this); }
  send(data: unknown) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
  /** One PCM16 sample of reply audio in `epoch`, framed as the gateway sends it. */
  audio(epoch: number) { const data = new ArrayBuffer(46); new DataView(data).setUint32(20, epoch); this.onmessage?.({ data }); }
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

const TICKET = { status: 200, body: JSON.stringify({ ticket: 't', stream_path: '/api/v1/agents/agent/voice-sessions/v/stream', call_token: 'c'.repeat(64) }) };
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

/**
 * Open the real page against a stub browser. The page starts the call by itself;
 * `audioNeedsTap` models Telegram's Android WebView, where audio stays suspended
 * until the first touch, and `micNeedsTap` a WebView that grants the microphone only from a tap.
 */
async function openPage(options: { tickets?: { status: number; body: string }[]; audioNeedsTap?: boolean; micNeedsTap?: boolean; micDenied?: boolean; storage?: Map<string, string>;
  linkUsed?: boolean; telegramTheme?: { colorScheme: string; themeParams: Record<string, string> }; prefersLight?: boolean } = {}) {
  const html = generateVoiceCallPage({ pairingId: 'a'.repeat(36), agentId: 'agent', basePath: '/gateway', maxUtteranceMs: 60000, linkUsed: options.linkUsed });
  const script = inlineScripts(html);
  type Element = { textContent: string; className: string; hidden: boolean; src?: string; onclick: null | (() => void); onload?: () => void;
    attributes: Record<string, string>; style: Record<string, string> & { setProperty(name: string, value: string): void }; setAttribute(name: string, value: string): void };
  const elements = new Map<string, Element>();
  const element = (id: string) => elements.get(id) ?? elements.set(id, {
    textContent: '', className: '', hidden: false, onclick: null, attributes: {},
    style: Object.assign(Object.create(null), { setProperty(this: Record<string, string>, name: string, value: string) { this[name] = value; } }),
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
  }).get(id)!;
  const noop = () => undefined;
  const handlers: Record<string, (() => void)[]> = {};
  const tg = { initData: 'signed', ready: noop, expand: noop, enableClosingConfirmation: noop, disableClosingConfirmation: noop, close: noop,
    colorScheme: options.telegramTheme?.colorScheme ?? 'light', themeParams: options.telegramTheme?.themeParams ?? {},
    setHeaderColor: jest.fn(), setBackgroundColor: jest.fn(),
    onEvent(name: string, handler: () => void) { (handlers[name] ??= []).push(handler); } };
  const track = { enabled: true, stop: noop };
  let touched = false;
  /** Audio nodes record where they connect, so a test can follow reply audio to the speaker. */
  type Node = { outputs: Node[]; gain?: { value: number }; connect(next: Node): void };
  const node = (extra: object = {}): Node => ({ outputs: [], connect(this: Node, next: Node) { this.outputs.push(next); }, ...extra });
  const destination = node(), replies: Node[] = [];
  /** How loud a reply source reaches the destination: the product of the gains on its way. */
  const loudness = (from: Node): number => from === destination ? 1 : Math.max(0, ...from.outputs.map(next => (from.gain?.value ?? 1) * loudness(next)));
  class FakeAudioContext {
    sampleRate = 48000; currentTime = 0; destination = destination; state = 'suspended';
    audioWorklet = { addModule: async () => undefined };
    resume = () => { if (options.audioNeedsTap && !touched) return new Promise<void>(noop); this.state = 'running'; return Promise.resolve(); };
    close = async () => undefined;
    createGain() { return node({ gain: { value: 1 } }); }
    createAnalyser() { return node({ fftSize: 2048, getFloatTimeDomainData: noop }); }
    createMediaStreamSource() { return node(); }
    createBuffer() { return { getChannelData: () => new Float32Array(1) }; }
    createBufferSource() { const source = node({ start: noop, stop: noop }); replies.push(source); return source; }
  }
  const worklets: FakeWorkletNode[] = [];
  class FakeWorkletNode { port: { onmessage?: (event: { data: Float32Array }) => void } = {}; outputs: Node[] = []; constructor() { worklets.push(this); } connect(next: Node) { this.outputs.push(next); } }
  const tickets = [...(options.tickets ?? [TICKET])];
  const fetch = jest.fn(async () => { const next = tickets.shift() ?? TICKET; return { ok: next.status === 200, status: next.status, json: async () => JSON.parse(next.body) }; });
  const location = { protocol: 'https:', host: 'pod.example', reload: jest.fn() };
  const systemTheme = { matches: Boolean(options.prefersLight), listeners: [] as (() => void)[], addEventListener(_: string, listener: () => void) { this.listeners.push(listener); } };
  const window = { Telegram: { WebApp: tg }, isSecureContext: true, AudioWorkletNode: FakeWorkletNode, matchMedia: (query: string) => { expect(query).toBe('(prefers-color-scheme: light)'); return systemTheme; } };
  const root = { attributes: {} as Record<string, string>, style: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value; } };
  const document = { getElementById: element, addEventListener: noop, visibilityState: 'visible', documentElement: root };
  const getUserMedia = jest.fn(async () => {
    if (options.micDenied || (options.micNeedsTap && !touched)) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  });
  const navigator = { mediaDevices: { getUserMedia } };
  const URL = { createObjectURL: () => 'blob:worklet' };
  const sockets: FakeSocket[] = [];
  const WebSocket = function(url: string) { return new FakeSocket(url, sockets); };
  const stored = options.storage ?? new Map<string, string>();
  const sessionStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
  new Function('window', 'document', 'navigator', 'AudioContext', 'AudioWorkletNode', 'fetch', 'location', 'URL', 'WebSocket', 'sessionStorage', script)(
    window, document, navigator, FakeAudioContext, FakeWorkletNode, fetch, location, URL, WebSocket, sessionStorage);
  await settle();
  /** A tap on a page button, which also counts as the WebView's first touch. */
  const tap = async (id: string) => { touched = true; element(id).onclick!(); await settle(); };
  /** The microphone hears `ms` of sound at one level, in the worklet's 40 ms chunks. */
  const hear = (level: number, ms: number) => { for (let t = 0; t < ms; t += 40) worklets.at(-1)!.port.onmessage!({ data: new Float32Array(1920).fill(level) }); };
  /** Telegram switches theme, as it does when the user turns on night mode. */
  const themeChanged = (colorScheme: string, themeParams: Record<string, string>) => { Object.assign(tg, { colorScheme, themeParams }); (handlers.themeChanged ?? []).forEach(handler => handler()); };
  const systemThemeChanged = (light: boolean) => { systemTheme.matches = light; systemTheme.listeners.forEach(listener => listener()); };
  return { element, location, fetch, sockets, getUserMedia, tap, replies, loudness, hear, root, tg, themeChanged, systemThemeChanged };
}

/** Every inline script of a page, in page order, as one script. */
function inlineScripts(html: string): string {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join(';\n');
}

describe('page after a refused ticket', () => {
  async function opened(response: { status: number; body: string }) {
    const page = await openPage({ tickets: [response] });
    expect(page.fetch).toHaveBeenCalledWith('/gateway/voice-call/' + 'a'.repeat(36) + '/ticket', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    return page;
  }

  test('a proxy 401 offers to sign in again, and signing in reloads the page into the login redirect', async () => {
    const { element, location } = await opened({ status: 401, body: 'unauthorized' });
    expect(element('state').textContent).toBe('You need to sign in again to continue the call.');
    expect(element('start')).toMatchObject({ hidden: false, textContent: 'Sign in again' });
    expect(location.reload).not.toHaveBeenCalled();
    element('start').onclick!();
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  test('the call token survives the sign-in reload, so the reloaded page continues its own call', async () => {
    const storage = new Map<string, string>();
    const first = await openPage({ tickets: [{ status: 401, body: 'unauthorized' }], storage });
    const reloaded = await openPage({ storage });
    const token = (fetch: jest.Mock) => JSON.parse((fetch.mock.calls[0] as any)[1].body).call_token;
    expect(token(first.fetch)).toMatch(/^[0-9a-f]{64}$/);
    expect(token(reloaded.fetch)).toBe(token(first.fetch));
  });

  test("the gateway's initData refusal still ends the call without a sign-in offer", async () => {
    const { element, location } = await opened({ status: 401, body: JSON.stringify({ error: 'Invalid initData' }) });
    expect(element('state').textContent).toBe('Telegram could not verify you. Reopen the call from the /call button.');
    expect(element('start').hidden).toBe(true);
    expect(location.reload).not.toHaveBeenCalled();
  });
});

describe('call page', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }); jest.setSystemTime(1_000_000); });
  afterEach(() => { jest.useRealTimers(); });

  test('opens straight into the call: no Start press, and it listens once the gateway does', async () => {
    const { element, fetch, sockets } = await openPage();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(element('start').hidden).toBe(true);
    sockets[0].open();
    expect(sockets[0].sent[0]).toEqual({ type: 'voice.start', muted: false });
    sockets[0].receive({ type: 'voice.state', state: 'listening', utterance_id: '0'.repeat(32), generation: '1'.repeat(32) });
    expect(element('state')).toMatchObject({ textContent: 'Listening', className: 'state' });
  });

  test('sound without words leaves the call calmly listening; a real error still shows', async () => {
    const { element, sockets } = await openPage();
    sockets[0].open();
    sockets[0].receive({ type: 'voice.state', state: 'listening', utterance_id: '0'.repeat(32), generation: '1'.repeat(32) });
    // As the gateway sends it for EMPTY_TRANSCRIPT: after the next listening state.
    sockets[0].receive({ type: 'voice.error', code: 'EMPTY_TRANSCRIPT', category: 'no_speech', retryable: true, message: 'No speech was recognized. Please speak again.', referenceId: 'r' });
    expect(element('state')).toMatchObject({ textContent: 'Listening', className: 'state' });
    sockets[0].receive({ type: 'voice.error', code: 'TTS_UNAVAILABLE', category: 'unavailable', message: 'The voice provider is temporarily unavailable. Please try again later.' });
    expect(element('state')).toMatchObject({ textContent: 'The voice provider is temporarily unavailable. Please try again later.', className: 'state err' });
  });

  test('the call clock starts on connect, keeps the call time across a reconnect, and stops at hang-up', async () => {
    const elapsed = { status: 200, body: JSON.stringify({ ...JSON.parse(TICKET.body), call_elapsed_ms: 66_000 }) };
    const { element, sockets, tap } = await openPage({ tickets: [TICKET, elapsed] });
    expect(element('timer').textContent).toBe('');
    sockets[0].open();
    sockets[0].receive({ type: 'voice.state', state: 'listening', utterance_id: '0'.repeat(32), generation: '1'.repeat(32) });
    expect(element('timer').textContent).toBe('0:00');
    await jest.advanceTimersByTimeAsync(65_000);
    expect(element('timer').textContent).toBe('1:05');
    sockets[0].drop(1006);
    await jest.advanceTimersByTimeAsync(600); await settle();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].receive({ type: 'voice.state', state: 'listening', utterance_id: '0'.repeat(32), generation: '1'.repeat(32) });
    // The gateway's clock for this call wins over the page's own.
    expect(element('timer').textContent).toBe('1:06');
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(element('timer').textContent).toBe('1:01:06');
    await tap('hangup');
    expect(sockets[1].sent).toContainEqual({ type: 'voice.stop', hangup: true });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(element('timer').textContent).toBe('1:01:06');
    expect(element('state').textContent).toBe('Call ended');
  });

  test('where audio needs a first touch, one Start tap resumes it and starts the call', async () => {
    const { element, fetch, sockets, tap } = await openPage({ audioNeedsTap: true });
    await jest.advanceTimersByTimeAsync(800); await settle();
    expect(element('state').textContent).toBe('Tap Start call to begin.');
    expect(element('start')).toMatchObject({ hidden: false, textContent: 'Start call' });
    expect(fetch).not.toHaveBeenCalled();
    await tap('start');
    expect(element('start').hidden).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  test('a microphone refused before any tap asks for one; refused again from a tap, the call ends', async () => {
    const tapped = await openPage({ micNeedsTap: true });
    expect(tapped.element('start')).toMatchObject({ hidden: false, textContent: 'Start call' });
    await tapped.tap('start');
    expect(tapped.getUserMedia).toHaveBeenCalledTimes(2);
    expect(tapped.sockets).toHaveLength(1);

    const denied = await openPage({ micDenied: true });
    await denied.tap('start');
    expect(denied.element('state')).toMatchObject({ textContent: 'Microphone access was denied.', className: 'state err' });
    expect(denied.element('start').hidden).toBe(true);
    expect(denied.fetch).not.toHaveBeenCalled();
  });

  const LISTENING = { type: 'voice.state', state: 'listening', utterance_id: '0'.repeat(32), generation: '1'.repeat(32) };

  test('round controls in phone order: Speaker, End call, Mute, as labelled toggle buttons', () => {
    const html = generateVoiceCallPage({ pairingId: 'a'.repeat(36), agentId: 'agent', basePath: '/gateway', maxUtteranceMs: 60000 });
    const buttons = [...html.matchAll(/<button type="button" class="round[^"]*" id="(\w+)" aria-label="([^"]+)"(?: aria-pressed="(\w+)")?>/g)].map(match => match.slice(1));
    expect(buttons).toEqual([['speaker', 'Speaker', 'true'], ['hangup', 'End call', undefined], ['mute', 'Mute', 'false']]);
    // No photo known: the initial alone, and no request that could only 404.
    expect(html).toContain('<div class="avatar" id="avatar" aria-hidden="true">A</div>');
  });

  test('the ring and chip follow the call: listening, the agent speaking, muted', async () => {
    const { element, sockets, tap } = await openPage();
    expect(element('controls').hidden).toBe(false);
    sockets[0].open();
    sockets[0].receive(LISTENING);
    expect(element('call').className).toBe('call listening');
    sockets[0].receive({ type: 'playback.start', epoch: 1 });
    expect(element('call').className).toBe('call speaking');
    expect(element('state').textContent).toBe('Speaking');
    sockets[0].receive({ type: 'playback.clear', epoch: 2 });
    expect(element('call').className).toBe('call listening');
    await tap('mute');
    expect(element('call').className).toBe('call muted');
    expect(element('mute').attributes['aria-pressed']).toBe('true');
    expect(sockets[0].sent).toContainEqual(expect.objectContaining({ type: 'voice.mute', muted: true }));
    await tap('mute');
    expect(element('call').className).toBe('call listening');
    expect(element('mute').attributes['aria-pressed']).toBe('false');
    sockets[0].receive({ type: 'voice.error', code: 'TTS_UNAVAILABLE', category: 'unavailable', message: 'Down' });
    expect(element('call').className).toBe('call');
  });

  test("Speaker turns the agent's voice off and on without touching the call", async () => {
    const { element, sockets, tap, replies, loudness } = await openPage();
    sockets[0].open();
    sockets[0].receive(LISTENING);
    sockets[0].receive({ type: 'playback.start', epoch: 1 });
    sockets[0].audio(1);
    expect(replies).toHaveLength(1);
    expect(loudness(replies[0])).toBe(1);
    await tap('speaker');
    expect(element('speaker').attributes['aria-pressed']).toBe('false');
    expect(loudness(replies[0])).toBe(0);
    sockets[0].audio(1);
    expect(loudness(replies[1])).toBe(0);
    // The call carries on: no stop, no mute sent to the gateway.
    expect(sockets[0].sent.filter(message => ['voice.stop', 'voice.mute'].includes(message.type))).toEqual([]);
    await tap('speaker');
    expect(element('speaker').attributes['aria-pressed']).toBe('true');
    expect(loudness(replies[1])).toBe(1);
  });

  test("the bot's Telegram name and photo, versioned by the photo's id; the agent id without them", () => {
    const named = generateVoiceCallPage({ pairingId: 'a'.repeat(36), agentId: 'getpod', basePath: '/gateway', maxUtteranceMs: 60000, botName: 'Meguri <Dev>', avatarVersion: 'AQADxyz' });
    expect(named).toContain(`<div class="avatar" id="avatar" aria-hidden="true">M<img id="photo" alt="" src="/gateway/voice-call/${'a'.repeat(36)}/avatar?v=AQADxyz"></div>`);
    expect(named).toContain('<div class="name">Meguri &lt;Dev&gt;</div>');
    const plain = generateVoiceCallPage({ pairingId: 'a'.repeat(36), agentId: 'getpod', basePath: '/gateway', maxUtteranceMs: 60000 });
    expect(plain).toContain('<div class="name">getpod</div>');
    expect(plain).toContain('<div class="avatar" id="avatar" aria-hidden="true">G</div>');
  });

  describe('Thinking as soon as the user stops speaking', () => {
    const NEXT = { ...LISTENING, utterance_id: '2'.repeat(32) };

    test('the chip turns to Thinking when the words end, holds through the commit and merge window, and gives way to the reply', async () => {
      const { element, sockets, hear } = await openPage();
      sockets[0].open(); sockets[0].receive(LISTENING);
      hear(0.003, 400); hear(0.2, 600);
      expect(element('call').className).toBe('call listening');
      hear(0.003, 400);
      expect(sockets[0].sent).toContainEqual(expect.objectContaining({ type: 'speech.ended' }));
      expect(element('state').textContent).toBe('Thinking');
      expect(element('call').className).toBe('call thinking');
      // The gateway commits the words and opens the next utterance while it waits for more.
      sockets[0].receive({ type: 'stt.segment', utterance_id: '0'.repeat(32), text: 'Hello', pending_text: 'Hello' });
      sockets[0].receive(NEXT);
      expect(element('call').className).toBe('call thinking');
      sockets[0].receive({ type: 'stt.final', utterance_id: '0'.repeat(32), text: 'Hello' });
      sockets[0].receive({ type: 'utterance.accepted', utterance_id: '0'.repeat(32), input_id: 'i' });
      expect(element('call').className).toBe('call thinking');
      sockets[0].receive({ type: 'playback.start', epoch: 1 });
      expect(element('call').className).toBe('call speaking');
    });

    test('speaking again before the answer returns to Listening; sound without words does too', async () => {
      const { element, sockets, hear } = await openPage();
      sockets[0].open(); sockets[0].receive(LISTENING);
      hear(0.003, 400); hear(0.2, 600); hear(0.003, 400);
      expect(element('state').textContent).toBe('Thinking');
      sockets[0].receive(NEXT);
      hear(0.2, 400);
      expect(element('call').className).toBe('call listening');
      hear(0.003, 400);
      expect(element('state').textContent).toBe('Thinking');
      sockets[0].receive({ type: 'voice.error', code: 'EMPTY_TRANSCRIPT', category: 'no_speech', retryable: true, message: 'No speech was recognized. Please speak again.' });
      expect(element('call').className).toBe('call listening');
      sockets[0].receive({ ...NEXT, utterance_id: '3'.repeat(32) });
      expect(element('call').className).toBe('call listening');
    });
  });

  describe('Mute sends what was said', () => {
    const frames = (socket: FakeSocket) => socket.sent.filter(data => data instanceof ArrayBuffer).length;
    const mutes = (socket: FakeSocket) => socket.sent.filter(message => message.type === 'voice.mute');

    test('muting mid-sentence commits the open utterance at once, so the agent answers it', async () => {
      const { sockets, tap, hear } = await openPage();
      sockets[0].open(); sockets[0].receive(LISTENING);
      hear(0.003, 400); hear(0.2, 600); // still talking: no speech.ended yet
      const sent = frames(sockets[0]);
      expect(sent).toBeGreaterThan(0);
      expect(sockets[0].sent.some(message => message.type === 'speech.ended')).toBe(false);
      await tap('mute');
      expect(mutes(sockets[0])).toEqual([{ type: 'voice.mute', muted: true, policy: 'commit', last_audio_seq: sent }]);
      hear(0.2, 400);
      expect(frames(sockets[0])).toBe(sent); // the microphone is off afterwards
    });

    test('muting with nothing said since the last commit only mutes', async () => {
      const { sockets, tap, hear } = await openPage();
      sockets[0].open(); sockets[0].receive(LISTENING);
      hear(0.003, 400);
      await tap('mute');
      expect(mutes(sockets[0])).toEqual([{ type: 'voice.mute', muted: true, policy: 'commit', last_audio_seq: 0 }]);
      await tap('mute');
      expect(mutes(sockets[0]).at(-1)).toEqual({ type: 'voice.mute', muted: false, policy: 'commit', last_audio_seq: 0 });
    });

    test('words spoken while the last utterance commits are sent with the next one, then committed by mute', async () => {
      const { sockets, tap, hear } = await openPage();
      sockets[0].open(); sockets[0].receive(LISTENING);
      hear(0.003, 400); hear(0.2, 400); hear(0.003, 400); // speech.ended: the gateway commits utterance 0
      expect(sockets[0].sent).toContainEqual(expect.objectContaining({ type: 'speech.ended' }));
      hear(0.2, 400); // more words before the gateway opens the next utterance
      await tap('mute');
      expect(mutes(sockets[0])).toEqual([]);
      const before = frames(sockets[0]);
      sockets[0].receive({ ...LISTENING, utterance_id: '2'.repeat(32) });
      const held = frames(sockets[0]) - before;
      expect(held).toBeGreaterThan(0);
      expect(mutes(sockets[0])).toEqual([{ type: 'voice.mute', muted: true, policy: 'commit', last_audio_seq: held }]);
    });

    test("the agent's reply still plays while the microphone is muted", async () => {
      const { sockets, tap, replies, loudness, element } = await openPage();
      sockets[0].open(); sockets[0].receive(LISTENING);
      await tap('mute');
      sockets[0].receive({ type: 'playback.start', epoch: 1 });
      sockets[0].audio(1);
      expect(replies).toHaveLength(1);
      expect(loudness(replies[0])).toBe(1);
      expect(element('mute').attributes['aria-pressed']).toBe('true');
    });
  });
});

describe('a used call link', () => {
  const USED = 'This call link was already used. Send /call again.';

  test('opened again from an old /call button, the page shows only that the link was used: no Starting, no microphone, no ticket, no buttons', async () => {
    const { element, fetch, getUserMedia, sockets } = await openPage({ linkUsed: true });
    expect(element('state')).toMatchObject({ textContent: USED, className: 'state err' });
    expect(fetch).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(element('controls').hidden).toBe(true);
    expect(element('start').hidden).toBe(true);
    expect(element('hint').hidden).toBe(true);
  });

  test('the page that holds the call token (a reload of the same call) still rejoins it with that token', async () => {
    const storage = new Map([['voice-call:' + 'a'.repeat(36), 'c'.repeat(64)]]);
    const { element, fetch, sockets } = await openPage({ linkUsed: true, storage });
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body).call_token).toBe('c'.repeat(64));
    expect(sockets).toHaveLength(1);
    expect(element('controls').hidden).toBe(false);
    expect(element('hint').hidden).toBe(false);
    sockets[0].open();
    sockets[0].receive({ type: 'voice.state', state: 'listening', utterance_id: '0'.repeat(32), generation: '1'.repeat(32) });
    expect(element('state')).toMatchObject({ textContent: 'Listening', className: 'state' });
  });
});

describe('theme', () => {
  test("Telegram's colour scheme decides inside Telegram; the system's outside it", () => {
    expect(voiceCallTheme({ colorScheme: 'light', themeParams: { bg_color: '#ffffff' } }, false)).toBe('light');
    expect(voiceCallTheme({ colorScheme: 'dark', themeParams: { bg_color: '#212121' } }, true)).toBe('dark');
    // telegram-web-app.js outside Telegram reports "light" without any theme colours.
    expect(voiceCallTheme({ colorScheme: 'light', themeParams: {} }, false)).toBe('dark');
    expect(voiceCallTheme(undefined, true)).toBe('light');
    expect(voiceCallTheme(undefined, false)).toBe('dark');
  });

  test("the page follows Telegram's theme as it opens and when it changes, and paints Telegram's header and background to match", async () => {
    const { root, tg, themeChanged } = await openPage({ telegramTheme: { colorScheme: 'light', themeParams: { bg_color: '#ffffff' } } });
    expect(root.attributes['data-theme']).toBe('light');
    expect(root.style.colorScheme).toBe('light');
    expect(tg.setHeaderColor).toHaveBeenLastCalledWith('bg_color');
    expect(tg.setBackgroundColor).toHaveBeenLastCalledWith('bg_color');
    themeChanged('dark', { bg_color: '#212121' });
    expect(root.attributes['data-theme']).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(tg.setHeaderColor).toHaveBeenCalledTimes(2);
  });

  test('without a Telegram theme the page follows the system setting, live', async () => {
    const { root, systemThemeChanged } = await openPage({ telegramTheme: { colorScheme: 'light', themeParams: {} }, prefersLight: true });
    expect(root.attributes['data-theme']).toBe('light');
    systemThemeChanged(false);
    expect(root.attributes['data-theme']).toBe('dark');
  });

  test('every colour on the call screen comes from a theme variable, with a light and a dark value for each semantic colour', () => {
    const html = generateVoiceCallPage({ pairingId: 'a'.repeat(36), agentId: 'agent', basePath: '/gateway', maxUtteranceMs: 60000 });
    const style = html.match(/<style>([\s\S]*)<\/style>/)![1];
    // The call screen's own palette, after the shared page style.
    const block = (selector: string) => [...style.matchAll(new RegExp(selector.replace(/[[\]"]/g, '\\$&') + ' \\{([^}]*)\\}', 'g'))].at(-1)![1];
    const dark = block(':root'), light = block(':root[data-theme="light"]');
    for (const name of ['--vc-end', '--vc-listen', '--vc-think', '--vc-speak', '--vc-muted', '--vc-err']) {
      expect(dark).toContain(name + ':');
      expect(light).toContain(name + ':');
    }
    // Telegram's own colours lead where it gives them.
    expect(dark).toContain('var(--tg-theme-bg-color,');
    expect(style).toMatch(/button\.round\.end \{[^}]*background: var\(--vc-end\)/);
    expect(style).toMatch(/\.call\.listening \.ring \{[^}]*var\(--vc-listen/);
    expect(style).toMatch(/\.call\.speaking \.ring \{[^}]*var\(--vc-speak/);
    expect(style).toMatch(/\.call\.muted \.chip \{[^}]*var\(--vc-muted\)/);
    expect(style).toMatch(/\.call\.thinking \.chip \{[^}]*var\(--vc-think\)/);
    // Speaking is orange; Thinking a blue apart from Listening's.
    for (const palette of [dark, light]) {
      const value = (name: string) => palette.match(new RegExp(name + ': (#[0-9a-f]{6})'))![1];
      const [r, g, b] = [1, 3, 5].map(i => parseInt(value('--vc-speak').slice(i, i + 2), 16));
      expect(r).toBeGreaterThan(g); expect(g).toBeGreaterThan(b); expect(r - b).toBeGreaterThan(120);
      const blue = (name: string) => [1, 3, 5].map(i => parseInt(value(name).slice(i, i + 2), 16));
      expect(blue('--vc-think')[2]).toBeGreaterThan(blue('--vc-think')[0]);
      expect(value('--vc-think')).not.toBe(value('--vc-listen'));
    }
  });
});
