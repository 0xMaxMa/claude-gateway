import { ORCHESTRATION_DEFAULTS } from '../../../src/orchestration/config';
import express from 'express';
import request from 'supertest';
import { createServer } from 'http';
import { once } from 'events';
import WebSocket from 'ws';
import { VoiceApi } from '../../../src/api/voice-router';
import { providerVoiceError } from '../../../src/voice/errors';
import { FakeSttProvider } from '../../../src/voice/providers/fake';
import type { AudioFormat } from '../../../src/voice/types';
import type { AgentConfig } from '../../../src/types';
import type { AgentRunner } from '../../../src/agent/runner';

// Auto picks 'refused' until the router reports the provider refusal, then 'next'.
const refusedVoices = new Set<string>();
const refuseAutoVoice = jest.fn((_config: unknown, voiceId: string) => { refusedVoices.add(voiceId); });
jest.mock('../../../src/voice/providers/voice-catalog', () => ({
  resolveVoiceId: async (config: { voiceId: string }) => config.voiceId || (refusedVoices.has('refused') ? 'next' : 'refused'),
  voiceChoices: async () => [{ id: 'refused', name: 'Refused' }, { id: 'next', name: 'Next', gender: 'female' }],
  refuseAutoVoice: (config: unknown, voiceId: string) => refuseAutoVoice(config, voiceId),
}));
const spokenWith: string[] = [];
jest.mock('../../../src/voice/providers/registry', () => ({
  sttProvider: jest.fn(() => new FakeSttProvider()),
  ttsProvider: () => ({ id: 'refusing', capabilities: { textStreaming: true, wordAlignment: false, outputFormats: [] },
    async *synthesize(options: { text: AsyncIterable<string>; voiceId: string; outputFormat: AudioFormat }) {
      spokenWith.push(options.voiceId);
      for await (const _text of options.text) {
        if (options.voiceId === 'refused') throw providerVoiceError('TTS', undefined, { error: 'voice_not_fine_tuned' });
        yield { bytes: new Uint8Array(640), format: options.outputFormat, chunkSeq: 0 };
      }
    } }),
}));
jest.mock('../../../src/voice/fast-ack', () => ({ ...jest.requireActual('../../../src/voice/fast-ack'), fastAcknowledgement: jest.fn(async () => ({ outcome: 'skipped', elapsedMs: 0 })) }));

async function call(voiceId: string, start: Record<string, unknown>) {
  const agent = { id: 'a', orchestration: { enabled: true }, voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true, tts: { ...ORCHESTRATION_DEFAULTS.voice.tts, voiceId } } } as AgentConfig;
  const pending: Array<{ responseId: string; text: string; spoken: string }> = [{ responseId: 'first', text: 'First', spoken: 'First' }];
  const runner = { setBrowserVoice: async () => {}, pendingVoiceSpeech: async () => pending, voiceTts: async (_scope: unknown, tts: unknown) => tts,
    subscribeVoiceResults: async () => () => {}, apiSessionExists: async () => true, authorizeVoiceSession: async () => {},
    stopVoiceResponse: jest.fn(), recordVoicePlayback: jest.fn(), saveVoiceReplay: jest.fn() } as unknown as AgentRunner;
  const api = new VoiceApi(new Map([['a', runner]]), new Map([['a', agent]]), [{ id: 'owner', key: 'fixture', agents: ['a'] }]);
  const app = express(); app.use(express.json()); app.use('/api', api.router);
  const server = createServer(app); server.on('upgrade', (req, socket, head) => { api.upgrade(req, socket, head); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const controls: any[] = [];
  const waitFor = async (predicate: () => boolean) => { const deadline = Date.now() + 3500; while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); expect(predicate()).toBe(true); };
  const ticket = await request(app).post('/api/v1/agents/a/sessions/s/voice-sessions').set('Authorization', 'Bearer fixture').send({ chat_id: 'c' });
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}${ticket.body.stream_path}?ticket=${ticket.body.ticket}`);
  ws.on('message', (data, binary) => {
    if (!binary) { controls.push(JSON.parse(String(data))); return; }
    const { decodeVoiceFrame } = require('../../../src/voice/protocol');
    const frame = decodeVoiceFrame(Buffer.from(data as Buffer));
    ws.send(JSON.stringify({ type: 'playback.progress', epoch: frame.epoch, sample_offset: frame.audio.length / 2 }));
  });
  await once(ws, 'open'); await waitFor(() => controls.some(c => c.state === 'ready'));
  ws.send(JSON.stringify({ type: 'voice.start', muted: true, ...start }));
  await waitFor(() => controls.some(c => c.type === 'voice.error'));
  const done = async () => { ws.terminate(); await api.close(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { controls, pending, waitFor, done };
}

beforeEach(() => { refusedVoices.clear(); refuseAutoVoice.mockClear(); spokenWith.length = 0; jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

test('a refused Auto voice reports a model error and later replies speak with the next Auto voice', async () => {
  const { controls, pending, waitFor, done } = await call('', {});
  try {
    expect(controls.find(c => c.type === 'voice.error')).toMatchObject({ category: 'model', code: 'TTS_PROVIDER_ERROR_VOICE_MODEL_MISMATCH_REASON_MODEL' });
    await waitFor(() => controls.some(c => c.type === 'voice.configured' && c.voice_id === 'next'));
    expect(refuseAutoVoice).toHaveBeenCalledWith(expect.objectContaining({ voiceId: '' }), 'refused');
    pending.push({ responseId: 'second', text: 'Second', spoken: 'Second' });
    await waitFor(() => controls.some(c => c.type === 'playback.end'));
    expect(spokenWith).toEqual(['refused', 'next']);
  } finally { await done(); }
});

test.each([['a saved voice', 'refused', {}], ['a voice chosen on the socket', '', { voice_id: 'refused' }]])('%s is reported, never replaced', async (_name, saved, start) => {
  const { controls, waitFor, done } = await call(saved, start);
  try {
    expect(controls.find(c => c.type === 'voice.error')).toMatchObject({ category: 'model' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(refuseAutoVoice).not.toHaveBeenCalled();
    expect(controls.filter(c => c.type === 'voice.configured' && c.voice_id === 'next')).toHaveLength(0);
    await waitFor(() => spokenWith.length >= 1);
    expect(new Set(spokenWith)).toEqual(new Set(['refused']));
  } finally { await done(); }
});
