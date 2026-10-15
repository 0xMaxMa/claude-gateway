import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { createProjectsRouter } from '../../src/api/projects-router';
import { getRegisteredRoutes } from '../../src/api/route-registry';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podWrite: { key: 'k-pod-write', agents: '*', write: true },
  podRead: { key: 'k-pod-read', agents: '*' },
  agentScoped: { key: 'k-agent', agents: ['alfred'], write: true },
} satisfies Record<string, ApiKey>;
const NON_ADMIN = [KEYS.podWrite, KEYS.podRead, KEYS.agentScoped];

let base: string;
let root: string;
let app: express.Express;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-admin-')));
  root = path.join(base, 'projects');
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  app = express();
  app.use(express.json());
  app.use('/api', createProjectsRouter(Object.values(KEYS), root));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function projectRoutes() {
  createProjectsRouter([], '');
  return getRegisteredRoutes().filter((r) => r.path.startsWith('/v1/projects'));
}

const call = (method: string, route: string, key: ApiKey) =>
  (request(app) as unknown as Record<string, (u: string) => request.Test>)
    [method.toLowerCase()]!(`/api${route.replace(':name', 'app')}`)
    .set('Authorization', `Bearer ${key.key}`)
    .send({ name: 'created-by-test', confirm: 'app' });

describe('every /v1/projects route needs an admin key', () => {
  it('covers the routes the router registers', () => {
    const paths = projectRoutes().map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(expect.arrayContaining([
      'GET /v1/projects', 'POST /v1/projects', 'DELETE /v1/projects/:name', 'GET /v1/projects/:name/tree',
      'GET /v1/projects/:name/file', 'GET /v1/projects/git-summary', 'GET /v1/projects/running',
      'GET /v1/projects/:name/git', 'GET /v1/projects/:name/running',
      'POST /v1/projects/:name/running/stop', 'POST /v1/projects/:name/running/start',
    ]));
    expect(projectRoutes().every((r) => r.auth === 'admin')).toBe(true);
  });

  it.each(NON_ADMIN)('refuses $key on every route with 403 forbidden_key and touches nothing', async (key) => {
    for (const r of projectRoutes()) {
      const res = await call(r.method, r.path, key);
      expect([r.method, r.path, res.status, res.body.code]).toEqual([r.method, r.path, 403, 'forbidden_key']);
      expect(res.body.error).toMatch(/admin API key is required/);
    }
    expect(fs.readdirSync(root)).toEqual(['app']);
  });

  it('lets an admin key past the gate on every route', async () => {
    for (const r of projectRoutes()) {
      if (r.method === 'DELETE') continue;
      const res = await call(r.method, r.path, KEYS.admin);
      expect([r.method, r.path, res.status === 403 && res.body.code === 'forbidden_key']).toEqual([r.method, r.path, false]);
    }
    expect((await call('DELETE', '/v1/projects/:name', KEYS.admin)).status).toBe(200);
  });

  it('still answers a missing key with 401', async () => {
    expect((await request(app).get('/api/v1/projects')).status).toBe(401);
  });
});

