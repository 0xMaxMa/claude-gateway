/**
 * Unit tests for avatar endpoints and wizard create API.
 */

import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { AgentConfig, ApiKey } from '../../src/types';
import { wizardStore } from '../../src/api/wizard-state';

// ── Mock child_process.spawn ──────────────────────────────────────────────────

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: jest.fn() };
});

import { spawn } from 'child_process';
const mockSpawn = spawn as jest.Mock;

function mockClaudeSuccess(output: string): void {
  mockSpawn.mockImplementationOnce(() => {
    const stdin = Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: jest.fn() });
    process.nextTick(() => {
      stdout.emit('data', Buffer.from(output));
      child.emit('close', 0);
    });
    return child;
  });
}

function mockClaudeFailure(): void {
  mockSpawn.mockImplementationOnce(() => {
    const stdin = Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: jest.fn() });
    process.nextTick(() => {
      stderr.emit('data', Buffer.from('error'));
      child.emit('close', 1);
    });
    return child;
  });
}

// ── Mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

// ── Magic byte helpers ────────────────────────────────────────────────────────

function makePngBuffer(size = 100): Buffer {
  const buf = Buffer.alloc(Math.max(size, 16));
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47; // PNG
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  return buf;
}

function makeJpegBuffer(size = 100): Buffer {
  const buf = Buffer.alloc(Math.max(size, 16));
  buf[0] = 0xFF; buf[1] = 0xD8; buf[2] = 0xFF;
  return buf;
}

