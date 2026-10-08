/**
 * Project-scoped API chat: a session bound to one folder under gateway.projects.root.
 * Real AgentRunner, real filesystem, real HTTP through GatewayRouter.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const KEYS: Record<string, ApiKey> = {
  admin: { key: 'sk-admin', agents: '*', admin: true },
  podWriter: { key: 'sk-pod-writer', agents: '*', write: true },
  podReader: { key: 'sk-pod-reader', agents: '*' },
  scopedWriter: { key: 'sk-scoped-writer', agents: ['alfred'], write: true },
  otherAgent: { key: 'sk-other', agents: ['warrior'], write: true },
};

interface Harness {
  base: string;
  root: string;
  app: ReturnType<GatewayRouter['getApp']>;
  runners: AgentRunner[];
  router: GatewayRouter;
}

function agentConfig(base: string, id: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  const workspace = path.join(base, 'agents', id, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), `# Persona of ${id}\n`);
  return {
    id,
    description: `agent ${id}`,
    workspace,
    env: '',
    claude: { model: 'claude-test', dangerouslySkipPermissions: true, extraFlags: [] },
    ...extra,
  };
}

async function harness(opts: { trusted?: string[]; orchestration?: boolean } = {}): Promise<Harness> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-')));
  const root = path.join(base, 'projects');
  fs.mkdirSync(path.join(root, 'site'), { recursive: true });
  const gateway: GatewayConfig = {
    gateway: {
      logDir: path.join(base, 'logs'),
      timezone: 'UTC',
      orchestration: opts.orchestration ?? false,
      api: { keys: Object.values(KEYS) },
      projects: { root, ...(opts.trusted ? { trusted: opts.trusted } : {}) },
    },
    agents: [],
  };
  const configs = [
    agentConfig(base, 'alfred'),
    agentConfig(base, 'warrior'),
    agentConfig(base, 'boxed', { type: 'app-agent', container: 'boxed-container' }),
  ];
  gateway.agents = configs;
  const runners = configs.map((c) => new AgentRunner(c, gateway));
  const router = new GatewayRouter(
    new Map(runners.map((r, i) => [configs[i]!.id, r])),
    new Map(configs.map((c) => [c.id, c])),
    undefined,
    gateway,
  );
  return { base, root, app: router.getApp(), runners, router };
}

async function teardown(h: Harness): Promise<void> {
  await Promise.all(h.runners.map((r) => r.stop().catch(() => {})));
  fs.rmSync(h.base, { recursive: true, force: true });
}

function create(h: Harness, agent: string, key: ApiKey, body: Record<string, unknown>) {
  return supertest(h.app)
    .post(`/api/v1/agents/${agent}/sessions`)
    .set('Authorization', `Bearer ${key.key}`)
    .query({ chat_id: 'web' })
    .send(body);
}

describe('POST /v1/agents/:id/sessions with project', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await teardown(h); });

  it('binds the session to the project and exposes it on create, list and info', async () => {
    const res = await create(h, 'alfred', KEYS.podWriter!, { project: 'site', name: 'Fix the footer' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sessionName: 'Fix the footer', project: 'site' });

    const list = await supertest(h.app).get('/api/v1/agents/alfred/sessions')
      .set('Authorization', `Bearer ${KEYS.admin!.key}`).query({ chat_id: 'web' });
    expect(list.body.sessions.find((s: { id: string }) => s.id === res.body.sessionId)).toMatchObject({ project: 'site' });

    const info = await supertest(h.app).get(`/api/v1/agents/alfred/sessions/${res.body.sessionId}/info`)
      .set('Authorization', `Bearer ${KEYS.admin!.key}`).query({ chat_id: 'web' });
    expect(info.body).toMatchObject({ sessionId: res.body.sessionId, project: 'site' });
  });

  it('leaves a session without a project unchanged', async () => {
    const res = await create(h, 'alfred', KEYS.podReader!, { name: 'plain' });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('project');
  });

  it.each([['..'], [''], ['a/b'], [42], ['.hidden']])('rejects project name %p with 400 invalid_name', async (project) => {
    const res = await create(h, 'alfred', KEYS.admin!, { project });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_name');
  });

  it('answers 404 project_not_found for a folder that does not exist', async () => {
    const res = await create(h, 'alfred', KEYS.admin!, { project: 'missing' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('project_not_found');
  });

  it('refuses a project that is a symlink out of the root', async () => {
    const outside = path.join(h.base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(h.root, 'escape'));
    const res = await create(h, 'alfred', KEYS.admin!, { project: 'escape' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'project_unavailable', reason: 'path_escape' });
  });

  it.each([
    ['a read-only pod key', 'podReader'],
    ['a write key scoped to this agent only', 'scopedWriter'],
  ])('forbids %s with 403 forbidden_key', async (_label, key) => {
    const res = await create(h, 'alfred', KEYS[key]!, { project: 'site' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_key');
  });

  it("forbids another agent's key before looking at the project", async () => {
    const res = await create(h, 'alfred', KEYS.otherAgent!, { project: 'site' });
    expect(res.status).toBe(403);
  });

  it('rejects a container agent with 409 project_unsupported_agent', async () => {
    const res = await create(h, 'boxed', KEYS.admin!, { project: 'site' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'project_unsupported_agent', reason: 'container' });
  });
});

describe('project chat on an orchestrated gateway', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness({ orchestration: true }); });
  afterEach(async () => { await teardown(h); });

  it('rejects the project with 409 project_unsupported_agent until the orchestrated path honours it', async () => {
    const res = await create(h, 'alfred', KEYS.admin!, { project: 'site' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'project_unsupported_agent', reason: 'orchestrated' });
  });
});
