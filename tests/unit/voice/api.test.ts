import { ORCHESTRATION_DEFAULTS } from '../../../src/orchestration/config';
import express from 'express';
import request from 'supertest';
import { createServer, request as httpRequest } from 'http';
import { once } from 'events';
import WebSocket from 'ws';
import { VoiceApi } from '../../../src/api/voice-router';
import { FakeSttProvider, FakeTtsProvider } from '../../../src/voice/providers/fake';
import type { AgentConfig } from '../../../src/types';
import type { AgentRunner } from '../../../src/agent/runner';

jest.mock('../../../src/voice/providers/voice-catalog', () => ({
  resolveVoiceId: async (config: {voiceId: string}) => config.voiceId || 'fixture',
  voiceChoices: async () => [{ id: 'fixture', name: 'Default' }, { id: 'alternate', name: 'Alternate' }],
}));

jest.mock('../../../src/voice/providers/registry', () => ({
  sttProvider: () => new FakeSttProvider(), ttsProvider: () => new FakeTtsProvider(),
}));

test('voice ticket requires scoped auth and origin-bound tickets without URL registration, is single-use, and releases its mic lease on disconnect', async () => {
  const agent = { id: 'a', orchestration: { enabled: true }, voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, tts: { ...ORCHESTRATION_DEFAULTS.voice.tts, voiceId: 'fixture' } } } as AgentConfig;
  const runner = { subscribeVoiceResults: async () => () => {}, apiSessionExists: async () => true, authorizeVoiceSession: async () => {}, submitVoiceUtterance: jest.fn(), stopVoiceResponse: jest.fn(), recordVoicePlayback: jest.fn() } as unknown as AgentRunner;
  const api = new VoiceApi(new Map([['a', runner]]), new Map([['a', agent]]), [{ id: 'owner', key: 'fixture', agents: ['a'] }]);
  const app = express(); app.use(express.json()); app.use('/api', api.router);
  const server = createServer(app); server.on('upgrade', (req, socket, head) => { api.upgrade(req, socket, head); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const endpoint = '/api/v1/agents/a/sessions/p/voice-sessions';
  let ws: WebSocket | undefined;
  try {
    const catalogPath = '/api/v1/agents/a/voice-sessions/voices';
    expect((await request(app).get(catalogPath)).status).toBe(401);
    expect((await request(app).get(catalogPath).set('Authorization', 'Bearer fixture').set('Origin', 'https://new-client.example')).status).toBe(200);
    const catalog = await request(app).get(catalogPath).set('Authorization', 'Bearer fixture');
    expect(catalog.body.voices.map((v: { id: string }) => v.id)).toEqual(['fixture', 'alternate']);
    expect((await request(app).post(endpoint).send({ chat_id: 'c' })).status).toBe(401);
    expect((await request(app).post(endpoint).set('Cookie', 'session=not-an-api-key').set('Origin', 'https://evil.example').send({ chat_id: 'c' })).status).toBe(401);
    const preflight = await request(app).options(endpoint).set('Origin', 'https://client.example');
    expect(preflight.status).toBe(204); expect(preflight.headers['access-control-allow-origin']).toBe('*'); expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    // The ticket is consumed before ws validates the handshake. A rejection must
    // release its lease even though no VoiceSession was ever constructed.
    const bad = await request(app).post(endpoint).set('Authorization', 'Bearer fixture').send({ chat_id: 'c' });
    expect(bad.status).toBe(200);
    const handshakeStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: `${bad.body.stream_path}?ticket=${bad.body.ticket}`,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '12' } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode));
      });
      req.once('error', reject); req.end();
    });
    expect(handshakeStatus).toBe(400);
    await new Promise(resolve => setImmediate(resolve));
    const ticket = await request(app).post(endpoint).set('Authorization', 'Bearer fixture').set('Origin', 'https://client.example').send({ chat_id: 'c' });
    expect(ticket.status).toBe(200);
    expect((await request(app).post(endpoint).set('Authorization', 'Bearer fixture').send({ chat_id: 'c' })).status).toBe(409);
    const url = `ws://127.0.0.1:${port}${ticket.body.stream_path}?ticket=${ticket.body.ticket}`;
    const wrongOrigin = new WebSocket(url, { origin: 'https://other.example' });
    const originRejected = await new Promise<Error>(resolve => wrongOrigin.once('error', resolve));
    expect(originRejected.message).toContain('403');
    ws = new WebSocket(url, { origin: 'https://client.example' });
    const ready = once(ws, 'message'); await once(ws, 'open');
    expect(JSON.parse(String((await ready)[0])).state).toBe('ready');
    const listening = once(ws, 'message'); ws.send(JSON.stringify({ type: 'voice.start' })); await listening;
    const configured = once(ws, 'message'); ws.send(JSON.stringify({ type: 'voice.configure', voice_id: 'alternate' }));
    expect(JSON.parse(String((await configured)[0]))).toMatchObject({ type: 'voice.configured', voice_id: 'alternate' });
    const modelChanged = once(ws, 'message'); ws.send(JSON.stringify({ type: 'voice.configure', model: 'gpt-6-astra' }));
    expect(JSON.parse(String((await modelChanged)[0]))).toMatchObject({ type: 'voice.configured', model: 'gpt-6-astra' });
    const invalid = once(ws, 'message'); ws.send(JSON.stringify({ type: 'voice.configure', voice_id: 'unknown' }));
    expect(JSON.parse(String((await invalid)[0]))).toMatchObject({ type: 'voice.error', code: 'INVALID_CONTROL' });
    const replay = new WebSocket(url, { origin: 'https://client.example' });
    const rejected = await new Promise<Error>(resolve => replay.once('error', resolve));
    expect(rejected.message).toContain('403');
    const closed = once(ws, 'close'); ws.close(); await closed;
    const replacement = await request(app).post(endpoint).set('Authorization', 'Bearer fixture').send({ chat_id: 'c' });
    expect(replacement.status).toBe(200);
  } finally { ws?.terminate(); await api.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
