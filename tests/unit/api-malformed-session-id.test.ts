import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const A = '/api/v1/agents/alfred';
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  ro: { key: 'k-ro', agents: ['alfred'] },
  writer: { key: 'k-w', agents: ['alfred'], write: true },
} satisfies Record<string, ApiKey>;

// From agents/alfred/sessions/api-web/, four `..` reach the temp root, which holds victim.json and config.json.
const HOSTILE = {
  dotdot_victim: '..%2F..%2F..%2F..%2Fvictim',
  dotdot_config: '..%2F..%2F..%2F..%2Fconfig',
  dotdot_canary: '..%2F..%2Fcanary',
  dot_upper: '%2E%2E%2F%2E%2E%2Fcanary',
  dot_lower: '%2e%2e%2f%2e%2e%2fcanary',
  backslash: '..%5C..%5Ccanary',
  dots: '..',
  dots_enc: '%2E%2E',
  nul: 'a%00b',
  nul_dotdot: '..%2F..%2Fcanary%00',
  abs: '%2Fetc%2Fpasswd',
  slash: 'a%2Fb',
  dot: 'a.b',
  space: 'a%20b',
  long65: 'x'.repeat(65),
  long5000: 'y'.repeat(5000),
  unicode: encodeURIComponent('ünï-çødé'),
  rtl: '%E2%80%AEabc',
};

let base: string;
let runner: AgentRunner;
let gw: ReturnType<GatewayRouter['getApp']>;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'malformed-sid-')));
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(base, 'projects', 'site'), { recursive: true });
  const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
  const gateway: GatewayConfig = {
    gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) }, projects: { root: path.join(base, 'projects') } },
    agents: [cfg],
  };
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify(gateway));
  runner = new AgentRunner(cfg, gateway);
  gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway, undefined, path.join(base, 'config.json')).getApp();
});
afterEach(async () => {
  await runner.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

const as = (req: request.Test, key?: ApiKey) => (key ? req.set('Authorization', `Bearer ${key.key}`) : req);
const create = async (body: object = {}) => {
  const res = await as(request(gw).post(`${A}/sessions?chat_id=web`), KEYS.admin).send(body);
  expect(res.status).toBe(201);
  return res.body.sessionId as string;
};
/** Every file under the temp root with a content hash, leaving out the history database and logs. */
const snapshot = () => {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'logs') walk(p); }
      else if (!/\.(db|db-wal|db-shm|sqlite)$/.test(e.name)) files.set(path.relative(base, p), crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(base);
  return files;
};

describe('a malformed session id on the session routes', () => {
  let server: http.Server;
  /** Sends the path byte for byte, as `curl --path-as-is` does; supertest's URL parser would fold `%2E%2E` away. */
  const raw = (method: string, p: string, key?: ApiKey, body?: object) => new Promise<{ status: number; code?: string }>((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (key) headers.Authorization = `Bearer ${key.key}`;
    const { port } = server.address() as { port: number };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let code: string | undefined;
        try { code = (JSON.parse(text) as { code?: string }).code; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, code });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });

  beforeEach(async () => {
    await create();
    await create();
    const alfred = path.join(base, 'agents', 'alfred');
    fs.writeFileSync(path.join(base, 'victim.json'), 'victim');
    fs.writeFileSync(path.join(alfred, 'canary.json'), 'canary');
    fs.writeFileSync(path.join(alfred, 'sessions', 'canary.json'), 'canary');
    server = gw.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); });

  it.each([['read-only', KEYS.ro], ['writer', KEYS.writer]])(
    'a %s key gets 400 on PATCH, then DELETE and clear of the same id, and no file changes',
    async (_n, key) => {
      const before = snapshot();
      for (const [name, id] of Object.entries(HOSTILE)) {
        const url = `${A}/sessions/${id}?chat_id=web`;
        const patch = await raw('PATCH', url, key, { session_name: 'x' });
        const del = await raw('DELETE', url, key);
        const clear = await raw('POST', `${A}/sessions/${id}/clear?chat_id=web`, key);
        expect([name, patch, del, clear]).toEqual([name, ...Array(3).fill({ status: 400, code: 'INVALID_INPUT' })]);
      }
      expect(snapshot()).toEqual(before);
      expect(fs.readFileSync(path.join(base, 'config.json'), 'utf8')).toContain('"alfred"');
    },
  );

  it('answers 400 before auth, with no key', async () => {
    for (const [name, id] of Object.entries(HOSTILE)) {
      expect([name, await raw('DELETE', `${A}/sessions/${id}?chat_id=web`)]).toEqual([name, { status: 400, code: 'INVALID_INPUT' }]);
    }
  });
});

describe('a well-formed session id', () => {
  // A client may name its own session: a UUID, a cron job's `cron-<id>`, or any 1 to 64 of [A-Za-z0-9_-].
  const CLIENT_IDS = [UUID, `cron-${UUID}`, 'my_session-1', 'A', 'z'.repeat(64)];

  it.each([['read-only', KEYS.ro], ['writer', KEYS.writer]])('a %s key renames and deletes a client-named session', async (_n, key) => {
    await create();
    for (const id of CLIENT_IDS) {
      const patch = await as(request(gw).patch(`${A}/sessions/${id}?chat_id=web`), key).send({ session_name: 'named' });
      expect([id, patch.status, patch.body.sessionId]).toEqual([id, 200, id]);
      const del = await as(request(gw).delete(`${A}/sessions/${id}?chat_id=web`), key);
      expect([id, del.status]).toEqual([id, 204]);
    }
  });

  it('a project chat and a plain chat answer alike on info, rename and delete', async () => {
    const plain = await create();
    const bound = await create({ project: 'site' });
    for (const key of [KEYS.ro, KEYS.writer]) {
      const answers = await Promise.all([plain, bound].map(async (id) => {
        const info = await as(request(gw).get(`${A}/sessions/${id}/info?chat_id=web`), key);
        const patch = await as(request(gw).patch(`${A}/sessions/${id}?chat_id=web`), key).send({ session_name: 'renamed' });
        return [info.status, patch.status, patch.body.sessionName];
      }));
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[0]).toEqual([200, 200, 'renamed']);
    }
    for (const id of [plain, bound]) expect((await as(request(gw).delete(`${A}/sessions/${id}?chat_id=web`), KEYS.writer)).status).toBe(204);
  });
});

const voiceAndBrowserRoutes: Array<[string, 'get' | 'post' | 'put' | 'delete', (s: string) => string]> = [
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
  const BAD = [HOSTILE.dot, HOSTILE.long65, HOSTILE.space, HOSTILE.slash, HOSTILE.dotdot_canary, HOSTILE.nul];
  it.each(voiceAndBrowserRoutes)('%s answers 400 before auth, with no key and with a key', async (_n, method, url) => {
    for (const bad of BAD) {
      for (const key of [undefined, KEYS.ro]) {
        const res = await as(request(gw)[method](url(bad)), key).send({});
        expect([bad, key?.key, res.status, res.body.code]).toEqual([bad, key?.key, 400, 'INVALID_INPUT']);
      }
    }
  });

  it('still lets a well-formed id reach auth', async () => {
    const res = await request(gw).get(`${A}/sessions/${UUID}/voice-sessions/replays`);
    expect(res.status).toBe(401);
  });
});
