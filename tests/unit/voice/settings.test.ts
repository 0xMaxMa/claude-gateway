jest.mock('../../../src/config/claude-settings', () => ({claudeSettingsEnv: () => ({})}));
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { voiceSettingsRouter } from '../../../src/api/voice-settings-router';
import { effectiveOrchestration } from '../../../src/orchestration/gateway-config';
import type { AgentConfig } from '../../../src/types';
import { upstreamVoiceConnection } from '../../../src/voice/providers/upstream';

test('voice settings require scoped writes and persist overrides without clobbering other config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-config-')),
    path = join(dir, 'config.json');
  const raw = {
    gateway: {
      orchestration: {
        enabled: true,
        voice: { language: 'ja', tts: { voiceId: 'inherited' } },
      },
    },
    agents: [
      {
        id: 'a',
        workspace: '/workspace',
        orchestration: { tasks: { maxConcurrentPerAgent: 14 } },
      },
      { id: 'other', name: 'Keep' },
    ],
  };
  writeFileSync(path, JSON.stringify(raw));
  const configs = new Map([
    [
      'a',
      {
        id: 'a',
        orchestration: effectiveOrchestration(
          {},
          structuredClone(raw.gateway.orchestration),
        ),
      } as AgentConfig,
    ],
  ]);
  const app = express();
  app.use(express.json());
  app.use(
    voiceSettingsRouter(
      configs,
      new Map(),
      [
        { id: 'reader', key: 'read', agents: ['a'] },
        { id: 'writer', key: 'write', agents: ['a'], write: true },
        { id: 'other', key: 'other', agents: ['other'], write: true },
      ],
      path,
    ),
  );
  try {
    expect((await request(app).get('/v1/agents/a/voice-settings')).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .patch('/v1/agents/a/voice-settings')
          .set('Authorization', 'Bearer read')
          .send({ enabled: true })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch('/v1/agents/a/voice-settings')
          .set('Authorization', 'Bearer other')
          .send({ enabled: true })
      ).status,
    ).toBe(403);
    const response = await request(app)
      .patch('/v1/agents/a/voice-settings')
      .set('Authorization', 'Bearer write')
      .send({
        enabled: true,
        allowedOrigins: ['https://legacy.example'],
        tts: { provider: 'upstream' },
        stt: { provider: 'upstream' },
      });
    expect({ status: response.status, error: response.body.error }).toEqual({
      status: 200,
      error: undefined,
    });
    expect(response.body.voice).toMatchObject({
      enabled: true,
      language: 'ja',
      tts: { provider: 'upstream', voiceId: 'inherited' },
    });
    expect(response.body.voice).not.toHaveProperty('allowedOrigins');
    const current = await request(app).get('/v1/agents/a/voice-settings').set('Authorization', 'Bearer read');
    expect(current.body.voice).not.toHaveProperty('allowedOrigins');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.agents[0].voice).not.toHaveProperty('allowedOrigins');
    expect(saved.gateway.orchestration).toBe(true);
    expect(saved.agents[0].orchestration).not.toHaveProperty('voice');
    expect(saved.agents[1]).toMatchObject(raw.agents[1]);
    expect(saved.agents[1].voice.language).toBe('ja');
    expect(saved.agents[0].orchestration.tasks).toEqual({
      maxConcurrentPerAgent: 14,
    });
    expect(
      (
        await request(app)
          .get('/v1/agents/a/voice-settings')
          .set('Authorization', 'Bearer read')
      ).body.voice.tts.provider,
    ).toBe('upstream');
    const before = readFileSync(path, 'utf8');
    for (const invalid of [
      { enabled: 'yes' },
      { apiKey: 'do-not-store' },
      { tts: { provider: 'unknown' } },
      { notes: { provider: 'deepgram' } },
      { notes: { model: ' ' } },
      { allowedOrigins: ['*'] },
      { playback: { bargeIn: false } },
    ])
      expect(
        (
          await request(app)
            .patch('/v1/agents/a/voice-settings')
            .set('Authorization', 'Bearer write')
            .send(invalid)
        ).status,
      ).toBe(400);
    expect(readFileSync(path, 'utf8')).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('upstream voice uses existing provider URL and auth without a GetPod-specific key', () => {
  const old = { ...process.env };
  try {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example/gateway';
    process.env.ANTHROPIC_AUTH_TOKEN = 'pod-secret';
    expect(upstreamVoiceConnection()).toEqual({
      base: new URL('https://provider.example/v1/voice/elevenlabs/'),
      key: 'pod-secret',
    });
    process.env.ANTHROPIC_BASE_URL = 'http://external.example';
    expect(() => upstreamVoiceConnection()).toThrow(
      'INVALID_UPSTREAM_VOICE_URL',
    );
    process.env.ANTHROPIC_BASE_URL = 'https://user:password@provider.example';
    expect(() => upstreamVoiceConnection()).toThrow();
  } finally {
    process.env = old;
  }
});

