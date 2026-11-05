import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { createCwdResolver } from '../../src/files/session-cwd';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';
import { silentLogger } from '../helpers/silent-logger';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podRead: { key: 'k-ro', agents: '*' },
} satisfies Record<string, ApiKey>;
const A = '/api/v1/agents/alfred';

let base: string;
let runner: AgentRunner;
let gw: ReturnType<GatewayRouter['getApp']>;
let bound: string;
const site = () => path.join(base, 'projects', 'site');
const boundCwd = async () => (await runner.sessionCwdView(bound)).cwd;
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
    gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) }, files: { root: path.join(base, 'projects') } },
    agents: [cfg],
  };
  runner = new AgentRunner(cfg, gateway, undefined, createCwdResolver(gateway, silentLogger));
  gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway).getApp();
  bound = (await request(gw).post(`${A}/sessions`).query({ chat_id: 'web' }).set('Authorization', 'Bearer k-admin').send({ cwd: 'site' })).body.sessionId;
  insert('FIRST-SECRET');
});
afterEach(async () => {
  await runner.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

describe('deleting a folder-bound session', () => {
  it('purges its history and drops the binding', async () => {
    expect(await boundCwd()).toBe(site());
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${bound}?chat_id=web`)).status).toBe(204);
    expect(await boundCwd()).toBeNull();
    expect(await readerSees()).not.toContain('FIRST-SECRET');
  });

  it('keeps the binding while a turn is still live, and purges what the turn wrote when it ends', async () => {
    const live = (runner as unknown as { pendingApiSessions: Set<string> }).pendingApiSessions;
    live.add(bound);
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${bound}?chat_id=web`)).status).toBe(204);
    expect(await runner.hasActiveWorkIn(site())).toBe(true);
    insert('PARTIAL-CWD-SECRET');
    live.delete(bound);
    expect((await as(KEYS.podRead, 'get', `${A}/sessions?chat_id=web`)).status).toBe(200);
    expect(await readerSees()).not.toMatch(/PARTIAL-CWD-SECRET|FIRST-SECRET/);
    expect(await boundCwd()).toBeNull();
  });

  it('keeps the binding when the delete names a chat that does not hold the session', async () => {
    expect((await as(KEYS.admin, 'delete', `${A}/sessions/${bound}?chat_id=other`)).status).toBe(204);
    expect(await boundCwd()).toBe(site());
  });
});
