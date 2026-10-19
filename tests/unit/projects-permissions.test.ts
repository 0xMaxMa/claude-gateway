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
  alfredOnly: { key: 'k-alfred', agents: ['alfred'], write: true },
} satisfies Record<string, ApiKey>;
const NON_ADMIN = [KEYS.podWrite, KEYS.podRead, KEYS.alfredOnly];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const ADMIN_ONLY_ROUTES = [
  'POST /v1/projects', 'DELETE /v1/projects/:name', 'POST /v1/projects/:name/running/stop', 'POST /v1/projects/:name/running/start',
  'GET /v1/projects/cleanup', 'POST /v1/projects/cleanup',
];
const READ_ROUTES = [
  'GET /v1/projects', 'GET /v1/projects/git-summary', 'GET /v1/projects/disk',
  'GET /v1/projects/running', 'GET /v1/projects/:name/git', 'GET /v1/projects/:name/running',
];

describe('the /v1/projects routes', () => {
  let base: string;
  let root: string;
  let app: express.Express;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-perm-')));
    root = path.join(base, 'projects');
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'README.md'), '# app\n');
    app = express();
    app.use(express.json());
    app.use('/api', createProjectsRouter(Object.values(KEYS), root));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  const routes = () => {
    createProjectsRouter([], '');
    return getRegisteredRoutes().filter((r) => r.path.startsWith('/v1/projects'));
  };
  const call = (route: string, key?: ApiKey) => {
    const [method, url] = route.split(' ') as [string, string];
    const req = (request(app) as unknown as Record<string, (u: string) => request.Test>)[method.toLowerCase()]!(
      `/api${url.replace(':name', 'app')}`,
    );
    return (key ? req.set('Authorization', `Bearer ${key.key}`) : req).send({ name: 'made-by-test', confirm: 'app' });
  };

  it('registers the twelve routes, and marks exactly create, delete, stop, start and both cleanup routes as admin', () => {
    const all = routes().map((r) => `${r.method} ${r.path}`);
    expect(all.sort()).toEqual([...ADMIN_ONLY_ROUTES, ...READ_ROUTES].sort());
    expect(routes().filter((r) => r.auth === 'admin').map((r) => `${r.method} ${r.path}`).sort()).toEqual([...ADMIN_ONLY_ROUTES].sort());
  });

  it.each(NON_ADMIN)('lets $key read every project route', async (key) => {
    for (const route of READ_ROUTES) {
      const res = await call(route, key);
      const expected = route.endsWith('/git') ? 409 : 200;
      expect([route, res.status]).toEqual([route, expected]);
    }
  });

  it.each(NON_ADMIN)('refuses $key on create, delete, stop, start and cleanup with 403 forbidden_key, and changes nothing', async (key) => {
    for (const route of ADMIN_ONLY_ROUTES) {
      const res = await call(route, key);
      expect([route, res.status, res.body.code, res.body.error]).toEqual([route, 403, 'forbidden_key', 'An admin API key is required for Projects']);
    }
    expect(fs.readdirSync(root)).toEqual(['app']);
  });

  it('lets an admin key past the gate on every route, and answers no key with 401', async () => {
    for (const route of [...READ_ROUTES, ...ADMIN_ONLY_ROUTES.filter((r) => !r.startsWith('DELETE'))]) {
      const res = await call(route, KEYS.admin);
      expect([route, res.body?.code === 'forbidden_key']).toEqual([route, false]);
      expect([route, (await call(route)).status]).toEqual([route, 401]);
    }
    expect((await call('DELETE /v1/projects/:name', KEYS.admin)).status).toBe(200);
    expect(fs.existsSync(path.join(root, 'app'))).toBe(false);
  });
});

