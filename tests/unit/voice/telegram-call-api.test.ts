import { ORCHESTRATION_DEFAULTS } from '../../../src/orchestration/config';
import express from 'express';
import request from 'supertest';
import { createServer } from 'http';
import { once } from 'events';
import { createHmac } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { VoiceApi } from '../../../src/api/voice-router';
import { createVoiceCallRouter } from '../../../src/api/voice-call-router';
import { VOICE_CALL_VAD } from '../../../src/voice/types';
import { voiceCallPairings } from '../../../src/voice/call-pairing';
import { TelegramBotAvatars } from '../../../src/voice/telegram-avatar';
import { FakeSttProvider, FakeTtsProvider } from '../../../src/voice/providers/fake';
import { encodeVoiceFrame } from '../../../src/voice/protocol';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TelegramVoices } from '../../../src/orchestration/telegram-voices';
import type { AgentConfig } from '../../../src/types';
import type { AgentRunner } from '../../../src/agent/runner';

// Auto picks "roger"; a configured or /voices voice id is used as given.
jest.mock('../../../src/voice/providers/voice-catalog', () => ({
  resolveVoiceId: async (tts: { voiceId: string }) => tts.voiceId.trim() || 'roger',
  voiceChoices: async () => [{ id: 'fixture', name: 'Default' }, { id: 'roger', name: 'Roger', gender: 'male' }, { id: 'lily', name: 'Lily', gender: 'female' }],
}));
// Every voice id the live session asks its TTS provider to speak with.
const mockSpokenVoices: string[] = [];
jest.mock('../../../src/voice/providers/registry', () => ({ sttProvider: jest.fn(() => new FakeSttProvider()), ttsProvider: () => {
  const tts = new FakeTtsProvider(), synthesize = tts.synthesize.bind(tts);
  tts.synthesize = (options: any) => { mockSpokenVoices.push(options.voiceId); return synthesize(options); };
  return tts;
} }));
// voice.live.fastAck is on by default: keep its acknowledgement call off the network.
jest.mock('../../../src/voice/fast-ack', () => ({ fastAcknowledgement: jest.fn(async () => ({ outcome: 'skipped', elapsedMs: 0 })) }));

const BOT_TOKEN = '123456:fixture-bot-token';
/** initData exactly as Telegram signs it for a Mini App launch. */
function initData(userId: number, authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN): string {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAE', user: JSON.stringify({ id: userId, first_name: 'Fixture' }) });
  const checked = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  params.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(token).digest()).update(checked).digest('hex'));
  return params.toString();
}

function fixture(agentPatch: Partial<AgentConfig> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'voice-call-'));
  const allow = (users: string[], dmPolicy = 'allowlist') => writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ dmPolicy, allowFrom: users }));
  allow(['42']);
  const agent = { id: 'a', telegram: { botToken: BOT_TOKEN }, orchestration: { enabled: true, channels: ['telegram'] },
    voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, tts: { ...ORCHESTRATION_DEFAULTS.voice.tts, voiceId: 'fixture' } }, ...agentPatch } as AgentConfig;
  const submit = jest.fn(async () => ({ inputId: 'input', response: Promise.resolve('Done.') }));
  const store = new OrchestrationStore(':memory:', 'a'), voices = new TelegramVoices(store, () => agent.voice!.tts as never);
  const runner = { voiceTts: jest.fn(async (scope, tts) => voices.forScope(scope, tts)), telegramVoiceSession: jest.fn(async () => 'tg-session'), authorizeVoiceSession: jest.fn(async () => {}), setBrowserVoice: jest.fn(async () => {}),
    pendingVoiceSpeech: async () => [], subscribeVoiceResults: async () => () => {}, submitVoiceUtterance: submit, stopVoiceResponse: jest.fn(),
    recordVoicePlayback: jest.fn(), saveVoiceReplay: jest.fn(), notifyVoiceCallEnded: jest.fn(async () => {}) } as unknown as AgentRunner;
  const agents = new Map([['a', runner]]), configs = new Map([['a', agent]]);
  const api = new VoiceApi(agents, configs, []);
  const app = express(); app.use(express.json());
  // Telegram is unreachable here: the page falls back to the agent id and its initial.
  const avatars = new TelegramBotAvatars((async () => { throw new Error('offline'); }) as unknown as typeof fetch);
  app.use('/voice-call', createVoiceCallRouter({ agents, configs, voiceApi: api, basePath: () => '', telegramStateDir: () => stateDir, avatars }));
  const server = createServer(app); server.on('upgrade', (req, socket, head) => { if (!api.upgrade(req, socket, head)) socket.destroy(); });
  const close = async () => { await api.close(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(stateDir, { recursive: true, force: true }); };
  return { agent, runner, submit, api, app, server, allow, close, store };
}