test('restricted model catalog permission does not hide usable voices', async () => {
  const catalog = await import('../../../src/voice/providers/voice-catalog');
  const choices = jest.spyOn(catalog, 'voiceChoices').mockResolvedValue([{ id: 'jessica', name: 'Jessica', gender: 'female' }]);
  const fetchModels = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"error":"models_read required"}', { status: 401 }));
  const configs = new Map([['a', { id: 'a' } as AgentConfig]]);
  const app = express();
  app.use(voiceSettingsRouter(configs, new Map(), [{ id: 'read', key: 'read', agents: ['a'] }]));
  try {
    const response = await request(app).get('/v1/agents/a/voice-settings/catalog?provider=elevenlabs').set('Authorization', 'Bearer read');
    expect(response.status).toBe(200);
    expect(response.body.voices).toEqual([{ id: 'jessica', name: 'Jessica', gender: 'female' }]);
    expect(response.body.models).toEqual(expect.arrayContaining([expect.objectContaining({model_id:'scribe_v2_realtime',realtime:true}),expect.objectContaining({model_id:'scribe_v2',voice_messages:true,conversation:false})]));
    expect(response.body.warnings[0]).toContain('models_read');
    expect(response.body.models).toContainEqual(expect.objectContaining({model_id:'eleven_v3_conversational',catalog_source:'supported_defaults'}));
  } finally { choices.mockRestore(); fetchModels.mockRestore(); }
});


test('upstream voice accepts the pod OAuth credential and retains explicit API credential precedence', () => {
  const old = { ...process.env };
  try {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'pod-oauth';
    expect(upstreamVoiceConnection().key).toBe('pod-oauth');
    process.env.ANTHROPIC_API_KEY = 'explicit-key';
    expect(upstreamVoiceConnection().key).toBe('explicit-key');
    process.env.ANTHROPIC_AUTH_TOKEN = 'explicit-token';
    expect(upstreamVoiceConnection().key).toBe('explicit-token');
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(() => upstreamVoiceConnection()).toThrow('UPSTREAM_VOICE_CREDENTIALS_MISSING');
  } finally {
    process.env = old;
  }
});


test('Paxa catalog returns both synthesis and recorded transcription models with separate capabilities', async () => {
  const catalog = await import('../../../src/voice/providers/voice-catalog');
  const choices = jest.spyOn(catalog, 'voiceChoices').mockResolvedValue([{ id: 'voice', name: 'Voice' }]);
  const fetchModels = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({models:[{id:'paxa-tts-flash-v1'},{id:'paxa-stt-lite-v1-preview'}]})));
  const previous=process.env.PAXALABS_API_KEY; process.env.PAXALABS_API_KEY='fixture';
  const app=express(); app.use(voiceSettingsRouter(new Map([['a',{id:'a'} as AgentConfig]]),new Map(),[{id:'reader',key:'read',agents:['a']}]));
  try {
    const response=await request(app).get('/v1/agents/a/voice-settings/catalog?provider=paxalabs').set('Authorization','Bearer read');
    expect(response.status).toBe(200);
    expect(response.body.models).toEqual(expect.arrayContaining([
      expect.objectContaining({model_id:'paxa-tts-flash-v1',can_do_text_to_speech:true,can_do_speech_to_text:false}),
      expect.objectContaining({model_id:'paxa-stt-lite-v1-preview',can_do_text_to_speech:false,can_do_speech_to_text:true,realtime:false,voice_messages:true}),
    ]));
  } finally {choices.mockRestore();fetchModels.mockRestore();if(previous===undefined)delete process.env.PAXALABS_API_KEY;else process.env.PAXALABS_API_KEY=previous;}
});

