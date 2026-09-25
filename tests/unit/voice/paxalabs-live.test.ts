jest.mock('../../../src/config/claude-settings', () => ({ claudeSettingsEnv: () => ({}) }));
import { PaxaLabsLiveStt, PAXA_REALTIME_STT_MODEL, isPaxaRealtimeSttModel } from '../../../src/voice/providers/paxalabs-live-stt';
import { sttProvider } from '../../../src/voice/providers/registry';
import { BoundedQueue } from '../../../src/voice/queue';
import { PCM16 } from '../../../src/voice/types';
import { VoiceTurnManager } from '../../../src/voice/turn-manager';
import { SocketFactory } from '../../../src/voice/providers/socket';

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

type Frames = BoundedQueue<Record<string, any>>;
/** Builds a fresh fake socket per connection, so reconnect-per-utterance is observable. */
function fakeConnect(hooks: { onSend?: (value: any, messages: Frames) => void; onAudio?: (messages: Frames) => void }) {
  const sockets: Array<{ url: string; headers: Record<string, string>; sent: any[]; audioFrames: number }> = [];
  const connect: SocketFactory = async (url, headers) => {
    const messages: Frames = new BoundedQueue(10000, () => 1);
    const record = { url, headers, sent: [] as any[], audioFrames: 0 };
    sockets.push(record);
    return {
      messages,
      audio: async () => { record.audioFrames++; hooks.onAudio?.(messages); },
      close: () => messages.close(),
      send: async (value: any) => { record.sent.push(value); hooks.onSend?.(value, messages); },
    };
  };
  return { connect, sockets };
}

test('realtime model predicate distinguishes streaming ids from batch ids', () => {
  expect(isPaxaRealtimeSttModel(PAXA_REALTIME_STT_MODEL)).toBe(true);
  expect(isPaxaRealtimeSttModel('paxa-stt-lite-v1-preview')).toBe(false);
});

test('registry routes the realtime model to live streaming and the batch model to recorded', () => {
  process.env.PAXALABS_API_KEY = 'fixture';
  const live = sttProvider({ provider: 'paxalabs', model: PAXA_REALTIME_STT_MODEL });
  expect(live.capabilities.partials).toBe(true);
  expect(live.capabilities.mode).toBe('realtime');
  const batch = sttProvider({ provider: 'paxalabs', model: 'paxa-stt-lite-v1-preview' });
  expect(batch.capabilities.partials).toBe(false);
  expect(batch.capabilities.mode).toBe('batch');
});

test('live Paxa joins per-pause turns, commits on done and reconnects for the next utterance', async () => {
  process.env.PAXALABS_API_KEY = 'fixture';
  const { connect, sockets } = fakeConnect({ onSend: (value, messages) => {
    if (value.type === 'end') {
      // The server splits a pause into two turns, each with its own final transcript.
      messages.push({ type: 'transcript', text: 'Hello', is_final: true, turn: 1 });
      messages.push({ type: 'transcript', text: 'world', is_final: true, turn: 2 });
      messages.push({ type: 'done', total_seconds: 2, turns: 2 });
    }
  } });
  const session = await new PaxaLabsLiveStt('paxalabs', PAXA_REALTIME_STT_MODEL, connect).open({ format: PCM16, language: 'th', signal: new AbortController().signal });
  let turn = new VoiceTurnManager(session, 16000, 500);
  const events: any[] = [];
  const reading = (async () => { for await (const event of session.events) { events.push(event); turn.event(event); } })();
  for (let i = 0; i < 2; i++) {
    turn = new VoiceTurnManager(session, 16000, 500);
    await turn.pushAudio(1, Buffer.alloc(3200));
    expect(await turn.commit(1)).toBe('Hello world');
  }
  expect(sockets).toHaveLength(2); // one socket per utterance — Paxa closes at done
  expect(sockets[0].sent[0]).toMatchObject({ type: 'start', model: PAXA_REALTIME_STT_MODEL, audio: { encoding: 'pcm_s16le', sample_rate: 16000 }, language: 'th' });
  expect(sockets[0].headers.Authorization).toBe('Bearer fixture');
  expect(sockets[0].audioFrames).toBe(1);
  expect(events.filter(e => e.type === 'commit_done')).toHaveLength(2);
  expect(events.filter(e => e.type === 'segment_final').map(e => e.text)).toEqual(['Hello', 'world', 'Hello', 'world']);
  await session.close();
  await reading;
});

test('an interim transcript surfaces as a partial carrying the finished turns plus the current text', async () => {
  process.env.PAXALABS_API_KEY = 'fixture';
  const { connect } = fakeConnect({
    onAudio: messages => messages.push({ type: 'transcript', text: 'partial words', is_final: false }),
    onSend: (value, messages) => {
      if (value.type === 'end') {
        messages.push({ type: 'transcript', text: 'final words', is_final: true, turn: 1 });
        messages.push({ type: 'done', total_seconds: 1, turns: 1 });
      }
    },
  });
  const session = await new PaxaLabsLiveStt('paxalabs', PAXA_REALTIME_STT_MODEL, connect).open({ format: PCM16, signal: new AbortController().signal });
  const turn = new VoiceTurnManager(session, 16000, 500);
  const partials: string[] = [];
  const reading = (async () => { for await (const event of session.events) { turn.event(event); if (event.type === 'partial') partials.push(event.text); } })();
  await turn.pushAudio(1, Buffer.alloc(3200));
  expect(await turn.commit(1)).toBe('final words');
  expect(partials).toContain('partial words');
  await session.close();
  await reading;
});