const ORIGIN = 'https://host.example';

test('the /call ticket route proves the Telegram user, the pairing owner and the allowlist before any ticket', async () => {
  const f = fixture();
  try {
    const pairingId = voiceCallPairings.create('a', '42');
    const ticket = (body: object) => request(f.app).post(`/voice-call/${pairingId}/ticket`).set('Origin', ORIGIN).send(body);
    const page = await request(f.app).get(`/voice-call/${pairingId}`);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await request(f.app).get('/voice-call/unknown')).status).toBe(404);

    expect((await ticket({ initData: initData(42).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64)) })).status).toBe(401);
    expect((await ticket({ initData: initData(42, Math.floor(Date.now() / 1000) - 2 * 60 * 60) })).status).toBe(401);
    expect((await ticket({ initData: initData(42, undefined, '999:another-bot') })).status).toBe(401);
    expect((await ticket({ initData: initData(7) })).status).toBe(403);
    f.allow([]);
    expect((await ticket({ initData: initData(42) })).status).toBe(403);
    // Turning DMs off silences the bot's private chats, calls included.
    f.allow(['42'], 'disabled');
    expect((await ticket({ initData: initData(42) })).status).toBe(403);
    f.allow(['42']);
    // A failure after the claim still hands the page its call token, so it can retry.
    (f.runner.telegramVoiceSession as jest.Mock).mockRejectedValueOnce(new Error('session store unavailable'));
    const unavailable = await ticket({ initData: initData(42) });
    expect(unavailable.status).toBe(503);

    const issued = await ticket({ initData: initData(42), call_token: unavailable.body.call_token });
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ ticket: expect.stringMatching(/^[0-9a-f]{64}$/), call_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      stream_path: `/api/v1/agents/a/voice-sessions/${issued.body.voice_session_id}/stream`, input_format: { sampleRate: 16000 } });
    expect(f.runner.telegramVoiceSession).toHaveBeenCalledWith('42');
    expect(f.runner.authorizeVoiceSession).toHaveBeenCalledWith('tg-session', 'telegram:42');
    // A Telegram chat has no "voice off" control, so no persistent browser-voice intent is saved.
    expect(f.runner.setBrowserVoice).not.toHaveBeenCalled();
    // A ticket in a private-chat topic speaks in that topic.
    const topic = voiceCallPairings.create('a', '42', '7'), mint = jest.spyOn(f.api, 'mintTicket');
    const proposed = 'c'.repeat(64);
    const topical = await request(f.app).post(`/voice-call/${topic}/ticket`).set('Origin', ORIGIN).send({ initData: initData(42), call_token: proposed });
    expect(mint).toHaveBeenLastCalledWith('a', 'tg-session', { kind: 'telegram', principalId: 'telegram:42', chatId: '42', threadKey: '7' }, ORIGIN, true, undefined);
    // The page's proposed token is kept, so retrying after a lost response still works.
    expect(topical.body.call_token).toBe(proposed);
    expect((await request(f.app).post(`/voice-call/${topic}/ticket`).set('Origin', ORIGIN).send({ initData: initData(42), call_token: proposed })).body.call_token).toBe(proposed);
    // A forwarded link cannot open a second call.
    expect((await ticket({ initData: initData(42) })).body).toMatchObject({ code: 'CALL_LINK_USED' });
    expect((await ticket({ initData: initData(42) })).status).toBe(409);
    // The page closed before connecting: the same call asking again replaces its own unused ticket at once.
    const again = await ticket({ initData: initData(42), call_token: issued.body.call_token });
    expect(again.status).toBe(200);
    expect(f.api.liveSessionIds()).toEqual(new Set([again.body.voice_session_id]));
    // Another call in the same chat session still waits for the lease.
    const other = await request(f.app).post(`/voice-call/${topic}/ticket`).set('Origin', ORIGIN).send({ initData: initData(42), call_token: proposed });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: 'Voice session already active', call_token: proposed });
  } finally { await f.close(); }
});

