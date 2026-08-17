/**
 * GET /knowledge/graph — the dashboard "Knowledge base" tab data source.
 * Verifies: dashboard auth (401 without a credential, 401 for a non-admin key,
 * 200 for an admin key), the on-demand model shape, the labelled demo fallback
 * for an empty vault, ?demo=off returning the real (empty) model, and a populated
 * vault returning real nodes/edges. Exercises the real Express app via supertest.
 */
import supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentConfig, GatewayConfig, ApiKey } from '../../src/types';

const KEY = 'sk-gateway-test-000000';
const NON_ADMIN_KEY = 'sk-gateway-scoped-00000';
const WITH_KEYS: ApiKey[] = [
  { key: KEY, description: 'admin', agents: '*', admin: true },
  { key: NON_ADMIN_KEY, description: 'scoped', agents: ['some-agent'] },
];

function buildApp(sharedRoot: string) {
  const gatewayConfig: GatewayConfig = {
    gateway: {
      logDir: '/tmp',
      timezone: 'UTC',
      api: { keys: WITH_KEYS },
      knowledge: { shared: { enabled: true, project: 'test', root: sharedRoot } },
    },
    agents: [],
  } as unknown as GatewayConfig;
  const router = new GatewayRouter(new Map(), new Map<string, AgentConfig>(), undefined, gatewayConfig);
  return router.getApp();
}

describe('GET /knowledge/graph', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-graph-ep-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('auth', () => {
    it('→ 401 without any credential', async () => {
      const res = await supertest(buildApp(root)).get('/knowledge/graph');
      expect(res.status).toBe(401);
    });
    it('→ 401 with a valid NON-admin key', async () => {
      const res = await supertest(buildApp(root)).get('/knowledge/graph').set('X-Api-Key', NON_ADMIN_KEY);
      expect(res.status).toBe(401);
    });
    it('→ 401 with a wrong key', async () => {
      const res = await supertest(buildApp(root)).get('/knowledge/graph').set('X-Api-Key', 'nope');
      expect(res.status).toBe(401);
    });
    it('→ 200 with an admin key', async () => {
      const res = await supertest(buildApp(root)).get('/knowledge/graph').set('X-Api-Key', KEY);
      expect(res.status).toBe(200);
    });
  });

  describe('payload', () => {
    it('empty vault → labelled demo dataset (demo:true, non-empty nodes)', async () => {
      const res = await supertest(buildApp(root)).get('/knowledge/graph').set('X-Api-Key', KEY);
      expect(res.body.demo).toBe(true);
      expect(Array.isArray(res.body.nodes)).toBe(true);
      expect(res.body.nodes.length).toBeGreaterThan(0);
      expect(Array.isArray(res.body.edges)).toBe(true);
    });

    it('empty vault + ?demo=off → real empty model (demo:false, no nodes)', async () => {
      const res = await supertest(buildApp(root)).get('/knowledge/graph?demo=off').set('X-Api-Key', KEY);
      expect(res.body.demo).toBe(false);
      expect(res.body.nodes).toEqual([]);
      expect(res.body.edges).toEqual([]);
    });

    it('empty vault + repeated ?demo=off (array query) still disables the demo', async () => {
      // Express parses ?demo=off&demo=off into an array — the off-switch must
      // still register (regression for the strict `!== "off"` scalar check).
      const res = await supertest(buildApp(root)).get('/knowledge/graph?demo=off&demo=off').set('X-Api-Key', KEY);
      expect(res.body.demo).toBe(false);
      expect(res.body.nodes).toEqual([]);
    });

    it('populated vault → real nodes/edges (demo:false)', async () => {
      const notes = path.join(root, 'test', 'notes');
      fs.mkdirSync(notes, { recursive: true });
      fs.writeFileSync(path.join(notes, 'a.md'), `---\ntitle: A\ntype: decision\n---\n[[b]]\n`);
      fs.writeFileSync(path.join(notes, 'b.md'), `---\ntitle: B\ntype: evidence\n---\nbody\n`);
      const res = await supertest(buildApp(root)).get('/knowledge/graph').set('X-Api-Key', KEY);
      expect(res.body.demo).toBe(false);
      expect(res.body.nodes.map((n: { id: string }) => n.id).sort()).toEqual(['notes/a.md', 'notes/b.md']);
      expect(res.body.edges).toEqual([{ source: 'notes/a.md', target: 'notes/b.md' }]);
    });
  });
});
