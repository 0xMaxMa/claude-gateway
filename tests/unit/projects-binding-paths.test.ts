import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { SessionStore } from '../../src/session/store';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podRead: { key: 'k-ro', agents: '*' },
  podWrite: { key: 'k-pw', agents: '*', write: true },
} satisfies Record<string, ApiKey>;
const A = '/api/v1/agents/alfred';

let base: string;
let runner: AgentRunner;
let gw: ReturnType<GatewayRouter['getApp']>;
let bound: string;
const bindingFile = () => path.join(base, 'agents', 'alfred', 'project-bindings', `${bound}.json`);

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'binding-paths-')));
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
});
afterEach(async () => {
  await runner.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

const ESCAPES = (id: string) => [
  `x%2F..%2F${id}`, `x%2f..%2f${id}`, `%2e%2e%2f${id}`, `%2E%2E%5C${id}`, `x%5c..%5c${id}`, `x%252F..%252F${id}`,
  `..%2F${id}`, `.%2F${id}`, `${id}%00`, `${id}%2F`, `${id}.json`, `%2F${id}`,
];

describe('a path-shaped session id never reaches a binding file', () => {
  it.each(Object.values(KEYS).filter((k) => !(k as ApiKey).admin))('%s cannot unbind a session by DELETE with an escaped id', async (key) => {
    for (const bad of ESCAPES(bound)) {
      const res = await request(gw).delete(`${A}/sessions/${bad}?chat_id=web`).set('Authorization', `Bearer ${key.key}`);
      expect([bad, res.status === 204, fs.existsSync(bindingFile())]).toEqual([bad, false, true]);
    }
  });

  it('answers 400 to a malformed id before any handler runs, on every session route, for a non-admin key', async () => {
    for (const bad of ESCAPES(bound)) {
      for (const [method, url] of [
        ['delete', `${A}/sessions/${bad}?chat_id=web`], ['patch', `${A}/sessions/${bad}?chat_id=web`],
        ['get', `${A}/sessions/${bad}/info?chat_id=web`], ['post', `${A}/sessions/${bad}/stop?chat_id=web`],
      ] as const) {
        const res = await request(gw)[method](url).set('Authorization', 'Bearer k-ro').send({});
        expect([method, bad, res.status]).toEqual([method, bad, 400]);
      }
    }
  });

  it('an admin key gets 400 on a malformed id and the binding survives', async () => {
    for (const bad of ESCAPES(bound)) {
      const res = await request(gw).delete(`${A}/sessions/${bad}?chat_id=web`).set('Authorization', 'Bearer k-admin');
      expect([bad, res.status, fs.existsSync(bindingFile())]).toEqual([bad, 400, true]);
    }
  });

  it('the store refuses to read, write or delete a binding for an id outside the strict pattern', async () => {
    const store = new SessionStore(path.join(base, 'agents'));
    const victim = bound;
    for (const bad of ['x/../' + victim, '../' + victim, victim + '/', '..', '.', '', 'a\0b', victim + '.json', 'x\\..\\' + victim, 'a'.repeat(65)]) {
      await expect(store.deleteProjectBinding('alfred', bad)).rejects.toThrow();
      expect(fs.existsSync(bindingFile())).toBe(true);
      expect((await store.loadProjectBinding('alfred', bad)).kind).toBe('unbound');
    }
    await expect(store.deleteProjectBinding('alfred', victim)).resolves.toBeUndefined();
    expect(fs.existsSync(bindingFile())).toBe(false);
  });
});
