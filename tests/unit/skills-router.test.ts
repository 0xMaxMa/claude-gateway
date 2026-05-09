import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as supertest from 'supertest';
import { createSkillsRouter } from '../../src/api/skills-router';
import { AgentConfig, ApiKey } from '../../src/types';

const SHARED_SKILLS_DIR = path.join(os.homedir(), '.claude-gateway', 'shared-skills');

const AGENT_ID = 'test-agent';

function makeTmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-router-test-'));
}

function buildApp(workspace: string, keys: ApiKey[]) {
  const config: AgentConfig = {
    id: AGENT_ID,
    description: 'Test agent',
    workspace,
    env: '',
    telegram: { botToken: 'tok' },
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
  const configs = new Map([[AGENT_ID, config]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createSkillsRouter(configs, keys));
  return app;
}

const READ_KEY: ApiKey = { key: 'sk-read', agents: [AGENT_ID] };
const WRITE_KEY: ApiKey = { key: 'sk-write', agents: [AGENT_ID], write: true };
const ADMIN_KEY: ApiKey = { key: 'sk-admin', agents: '*', admin: true };
const OTHER_WRITE_KEY: ApiKey = { key: 'sk-other-write', agents: ['other-agent'], write: true };

const ALL_KEYS = [READ_KEY, WRITE_KEY, ADMIN_KEY, OTHER_WRITE_KEY];

function authHeader(key: ApiKey) {
  return { Authorization: `Bearer ${key.key}` };
}

describe('POST /api/v1/agents/:agentId/skills — access control', () => {
  let workspace: string;
  beforeEach(() => { workspace = makeTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  const body = { name: 'my-skill', description: 'test', content: 'hello', scope: 'workspace' };
  const url = `/api/v1/agents/${AGENT_ID}/skills`;

  it('returns 403 for read-only key', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).post(url).set(authHeader(READ_KEY)).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/write permission required/i);
  });

  it('returns 403 for write key scoped to different agent', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).post(url).set(authHeader(OTHER_WRITE_KEY)).send(body);
    expect(res.status).toBe(403);
  });

  it('allows write key with correct scope (workspace)', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).post(url).set(authHeader(WRITE_KEY)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('my-skill');
    expect(res.body.scope).toBe('workspace');
  });

  it('allows admin key (workspace scope)', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).post(url).set(authHeader(ADMIN_KEY)).send(body);
    expect(res.status).toBe(201);
  });

  it('returns 403 when write key tries shared scope', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).post(url).set(authHeader(WRITE_KEY)).send({ ...body, scope: 'shared' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key required for shared scope/i);
  });

  it('allows admin key to create shared scope skill', async () => {
    const sharedSkillDir = path.join(SHARED_SKILLS_DIR, 'my-skill');
    try { fs.rmSync(sharedSkillDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).post(url).set(authHeader(ADMIN_KEY)).send({ ...body, scope: 'shared' });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe('shared');
    try { fs.rmSync(sharedSkillDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

describe('DELETE /api/v1/agents/:agentId/skills/:name — access control', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = makeTmpWorkspace();
    const skillDir = path.join(workspace, 'skills', 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: test\n---\nhello');
  });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  const url = `/api/v1/agents/${AGENT_ID}/skills/my-skill`;

  it('returns 403 for read-only key', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).delete(url).set(authHeader(READ_KEY));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/write permission required/i);
  });

  it('returns 403 for write key scoped to different agent', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).delete(url).set(authHeader(OTHER_WRITE_KEY));
    expect(res.status).toBe(403);
  });

  it('allows write key to delete workspace skill', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).delete(url).set(authHeader(WRITE_KEY));
    expect(res.status).toBe(200);
  });

  it('returns 403 when write key tries to delete shared scope skill', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).delete(`${url}?scope=shared`).set(authHeader(WRITE_KEY));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key required for shared scope/i);
  });
});

describe('POST /api/v1/agents/:agentId/skills/install — access control', () => {
  let workspace: string;
  beforeEach(() => { workspace = makeTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  const url = `/api/v1/agents/${AGENT_ID}/skills/install`;

  it('returns 403 for read-only key', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).post(url).set(authHeader(READ_KEY))
      .send({ url: 'https://github.com/example/repo/blob/main/SKILL.md' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key required/i);
  });

  it('returns 403 for write key without admin flag', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).post(url).set(authHeader(WRITE_KEY))
      .send({ url: 'https://github.com/example/repo/blob/main/SKILL.md' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key required/i);
  });

  it('admin key passes auth and hits URL validation (not 403)', async () => {
    const app = buildApp(workspace, ALL_KEYS);
    const res = await supertest.default(app).post(url).set(authHeader(ADMIN_KEY))
      .send({ url: 'http://example.com/skill' }); // http:// fails URL check, not auth
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400); // HTTPS required
  });
});

describe('POST /api/v1/agents/:agentId/skills/install — SSRF protection', () => {
  let workspace: string;
  beforeEach(() => { workspace = makeTmpWorkspace(); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  const url = `/api/v1/agents/${AGENT_ID}/skills/install`;

  const privateUrls = [
    'https://localhost/SKILL.md',
    'https://127.0.0.1/SKILL.md',
    'https://10.0.0.1/SKILL.md',
    'https://172.16.0.1/SKILL.md',
    'https://192.168.1.1/SKILL.md',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/SKILL.md',
    'https://[fe80::1]/SKILL.md',
  ];

  for (const privateUrl of privateUrls) {
    it(`blocks private URL: ${privateUrl}`, async () => {
      const app = buildApp(workspace, ALL_KEYS);
      const res = await supertest.default(app).post(url).set(authHeader(ADMIN_KEY))
        .send({ url: privateUrl });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/private\/internal/i);
    });
  }
});
