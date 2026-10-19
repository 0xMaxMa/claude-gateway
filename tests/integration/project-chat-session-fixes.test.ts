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

async function harness(opts: { trusted?: string[]; orchestration?: boolean; extra?: Record<string, Partial<AgentConfig>> } = {}): Promise<Harness> {
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
    ...Object.entries(opts.extra ?? {}).map(([id, extra]) => agentConfig(base, id, extra)),
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

function send(h: Harness, sessionId: string, message: string, key: ApiKey = KEYS.admin!, chatId = 'web') {
  return supertest(h.app)
    .post('/api/v1/agents/alfred/messages')
    .set('Authorization', `Bearer ${key.key}`)
    .send({ message, chat_id: chatId, session_id: sessionId });
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


import * as chat from '../../src/projects/chat';
const auth = (k: ApiKey) => ({ Authorization: `Bearer ${k.key}` });

const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];

describe('project chat session fixes', () => {
  beforeAll(() => { process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE}`; });
  let h: Harness;
  afterEach(async () => { jest.restoreAllMocks(); await teardown(h); });

  it('F1 project delete is refused while a bound chat is still spawning its first turn', async () => {
    h = await harness();
    const sid = await projectSession(h);
    const orig = chat.projectContext;
    let entered!: () => void; const inCtx = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    jest.spyOn(chat, 'projectContext').mockImplementation(async (...a) => { entered(); await gate; return orig(...a); });
    const turn = send(h, sid, 'a').then((r) => r, (e: unknown) => e);
    await inCtx;
    const del = await supertest(h.app).delete('/api/v1/projects/site').set(auth(KEYS.admin!)).send({ confirm: 'site' });
    release();
    await turn;
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('project_running');
    expect(fs.existsSync(path.join(h.root, 'site'))).toBe(true);
  }, 30000);

  it('F2 folder removed between resolve and spawn ends as a fast 409 PROJECT_UNAVAILABLE', async () => {
    h = await harness();
    const sid = await projectSession(h);
    const orig = chat.projectContext;
    jest.spyOn(chat, 'projectContext').mockImplementation(async (...a) => { fs.rmSync(path.join(h.root, 'site'), { recursive: true }); return orig(...a); });
    const t = Date.now();
    const res = await send(h, sid, 'a');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROJECT_UNAVAILABLE');
    expect(Date.now() - t).toBeLessThan(15000);
  }, 30000);

  it('F3 greeting refuses a key that cannot write to the agent, and keeps GREETING.md when the project is gone', async () => {
    h = await harness();
    const sid = await projectSession(h);
    const greeting = path.join(h.base, 'agents', 'alfred', 'workspace', 'GREETING.md');
    fs.writeFileSync(greeting, 'hello');
    const denied = await supertest(h.app).post('/api/v1/agents/alfred/greeting').set(auth(KEYS.podReader!)).send({ session_id: sid, chat_id: 'web' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/requires write or admin access/);
    expect(spawns(h)).toEqual([]);
    expect(fs.existsSync(greeting)).toBe(true);

    fs.rmSync(path.join(h.root, 'site'), { recursive: true });
    const gone = await supertest(h.app).post('/api/v1/agents/alfred/greeting').set(auth(KEYS.admin!)).send({ session_id: sid, chat_id: 'web' });
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe('PROJECT_UNAVAILABLE');
    expect(fs.existsSync(greeting)).toBe(true);
  }, 30000);

  it('F4 revoking trust respawns the live session with --setting-sources user', async () => {
    h = await harness({ trusted: ['site'] });
    const sid = await projectSession(h);
    await send(h, sid, 'a');
    expect(flagValue(spawns(h)[0]!.argv, '--setting-sources')).toBeUndefined();
    (h.runners[0] as any).gatewayConfig.gateway.projects.trusted = [];
    await send(h, sid, 'b');
    expect(spawns(h)).toHaveLength(2);
    expect(flagValue(spawns(h)[1]!.argv, '--setting-sources')).toBe('user');
  }, 30000);

  it('F5 a failed index write leaves no binding or session file, and a retry creates exactly one session', async () => {
    h = await harness();
    const store = (h.runners[0] as any).sessionStore;
    await create(h, 'alfred', KEYS.admin!, {});
    const dir = path.join(h.base, 'agents', 'alfred');
    const before = walk(dir).filter((f) => !f.includes('workspace'));
    const spy = jest.spyOn(store, 'saveIndex').mockRejectedValueOnce(new Error('disk full'));
    const res = await create(h, 'alfred', KEYS.admin!, { project: 'site' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    spy.mockRestore();
    expect(walk(dir).filter((f) => !f.includes('workspace'))).toEqual(before);
    const retry = await create(h, 'alfred', KEYS.admin!, { project: 'site' });
    expect(retry.status).toBe(201);
    const list = await supertest(h.app).get('/api/v1/agents/alfred/sessions').set(auth(KEYS.admin!)).query({ chat_id: 'web' });
    expect(list.body.sessions.filter((s: any) => s.project === 'site')).toHaveLength(1);
  }, 30000);

  it('F6 deleting a session removes its binding file and boundProjects entry', async () => {
    h = await harness();
    const sid = await projectSession(h);
    await create(h, 'alfred', KEYS.admin!, {});
    await send(h, sid, 'a');
    const del = await supertest(h.app).delete(`/api/v1/agents/alfred/sessions/${sid}`).set(auth(KEYS.admin!)).query({ chat_id: 'web' });
    expect(del.status).toBeLessThan(300);
    expect(fs.existsSync(path.join(h.base, 'agents', 'alfred', 'project-bindings', `${sid}.json`))).toBe(false);
    expect((h.runners[0] as any).boundProjects.has(sid)).toBe(false);
  }, 30000);
});
