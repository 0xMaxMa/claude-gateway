import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { mintAgentSessionToken } from '../../src/api/agent-credential';
import { GatewayRouter } from '../../src/api/gateway-router';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podRead: { key: 'k-ro', agents: '*' },
  podWrite: { key: 'k-pw', agents: '*', write: true },
  scoped: { key: 'k-sc', agents: ['alfred'], write: true },
} satisfies Record<string, ApiKey>;
const NON_ADMIN = [KEYS.podRead, KEYS.podWrite, KEYS.scoped];
const A = '/api/v1/agents/alfred';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let base: string;
let runner: AgentRunner;
let gw: ReturnType<GatewayRouter['getApp']>;
let bound: string;
let plain: string;

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-routes-')));
  process.env.HOME = base;
  fs.mkdirSync(path.join(base, 'projects', 'site'), { recursive: true });
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
  const gateway: GatewayConfig = {
    gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) }, projects: { root: path.join(base, 'projects') } },
    agents: [cfg],
  };
  runner = new AgentRunner(cfg, gateway);
  gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway, undefined, path.join(base, 'config.json')).getApp();
  const open = async (body: object) => (await request(gw).post(`${A}/sessions`).query({ chat_id: 'web' }).set('Authorization', 'Bearer k-admin').send(body)).body.sessionId as string;
  bound = await open({ project: 'site', name: 'secret-site-chat' });
  plain = await open({ name: 'plain chat' });
  for (const id of [bound, plain]) {
    fs.mkdirSync(path.join(base, 'agents', 'alfred', 'media', `api-${id}`), { recursive: true });
    fs.writeFileSync(path.join(base, 'agents', 'alfred', 'media', `api-${id}`, 'f.png'), PNG);
  }
});
afterEach(async () => {
  await runner.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

const as = (key: ApiKey, method: 'get' | 'post', url: string, body?: object, headers: Record<string, string> = {}) =>
  request(gw)[method](url).set('Authorization', `Bearer ${key.key}`).set(headers).send(body ?? {});
const boundFile = () => `media/api-${bound}/f.png`;
const share = (sid: string, ref: string) => ({ agent_id: 'alfred', session_id: sid, refs: [{ path: ref }] });

describe('routes that name a bound session or its media', () => {
  it.each(NON_ADMIN)('refuse $key', async (key) => {
    const cases: Array<[string, () => request.Test]> = [
      ['share of the bound session', () => as(key, 'post', '/api/v1/shares', share(bound, boundFile()))],
      ['share of its file from another session', () => as(key, 'post', '/api/v1/shares', share(plain, boundFile()))],
      ['share of its file by a dotted path', () => as(key, 'post', '/api/v1/shares', share(plain, `media/x/../api-${bound}/f.png`))],
      ['image artifact in the bound session', () => as(key, 'post', '/api/v1/image-artifacts', { agent_id: 'alfred', session_id: bound, files: [boundFile()] })],
      ['image artifact of its file', () => as(key, 'post', '/api/v1/image-artifacts', { agent_id: 'alfred', session_id: plain, files: [boundFile()] })],
      ['image catalog', () => as(key, 'get', `/api/v1/image-catalog?agent_id=alfred&session_id=${bound}`)],
      ['video catalog', () => as(key, 'get', `/api/v1/video-catalog?agent_id=alfred&session_id=${bound}`)],
      ['attachments', () => as(key, 'post', `${A}/sessions/${bound}/attachments`, { files: [path.join(base, 'agents', 'alfred', 'media', `api-${bound}`, 'f.png')] })],
      ['media_files of its file', () => as(key, 'post', `${A}/messages`, { message: 'hi', chat_id: 'web', session_id: plain, media_files: [boundFile()] })],
    ];
    for (const [label, call] of cases) {
      const res = await call();
      expect([label, res.status, res.body.code]).toEqual([label, 403, 'forbidden_key']);
    }
  });

  it.each(NON_ADMIN)('still serve $key for an unbound session', async (key) => {
    const ok = await as(key, 'post', '/api/v1/shares', share(plain, `media/api-${plain}/f.png`));
    expect(ok.status).toBe(201);
    expect((await as(key, 'get', `/api/v1/image-catalog?agent_id=alfred&session_id=${plain}`)).status).toBe(200);
    expect((await as(key, 'post', `${A}/sessions/${plain}/attachments`, { files: [path.join(base, 'agents', 'alfred', 'media', `api-${plain}`, 'f.png')] })).status).toBe(200);
  });

  it('serve an admin key for the bound session', async () => {
    expect((await as(KEYS.admin, 'post', '/api/v1/shares', share(bound, boundFile()))).status).toBe(201);
    expect((await as(KEYS.admin, 'get', `/api/v1/image-catalog?agent_id=alfred&session_id=${bound}`)).status).toBe(200);
    expect((await as(KEYS.admin, 'post', `${A}/sessions/${bound}/attachments`, { files: [path.join(base, 'agents', 'alfred', 'media', `api-${bound}`, 'f.png')] })).status).toBe(200);
  });

  it.each(NON_ADMIN)('serve the agent of the bound session, with $key as the API key and the session token', async (key) => {
    const token = { 'X-Gateway-Session-Token': mintAgentSessionToken('alfred', bound) };
    expect((await as(key, 'post', '/api/v1/shares', share(bound, boundFile()), token)).status).toBe(201);
    expect((await as(key, 'post', '/api/v1/image-artifacts', { agent_id: 'alfred', session_id: bound, files: [boundFile()] }, token)).status).toBe(201);
    expect((await as(key, 'get', `/api/v1/image-catalog?agent_id=alfred&session_id=${bound}`, undefined, token)).status).toBe(200);
    expect((await as(key, 'post', `${A}/sessions/${bound}/attachments`, { files: [path.join(base, 'agents', 'alfred', 'media', `api-${bound}`, 'f.png')] }, token)).status).toBe(200);
  });

  it('never lets one session token open another bound session or a forged token open any', async () => {
    const other = (await as(KEYS.admin, 'post', `${A}/sessions?chat_id=web`, { project: 'site' })).body.sessionId as string;
    fs.mkdirSync(path.join(base, 'agents', 'alfred', 'media', `api-${other}`), { recursive: true });
    fs.writeFileSync(path.join(base, 'agents', 'alfred', 'media', `api-${other}`, 'f.png'), PNG);
    const mine = { 'X-Gateway-Session-Token': mintAgentSessionToken('alfred', bound) };
    expect((await as(KEYS.podWrite, 'post', '/api/v1/shares', share(bound, `media/api-${other}/f.png`), mine)).status).toBe(403);
    expect((await as(KEYS.podWrite, 'post', '/api/v1/shares', share(other, `media/api-${other}/f.png`), mine)).status).toBe(403);
    expect((await as(KEYS.podWrite, 'post', '/api/v1/shares', share(bound, boundFile()), { 'X-Gateway-Session-Token': 'a'.repeat(64) })).status).toBe(403);
    expect((await as(KEYS.podWrite, 'post', '/api/v1/shares', share(bound, boundFile()), { 'X-Gateway-Session-Token': mintAgentSessionToken('warrior', bound) })).status).toBe(403);
  });
});

describe('the /sessions chat command', () => {
  const list = (key: ApiKey) => as(key, 'post', `${A}/messages`, { message: '/sessions', chat_id: 'web', session_id: plain });
  it.each(NON_ADMIN)('does not list a bound session to $key', async (key) => {
    const res = await list(key);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${bound}|secret-site-chat`));
    expect(JSON.stringify(res.body)).toContain(plain);
  });
  it('lists it to an admin key', async () => {
    expect(JSON.stringify((await list(KEYS.admin)).body)).toContain(bound);
  });
});

describe('an unreadable project-bindings folder, for a key that is not an admin key', () => {
  const dir = () => path.join(base, 'agents', 'alfred', 'project-bindings');
  beforeEach(() => { fs.chmodSync(dir(), 0o000); });
  afterEach(() => { fs.chmodSync(dir(), 0o700); });
  const skip = process.getuid?.() === 0;

  (skip ? it.skip : it).each(NON_ADMIN)('lists answer 503 and routes naming a session answer 403 for $key', async (key) => {
    const lists = [`${A}/sessions?chat_id=web`, `${A}/chats`];
    for (const url of lists) {
      const res = await as(key, 'get', url);
      expect([url, res.status, res.body.code]).toEqual([url, 503, 'project_bindings_unreadable']);
    }
    for (const url of [`${A}/sessions/${plain}/info?chat_id=web`, `${A}/sessions/${plain}/activity`]) {
      const res = await as(key, 'get', url);
      expect([url, res.status, res.body.code]).toEqual([url, 403, 'forbidden_key']);
    }
    const command = await as(key, 'post', `${A}/messages`, { message: '/sessions', chat_id: 'web', session_id: plain });
    expect([command.status, command.body.code]).toEqual([403, 'forbidden_key']);
  });

  (skip ? it.skip : it)('an admin key is not affected', async () => {
    expect((await as(KEYS.admin, 'get', `${A}/sessions?chat_id=web`)).status).toBe(200);
  });
});