describe('a project-bound chat', () => {
  let base: string;
  let runners: AgentRunner[];
  let gw: ReturnType<GatewayRouter['getApp']>;
  const chats: Record<string, string> = {};

  const as = (key: ApiKey, method: string, url: string, body?: object) =>
    (request(gw) as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('Authorization', `Bearer ${key.key}`).send(body ?? {});
  const open = async (agent: string, body: object) =>
    (await as(KEYS.admin, 'post', `/api/v1/agents/${agent}/sessions?chat_id=web`, body)).body.sessionId as string;

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-perm-gw-')));
    process.env.HOME = base;
    fs.mkdirSync(path.join(base, 'projects', 'site'), { recursive: true });
    const configs: AgentConfig[] = ['alfred', 'bruce'].map((id) => {
      const workspace = path.join(base, 'agents', id, 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      return { id, description: id, workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
    });
    const gateway: GatewayConfig = {
      gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) }, projects: { root: path.join(base, 'projects') } },
      agents: configs,
    };
    runners = configs.map((c) => new AgentRunner(c, gateway));
    gw = new GatewayRouter(new Map(runners.map((r, i) => [configs[i]!.id, r])), new Map(configs.map((c) => [c.id, c])), undefined, gateway, undefined, path.join(base, 'config.json')).getApp();
    chats.bound = await open('alfred', { project: 'site', name: 'site chat' });
    chats.plain = await open('alfred', { name: 'plain chat' });
    chats.theirs = await open('bruce', { project: 'site', name: 'bruce site chat' });
    for (const [name, agent] of [['bound', 'alfred'], ['plain', 'alfred'], ['theirs', 'bruce']] as const) {
      const id = chats[name]!;
      const dir = path.join(base, 'agents', agent, 'media', `api-${id}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'f.png'), PNG);
      runners[agent === 'alfred' ? 0 : 1]!.getHistoryDb().insertMessage({ chatId: 'api-web', sessionId: id, source: 'api', role: 'user', content: `WORDS-OF-${name}`, ts: Date.now() });
    }
  });
  afterEach(async () => {
    await Promise.all(runners.map((r) => r.stop().catch(() => {})));
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** Routes that read or act on one session of `agent`, without starting a turn. */
  const sessionRoutes = (agent: string, sid: string): Array<[string, string, string, object?]> => {
    const A = `/api/v1/agents/${agent}`;
    const file = path.join(base, 'agents', agent, 'media', `api-${sid}`, 'f.png');
    return [
      ['info', 'get', `${A}/sessions/${sid}/info?chat_id=web`],
      ['rename', 'patch', `${A}/sessions/${sid}?chat_id=web`, { session_name: 'renamed' }],
      ['activity', 'get', `${A}/sessions/${sid}/activity`],
      ['tasks', 'get', `${A}/sessions/${sid}/tasks`],
      ['history', 'get', `${A}/chats/api-web/messages?session_id=${sid}`],
      ['active-days', 'get', `${A}/chats/api-web/messages/active-days?from=${Date.now() - 1e6}&to=${Date.now() + 1e6}&session_id=${sid}`],
      ['media', 'get', `${A}/media/api-${sid}/f.png`],
      ['attachments', 'post', `${A}/sessions/${sid}/attachments`, { files: [file] }],
      ['share', 'post', '/api/v1/shares', { agent_id: agent, session_id: sid, refs: [{ path: `media/api-${sid}/f.png` }] }],
      ['image artifact', 'post', '/api/v1/image-artifacts', { agent_id: agent, session_id: sid, provider: 'p', model: 'm', files: [`media/api-${sid}/f.png`] }],
      ['image catalog', 'get', `/api/v1/image-catalog?agent_id=${agent}&session_id=${sid}`],
      ['video catalog', 'get', `/api/v1/video-catalog?agent_id=${agent}&session_id=${sid}`],
      ['voice replays', 'get', `${A}/sessions/${sid}/voice-sessions/replays`],
    ];
  };
  const answers = async (key: ApiKey, agent: string, sid: string) => {
    const out: Array<[string, number]> = [];
    for (const [label, method, url, body] of sessionRoutes(agent, sid)) out.push([label, (await as(key, method, url, body)).status]);
    return out;
  };

  it.each(Object.values(KEYS))('answers $key on every route of a bound session exactly as on a plain one', async (key) => {
    const bound = await answers(key, 'alfred', chats.bound!);
    const plain = await answers(key, 'alfred', chats.plain!);
    expect(bound).toEqual(plain);
    expect(bound.find(([label]) => label === 'media')).toEqual(['media', 200]);
    expect(bound.find(([label]) => label === 'share')).toEqual(['share', 201]);
  });

  it.each(Object.values(KEYS))('shows $key the bound session, its project and its transcript in every list', async (key) => {
    const sessions = await as(key, 'get', '/api/v1/agents/alfred/sessions?chat_id=web');
    expect(sessions.body.sessions.find((s: { id: string }) => s.id === chats.bound)).toMatchObject({ project: 'site', trusted: false });
    const info = await as(key, 'get', `/api/v1/agents/alfred/sessions/${chats.bound}/info?chat_id=web`);
    expect(info.body).toMatchObject({ project: 'site', trusted: false });
    const chatList = await as(key, 'get', '/api/v1/agents/alfred/chats');
    expect(chatList.body.chats.find((c: { chatId: string }) => c.chatId === 'api-web').messageCount).toBe(2);
    expect(JSON.stringify((await as(key, 'get', '/api/v1/agents/alfred/chats/api-web/messages')).body)).toContain('WORDS-OF-bound');
    const found = await as(key, 'get', '/api/v1/agents/alfred/chats/api-web/messages/search?q=WORDS');
    expect(found.body.results.map((r: { sessionId: string }) => r.sessionId).sort()).toEqual([chats.bound, chats.plain].sort());
    const command = await as(key, 'post', '/api/v1/agents/alfred/messages', { message: '/sessions', chat_id: 'web', session_id: chats.plain });
    expect(JSON.stringify(command.body)).toContain(chats.bound!);
  });

  it("refuses an agent-scoped key on every route of another agent's project chat, and on its lists", async () => {
    for (const [label, status] of await answers(KEYS.alfredOnly, 'bruce', chats.theirs!)) expect([label, status]).toEqual([label, 403]);
    for (const url of ['/api/v1/agents/bruce/sessions?chat_id=web', '/api/v1/agents/bruce/chats', '/api/v1/agents/bruce/chats/api-web/messages']) {
      const res = await as(KEYS.alfredOnly, 'get', url);
      expect([url, res.status, res.body.error]).toEqual([url, 403, "API key has no access to agent 'bruce'"]);
    }
    const send = await as(KEYS.alfredOnly, 'post', '/api/v1/agents/bruce/messages', { message: 'hi', chat_id: 'web', session_id: chats.theirs });
    expect([send.status, JSON.stringify(send.body)]).toEqual([403, expect.not.stringContaining('WORDS')]);
  });

  it('lets a key that can write to the agent bind a chat, and only to its own agent', async () => {
    const bind = (key: ApiKey, agent: string, project = 'site') => as(key, 'post', `/api/v1/agents/${agent}/sessions?chat_id=web`, { project });
    for (const key of [KEYS.admin, KEYS.podWrite, KEYS.alfredOnly]) {
      const res = await bind(key, 'alfred');
      expect([key.key, res.status, res.body.project]).toEqual([key.key, 201, 'site']);
    }
    expect((await bind(KEYS.podWrite, 'bruce')).status).toBe(201);
    expect([(await bind(KEYS.alfredOnly, 'bruce')).status, (await bind(KEYS.alfredOnly, 'bruce')).body.error]).toEqual([403, "API key has no access to agent 'bruce'"]);
    const reader = await bind(KEYS.podRead, 'alfred');
    expect([reader.status, reader.body.error]).toEqual([403, 'Write permission required']);
    expect((await bind(KEYS.podWrite, 'alfred', 'missing')).body.code).toBe('project_not_found');
  });

  it.each(Object.values(KEYS))('answers $key 404 on the removed project file routes of the full gateway', async (key) => {
    fs.writeFileSync(path.join(base, 'projects', 'site', 'README.md'), 'SITE-README');
    for (const url of ['/api/v1/projects/site/tree', '/api/v1/projects/site/tree?path=', '/api/v1/projects/site/file?path=README.md']) {
      const res = await as(key, 'get', url);
      expect([url, res.status]).toEqual([url, 404]);
      expect(res.text).not.toContain('SITE-README');
    }
  });

  it('refuses a read-only key the greeting of a bound chat, as for a plain one', async () => {
    fs.writeFileSync(path.join(base, 'agents', 'alfred', 'workspace', 'GREETING.md'), 'hello');
    for (const sid of [chats.bound, chats.plain]) {
      const res = await as(KEYS.podRead, 'post', '/api/v1/agents/alfred/greeting', { session_id: sid, chat_id: 'web' });
      expect([res.status, res.body.error]).toEqual([403, "greeting requires write or admin access to agent 'alfred'"]);
    }
  });
});