describe('a project-bound session or chat is admin-only on every route that reveals or controls it', () => {
  const A = '/api/v1/agents/alfred';
  const UUID = '11111111-2222-3333-4444-555555555555';
  let gwBase: string;
  let runner: AgentRunner;
  let gw: ReturnType<GatewayRouter['getApp']>;
  let bound: string;
  let plain: string;

  beforeEach(async () => {
    gwBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-admin-gw-')));
    fs.mkdirSync(path.join(gwBase, 'projects', 'site'), { recursive: true });
    const workspace = path.join(gwBase, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
    const gateway: GatewayConfig = {
      gateway: { logDir: path.join(gwBase, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) }, projects: { root: path.join(gwBase, 'projects') } },
      agents: [cfg],
    };
    runner = new AgentRunner(cfg, gateway);
    gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway).getApp();
    const open = async (key: ApiKey, chat: string, body: object) =>
      (await request(gw).post(`${A}/sessions`).query({ chat_id: chat }).set('Authorization', `Bearer ${key.key}`).send(body)).body.sessionId as string;
    bound = await open(KEYS.admin, 'web', { project: 'site', name: 'secret-site-chat' });
    plain = await open(KEYS.admin, 'web', { name: 'plain chat' });
    const lonely = await open(KEYS.admin, 'plain', {});
    const db = runner.getHistoryDb();
    const row = (chatId: string, sessionId: string, content: string) =>
      db.insertMessage({ chatId, sessionId, source: 'api', role: 'user', content, ts: Date.now() });
    row('api-web', bound, 'TRANSCRIPT-OF-THE-PROJECT');
    row('api-web', plain, 'ordinary words');
    row('api-plain', lonely, 'lonely words');
  });
  afterEach(async () => {
    await runner.stop().catch(() => {});
    fs.rmSync(gwBase, { recursive: true, force: true });
  });

  const as = (key: ApiKey, method: string, url: string, body?: object) =>
    (request(gw) as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('Authorization', `Bearer ${key.key}`).send(body ?? {});

  /** Every route that takes a session id (or a chat id that holds one) and can reveal or control the session. */
  type Body = (sid: string) => object;
  const SESSION_ROUTES: Array<[string, string, (sid: string) => string, Body?]> = [
    ['get', 'info', (s) => `${A}/sessions/${s}/info?chat_id=web`],
    ['patch', 'rename', (s) => `${A}/sessions/${s}?chat_id=web`, () => ({ session_name: 'x' })],
    ['delete', 'delete', (s) => `${A}/sessions/${s}?chat_id=web`],
    ['post', 'clear', (s) => `${A}/sessions/${s}/clear?chat_id=web`],
    ['post', 'compact', (s) => `${A}/sessions/${s}/compact?chat_id=web`],
    ['post', 'stop', (s) => `${A}/sessions/${s}/stop?chat_id=web`],
    ['post', 'restart', (s) => `${A}/sessions/${s}/restart?chat_id=web`],
    ['get', 'messages/stream', (s) => `${A}/sessions/${s}/messages/stream`],
    ['get', 'activity/stream', (s) => `${A}/sessions/${s}/activity/stream`],
    ['get', 'activity', (s) => `${A}/sessions/${s}/activity`],
    ['get', 'stream', (s) => `${A}/sessions/${s}/stream`],
    ['get', 'media of the session', (s) => `${A}/media/api-${s}/x.png`],
    ['get', 'tasks', (s) => `${A}/sessions/${s}/tasks`],
    ['get', 'task', (s) => `${A}/sessions/${s}/tasks/${UUID}`],
    ['post', 'task answer', (s) => `${A}/sessions/${s}/tasks/${UUID}/answer`, () => ({ questionId: UUID, answer: 'a' })],
    ['post', 'task control', (s) => `${A}/sessions/${s}/tasks/${UUID}/control`, () => ({ id: UUID, action: 'pause', expectedRevision: 1 })],
    ['post', 'task cancel', (s) => `${A}/sessions/${s}/tasks/${UUID}/cancel`],
    ['get', 'voice replays', (s) => `${A}/sessions/${s}/voice-sessions/replays`],
    ['get', 'voice replay', (s) => `${A}/sessions/${s}/voice-sessions/replays/${UUID}`],
    ['post', 'voice replay', (s) => `${A}/sessions/${s}/voice-sessions/replays/${UUID}`],
    ['put', 'voice preference', (s) => `${A}/sessions/${s}/voice-sessions/preference`, () => ({ enabled: false })],
    ['post', 'voice session', (s) => `${A}/sessions/${s}/voice-sessions`, () => ({ chat_id: 'web' })],
    ['post', 'inject message', (s) => `${A}/chats/telegram-1/sessions/${s}/messages`, () => ({ content: 'hi' })],
    ['post', 'messages', (s) => `${A}/messages`, (s) => ({ session_id: s, chat_id: 'web', message: 'hi' })],
    ['post', 'messages/accept', (s) => `${A}/messages/accept`, (s) => ({ session_id: s, chat_id: 'web', message: 'hi' })],
    ['post', 'greeting', (s) => `${A}/greeting`, (s) => ({ session_id: s, chat_id: 'web' })],
  ];
  const CHAT_ROUTES: Array<[string, (chat: string, sid?: string) => string]> = [
    ['messages', (c, s) => `${A}/chats/${c}/messages${s ? `?session_id=${s}` : ''}`],
    ['messages/search', (c) => `${A}/chats/${c}/messages/search?q=words`],
    ['active-days', (c, s) => `${A}/chats/${c}/messages/active-days?from=${Date.now() - 1e6}&to=${Date.now() + 1e6}${s ? `&session_id=${s}` : ''}`],
  ];
  const forbidden = (res: request.Response) => [res.status, res.body?.code];

  it.each(NON_ADMIN.map((k) => [k.key, k] as const))('%s is refused on every session route of a bound session', async (_n, key) => {
    for (const [method, label, url, body] of SESSION_ROUTES) {
      const res = await as(key, method, url(bound), body?.(bound));
      expect([label, ...forbidden(res)]).toEqual([label, 403, 'forbidden_key']);
    }
    expect(fs.existsSync(path.join(gwBase, 'agents', 'alfred', 'project-bindings', `${bound}.json`))).toBe(true);
  });

  it.each(NON_ADMIN.map((k) => [k.key, k] as const))('%s is not refused as forbidden_key on an unbound session', async (_n, key) => {
    for (const [method, label, url, body] of SESSION_ROUTES) {
      if (/stream|delete|voice session/.test(label)) continue;
      const res = await as(key, method, url(plain), body?.(plain));
      expect([label, res.body?.code === 'forbidden_key']).toEqual([label, false]);
    }
  });

  it.each(NON_ADMIN.map((k) => [k.key, k] as const))('%s reads a mixed chat without the bound session, and is refused when it asks for that session', async (_n, key) => {
    for (const [label, url] of CHAT_ROUTES) {
      const mixed = await as(key, 'get', url('api-web'));
      expect([label, mixed.status]).toEqual([label, 200]);
      expect(JSON.stringify(mixed.body)).not.toContain('TRANSCRIPT');
      if (label !== 'messages/search') {
        expect([label, ...forbidden(await as(key, 'get', url('api-web', bound)))]).toEqual([label, 403, 'forbidden_key']);
        expect([label, (await as(key, 'get', url('api-web', plain))).status]).toEqual([label, 200]);
      }
      expect([label, (await as(key, 'get', url('api-plain'))).status]).toEqual([label, 200]);
    }
    const found = await as(key, 'get', `${A}/chats/api-web/messages/search?q=ordinary`);
    expect(found.body.results.map((r: { sessionId: string }) => r.sessionId)).toEqual([plain]);
    const days = await as(key, 'get', CHAT_ROUTES[2]![1]('api-web'));
    expect(days.body.days).toHaveLength(1);
  });

  it.each(NON_ADMIN.map((k) => [k.key, k] as const))('%s sees neither the bound session nor its project in any list', async (_n, key) => {
    const sessions = await as(key, 'get', `${A}/sessions?chat_id=web`);
    expect(sessions.status).toBe(200);
    const ids = sessions.body.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(plain);
    expect(ids).not.toContain(bound);
    expect(sessions.body.sessions.every((s: { project: unknown }) => !s.project)).toBe(true);
    const chats = await as(key, 'get', `${A}/chats`);
    expect(chats.body.chats.map((c: { chatId: string; messageCount: number }) => [c.chatId, c.messageCount]).sort()).toEqual([['api-plain', 1], ['api-web', 1]]);
    for (const res of [sessions, chats]) expect(JSON.stringify(res.body)).not.toMatch(/site|TRANSCRIPT|secret-site-chat/);
  });

  it('shows an admin key everything', async () => {
    for (const [label, url] of CHAT_ROUTES) expect([label, (await as(KEYS.admin, 'get', url('api-web'))).status]).toEqual([label, 200]);
    const sessions = await as(KEYS.admin, 'get', `${A}/sessions?chat_id=web`);
    expect(sessions.body.sessions.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([bound, plain]));
    expect(sessions.body.sessions.find((s: { id: string }) => s.id === bound).project).toBe('site');
    expect((await as(KEYS.admin, 'get', `${A}/chats`)).body.chats.map((c: { chatId: string }) => c.chatId).sort()).toEqual(['api-plain', 'api-web']);
    expect((await as(KEYS.admin, 'get', `${A}/sessions/${bound}/info?chat_id=web`)).status).toBe(200);
  });

  it('covers a session bound before the upgrade: only the binding file says so', async () => {
    const old = (await as(KEYS.admin, 'post', `${A}/sessions?chat_id=old`, {})).body.sessionId as string;
    runner.getHistoryDb().insertMessage({ chatId: 'api-old', sessionId: old, source: 'api', role: 'user', content: 'LEGACY-SECRET', ts: Date.now() });
    fs.mkdirSync(path.join(gwBase, 'agents', 'alfred', 'project-bindings'), { recursive: true });
    fs.writeFileSync(path.join(gwBase, 'agents', 'alfred', 'project-bindings', `${old}.json`), '{"project":"site"}\n');
    const res = await as(KEYS.podWrite, 'get', `${A}/chats/api-old/messages?session_id=${old}`);
    expect([res.status, res.body.code]).toEqual([403, 'forbidden_key']);
    for (const url of [`${A}/chats/api-old/messages`, `${A}/chats/api-old/messages/search?q=LEGACY`, `${A}/chats`, `${A}/sessions?chat_id=old`]) {
      expect(JSON.stringify((await as(KEYS.podWrite, 'get', url)).body)).not.toContain('LEGACY');
    }
  });
});
