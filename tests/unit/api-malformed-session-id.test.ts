import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import type { AgentConfig, GatewayConfig } from '../../src/types';

const A = '/api/v1/agents/alfred';
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const BAD = ['a.b', 'x'.repeat(65), 'a%20b', 'a%2Fb'];

let base: string;
let runner: AgentRunner;
let gw: ReturnType<GatewayRouter['getApp']>;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'malformed-sid-')));
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
  const gateway: GatewayConfig = {
    gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', api: { keys: [{ key: 'k-ro', agents: '*' }] } },
    agents: [cfg],
  };
  runner = new AgentRunner(cfg, gateway);
  gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway).getApp();
});
afterEach(async () => {
  await runner.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

const routes: Array<[string, 'get' | 'post' | 'put' | 'delete', (s: string) => string]> = [
  ['voice replays', 'get', (s) => `${A}/sessions/${s}/voice-sessions/replays`],
  ['voice replay', 'post', (s) => `${A}/sessions/${s}/voice-sessions/replays/${UUID}`],
  ['voice preference', 'put', (s) => `${A}/sessions/${s}/voice-sessions/preference`],
  ['voice session', 'post', (s) => `${A}/sessions/${s}/voice-sessions`],
  ['voice session close', 'delete', (s) => `${A}/sessions/${s}/voice-sessions/${UUID}`],
  ['browser bindings', 'get', (s) => `${A}/sessions/${s}/browser-bindings`],
  ['browser binding create', 'post', (s) => `${A}/sessions/${s}/browser-bindings`],
  ['browser binding delete', 'delete', (s) => `${A}/sessions/${s}/browser-bindings/${UUID}`],
  ['browser evidence', 'get', (s) => `${A}/sessions/${s}/tasks/${UUID}/browser-evidence`],
];

describe('a malformed session id on the voice and browser-binding routes', () => {
  it.each(routes)('%s answers 400 before auth, with no key and with a key', async (_n, method, url) => {
    for (const bad of BAD) {
      for (const auth of [undefined, 'Bearer k-ro']) {
        const req = request(gw)[method](url(bad));
        const res = await (auth ? req.set('Authorization', auth) : req).send({});
        expect([bad, auth, res.status, res.body.code]).toEqual([bad, auth, 400, 'INVALID_INPUT']);
      }
    }
  });

  it('still lets a well-formed id reach auth', async () => {
    const res = await request(gw).get(`${A}/sessions/${UUID}/voice-sessions/replays`);
    expect(res.status).toBe(401);
  });
});
