import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podRead: { key: 'k-ro', agents: '*' },
  podWrite: { key: 'k-pw', agents: '*', write: true },
  scoped: { key: 'k-sc', agents: ['alfred'], write: true },
} satisfies Record<string, ApiKey>;
const A = '/api/v1/agents/alfred';

let base: string;
let runner: AgentRunner;
let server: http.Server;
let port: number;
let bound: string;
let plain: string;

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-gate-')));
  fs.mkdirSync(path.join(base, 'projects', 'site'), { recursive: true });
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
  const gateway: GatewayConfig = {
    gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) }, projects: { root: path.join(base, 'projects') } },
    agents: [cfg],
  };
  runner = new AgentRunner(cfg, gateway);
  const gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway).getApp();
  server = gw.listen(0);
  port = (server.address() as AddressInfo).port;
  const open = async (body: object) => (await request(gw).post(`${A}/sessions`).query({ chat_id: 'web' }).set('Authorization', 'Bearer k-admin').send(body)).body.sessionId as string;
  bound = await open({ project: 'site' });
  plain = await open({});
  for (const id of [bound, plain]) {
    fs.mkdirSync(path.join(base, 'agents', 'alfred', 'media', `api-${id}`), { recursive: true });
    fs.writeFileSync(path.join(base, 'agents', 'alfred', 'media', `api-${id}`, 'f.png'), id === bound ? 'BOUND-PIXELS' : 'PLAIN-PIXELS');
  }
  fs.mkdirSync(path.join(base, 'agents', 'alfred', 'media', 'ui-upload'), { recursive: true });
});
afterEach(async () => {
  server.closeAllConnections();
  server.close();
  await runner.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

/** Raw request line, so nothing normalizes the path on the client side. */
function get(rawPath: string, key: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: rawPath, headers: { Authorization: `Bearer ${key}` } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    }).on('error', reject);
  });
}

const variants = (id: string) => [
  `api-${id}/f.png`, `media/api-${id}/f.png`, `./api-${id}/f.png`, `x/../api-${id}/f.png`, `%2e/api-${id}/f.png`,
  `%2e%2e/media/api-${id}/f.png`, `ui-upload/../api-${id}/f.png`, `ui-upload/%2e%2e/api-${id}/f.png`, `/api-${id}/f.png`, `//api-${id}//f.png`,
  `api-${id}/./f.png`, `api-${id}/x/../f.png`, `media/./api-${id}/f.png`, `API-${id}/f.png`, `api-${id}/f.png/`, `%61pi-${id}/f.png`,
  `api-${id}%2ff.png`, `ui-upload/%2e%2e%2fapi-${id}/f.png`, `api-${id}%00/f.png`,
];

describe('GET /media is gated on the normalized path', () => {
  it.each(Object.values(KEYS).filter((k) => !(k as ApiKey).admin))('$key never returns a bound session file, however the path is spelled', async (key) => {
    for (const v of variants(bound)) {
      const res = await get(`${A}/media/${v}`, key.key);
      expect([v, res.status === 200, res.body.includes('BOUND-PIXELS')]).toEqual([v, false, false]);
    }
  });

  it.each(Object.values(KEYS).filter((k) => !(k as ApiKey).admin))('$key still reads an unbound session file through the same spellings', async (key) => {
    for (const v of [`api-${plain}/f.png`, `media/api-${plain}/f.png`, `./api-${plain}/f.png`, `x/../api-${plain}/f.png`, `%2e/api-${plain}/f.png`]) {
      const res = await get(`${A}/media/${v}`, key.key);
      expect([v, res.status, res.body]).toEqual([v, 200, 'PLAIN-PIXELS']);
    }
  });

  it('an admin key reads the bound session file by the literal and the dotted path', async () => {
    for (const v of [`api-${bound}/f.png`, `./api-${bound}/f.png`]) {
      expect([v, (await get(`${A}/media/${v}`, 'k-admin')).body]).toEqual([v, 'BOUND-PIXELS']);
    }
  });
});
