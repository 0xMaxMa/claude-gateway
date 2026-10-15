import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podRead: { key: 'k-ro', agents: '*' },
} satisfies Record<string, ApiKey>;
const A = '/api/v1/agents/alfred';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let base: string;
let runner: AgentRunner;
let gw: ReturnType<GatewayRouter['getApp']>;
let bound: string;
let plain: string;
const mediaDir = (id: string) => path.join(base, 'agents', 'alfred', 'media', `api-${id}`);
const bindingFile = (id: string) => path.join(base, 'agents', 'alfred', 'project-bindings', `${id}.json`);
const as = (key: ApiKey, method: 'get' | 'post' | 'delete', url: string, body?: object) =>
  request(gw)[method](url).set('Authorization', `Bearer ${key.key}`).send(body ?? {});
const share = (sid: string, ref: string) => ({ agent_id: 'alfred', session_id: sid, refs: [{ path: ref }] });
const readerReaches = async (id: string) => {
  const get = await as(KEYS.podRead, 'get', `${A}/media/api-${id}/f.png`);
  const shared = await as(KEYS.podRead, 'post', '/api/v1/shares', share(id, `media/api-${id}/f.png`));
  return { get: get.status, share: shared.status };
};

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-media-')));
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
  const open = async (body: object) => (await as(KEYS.admin, 'post', `${A}/sessions?chat_id=web`, body)).body.sessionId as string;
  bound = await open({ project: 'site' });
  plain = await open({});
  for (const id of [bound, plain]) {
    fs.mkdirSync(mediaDir(id), { recursive: true });
    fs.writeFileSync(path.join(mediaDir(id), 'f.png'), PNG);
  }
});
afterEach(async () => {
  await runner.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the media of a deleted project chat', () => {
  it('is removed with the chat, so a read-only key reaches nothing', async () => {
    expect(await readerReaches(bound)).toEqual({ get: 403, share: 403 });
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${bound}?chat_id=web`)).status).toBe(204);
    expect(fs.existsSync(mediaDir(bound))).toBe(false);
    expect(await readerReaches(bound)).toEqual({ get: 403, share: 403 });
  });

  it('stays while a turn is live, and goes when the binding is reaped', async () => {
    const live = (runner as unknown as { pendingApiSessions: Set<string> }).pendingApiSessions;
    live.add(bound);
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${bound}?chat_id=web`)).status).toBe(204);
    expect(fs.existsSync(mediaDir(bound))).toBe(true);
    expect((await readerReaches(bound)).get).toBe(403);
    live.delete(bound);
    await runner.boundSessionIds();
    expect(fs.existsSync(mediaDir(bound))).toBe(false);
    expect(fs.existsSync(bindingFile(bound))).toBe(false);
  });

  it('is kept for a delete that names a chat not holding the session', async () => {
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${bound}?chat_id=other`)).status).toBe(204);
    expect(fs.existsSync(mediaDir(bound))).toBe(true);
    expect((await readerReaches(bound)).get).toBe(403);
  });

  it('is not removed for an unbound session', async () => {
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${plain}?chat_id=web`)).status).toBe(204);
    expect(fs.existsSync(mediaDir(plain))).toBe(true);
  });
});

describe('the media gate for a session id with no record', () => {
  it('refuses a read-only key a folder whose session is gone and has no binding', async () => {
    fs.rmSync(bindingFile(bound));
    const idx = path.join(base, 'agents', 'alfred', 'sessions', 'api-web');
    for (const f of fs.readdirSync(idx)) {
      const file = path.join(idx, f);
      if (fs.statSync(file).isFile() && f.endsWith('.json')) {
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes(bound)) {
          const json = JSON.parse(text);
          json.sessions = json.sessions.filter((s: { id: string }) => s.id !== bound);
          fs.writeFileSync(file, JSON.stringify(json));
        }
      }
    }
    await runner.boundSessionIds();
    expect(await readerReaches(bound)).toEqual({ get: 403, share: 403 });
    expect((await as(KEYS.admin, 'get', `${A}/media/api-${bound}/f.png`)).status).toBe(200);
  });

  it('still serves a read-only key the media of an existing unbound session and of a chat folder', async () => {
    expect(await readerReaches(plain)).toEqual({ get: 200, share: 201 });
    fs.mkdirSync(mediaDir('web'), { recursive: true });
    fs.writeFileSync(path.join(mediaDir('web'), 'f.png'), PNG);
    expect((await readerReaches('web')).get).toBe(200);
  });
});
