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
import { voiceCallPairings } from '../../../src/voice/call-pairing';
import { FakeSttProvider, FakeTtsProvider } from '../../../src/voice/providers/fake';
import { encodeVoiceFrame } from '../../../src/voice/protocol';
import type { AgentConfig } from '../../../src/types';
import type { AgentRunner } from '../../../src/agent/runner';

jest.mock('../../../src/voice/providers/voice-catalog', () => ({
  resolveVoiceId: async () => 'fixture', voiceChoices: async () => [{ id: 'fixture', name: 'Default' }],
}));
jest.mock('../../../src/voice/providers/registry', () => ({ sttProvider: jest.fn(() => new FakeSttProvider()), ttsProvider: () => new FakeTtsProvider() }));

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
  const runner = { telegramVoiceSession: jest.fn(async () => 'tg-session'), authorizeVoiceSession: jest.fn(async () => {}), setBrowserVoice: jest.fn(async () => {}),
    pendingVoiceSpeech: async () => [], subscribeVoiceResults: async () => () => {}, submitVoiceUtterance: submit, stopVoiceResponse: jest.fn(),
    recordVoicePlayback: jest.fn(), saveVoiceReplay: jest.fn() } as unknown as AgentRunner;
  const agents = new Map([['a', runner]]), configs = new Map([['a', agent]]);
  const api = new VoiceApi(agents, configs, []);
  const app = express(); app.use(express.json());
  app.use('/voice-call', createVoiceCallRouter({ agents, configs, voiceApi: api, basePath: () => '', telegramStateDir: () => stateDir }));
  const server = createServer(app); server.on('upgrade', (req, socket, head) => { if (!api.upgrade(req, socket, head)) socket.destroy(); });
  const close = async () => { await api.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(stateDir, { recursive: true, force: true }); };
  return { agent, runner, submit, api, app, server, allow, close };
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
    // A forwarded link cannot open a second call; the page's own token can, once the lease is free.
    expect((await ticket({ initData: initData(42) })).body).toMatchObject({ code: 'CALL_LINK_USED' });
    expect((await ticket({ initData: initData(42) })).status).toBe(409);
    const busy = await ticket({ initData: initData(42), call_token: issued.body.call_token });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: 'Voice session already active', call_token: issued.body.call_token });
  } finally { await f.close(); }
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
      'what is on my calendar', listening.utterance_id, true, undefined, undefined]);

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