test('a turn error frame fails the commit instead of hanging', async () => {
  process.env.PAXALABS_API_KEY = 'fixture';
  const { connect } = fakeConnect({ onSend: (value, messages) => { if (value.type === 'end') messages.push({ type: 'error', turn: 1 }); } });
  const session = await new PaxaLabsLiveStt('paxalabs', PAXA_REALTIME_STT_MODEL, connect).open({ format: PCM16, signal: new AbortController().signal });
  const turn = new VoiceTurnManager(session, 16000, 500);
  const reading = (async () => { try { for await (const event of session.events) turn.event(event); } catch { /* queue closes with the provider error */ } })();
  await turn.pushAudio(1, Buffer.alloc(3200));
  await expect(turn.commit(1)).rejects.toThrow();
  await session.close();
  await reading;
});

test('missing credentials and unsupported languages are rejected before connecting', async () => {
  const previous = process.env.PAXALABS_API_KEY;
  delete process.env.PAXALABS_API_KEY;
  const { connect, sockets } = fakeConnect({});
  await expect(new PaxaLabsLiveStt('paxalabs', PAXA_REALTIME_STT_MODEL, connect).open({ format: PCM16, signal: new AbortController().signal })).rejects.toThrow('STT_CREDENTIALS_MISSING');
  process.env.PAXALABS_API_KEY = 'fixture';
  await expect(new PaxaLabsLiveStt('paxalabs', PAXA_REALTIME_STT_MODEL, connect).open({ format: PCM16, language: 'ja', signal: new AbortController().signal })).rejects.toThrow('STT_LANGUAGE_UNSUPPORTED');
  expect(sockets).toHaveLength(0);
  if (previous === undefined) delete process.env.PAXALABS_API_KEY; else process.env.PAXALABS_API_KEY = previous;
});

test('a failed start handshake is not cached, so the next utterance reconnects instead of wedging', async () => {
  process.env.PAXALABS_API_KEY = 'fixture';
  let attempt = 0;
  const connect: SocketFactory = async () => {
    const messages: Frames = new BoundedQueue(10000, () => 1);
    const n = attempt++;
    return {
      messages,
      audio: async () => {},
      close: () => messages.close(),
      send: async (value: any) => {
        // The server accepts the socket then drops it before acknowledging start.
        if (value.type === 'start' && n === 0) throw new Error('PROVIDER_CONNECTION_CLOSED');
        if (value.type === 'end') { messages.push({ type: 'transcript', text: 'Hello', is_final: true, turn: 1 }); messages.push({ type: 'done', total_seconds: 1, turns: 1 }); }
      },
    };
  };
  const session = await new PaxaLabsLiveStt('paxalabs', PAXA_REALTIME_STT_MODEL, connect).open({ format: PCM16, signal: new AbortController().signal });
  const events: any[] = [];
  const reading = (async () => { try { for await (const event of session.events) events.push(event); } catch { /* not expected */ } })();
  await expect(session.pushAudio(Buffer.alloc(3200))).rejects.toThrow(); // start failed — surfaced, not swallowed
  await session.pushAudio(Buffer.alloc(3200)); // must reconnect on a fresh socket, not reuse the dead one
  await session.commitSegment('c1');
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(attempt).toBe(2); // reconnected — the dead socket was never cached
  expect(events.filter(e => e.type === 'segment_final').map(e => e.text)).toEqual(['Hello']);
  expect(events.filter(e => e.type === 'commit_done')).toHaveLength(1);
  await session.close();
  await reading;
});

test('partials keep earlier finalized turns after a mid-utterance reconnect', async () => {
  process.env.PAXALABS_API_KEY = 'fixture';
  const queues: Frames[] = [];
  let attempt = 0;
  const connect: SocketFactory = async () => {
    const messages: Frames = new BoundedQueue(10000, () => 1);
    const n = attempt++;
    queues.push(messages);
    return {
      messages,
      audio: async () => { if (n === 1) messages.push({ type: 'transcript', text: 'again', is_final: false }); },
      close: () => messages.close(),
      send: async () => {},
    };
  };
  const session = await new PaxaLabsLiveStt('paxalabs', PAXA_REALTIME_STT_MODEL, connect).open({ format: PCM16, signal: new AbortController().signal });
  const partials: string[] = [];
  const reading = (async () => { for await (const event of session.events) if (event.type === 'partial') partials.push(event.text); })();
  // First socket: one finalized turn, then the server ends the turn (done) while the client is still speaking — no `end` was sent.
  await session.pushAudio(Buffer.alloc(3200));
  queues[0].push({ type: 'transcript', text: 'Hello', is_final: true, turn: 1 });
  queues[0].push({ type: 'done', total_seconds: 1, turns: 1 });
  await new Promise(resolve => setTimeout(resolve, 10)); // let the run loop drain socket 0 and drop the live socket
  // Second socket for the SAME uncommitted utterance: its interim partial must still carry the earlier 'Hello'.
  await session.pushAudio(Buffer.alloc(3200));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(attempt).toBe(2);
  expect(partials).toContain('Hello again');
  await session.close();
  await reading;
});