test('a connected call is taken over by its own token: the held socket closes and the new one opens; the replaced ticket no longer opens', async () => {
  const f = fixture();
  f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
  const port = (f.server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  const connect = (body: { stream_path: string; ticket: string }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${body.stream_path}?ticket=${body.ticket}`, { origin: ORIGIN }); sockets.push(ws);
    return new Promise<'open' | string>(resolve => { ws.once('open', () => resolve('open')); ws.once('error', error => resolve(error.message)); });
  };
  try {
    const pairingId = voiceCallPairings.create('a', '42');
    const ticket = (body: object) => request(f.app).post(`/voice-call/${pairingId}/ticket`).set('Origin', ORIGIN).send(body);
    const stale = await ticket({ initData: initData(42) });
    const fresh = await ticket({ initData: initData(42), call_token: stale.body.call_token });
    expect(fresh.status).toBe(200);
    expect(await connect(stale.body)).toContain('403');
    expect(await connect(fresh.body)).toBe('open');
    // The network changed: the server still holds the old socket when the page asks again.
    const held = sockets[1], closed = new Promise<number>(resolve => held.once('close', code => resolve(code)));
    const rejoined = await ticket({ initData: initData(42), call_token: stale.body.call_token });
    expect(rejoined.status).toBe(200);
    expect(rejoined.body.voice_session_id).not.toBe(fresh.body.voice_session_id);
    expect(await closed).toBe(4001);
    expect(await connect(rejoined.body)).toBe('open');
    expect(f.api.liveSessionIds()).toEqual(new Set([rejoined.body.voice_session_id]));
    // Without the call token it is still someone else's call.
    expect((await ticket({ initData: initData(42) })).body).toMatchObject({ code: 'CALL_LINK_USED' });
  } finally { sockets.forEach(ws => ws.terminate()); await f.close(); }
});

test('voice disabled or an expired link refuses a ticket', async () => {
  const f = fixture({ voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: false } } as Partial<AgentConfig>);
  const now = jest.spyOn(Date, 'now');
  try {
    const pairingId = voiceCallPairings.create('a', '42');
    const disabled = await request(f.app).post(`/voice-call/${pairingId}/ticket`).send({ initData: initData(42) });
    expect(disabled.status).toBe(409); expect(disabled.body.code).toBe('VOICE_DISABLED');
    const real = Date.now();
    now.mockReturnValue(real + 4 * 60 * 1000);
    expect((await request(f.app).post(`/voice-call/${pairingId}/ticket`).send({ initData: initData(42, Math.floor(real / 1000)) })).status).toBe(410);
  } finally { now.mockRestore(); await f.close(); }
});

test('a Telegram call speaks in the DM scope over the shared voice WebSocket, survives API-key reloads, and reconnects with its call token', async () => {
  const f = fixture();
  const { sttProvider } = require('../../../src/voice/providers/registry');
  const stt = new FakeSttProvider(); sttProvider.mockReturnValueOnce(stt);
  f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
  const port = (f.server.address() as { port: number }).port;
  const events: any[] = [];
  const until = async (fn: () => boolean) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > 5000) throw Error('voice fixture timeout'); await new Promise(r => setTimeout(r, 5)); } };
  let ws: WebSocket | undefined;
  try {
    const pairingId = voiceCallPairings.create('a', '42');
    const issued = await request(f.app).post(`/voice-call/${pairingId}/ticket`).set('Origin', ORIGIN).send({ initData: initData(42) });
    const url = `ws://127.0.0.1:${port}/gateway${issued.body.stream_path}?ticket=${issued.body.ticket}`;
    const wrongOrigin = new WebSocket(url, { origin: 'https://evil.example' });
    expect((await new Promise<Error>(resolve => wrongOrigin.once('error', resolve))).message).toContain('403');
    // The ticket is bound to the page origin; the page itself can still use it (under the public-URL prefix).
    ws = new WebSocket(url, { origin: ORIGIN });
    ws.on('message', (data, binary) => { if (!binary) events.push(JSON.parse(String(data))); });
    await until(() => events.some(e => e.state === 'ready'));
    ws.send(JSON.stringify({ type: 'voice.start' }));
    await until(() => events.some(e => e.state === 'listening'));
    const listening = events.find(e => e.state === 'listening');
    ws.send(encodeVoiceFrame({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(640) }));
    await until(() => stt.sessions[0]?.frames.length === 1);
    ws.send(JSON.stringify({ type: 'utterance.commit', last_audio_seq: 1, final: true }));
    await until(() => Boolean(stt.sessions[0].commitId));
    stt.sessions[0].emit({ type: 'segment_final', segmentId: 'segment', text: 'what is on my calendar' });
    stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
    await until(() => f.submit.mock.calls.length === 1);
    expect(f.submit.mock.calls[0]).toEqual(['tg-session', { kind: 'telegram', principalId: 'telegram:42', chatId: '42', threadKey: '' },
      'what is on my calendar', listening.utterance_id, true, undefined, undefined, expect.any(Function)]);

    // API keys authorize API calls only; reloading them must not drop a Telegram call.
    f.api.invalidateAuthorization();
    await new Promise(r => setTimeout(r, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // An STT drop closes with 1012 and releases the lease before the reconnect ticket.
    stt.sessions[0].emit({ type: 'error', code: 'STT_CONNECTION_CLOSED', retryable: true });
    const [code] = await once(ws, 'close');
    expect(code).toBe(1012);
    // Telegram never refreshes initData: a call older than its one-hour limit reconnects with its call token,
    // while stale initData alone, or with a wrong token, cannot.
    const stale = initData(42, Math.floor(Date.now() / 1000) - 2 * 60 * 60);
    expect((await request(f.app).post(`/voice-call/${pairingId}/ticket`).set('Origin', ORIGIN).send({ initData: stale })).status).toBe(401);
    expect((await request(f.app).post(`/voice-call/${pairingId}/ticket`).set('Origin', ORIGIN).send({ initData: stale, call_token: 'f'.repeat(64) })).status).toBe(409);
    const reconnect = await request(f.app).post(`/voice-call/${pairingId}/ticket`).set('Origin', ORIGIN).send({ initData: stale, call_token: issued.body.call_token });
    expect(reconnect.status).toBe(200);
    // A call that stays connected keeps its link alive past the 30-minute window.
    const now = jest.spyOn(Date, 'now'), start = Date.now();
    try {
      voiceCallPairings.prune(id => id === reconnect.body.voice_session_id);
      now.mockReturnValue(start + 29 * 60 * 1000);
      voiceCallPairings.prune(id => id === reconnect.body.voice_session_id);
      now.mockReturnValue(start + 45 * 60 * 1000);
      expect(voiceCallPairings.get(pairingId)).toBeDefined();
      now.mockReturnValue(start + 90 * 60 * 1000);
      voiceCallPairings.prune(() => false);
      expect(voiceCallPairings.get(pairingId)).toBeUndefined();
    } finally { now.mockRestore(); }
    // Opening a call still needs fresh initData, whatever token is presented.
    const unclaimed = voiceCallPairings.create('a', '42');
    expect((await request(f.app).post(`/voice-call/${unclaimed}/ticket`).set('Origin', ORIGIN).send({ initData: stale, call_token: issued.body.call_token })).status).toBe(401);
  } finally { ws?.terminate(); await f.close(); }
});

test('API-key reloads still revoke API voice calls', async () => {
  const f = fixture();
  f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
  const port = (f.server.address() as { port: number }).port;
  try {
    const minted = await f.api.mintTicket('a', 'api-session', { kind: 'api', principalId: 'api:owner', chatId: 'chat' }, ORIGIN, false);
    expect(minted.status).toBe(200);
    expect(f.runner.setBrowserVoice).toHaveBeenCalledWith('api-session', 'api:owner', true);
    const body = minted.body as { stream_path: string; ticket: string };
    const ws = new WebSocket(`ws://127.0.0.1:${port}${body.stream_path}?ticket=${body.ticket}`, { origin: ORIGIN });
    await once(ws, 'message');
    f.api.invalidateAuthorization();
    const [code] = await once(ws, 'close');
    expect(code).toBe(1008);
  } finally { await f.close(); }
});

test('voice.turns.mergeWindowMs reaches the voice session: 0 admits a committed utterance without a merge window', async () => {
  for (const [mergeWindowMs, merged] of [[0, false], [1200, true]] as const) {
    const f = fixture({ voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, tts: { ...ORCHESTRATION_DEFAULTS.voice.tts, voiceId: 'fixture' }, turns: { ...ORCHESTRATION_DEFAULTS.voice.turns, mergeWindowMs } } } as Partial<AgentConfig>);
    const { sttProvider } = require('../../../src/voice/providers/registry');
    const stt = new FakeSttProvider(); sttProvider.mockReturnValueOnce(stt);
    f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
    const events: any[] = [];
    const until = async (fn: () => boolean) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > 5000) throw Error('voice fixture timeout'); await new Promise(r => setTimeout(r, 5)); } };
    let ws: WebSocket | undefined;
    try {
      const issued = await request(f.app).post(`/voice-call/${voiceCallPairings.create('a', '42')}/ticket`).set('Origin', ORIGIN).send({ initData: initData(42) });
      ws = new WebSocket(`ws://127.0.0.1:${(f.server.address() as { port: number }).port}${issued.body.stream_path}?ticket=${issued.body.ticket}`, { origin: ORIGIN });
      ws.on('message', (data, binary) => { if (!binary) events.push(JSON.parse(String(data))); });
      await until(() => events.some(e => e.state === 'ready'));
      ws.send(JSON.stringify({ type: 'voice.start' }));
      await until(() => events.some(e => e.state === 'listening'));
      const listening = events.find(e => e.state === 'listening');
      ws.send(encodeVoiceFrame({ generation: listening.generation, epoch: 0, sequence: 1, segmentId: listening.utterance_id, audio: Buffer.alloc(640) }));
      await until(() => stt.sessions[0]?.frames.length === 1);
      ws.send(JSON.stringify({ type: 'utterance.commit', last_audio_seq: 1 }));
      await until(() => Boolean(stt.sessions[0].commitId));
      stt.sessions[0].emit({ type: 'segment_final', segmentId: 'segment', text: 'hello' });
      stt.sessions[0].emit({ type: 'commit_done', commitId: stt.sessions[0].commitId! });
      await until(() => events.some(e => e.type === 'stt.segment' || e.type === 'stt.final'));
      expect(events.some(e => e.type === 'stt.segment')).toBe(merged);
    } finally { ws?.terminate(); await f.close(); }
  }
});