test('voice preview requires write access and does not change stored settings', async () => {
  const registry = await import('../../../src/voice/providers/registry');
  const samples: string[] = [];
  const synth = jest.spyOn(registry, 'ttsProvider').mockReturnValue({ id: 'fixture', capabilities: { textStreaming: false, wordAlignment: false, outputFormats: [] }, synthesize: async function* (options) { for await (const text of options.text) samples.push(text); yield { bytes: Buffer.alloc(320), format: { encoding: 'pcm_s16le', channels: 1, sampleRate: 16000 }, chunkSeq: 0 }; } });
  const config = { id: 'a' } as AgentConfig;
  const app = express(); app.use(express.json()); app.use(voiceSettingsRouter(new Map([['a', config]]), new Map(), [{ id: 'r', key: 'r', agents: ['a'] }, { id: 'w', key: 'w', agents: ['a'], write: true }]));
  try {
    expect((await request(app).post('/v1/agents/a/voice-settings/preview').set('Authorization', 'Bearer r').send({ provider: 'gemini', model: 'gemini-2.5-flash-preview-tts', voiceId: 'Kore' })).status).toBe(403);
    const response = await request(app).post('/v1/agents/a/voice-settings/preview').set('Authorization', 'Bearer w').send({ provider: 'gemini', model: 'gemini-2.5-flash-preview-tts', voiceId: 'Kore' });
    expect(response.status).toBe(200);
    expect(Buffer.from(response.body.audio, 'base64').toString('ascii', 0, 4)).toBe('RIFF');
    expect(samples).toEqual(['Hello! This is a preview of my voice.']);
    const thai = await request(app).post('/v1/agents/a/voice-settings/preview').set('Authorization', 'Bearer w').send({ provider: 'gemini', model: 'gemini-2.5-flash-preview-tts', voiceId: 'Kore', language: 'th' });
    expect(thai.status).toBe(200);
    expect(samples[1]).toContain('สวัสดี');
    for (const language of ['xx', '__proto__']) {
      expect((await request(app).post('/v1/agents/a/voice-settings/preview').set('Authorization', 'Bearer w').send({ provider: 'gemini', model: 'test', voiceId: 'Kore', language })).status).toBe(400);
    }
    expect((await request(app).post('/v1/agents/a/voice-settings/preview').set('Authorization', 'Bearer w').send({ provider: 'upstream:paxalabs', model: 'test', voiceId: 'test', language: 'ja' })).status).toBe(400);
    expect((await request(app).post('/v1/agents/a/voice-settings/preview').set('Authorization', 'Bearer w').send({ provider: 'upstream', model: 'elevenlabs/eleven_flash_v2_5', voiceId: 'test', language: 'th' })).status).toBe(400);
    expect(samples).toHaveLength(2);
    synth.mockImplementationOnce(() => { throw new Error('TTS_CREDENTIALS_MISSING'); });
    const failed = await request(app).post('/v1/agents/a/voice-settings/preview').set('Authorization', 'Bearer w').send({ provider: 'gemini', model: 'test', voiceId: 'Kore' });
    expect(failed.status).toBe(503);
    expect(failed.body.error).toContain('No API key is configured');
    expect(config).toEqual({ id: 'a' });
  } finally { synth.mockRestore(); }
});

test('new agents have no inherited models and save only their own top-level voice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-new-agent-')), path = join(dir, 'config.json');
  const raw = { gateway: { orchestration: true }, agents: [{ id: 'a' }, { id: 'other', voice: { enabled: false } }] };
  writeFileSync(path, JSON.stringify(raw));
  const configs = new Map([['a', { id: 'a', orchestration: effectiveOrchestration({}, true) } as AgentConfig]]);
  const app = express(); app.use(express.json()); app.use(voiceSettingsRouter(configs, new Map(), [{ id: 'owner', key: 'key', agents: ['a'], write: true }], path));
  try {
    const initial = await request(app).get('/v1/agents/a/voice-settings').set('Authorization', 'Bearer key');
    expect(initial.body.voice).toMatchObject({ enabled: false, tts: { provider: '', model: '', voiceId: '' }, stt: { provider: '', model: '' } });
    expect((await request(app).patch('/v1/agents/a/voice-settings').set('Authorization', 'Bearer key').send({ enabled: true })).status).toBe(400);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(raw);
    const selected = { enabled: true, tts: { provider: 'elevenlabs', model: 'eleven_v3', voiceId: '' }, stt: { provider: 'elevenlabs', model: 'scribe_v2_realtime' }, notes: { enabled: false } };
    const saved = await request(app).patch('/v1/agents/a/voice-settings').set('Authorization', 'Bearer key').send(selected);
    expect(saved.status).toBe(200);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    expect(doc.gateway).toEqual(raw.gateway); expect(doc.agents[1]).toEqual(raw.agents[1]);
    expect(doc.agents[0].voice).toEqual(selected); expect(doc.agents[0]).not.toHaveProperty('orchestration');
    const off = await request(app).patch('/v1/agents/a/voice-settings').set('Authorization', 'Bearer key').send({ enabled: false });
    expect(off.status).toBe(200); expect(off.body.voice.tts).toEqual(selected.tts);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['paxalabs', 'gemini', 'deepgram'])('model failure for %s retains voices and a specific safe diagnostic', async provider => {
  const catalog = await import('../../../src/voice/providers/voice-catalog');
  const choices = jest.spyOn(catalog, 'voiceChoices').mockResolvedValue([{id:'voice',name:'Available voice'}]);
  const fetchModels = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({error:{message:'private provider detail'}}), {status:403}));
  const app=express(); app.use(voiceSettingsRouter(new Map([['a',{id:'a'} as AgentConfig]]),new Map(),[{id:'reader',key:'read',agents:['a']}]));
  try {
    const response=await request(app).get(`/v1/agents/a/voice-settings/catalog?provider=${provider}`).set('Authorization','Bearer read');
    expect(response.status).toBe(200);
    expect(response.body.voices).toEqual(provider === 'deepgram' ? [] : [{id:'voice',name:'Available voice'}]);
    expect(response.body.models).toEqual([]);
    expect(response.body.warnings.join(' ')).toMatch(/permission|API key/i);
    expect(JSON.stringify(response.body)).not.toContain('private provider detail');
  } finally { choices.mockRestore(); fetchModels.mockRestore(); }
});
