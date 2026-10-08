/**
 * Project-scoped API chat: a session bound to one folder under gateway.projects.root.
 * Real AgentRunner, real filesystem, real HTTP through GatewayRouter.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';
import { waitForCondition } from '../helpers/wait-for';

const MOCK_CLAUDE = path.resolve(__dirname, '../helpers/mock-claude-argv.js');

const KEYS: Record<string, ApiKey> = {
  admin: { key: 'sk-admin', agents: '*', admin: true },
  podWriter: { key: 'sk-pod-writer', agents: '*', write: true },
  podReader: { key: 'sk-pod-reader', agents: '*' },
  scopedWriter: { key: 'sk-scoped-writer', agents: ['alfred'], write: true },
  otherAgent: { key: 'sk-other', agents: ['warrior'], write: true },
};

interface Harness {
  base: string;
  argvLog: string;
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
  const argvLog = path.join(base, 'argv.jsonl');
  process.env.MOCK_CLAUDE_ARGV_LOG = argvLog;
  return { base, argvLog, root, app: router.getApp(), runners, router };
}

interface Spawn { pid: number; cwd: string; argv: string[] }

function spawns(h: Harness): Spawn[] {
  if (!fs.existsSync(h.argvLog)) return [];
  return fs.readFileSync(h.argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Spawn);
}

function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

function send(h: Harness, sessionId: string, message: string) {
  return supertest(h.app)
    .post('/api/v1/agents/alfred/messages')
    .set('Authorization', `Bearer ${KEYS.admin!.key}`)
    .send({ message, chat_id: 'web', session_id: sessionId });
}

async function projectSession(h: Harness): Promise<string> {
  const res = await create(h, 'alfred', KEYS.admin!, { project: 'site' });
  expect(res.status).toBe(201);
  return res.body.sessionId as string;
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

describe('a project-bound legacy chat turn', () => {
  let h: Harness;
  beforeAll(() => { process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE}`; });
  afterAll(() => { delete process.env.CLAUDE_BIN; delete process.env.MOCK_CLAUDE_ARGV_LOG; });
  afterEach(async () => { await teardown(h); });

  it('runs in the project dir with the persona file and user-only settings when untrusted', async () => {
    h = await harness();
    const sessionId = await projectSession(h);
    const res = await send(h, sessionId, 'where am I');
    expect(res.status).toBe(200);
    const [spawn] = spawns(h);
    expect(spawn!.cwd).toBe(path.join(h.root, 'site'));
    expect(flagValue(spawn!.argv, '--setting-sources')).toBe('user');
    expect(flagValue(spawn!.argv, '--append-system-prompt-file')).toBe(path.join(h.base, 'agents', 'alfred', 'workspace', 'CLAUDE.md'));
  });

  it('tells the agent which project and git state it is in, without remote credentials', async () => {
    h = await harness();
    const dir = path.join(h.root, 'site');
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('remote', 'add', 'origin', 'https://bob:s3cret-token@github.com/acme/site.git');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'y');
    const sessionId = await projectSession(h);
    expect((await send(h, sessionId, 'hi')).status).toBe(200);

    const block = flagValue(spawns(h)[0]!.argv, '--append-system-prompt');
    expect(block).toBe(`You are working in project site at ${dir}. Git: branch main, 2 changes, remote github.com.`);
    const argv = spawns(h)[0]!.argv.join(' ');
    expect(argv).not.toContain('s3cret');
    expect(argv).not.toContain('acme/site');
  });

  it('names the project without git details when the folder is not a repository', async () => {
    h = await harness();
    const sessionId = await projectSession(h);
    expect((await send(h, sessionId, 'hi')).status).toBe(200);
    expect(flagValue(spawns(h)[0]!.argv, '--append-system-prompt')).toBe(`You are working in project site at ${path.join(h.root, 'site')}.`);
  });

  it('loads project settings when the operator trusts the project', async () => {
    h = await harness({ trusted: ['site'] });
    const sessionId = await projectSession(h);
    expect((await send(h, sessionId, 'hi')).status).toBe(200);
    const [spawn] = spawns(h);
    expect(spawn!.cwd).toBe(path.join(h.root, 'site'));
    expect(spawn!.argv).not.toContain('--setting-sources');
    expect(spawn!.argv).toContain('--append-system-prompt-file');
  });

  it('leaves a session without a project in the agent workspace with unchanged flags', async () => {
    h = await harness();
    const res = await create(h, 'alfred', KEYS.admin!, {});
    expect((await send(h, res.body.sessionId, 'hi')).status).toBe(200);
    const [spawn] = spawns(h);
    expect(spawn!.cwd).toBe(path.join(h.base, 'agents', 'alfred', 'workspace'));
    expect(spawn!.argv).not.toContain('--setting-sources');
    expect(spawn!.argv).not.toContain('--append-system-prompt-file');
  });

  it('fails the next turn with PROJECT_UNAVAILABLE after a rename and never falls back to the workspace', async () => {
    h = await harness();
    const sessionId = await projectSession(h);
    expect((await send(h, sessionId, 'first')).status).toBe(200);
    fs.renameSync(path.join(h.root, 'site'), path.join(h.root, 'site-renamed'));

    const res = await send(h, sessionId, 'second');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROJECT_UNAVAILABLE');
    expect(spawns(h).map((s) => s.cwd)).toEqual([path.join(h.root, 'site')]);

    fs.renameSync(path.join(h.root, 'site-renamed'), path.join(h.root, 'site'));
    expect((await send(h, sessionId, 'third')).status).toBe(200);
    expect(spawns(h).map((s) => s.cwd)).toEqual([path.join(h.root, 'site'), path.join(h.root, 'site')]);
  });

  it('refuses a project swapped for a symlink out of the root between turns', async () => {
    h = await harness();
    const sessionId = await projectSession(h);
    expect((await send(h, sessionId, 'first')).status).toBe(200);
    const outside = path.join(h.base, 'outside');
    fs.mkdirSync(outside);
    fs.renameSync(path.join(h.root, 'site'), path.join(h.base, 'moved-away'));
    fs.symlinkSync(outside, path.join(h.root, 'site'));

    const res = await send(h, sessionId, 'second');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROJECT_UNAVAILABLE');
    expect(spawns(h).some((s) => s.cwd === outside)).toBe(false);
  });

  it('streams PROJECT_UNAVAILABLE as an error frame', async () => {
    h = await harness();
    const sessionId = await projectSession(h);
    fs.rmSync(path.join(h.root, 'site'), { recursive: true });
    const res = await supertest(h.app)
      .post('/api/v1/agents/alfred/messages')
      .set('Authorization', `Bearer ${KEYS.admin!.key}`)
      .send({ message: 'hi', chat_id: 'web', session_id: sessionId, stream: true });
    expect(res.text).toMatch(/"type":"error"[^\n]*"code":"PROJECT_UNAVAILABLE"/);
    expect(spawns(h)).toEqual([]);
  });

  it('re-resolves the project on a crash restart', async () => {
    h = await harness();
    const sessionId = await projectSession(h);
    expect((await send(h, sessionId, 'first')).status).toBe(200);
    process.kill(spawns(h)[0]!.pid, 'SIGKILL');
    await waitForCondition(() => spawns(h).length === 2, 15_000);
    expect(spawns(h)[1]!.cwd).toBe(path.join(h.root, 'site'));
    expect(flagValue(spawns(h)[1]!.argv, '--setting-sources')).toBe('user');
  }, 30_000);

  it('does not restart a crashed session in the workspace once its project is gone', async () => {
    h = await harness();
    const sessionId = await projectSession(h);
    expect((await send(h, sessionId, 'first')).status).toBe(200);
    fs.renameSync(path.join(h.root, 'site'), path.join(h.root, 'gone'));
    process.kill(spawns(h)[0]!.pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(spawns(h)).toHaveLength(1);
    const res = await send(h, sessionId, 'second');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROJECT_UNAVAILABLE');
    expect(spawns(h)).toHaveLength(1);
  }, 30_000);
});

describe('project chat on an orchestrated gateway', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness({ orchestration: true }); });
  afterEach(async () => { await teardown(h); });

  it('binds the session to the project, since its workers run there', async () => {
    const res = await create(h, 'alfred', KEYS.admin!, { project: 'site' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ project: 'site' });
  });
});
