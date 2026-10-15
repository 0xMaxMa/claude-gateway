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

let base: string;
let runner: AgentRunner;
let gw: ReturnType<GatewayRouter['getApp']>;
let bound: string;
const bindingFile = () => path.join(base, 'agents', 'alfred', 'project-bindings', `${bound}.json`);
const as = (key: ApiKey, method: 'get' | 'delete', url: string) => request(gw)[method](url).set('Authorization', `Bearer ${key.key}`);
const insert = (content: string) => runner.getHistoryDb().insertMessage({ chatId: 'api-web', sessionId: bound, source: 'api', role: 'assistant', content, ts: Date.now() });
const readerSees = async () => JSON.stringify((await as(KEYS.podRead, 'get', `${A}/chats/api-web/messages`)).body) + JSON.stringify((await as(KEYS.podRead, 'get', `${A}/chats`)).body);

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-order-')));
  fs.mkdirSync(path.join(base, 'projects', 'site'), { recursive: true });
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
  const gateway: GatewayConfig = {
    gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) }, projects: { root: path.join(base, 'projects') } },
    agents: [cfg],
  };
  runner = new AgentRunner(cfg, gateway);
  gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway).getApp();
  bound = (await request(gw).post(`${A}/sessions`).query({ chat_id: 'web' }).set('Authorization', 'Bearer k-admin').send({ project: 'site' })).body.sessionId;
  insert('FIRST-SECRET');
});
afterEach(async () => {
  await runner.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

describe('deleting a project-bound session', () => {
  it('purges its history before it drops the binding', async () => {
    const order: string[] = [];
    const db = runner.getHistoryDb();
    const clear = db.clearSession.bind(db);
    db.clearSession = (chat: string, id: string) => { order.push(`history:${fs.existsSync(bindingFile()) ? 'bound' : 'unbound'}`); return clear(chat, id); };
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${bound}?chat_id=web`)).status).toBe(204);
    expect(order).toEqual(['history:bound']);
    expect(fs.existsSync(bindingFile())).toBe(false);
    expect(await readerSees()).not.toContain('FIRST-SECRET');
  });

  it('keeps the session hidden while a turn is still live, and purges what the turn wrote when it ends', async () => {
    const live = (runner as unknown as { pendingApiSessions: Set<string> }).pendingApiSessions;
    live.add(bound);
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${bound}?chat_id=web`)).status).toBe(204);
    insert('PARTIAL-PROJECT-SECRET');
    expect(await readerSees()).not.toMatch(/PARTIAL-PROJECT-SECRET|FIRST-SECRET/);
    live.delete(bound);
    expect(await readerSees()).not.toMatch(/PARTIAL-PROJECT-SECRET|FIRST-SECRET/);
    expect(fs.existsSync(bindingFile())).toBe(false);
    const admin = JSON.stringify((await as(KEYS.admin, 'get', `${A}/chats/api-web/messages`)).body);
    expect(admin).not.toContain('PARTIAL-PROJECT-SECRET');
  });

  it('keeps the binding when the delete names a chat that does not hold the session', async () => {
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${bound}?chat_id=other`)).status).toBe(204);
    expect(fs.existsSync(bindingFile())).toBe(true);
    expect(await readerSees()).not.toContain('FIRST-SECRET');
  });
});