test('hanging up posts one call-length notice for the whole call; a socket that never started posts none', async () => {
  const f = fixture();
  f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
  const port = (f.server.address() as { port: number }).port;
  const until = async (fn: () => boolean) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > 5000) throw Error('voice fixture timeout'); await new Promise(r => setTimeout(r, 5)); } };
  const notify = f.runner.notifyVoiceCallEnded as jest.Mock;
  const sockets: WebSocket[] = [];
  const open = async (pairingId: string, body: object) => {
    const issued = await request(f.app).post(`/voice-call/${pairingId}/ticket`).set('Origin', ORIGIN).send(body);
    expect(issued.status).toBe(200);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${issued.body.stream_path}?ticket=${issued.body.ticket}`, { origin: ORIGIN }), events: any[] = [];
    sockets.push(ws);
    ws.on('message', (data, binary) => { if (!binary) events.push(JSON.parse(String(data))); });
    await until(() => events.some(e => e.state === 'ready'));
    return { ws, events, issued: issued.body };
  };
  const clock = jest.spyOn(Date, 'now'), real = clock.getMockImplementation() ?? (() => new Date().getTime());
  let offset = 0; clock.mockImplementation(() => real() + offset);
  try {
    // Opened, never listening, then closed: not a call.
    const silent = voiceCallPairings.create('a', '42');
    const idle = await open(silent, { initData: initData(42) });
    idle.ws.send(JSON.stringify({ type: 'voice.stop', hangup: true }));
    await once(idle.ws, 'close');

    const pairingId = voiceCallPairings.create('a', '42');
    const first = await open(pairingId, { initData: initData(42) });
    expect(first.issued.call_elapsed_ms).toBeUndefined();
    first.ws.send(JSON.stringify({ type: 'voice.start' }));
    await until(() => first.events.some(e => e.state === 'listening'));
    // The network drops; the page rejoins the same call and keeps its clock.
    offset += 20_000;
    first.ws.terminate();
    await until(() => voiceCallPairings.get(pairingId)?.call?.connected === false);
    const second = await open(pairingId, { initData: initData(42), call_token: first.issued.call_token });
    expect(second.issued.call_elapsed_ms).toBeGreaterThanOrEqual(20_000);
    expect(second.issued.call_elapsed_ms).toBeLessThan(25_000);
    second.ws.send(JSON.stringify({ type: 'voice.start' }));
    await until(() => second.events.some(e => e.state === 'listening'));
    second.ws.send(JSON.stringify({ type: 'voice.stop', hangup: 'yes' }));
    await until(() => second.events.some(e => e.type === 'voice.error' && e.code === 'INVALID_CONTROL'));
    offset += 202_000;
    second.ws.send(JSON.stringify({ type: 'voice.stop', hangup: true }));
    await once(second.ws, 'close');
    await until(() => notify.mock.calls.length > 0);
    await new Promise(r => setTimeout(r, 50));
    expect(notify).toHaveBeenCalledTimes(1);
    const [sessionId, scope, durationMs] = notify.mock.calls[0];
    expect([sessionId, scope]).toEqual(['tg-session', { kind: 'telegram', principalId: 'telegram:42', chatId: '42', threadKey: '' }]);
    expect(durationMs).toBeGreaterThanOrEqual(222_000);
    expect(durationMs).toBeLessThan(227_000);
  } finally { clock.mockRestore(); sockets.forEach(ws => ws.terminate()); await f.close(); }
});

test('a /call speaks with the chat\'s /voices choice, and with the configured default when the chat chose none', async () => {
  const until = async (fn: () => boolean) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > 5000) throw Error('voice fixture timeout'); await new Promise(r => setTimeout(r, 5)); } };
  // [/voices choice for chat 42, configured voice, voice the call must speak with, persona gender]
  const cases = [['lily', '', 'lily', 'female'], [undefined, '', 'roger', 'male'], [undefined, 'fixture', 'fixture', undefined], ['lily', 'fixture', 'lily', 'female']] as const;
  for (const [chosen, configured, expected, gender] of cases) {
    const f = fixture({ voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, tts: { ...ORCHESTRATION_DEFAULTS.voice.tts, voiceId: configured } } } as Partial<AgentConfig>);
    // What /voices stores for a private chat; another chat's choice must not leak in.
    f.store.run('INSERT INTO telegram_tts_voices VALUES(?,?,?)', '7', ORCHESTRATION_DEFAULTS.voice.tts.provider, 'other');
    if (chosen) f.store.run('INSERT INTO telegram_tts_voices VALUES(?,?,?)', '42', ORCHESTRATION_DEFAULTS.voice.tts.provider, chosen);
    let receive: ((result: { responseId: string; text: string; spoken: string }) => void) | undefined, persona: (() => string | undefined) | undefined;
    (f.runner as any).subscribeVoiceResults = async (_s: string, _p: string, r: typeof receive, g: typeof persona) => { receive = r; persona = g; return () => {}; };
    f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
    const events: any[] = [];
    let ws: WebSocket | undefined;
    mockSpokenVoices.length = 0;
    try {
      const issued = await request(f.app).post(`/voice-call/${voiceCallPairings.create('a', '42')}/ticket`).set('Origin', ORIGIN).send({ initData: initData(42) });
      ws = new WebSocket(`ws://127.0.0.1:${(f.server.address() as { port: number }).port}${issued.body.stream_path}?ticket=${issued.body.ticket}`, { origin: ORIGIN });
      ws.on('message', (data, binary) => { if (!binary) events.push(JSON.parse(String(data))); });
      await until(() => events.some(e => e.state === 'ready'));
      ws.send(JSON.stringify({ type: 'voice.start' }));
      await until(() => events.some(e => e.state === 'listening'));
      expect(events.find(e => e.type === 'voice.configured')?.voice_id).toBe(expected);
      expect(persona?.()).toBe(gender);
      receive!({ responseId: 'r1', text: 'Hello.', spoken: 'Hello.' });
      await until(() => events.some(e => e.type === 'playback.start' && e.phase === 'response'));
      expect(events.find(e => e.type === 'playback.start' && e.phase === 'response').voice_id).toBe(expected);
      await until(() => mockSpokenVoices.length > 0);
      expect(mockSpokenVoices).toEqual([expected]);
    } finally { ws?.terminate(); await f.close(); }
  }
});

