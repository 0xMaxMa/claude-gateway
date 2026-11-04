/**
 * G1c: a session binds a working folder (cwd) under gateway.files.root. Each test is named by the defect it catches.
 * Real AgentRunner, real filesystem, real HTTP through GatewayRouter, mock claude that records its spawn cwd and argv.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { createCwdResolver } from '../../src/files/session-cwd';
import type { CwdResolver } from '../../src/session/cwd';
import { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';
import { silentLogger } from '../helpers/silent-logger';
import { waitForCondition } from '../helpers/wait-for';

const MOCK_CLAUDE = path.resolve(__dirname, '../helpers/mock-claude-argv.js');
const ADMIN: ApiKey = { key: 'sk-admin', agents: '*', admin: true };
const AUTH = { Authorization: `Bearer ${ADMIN.key}` };

interface Harness {
  base: string;
  root: string;
  workspace: string;
  argvLog: string;
  gateway: GatewayConfig;
  config: AgentConfig;
  runner: AgentRunner;
  resolver: CwdResolver;
  app: ReturnType<GatewayRouter['getApp']>;
}

interface Spawn { pid: number; cwd: string; argv: string[] }

function boot(h: Omit<Harness, 'runner' | 'resolver' | 'app'>): Harness {
  const resolver = createCwdResolver(h.gateway, silentLogger);
  const runner = new AgentRunner(h.config, h.gateway, undefined, resolver);
  const app = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', h.config]]), undefined, h.gateway).getApp();
  return { ...h, runner, resolver, app };
}

function harness(opts: { trusted?: string[]; orchestration?: boolean; enabled?: false } = {}): Harness {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-cwd-')));
  const root = path.join(base, 'projects');
  fs.mkdirSync(path.join(root, 'site', 'web'), { recursive: true });
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const config: AgentConfig = { id: 'alfred', description: 'alfred', workspace, env: '', claude: { model: 'claude-test', dangerouslySkipPermissions: true, extraFlags: [] } };
  const gateway: GatewayConfig = {
    gateway: {
      logDir: path.join(base, 'logs'),
      timezone: 'UTC',
      orchestration: opts.orchestration ?? false,
      api: { keys: [ADMIN] },
      files: { root, ...(opts.trusted ? { trusted: opts.trusted } : {}), ...(opts.enabled === false ? { enabled: false } : {}) },
    },
    agents: [config],
  };
  const argvLog = path.join(base, 'argv.jsonl');
  process.env.MOCK_CLAUDE_ARGV_LOG = argvLog;
  return boot({ base, root, workspace, argvLog, gateway, config });
}

async function teardown(h: Harness): Promise<void> {
  await h.runner.stop().catch(() => {});
  fs.rmSync(h.base, { recursive: true, force: true });
}

const spawns = (h: Harness): Spawn[] => fs.existsSync(h.argvLog)
  ? fs.readFileSync(h.argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Spawn)
  : [];

const create = (h: Harness, body: Record<string, unknown>, chatId = 'web') =>
  supertest(h.app).post('/api/v1/agents/alfred/sessions').set(AUTH).query({ chat_id: chatId }).send(body);

const send = (h: Harness, sessionId: string, message: string, chatId = 'web') =>
  supertest(h.app).post('/api/v1/agents/alfred/messages').set(AUTH).send({ message, chat_id: chatId, session_id: sessionId });

const listRows = async (h: Harness, chatId = 'web') =>
  (await supertest(h.app).get('/api/v1/agents/alfred/sessions').set(AUTH).query({ chat_id: chatId })).body.sessions as Array<Record<string, unknown> & { id: string }>;

const row = async (h: Harness, sessionId: string) => (await listRows(h)).find((s) => s.id === sessionId);

const indexFile = (h: Harness, chatId: string) => path.join(h.base, 'agents', 'alfred', 'sessions', `api-${chatId}`, 'index.json');

async function bound(h: Harness, cwd: string): Promise<string> {
  const res = await create(h, { cwd });
  expect([res.status, res.body.code]).toEqual([201, undefined]);
  return res.body.sessionId as string;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

beforeAll(() => { process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE}`; });
afterAll(() => { delete process.env.CLAUDE_BIN; delete process.env.MOCK_CLAUDE_ARGV_LOG; });

describe('session cwd', () => {
  let h: Harness;
  afterEach(async () => {
    jest.restoreAllMocks();
    await teardown(h);
  });

  it('1. a cwd outside the root is refused 403 cwd_outside_root and creates no session (escape by absolute path, symlink or sibling-prefix root)', async () => {
    h = harness();
    const outside = path.join(h.base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(h.root, 'escape'));
    fs.mkdirSync(`${h.root}2/x`, { recursive: true });
    for (const cwd of ['/etc', 'escape', path.join(h.root, 'escape'), `${h.root}2/x`]) {
      const res = await create(h, { cwd });
      expect([cwd, res.status, res.body.code]).toEqual([cwd, 403, 'cwd_outside_root']);
    }
    expect(fs.existsSync(indexFile(h, 'web'))).toBe(false);
  });

  it('2. the root itself is refused 403 cwd_outside_root, by absolute path or by a link to it', async () => {
    h = harness();
    fs.symlinkSync('.', path.join(h.root, 'all'));
    for (const cwd of [h.root, 'all', path.join(h.root, 'all')]) {
      const res = await create(h, { cwd });
      expect([cwd, res.status, res.body.code]).toEqual([cwd, 403, 'cwd_outside_root']);
    }
    const empty = await create(h, { cwd: '' });
    expect([empty.status, empty.body.code]).toEqual([400, 'invalid_cwd']);
    expect(fs.existsSync(indexFile(h, 'web'))).toBe(false);
  });

  it('3. a missing cwd answers 404 cwd_not_found, and a file 409 cwd_unavailable not_a_directory', async () => {
    h = harness();
    fs.writeFileSync(path.join(h.root, 'notes.txt'), 'x');
    const missing = await create(h, { cwd: 'nope' });
    expect([missing.status, missing.body.code]).toEqual([404, 'cwd_not_found']);
    const file = await create(h, { cwd: 'notes.txt' });
    expect([file.status, file.body]).toEqual([409, expect.objectContaining({ code: 'cwd_unavailable', reason: 'not_a_directory' })]);
    expect(fs.existsSync(indexFile(h, 'web'))).toBe(false);
  });

  it('4. relative and absolute spellings store one cwd, and a nested folder runs its chat there', async () => {
    h = harness();
    const relative = await create(h, { cwd: 'site' });
    const absolute = await create(h, { cwd: path.join(h.root, 'site') });
    expect([relative.body.cwd, absolute.body.cwd]).toEqual([path.join(h.root, 'site'), path.join(h.root, 'site')]);

    const nested = await bound(h, 'site/web');
    expect(await row(h, nested)).toMatchObject({ cwd: path.join(h.root, 'site', 'web'), cwdState: 'available' });
    expect((await send(h, nested, 'hi')).status).toBe(200);
    expect(spawns(h).map((s) => s.cwd)).toEqual([path.join(h.root, 'site', 'web')]);
  }, 30_000);

  it('4b. a trailing slash is refused 400 invalid_cwd in every spelling, whatever the folder it names', async () => {
    h = harness();
    const outside = path.join(h.base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(h.root, 'link-out'));
    for (const cwd of ['site/', `${h.root}/site/`, 'link-out/', `${h.root}/link-out/`, 'nope/', `${h.root}/`]) {
      const res = await create(h, { cwd });
      expect([cwd, res.status, res.body.code]).toEqual([cwd, 400, 'invalid_cwd']);
    }
    expect([(await create(h, { cwd: 'link-out' })).status, (await create(h, { cwd: `${h.root}/link-out` })).status]).toEqual([403, 403]);
    expect(fs.existsSync(indexFile(h, 'web'))).toBe(false);
  });

  it('5. a symlink alias runs in the real folder, is never trusted, and keeps the real folder from being deleted mid-turn', async () => {
    h = harness({ trusted: ['site', 'alias'] });
    fs.symlinkSync('site', path.join(h.root, 'alias'));
    const res = await create(h, { cwd: 'alias' });
    expect(res.body).toMatchObject({ cwd: path.join(h.root, 'alias'), trusted: false, cwdState: 'available' });
    const sid = res.body.sessionId as string;

    void send(h, sid, 'HOLD-TURN').then((r) => r, (e: unknown) => e);
    await waitForCondition(() => spawns(h).length > 0, 15_000);
    const [spawn] = spawns(h);
    expect(spawn!.cwd).toBe(path.join(h.root, 'site'));
    expect(flagValue(spawn!.argv, '--setting-sources')).toBe('user');

    const del = await supertest(h.app).delete('/api/v1/files').set(AUTH).send({ path: 'site', confirm: 'site' });
    expect([del.status, del.body.code]).toEqual([409, 'in_use']);
    expect(fs.existsSync(path.join(h.root, 'site'))).toBe(true);
  }, 40_000);

  it.each([
    [['site'], { site: true, 'site/web': false }],
    [['site/web'], { site: false, 'site/web': true }],
  ] as const)('6. trust is an exact match with no inheritance: trusted %j', async (trusted, expected) => {
    h = harness({ trusted: [...trusted] });
    for (const [cwd, isTrusted] of Object.entries(expected)) {
      const sid = await bound(h, cwd);
      expect([cwd, (await row(h, sid))?.trusted]).toEqual([cwd, isTrusted]);
      const before = spawns(h).length;
      expect((await send(h, sid, 'hi')).status).toBe(200);
      const spawn = spawns(h)[before]!;
      expect([cwd, spawn.cwd, flagValue(spawn.argv, '--setting-sources')]).toEqual([cwd, path.join(h.root, cwd), isTrusted ? undefined : 'user']);
    }
  }, 30_000);

  it('7. a cwd-bound session id cannot be carried into another chat (SESSION_ID_IN_USE), which never spawns or lists it', async () => {
    h = harness();
    const sid = await bound(h, 'site');
    const rename = await supertest(h.app).patch(`/api/v1/agents/alfred/sessions/${sid}`).set(AUTH).query({ chat_id: 'evil' }).send({ session_name: 'stolen' });
    expect([rename.status, rename.body.code]).toEqual([409, 'SESSION_ID_IN_USE']);
    const clear = await supertest(h.app).post(`/api/v1/agents/alfred/sessions/${sid}/clear`).set(AUTH).query({ chat_id: 'evil' });
    expect([clear.status, clear.body.code]).toEqual([409, 'SESSION_ID_IN_USE']);
    const turn = await send(h, sid, 'hi', 'evil');
    expect([turn.status, turn.body.code]).toEqual([404, 'SESSION_NOT_FOUND']);
    const accepted = await supertest(h.app).post('/api/v1/agents/alfred/messages/accept').set(AUTH).send({ message: 'hi', chat_id: 'evil', session_id: sid });
    expect([accepted.status, accepted.body.code]).toEqual([404, 'SESSION_NOT_FOUND']);

    expect(spawns(h)).toEqual([]);
    const evilIndex = fs.existsSync(indexFile(h, 'evil')) ? fs.readFileSync(indexFile(h, 'evil'), 'utf8') : '';
    expect(evilIndex).not.toContain(sid);
    expect((await listRows(h, 'evil')).map((s) => s.id)).not.toContain(sid);
    expect(await row(h, sid)).toMatchObject({ cwd: path.join(h.root, 'site'), name: expect.not.stringMatching('stolen') });
  }, 30_000);

  it('7b. two chats claiming one fresh session id in parallel: exactly one wins on every claiming route (40 races)', async () => {
    h = harness();
    const claims: Record<string, (sid: string, chatId: string) => supertest.Test> = {
      rename: (sid, chatId) => supertest(h.app).patch(`/api/v1/agents/alfred/sessions/${sid}`).set(AUTH).query({ chat_id: chatId }).send({ session_name: chatId }),
      clear: (sid, chatId) => supertest(h.app).post(`/api/v1/agents/alfred/sessions/${sid}/clear`).set(AUTH).query({ chat_id: chatId }),
      compact: (sid, chatId) => supertest(h.app).post(`/api/v1/agents/alfred/sessions/${sid}/compact`).set(AUTH).query({ chat_id: chatId }),
      stop: (sid, chatId) => supertest(h.app).post(`/api/v1/agents/alfred/sessions/${sid}/stop`).set(AUTH).query({ chat_id: chatId }),
      restart: (sid, chatId) => supertest(h.app).post(`/api/v1/agents/alfred/sessions/${sid}/restart`).set(AUTH).query({ chat_id: chatId }),
    };
    const indexed = (chatId: string) => fs.existsSync(indexFile(h, chatId)) ? fs.readFileSync(indexFile(h, chatId), 'utf8') : '';
    const outcomes: string[] = [];
    for (let i = 0; i < 40; i++) {
      const [route, claim] = Object.entries(claims)[i % 5]!;
      const sid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const [a, b] = await Promise.all([claim(sid, 'chat-a'), claim(sid, 'chat-b')]);
      const inUse = [a, b].filter((r) => r.body.code === 'SESSION_ID_IN_USE').length;
      const inBoth = indexed('chat-a').includes(sid) && indexed('chat-b').includes(sid);
      outcomes.push(`${route} in_use=${inUse} in_both=${inBoth}`);
    }
    expect(outcomes.filter((o) => !o.endsWith('in_use=1 in_both=false'))).toEqual([]);
  }, 60_000);

  it('9. active is true exactly while a turn runs or a spawn is pending, and false at rest', async () => {
    h = harness();
    const sid = await bound(h, 'site');
    const dir = path.join(h.root, 'site');
    expect((await row(h, sid))?.active).toBe(false);

    const resolver = h.resolver;
    const note = resolver.note.bind(resolver);
    let entered!: () => void; const inSpawn = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    jest.spyOn(resolver, 'note').mockImplementationOnce(async (cwd) => { entered(); await gate; return note(cwd); });
    const held = send(h, sid, 'HOLD-TURN').then((r) => r, (e: unknown) => e);
    await inSpawn;
    expect((await row(h, sid))?.active).toBe(true);
    await h.runner.prepareWorkCheck();
    expect([...h.runner.workIn(dir)]).toContain('spawn');
    release();

    await waitForCondition(() => spawns(h).length > 0, 15_000);
    expect((await row(h, sid))?.active).toBe(true);
    await h.runner.prepareWorkCheck();
    expect([...h.runner.workIn(dir)]).toEqual(expect.arrayContaining(['turn']));

    await supertest(h.app).post(`/api/v1/agents/alfred/sessions/${sid}/restart`).set(AUTH).query({ chat_id: 'web' });
    await held;
    await waitForCondition(() => !h.runner.hasActiveApiSession(sid), 10_000);
    expect((await row(h, sid))?.active).toBe(false);
    expect((await h.runner.sessionCwdView(sid)).active).toBe(false);
  }, 40_000);

  it('9. an unfinished task keeps its folder busy and its session active', async () => {
    h = harness({ orchestration: true });
    const sid = await bound(h, 'site');
    fs.mkdirSync(path.join(h.root, 'other'));
    const accepted = await supertest(h.app).post('/api/v1/agents/alfred/messages/accept').set(AUTH)
      .send({ message: 'hello', chat_id: 'web', session_id: sid, client_message_id: '00000000-0000-4000-8000-0000000000c1' });
    expect(accepted.status).toBe(202);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runtime = (): any => (h.runner as any).orchestration;
    await waitForCondition(() => !!runtime() && runtime().liveSessionIds().size === 0, 20_000);
    expect((await h.runner.sessionCwdView(sid)).active).toBe(false);

    const conv = runtime().store.get('SELECT id FROM conversations WHERE agent_session_id=?', sid);
    const now = Date.now();
    const insert = (id: string, snapshot: object) => runtime().store.run('INSERT INTO tasks(id,conversation_id,state,state_version,revision,active_attempt_id,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, conv.id, 'running', 1, 1, null, JSON.stringify(snapshot), now, now);
    insert('task-cwd', { cwd: path.join(h.root, 'site') });

    expect((await h.runner.sessionCwdView(sid)).active).toBe(true);
    expect((await row(h, sid))?.active).toBe(true);
    await h.runner.prepareWorkCheck();
    expect([...h.runner.workIn(path.join(h.root, 'site'))]).toContain('task');

    runtime().store.run("UPDATE tasks SET state='completed' WHERE id='task-cwd'");
    expect((await h.runner.sessionCwdView(sid)).active).toBe(false);
    await h.runner.prepareWorkCheck();
    expect([...h.runner.workIn(path.join(h.root, 'other'))]).toEqual([]);
  }, 40_000);

  it.each([
    ['orchestration on, files enabled', { orchestration: true }, ['cwd']],
    ['orchestration off', { orchestration: false }, []],
    ['files disabled', { orchestration: true, enabled: false as const }, []],
  ] as const)('10. capabilities.sessions advertises cwd only when a chat could bind one: %s', async (_label, opts, sessions) => {
    h = harness(opts);
    const res = await supertest(h.app).get('/api/v1/capabilities').set(AUTH);
    expect(res.body.capabilities.sessions).toEqual(sessions);
    expect(res.body.capabilities).not.toHaveProperty('projects');
  });
});