function makeTextBuffer(): Buffer {
  return Buffer.from('this is not an image');
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const AGENT_ID = 'alfred';
const ADMIN_KEY = 'sk-admin';
const WRITE_KEY = 'sk-write';
const READ_KEY = 'sk-read';

const apiKeys: ApiKey[] = [
  { key: ADMIN_KEY, agents: '*', admin: true },
  { key: WRITE_KEY, agents: [AGENT_ID], write: true },
  { key: READ_KEY, agents: [AGENT_ID] },
];

// ── App builder ───────────────────────────────────────────────────────────────

interface TestCtx {
  tmpDir: string;
  configPath: string;
  agentDir: string;
  agentConfigs: Map<string, AgentConfig>;
  app: express.Express;
}

function buildCtx(agentOverrides: Partial<AgentConfig> = {}): TestCtx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-avatar-test-'));
  const configPath = path.join(tmpDir, 'config.json');
  const agentDirPath = path.join(tmpDir, 'agents', AGENT_ID);
  const workspaceDirPath = path.join(agentDirPath, 'workspace');
  fs.mkdirSync(workspaceDirPath, { recursive: true });

  const agentCfg: AgentConfig = {
    id: AGENT_ID,
    description: 'Test agent',
    workspace: workspaceDirPath,
    env: path.join(workspaceDirPath, '.env'),
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
    ...agentOverrides,
  };

  const initialConfig = {
    gateway: { logDir: '/tmp', timezone: 'UTC', api: { keys: apiKeys } },
    agents: [{ ...agentCfg }],
  };
  fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));

  const agentConfigs = new Map<string, AgentConfig>([[AGENT_ID, agentCfg]]);
  const runners = new Map();

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, agentConfigs, apiKeys, configPath));

  return { tmpDir, configPath, agentDir: agentDirPath, agentConfigs, app };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterEach(() => {
  // Clean up any wizard states between tests
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/agents — avatarUrl field
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/agents — avatarUrl', () => {
  it('returns null avatarUrl when no avatar set', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .get('/api/v1/agents')
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(res.status).toBe(200);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent).toBeDefined();
      expect(agent.avatarUrl).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns avatarUrl when avatar is set in config', async () => {
    const { app, tmpDir } = buildCtx({ avatar: 'avatar.png' });
    try {
      const res = await supertest.default(app)
        .get('/api/v1/agents')
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(res.status).toBe(200);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.avatarUrl).toBe(`/api/v1/agents/${AGENT_ID}/avatar`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/agents/:agentId/avatar
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/v1/agents/:agentId/avatar', () => {
  it('returns 401 without auth', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .put(`/api/v1/agents/${AGENT_ID}/avatar`)
        .send(makePngBuffer());
      expect(res.status).toBe(401);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 403 for read-only key', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .put(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`)
        .set('Content-Type', 'image/png')
        .send(makePngBuffer());
      expect(res.status).toBe(403);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 415 for non-image data', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .put(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${WRITE_KEY}`)
        .set('Content-Type', 'image/png')
        .send(makeTextBuffer());
      expect(res.status).toBe(415);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 400 for empty body', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .put(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${WRITE_KEY}`)
        .set('Content-Type', 'image/png')
        .send(Buffer.alloc(0));
      expect(res.status).toBe(400);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 413 for file exceeding 5MB', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const big = Buffer.alloc(5 * 1024 * 1024 + 1);
      big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47; // PNG magic
      const res = await supertest.default(app)
        .put(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${WRITE_KEY}`)
        .set('Content-Type', 'image/png')
        .send(big);
      expect(res.status).toBe(413);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('saves PNG avatar and updates config', async () => {
    const { app, tmpDir, configPath, agentDir } = buildCtx();
    try {
      const buf = makePngBuffer();
      const res = await supertest.default(app)
        .put(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${WRITE_KEY}`)
        .set('Content-Type', 'image/png')
        .send(buf);
      expect(res.status).toBe(200);
      expect(res.body.avatarUrl).toBe(`/api/v1/agents/${AGENT_ID}/avatar`);

      // File written to disk
      expect(fs.existsSync(path.join(agentDir, 'avatar.png'))).toBe(true);

      // Config updated
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { agents: { id: string; avatar?: string }[] };
      const agent = cfg.agents.find((a) => a.id === AGENT_ID);
      expect(agent?.avatar).toBe('avatar.png');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('removes old avatar file when extension changes', async () => {
    const { app, tmpDir, agentDir } = buildCtx({ avatar: 'avatar.jpg' });
    try {
      // Create old avatar file
      const oldPath = path.join(agentDir, 'avatar.jpg');
      fs.writeFileSync(oldPath, makeJpegBuffer());

      const res = await supertest.default(app)
        .put(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${WRITE_KEY}`)
        .set('Content-Type', 'image/png')
        .send(makePngBuffer());
      expect(res.status).toBe(200);

      // Give unlink a tick to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(path.join(agentDir, 'avatar.png'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/agents/:agentId/avatar
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/agents/:agentId/avatar', () => {
  it('returns 403 for read-only key', async () => {
    const { app, tmpDir } = buildCtx({ avatar: 'avatar.png' });
    try {
      const res = await supertest.default(app)
        .delete(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(res.status).toBe(403);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 204 and removes avatar from config', async () => {
    const { app, tmpDir, configPath, agentDir } = buildCtx({ avatar: 'avatar.png' });
    try {
      fs.writeFileSync(path.join(agentDir, 'avatar.png'), makePngBuffer());

      const res = await supertest.default(app)
        .delete(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${WRITE_KEY}`);
      expect(res.status).toBe(204);

      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { agents: { id: string; avatar?: string }[] };
      const agent = cfg.agents.find((a) => a.id === AGENT_ID);
      expect(agent?.avatar).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/agents/:agentId/avatar
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/agents/:agentId/avatar', () => {
  it('returns 404 when no avatar set', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 403 for unknown/invalid key', async () => {
    const { app, tmpDir } = buildCtx({ avatar: 'avatar.png' });
    try {
      const res = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', 'Bearer sk-no-access');
      expect(res.status).toBe(403);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns image with correct headers', async () => {
    const { app, tmpDir, agentDir } = buildCtx({ avatar: 'avatar.png' });
    try {
      const buf = makePngBuffer(200);
      fs.writeFileSync(path.join(agentDir, 'avatar.png'), buf);

      const res = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/png/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['etag']).toMatch(/^W\//);
      expect(res.headers['last-modified']).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 304 when ETag matches (If-None-Match)', async () => {
    const { app, tmpDir, agentDir } = buildCtx({ avatar: 'avatar.png' });
    try {
      const buf = makePngBuffer(200);
      fs.writeFileSync(path.join(agentDir, 'avatar.png'), buf);

      // First request — get the ETag
      const first = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(first.status).toBe(200);
      const etag = first.headers['etag'];
      expect(etag).toBeDefined();

      // Second request with matching If-None-Match — must return 304
      const second = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`)
        .set('If-None-Match', etag);
      expect(second.status).toBe(304);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 200 with new content when ETag does not match (file changed)', async () => {
    const { app, tmpDir, agentDir } = buildCtx({ avatar: 'avatar.png' });
    try {
      fs.writeFileSync(path.join(agentDir, 'avatar.png'), makePngBuffer(200));

      const res = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`)
        .set('If-None-Match', 'W/"stale-etag"');
      expect(res.status).toBe(200);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 304 when ETag appears in comma-separated If-None-Match list', async () => {
    const { app, tmpDir, agentDir } = buildCtx({ avatar: 'avatar.png' });
    try {
      fs.writeFileSync(path.join(agentDir, 'avatar.png'), makePngBuffer(200));

      const first = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(first.status).toBe(200);
      const etag = first.headers['etag'];

      // Browser may send multiple ETags — current ETag is one of them
      const second = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`)
        .set('If-None-Match', `W/"other-etag", ${etag}`);
      expect(second.status).toBe(304);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 404 when avatar file is missing from disk', async () => {
    const { app, tmpDir } = buildCtx({ avatar: 'avatar.png' });
    try {
      const res = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: stale agentConfigs after extension change (PUT jpeg → PUT png → GET)
// ─────────────────────────────────────────────────────────────────────────────

describe('avatar extension change regression', () => {
  it('GET returns 200 immediately after PUT with different extension (no stale 404)', async () => {
    const { app, tmpDir, agentDir, agentConfigs } = buildCtx({ avatar: 'avatar.jpeg' });
    try {
      // Seed the old jpeg file on disk (as if uploaded previously)
      fs.writeFileSync(path.join(agentDir, 'avatar.jpeg'), makeJpegBuffer(200));

      // PUT a PNG — this should delete avatar.jpeg, write avatar.png, and update agentConfigs in-memory
      const putRes = await supertest.default(app)
        .put(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${WRITE_KEY}`)
        .set('Content-Type', 'image/png')
        .send(makePngBuffer(200));
      expect(putRes.status).toBe(200);

      // In-memory map must reflect the new filename immediately (before any file watcher fires)
      expect(agentConfigs.get(AGENT_ID)?.avatar).toBe('avatar.png');

      // GET immediately after — must NOT return 404 "Avatar file not found"
      const getRes = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(getRes.status).toBe(200);
      expect(getRes.headers['content-type']).toMatch(/image\/png/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('GET returns 404 after DELETE — agentConfigs.avatar removed immediately', async () => {
    const { app, tmpDir, agentDir, agentConfigs } = buildCtx({ avatar: 'avatar.png' });
    try {
      fs.writeFileSync(path.join(agentDir, 'avatar.png'), makePngBuffer(200));

      const delRes = await supertest.default(app)
        .delete(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${WRITE_KEY}`);
      expect(delRes.status).toBe(204);

      // In-memory map must have avatar removed immediately
      expect(agentConfigs.get(AGENT_ID)?.avatar).toBeUndefined();

      // GET must return 404 (no avatar set), not 500 or stale file reference
      const getRes = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/avatar`)
        .set('Authorization', `Bearer ${READ_KEY}`);
      expect(getRes.status).toBe(404);
      expect(getRes.body.error).toMatch(/no avatar/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wizard State (unit tests for WizardStore)
// ─────────────────────────────────────────────────────────────────────────────

describe('WizardStore', () => {
  it('creates and retrieves a wizard state', () => {
    const store = new (require('../../src/api/wizard-state').WizardStore)();
    const state = store.create('bot1', 'A test bot', { 'AGENTS.md': 'content' });
    expect(state.wizardId).toBeDefined();
    expect(state.agentId).toBe('bot1');
    expect(state.step).toBe('pending');

    const retrieved = store.get(state.wizardId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.agentId).toBe('bot1');
  });

  it('returns undefined for expired wizard', () => {
    const store = new (require('../../src/api/wizard-state').WizardStore)();
    const state = store.create('bot2', 'p', {});
    // Force expire
    store.update(state.wizardId, { expiresAt: Date.now() - 1000 });
    expect(store.get(state.wizardId)).toBeUndefined();
  });

  it('findByAgentId finds an active wizard', () => {
    const store = new (require('../../src/api/wizard-state').WizardStore)();
    store.create('bot3', 'p', {});
    expect(store.findByAgentId('bot3')).toBeDefined();
    expect(store.findByAgentId('nonexistent')).toBeUndefined();
  });

  it('delete removes the wizard', () => {
    const store = new (require('../../src/api/wizard-state').WizardStore)();
    const state = store.create('bot4', 'p', {});
    store.delete(state.wizardId);
    expect(store.get(state.wizardId)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/agents/wizard/start
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/agents/wizard/start', () => {
  it('returns 403 without admin key', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/start')
        .set('Authorization', `Bearer ${READ_KEY}`)
        .send({ id: 'newbot', prompt: 'A bot' });
      expect(res.status).toBe(403);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 400 for invalid agent id', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/start')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ id: 'INVALID ID', prompt: 'A bot' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pattern/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 400 when prompt is missing', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/start')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ id: 'newbot' });
      expect(res.status).toBe(400);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 409 when agent already exists', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/start')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ id: AGENT_ID, prompt: 'A bot' }); // AGENT_ID = 'alfred' already in configs
      expect(res.status).toBe(409);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 201 with wizardId and files on success', async () => {
    const { app, tmpDir } = buildCtx();
    mockClaudeSuccess('=== AGENTS.md ===\n# Agent: Newbot\n\nA new agent\n');
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/start')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ id: 'newbot', prompt: 'A helpful new bot' });
      expect(res.status).toBe(201);
      expect(res.body.wizardId).toBeDefined();
      expect(res.body.agentId).toBe('newbot');
      expect(res.body.files).toBeDefined();
      expect(typeof res.body.expiresAt).toBe('string');

      // Cleanup wizard state
      wizardStore.delete(res.body.wizardId);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 409 when wizard already in progress for same agentId', async () => {
    const { app, tmpDir } = buildCtx();
    mockClaudeSuccess('=== AGENTS.md ===\n# Agent: Dupbot\n\ncontent\n');
    try {
      const res1 = await supertest.default(app)
        .post('/api/v1/agents/wizard/start')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ id: 'dupbot', prompt: 'A bot' });
      expect(res1.status).toBe(201);

      const res2 = await supertest.default(app)
        .post('/api/v1/agents/wizard/start')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ id: 'dupbot', prompt: 'A bot again' });
      expect(res2.status).toBe(409);

      wizardStore.delete(res1.body.wizardId);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 500 when Claude fails', async () => {
    const { app, tmpDir } = buildCtx();
    mockClaudeFailure();
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/start')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ id: 'failbot', prompt: 'A bot' });
      expect(res.status).toBe(500);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // The concurrency cap (429 when wizardStartsInFlight >= WIZARD_MAX_CONCURRENT) is a
  // 3-line counter guard. Orchestrating genuinely concurrent hanging spawns in Jest's
  // single-threaded event loop is brittle, so this case is covered by manual smoke test.
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/agents/wizard/:wizardId/avatar
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/v1/agents/wizard/:wizardId/avatar', () => {
  it('returns 404 for unknown wizardId', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .put('/api/v1/agents/wizard/nonexistent/avatar')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send(makePngBuffer());
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 415 for non-image data', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('wizavbot', 'p', { 'AGENTS.md': '#' });
    try {
      const res = await supertest.default(app)
        .put(`/api/v1/agents/wizard/${state.wizardId}/avatar`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send(makeTextBuffer());
      expect(res.status).toBe(415);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 200 with preview:true and stores avatar in wizard state', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('wizavbot2', 'p', { 'AGENTS.md': '#' });
    try {
      const res = await supertest.default(app)
        .put(`/api/v1/agents/wizard/${state.wizardId}/avatar`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send(makePngBuffer());
      expect(res.status).toBe(200);
      expect(res.body.preview).toBe(true);

      const updated = wizardStore.get(state.wizardId);
      expect(updated?.avatarMime).toBe('image/png');
      expect(updated?.avatarData).toBeDefined();
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/agents/wizard/:wizardId/confirm
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/agents/wizard/:wizardId/confirm', () => {
  it('returns 404 for unknown wizardId', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/unknown-uuid/confirm')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ files: { 'AGENTS.md': '# content' } });
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 400 when AGENTS.md is missing from files', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('confirmbot', 'prompt', {});
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/confirm`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ files: { 'SOUL.md': 'soul content' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/AGENTS\.md/);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates workspace, writes files, and adds agent to config', async () => {
    const { app, tmpDir, configPath } = buildCtx();
    const state = wizardStore.create('confirmbot2', 'A helpful bot', {
      'AGENTS.md': '# Agent: confirmbot2\n\nA helpful bot\n',
      'SOUL.md': '# Soul\n\n',
      'MEMORY.md': '',
    });
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/confirm`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({
          files: {
            'AGENTS.md': '# Agent: confirmbot2\n\nA helpful bot\n',
            'SOUL.md': '# Soul\n\n',
          },
        });
      expect(res.status).toBe(200);
      expect(res.body.agentId).toBe('confirmbot2');
      expect(res.body.avatarUrl).toBeNull();

      // Workspace directory and AGENTS.md written
      const workspaceDir = path.join(tmpDir, 'agents', 'confirmbot2', 'workspace');
      expect(fs.existsSync(workspaceDir)).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, 'AGENTS.md'))).toBe(true);

      // Config updated
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { agents: { id: string }[] };
      expect(cfg.agents.find((a) => a.id === 'confirmbot2')).toBeDefined();

      // Wizard step updated
      const updated = wizardStore.get(state.wizardId);
      expect(updated?.step).toBe('confirmed');
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes avatar to disk when avatar data is in wizard state', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('avbot', 'A bot with avatar', {
      'AGENTS.md': '# Agent: avbot\n\n',
    });
    wizardStore.update(state.wizardId, { avatarData: makePngBuffer(200), avatarMime: 'image/png' });
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/confirm`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ files: { 'AGENTS.md': '# Agent: avbot\n\n' } });
      expect(res.status).toBe(200);
      expect(res.body.avatarUrl).toBe('/api/v1/agents/avbot/avatar');

      const avatarPath = path.join(tmpDir, 'agents', 'avbot', 'avatar.png');
      expect(fs.existsSync(avatarPath)).toBe(true);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 409 if wizard step is not pending', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('stepbot', 'p', { 'AGENTS.md': '#' });
    wizardStore.update(state.wizardId, { step: 'confirmed' });
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/confirm`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ files: { 'AGENTS.md': '# content' } });
      expect(res.status).toBe(409);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/agents/wizard/:wizardId/channel
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/agents/wizard/:wizardId/channel', () => {
  it('returns 404 for unknown wizardId', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/unknown/channel')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ channel: 'telegram', botToken: '123:abc' });
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 409 when step is not confirmed', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('chanbot', 'p', { 'AGENTS.md': '#' });
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/channel`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ channel: 'telegram', botToken: '123:abc' });
      expect(res.status).toBe(409);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 400 for invalid channel', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('chanbot2', 'p', { 'AGENTS.md': '#' });
    wizardStore.update(state.wizardId, { step: 'confirmed' });
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/channel`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ channel: 'slack', botToken: '123:abc' });
      expect(res.status).toBe(400);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 400 when Telegram token is invalid', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('chanbot3', 'p', { 'AGENTS.md': '#' });
    wizardStore.update(state.wizardId, { step: 'confirmed' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false }),
    } as Response);

    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/channel`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ channel: 'telegram', botToken: '123:badtoken' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid telegram/i);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 200 with pairingCode when token is valid', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('chanbot4', 'p', { 'AGENTS.md': '#' });
    wizardStore.update(state.wizardId, { step: 'confirmed' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { username: 'my_test_bot' } }),
    } as Response);

    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/channel`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ channel: 'telegram', botToken: '123456:validtoken' });
      expect(res.status).toBe(200);
      expect(res.body.channel).toBe('telegram');
      expect(res.body.botName).toBe('@my_test_bot');
      expect(typeof res.body.pairingCode).toBe('string');
      expect(res.body.pairingCode).toHaveLength(6);
      expect(res.body.instruction).toBeDefined();

      const updated = wizardStore.get(state.wizardId);
      expect(updated?.step).toBe('pairing');
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/agents/wizard/:wizardId/channel/verify
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/agents/wizard/:wizardId/channel/verify', () => {
  it('returns 404 for unknown wizardId', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/unknown/channel/verify')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 409 when step is not pairing', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('verbot', 'p', { 'AGENTS.md': '#' });
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/channel/verify`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(409);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 501 for Discord channel', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('discordbot', 'p', { 'AGENTS.md': '#' });
    wizardStore.update(state.wizardId, {
      step: 'pairing',
      channel: 'discord',
      botToken: 'sometoken',
      pairingCode: 'ABC123',
    });
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/channel/verify`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(501);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns { success: false, pending: true } when code not received yet', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('pendbot', 'p', { 'AGENTS.md': '#' });
    wizardStore.update(state.wizardId, {
      step: 'pairing',
      channel: 'telegram',
      botToken: '123:tok',
      pairingCode: 'XYZ999',
      updateOffset: 0,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: [] }),
    } as Response);

    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/channel/verify`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.pending).toBe(true);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('advances updateOffset on non-matching messages to avoid reprocessing', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('offsetbot', 'p', { 'AGENTS.md': '#' });
    wizardStore.update(state.wizardId, {
      step: 'pairing',
      channel: 'telegram',
      botToken: '123:tok',
      pairingCode: 'ZZZZZZ',
      updateOffset: 5,
    });

    // Return a non-matching message with update_id=10
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: [{ update_id: 10, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: 'wrong' } }],
      }),
    } as Response);

    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/channel/verify`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);

      // Offset should have advanced to 11 (update_id + 1)
      const updated = wizardStore.get(state.wizardId);
      expect(updated?.updateOffset).toBe(11);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns { success: true } when pairing code is found', async () => {
    const { app, tmpDir, configPath } = buildCtx();
    const state = wizardStore.create('pairbot', 'A pairing bot', { 'AGENTS.md': '#' });
    // Pre-confirm the wizard (write workspace + config)
    const workspaceDir = path.join(tmpDir, 'agents', 'pairbot', 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Agent: pairbot\n');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { agents: unknown[] };
    cfg.agents.push({
      id: 'pairbot', description: 'A pairing bot',
      workspace: workspaceDir, env: path.join(workspaceDir, '.env'),
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
    });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    wizardStore.update(state.wizardId, {
      step: 'pairing',
      channel: 'telegram',
      botToken: '456:tok',
      pairingCode: 'ABCDEF',
      updateOffset: 0,
    });

    // getUpdates returns a matching message
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: [{
            update_id: 100,
            message: { from: { id: 777 }, chat: { id: 777, type: 'private' }, text: 'abcdef' },
          }],
        }),
      } as Response)
      // sendMessage (welcome)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);

    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/channel/verify`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.agentId).toBe('pairbot');

      // Config updated with telegram entry
      const updatedCfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { agents: { id: string; telegram?: unknown }[] };
      const agent = updatedCfg.agents.find((a) => a.id === 'pairbot');
      expect(agent?.telegram).toBeDefined();

      // access.json written
      const accessPath = path.join(workspaceDir, '.telegram-state', 'access.json');
      expect(fs.existsSync(accessPath)).toBe(true);
      const access = JSON.parse(fs.readFileSync(accessPath, 'utf-8'));
      expect(access.allowFrom).toContain('777');
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/agents/wizard/:wizardId/complete
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/agents/wizard/:wizardId/complete', () => {
  it('returns 404 for unknown wizardId', async () => {
    const { app, tmpDir } = buildCtx();
    try {
      const res = await supertest.default(app)
        .post('/api/v1/agents/wizard/unknown/complete')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 409 when wizard is not yet confirmed', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('complbot', 'p', { 'AGENTS.md': '#' });
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/complete`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(409);
    } finally {
      wizardStore.delete(state.wizardId);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 200 and deletes wizard state', async () => {
    const { app, tmpDir } = buildCtx();
    const state = wizardStore.create('complbot2', 'p', { 'AGENTS.md': '#' });
    wizardStore.update(state.wizardId, { step: 'confirmed' });
    try {
      const res = await supertest.default(app)
        .post(`/api/v1/agents/wizard/${state.wizardId}/complete`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.agentId).toBe('complbot2');
      expect(wizardStore.get(state.wizardId)).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