test('an API voice call keeps the configured voice: /voices is a Telegram chat setting', async () => {
  const f = fixture({ voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, tts: { ...ORCHESTRATION_DEFAULTS.voice.tts, voiceId: '' } } } as Partial<AgentConfig>);
  f.store.run('INSERT INTO telegram_tts_voices VALUES(?,?,?)', '42', ORCHESTRATION_DEFAULTS.voice.tts.provider, 'lily');
  f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
  const events: any[] = [];
  const until = async (fn: () => boolean) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > 5000) throw Error('voice fixture timeout'); await new Promise(r => setTimeout(r, 5)); } };
  let ws: WebSocket | undefined;
  try {
    const minted = await f.api.mintTicket('a', 'api-session', { kind: 'api', principalId: 'api:owner', chatId: '42' }, ORIGIN, false);
    const body = minted.body as { stream_path: string; ticket: string };
    ws = new WebSocket(`ws://127.0.0.1:${(f.server.address() as { port: number }).port}${body.stream_path}?ticket=${body.ticket}`, { origin: ORIGIN });
    ws.on('message', (data, binary) => { if (!binary) events.push(JSON.parse(String(data))); });
    await until(() => events.some(e => e.state === 'ready'));
    ws.send(JSON.stringify({ type: 'voice.start' }));
    await until(() => events.some(e => e.type === 'voice.configured'));
    expect(events.find(e => e.type === 'voice.configured').voice_id).toBe('roger');
  } finally { ws?.terminate(); await f.close(); }
});

test('the call page decides up front: a fresh link opens the call, a used, expired or unknown one shows only how it ended', async () => {
  const f = fixture();
  const now = jest.spyOn(Date, 'now');
  const page = (pairingId: string) => request(f.app).get(`/voice-call/${pairingId}`);
  const calling = (html: string) => ({ starting: html.includes('id="state">Starting…<'), script: html.includes("api('/ticket')") });
  try {
    // Rendering never claims a link: the call still opens after any number of loads.
    const fresh = voiceCallPairings.create('a', '42');
    for (let i = 0; i < 2; i++) {
      const opened = await page(fresh);
      expect(opened.status).toBe(200);
      expect(calling(opened.text)).toEqual({ starting: true, script: true });
      expect(opened.text).toContain('"linkUsed":false');
    }
    const claimed = await request(f.app).post(`/voice-call/${fresh}/ticket`).set('Origin', ORIGIN).send({ initData: initData(42) });
    expect(claimed.status).toBe(200);

    // Used: the page that holds the call token may still rejoin, so the call script stays; nothing else starts.
    const used = await page(fresh);
    expect(used.status).toBe(200);
    expect(used.text).toContain('<span class="state err" id="state">This call link was already used. Send /call again.</span>');
    expect(used.text).toContain('"linkUsed":true');
    expect(calling(used.text)).toEqual({ starting: false, script: true });

    const expired = voiceCallPairings.create('a', '42');
    now.mockReturnValue(Date.now() + 4 * 60 * 1000);
    for (const gone of [await page(expired), await page('unknown')]) {
      expect(gone.status).toBe(404);
      expect(gone.headers['cache-control']).toBe('no-store');
      expect(gone.text).toContain('This call link has expired. Send /call again.');
      expect(calling(gone.text)).toEqual({ starting: false, script: false });
    }
  } finally { now.mockRestore(); await f.close(); }
});

test('the call page embeds the agent voice.live.vad overrides over the default VAD', async () => {
  const f = fixture({ voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, tts: { ...ORCHESTRATION_DEFAULTS.voice.tts, voiceId: 'fixture' }, live: { vad: { minLevel: 0.04 } } } });
  try {
    const page = await request(f.app).get(`/voice-call/${voiceCallPairings.create('a', '42')}`);
    const cfg = JSON.parse(/var CFG = (\{.*?\});/.exec(page.text)![1]);
    expect(cfg.vad).toEqual({ ...VOICE_CALL_VAD, minLevel: 0.04 });
  } finally { await f.close(); }
});
