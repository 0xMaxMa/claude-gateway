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

// Build an app whose agents-root resolves under `configDir` (via configPath), with
// the given agent ids registered. Lets scope=agent:<id> / sources tests seed real
// per-agent memory dirs in isolation.
function buildAppWithAgents(sharedRoot: string, configDir: string, agentIds: string[]) {
  const gatewayConfig: GatewayConfig = {
    gateway: {
      logDir: '/tmp',
      timezone: 'UTC',
      api: { keys: WITH_KEYS },
      knowledge: { shared: { enabled: true, project: 'test', root: sharedRoot } },
    },
    agents: [],
  } as unknown as GatewayConfig;
  const agents = new Map(agentIds.map((id) => [id, {} as never]));
  const configPath = path.join(configDir, 'config.json');
  const router = new GatewayRouter(agents, new Map<string, AgentConfig>(), undefined, gatewayConfig, undefined, configPath);
  return router.getApp();
}

function seedAgentMemory(configDir: string, id: string, files: Record<string, string>) {
  const memDir = path.join(configDir, 'agents', id, 'workspace', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(memDir, name), body);
}

function seedAgentDreams(configDir: string, id: string, dreamsMd: string, promotions: string) {
  const dir = path.join(configDir, 'agents', id, 'workspace', '.dreaming');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'DREAMS.md'), dreamsMd);
  if (promotions) fs.writeFileSync(path.join(dir, 'promotions.jsonl'), promotions);
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

    it('empty vault + ?demo=300 → synthetic sized demo (demo:true, 300 nodes)', async () => {
      const res = await supertest(buildApp(root)).get('/knowledge/graph?demo=300').set('X-Api-Key', KEY);
      expect(res.body.demo).toBe(true);
      expect(res.body.nodes.length).toBe(300);
      expect(res.body.edges.length).toBeGreaterThan(0);
    });

    it('populated vault ignores ?demo=300 (real notes win)', async () => {
      const notes = path.join(root, 'test', 'notes');
      fs.mkdirSync(notes, { recursive: true });
      fs.writeFileSync(path.join(notes, 'a.md'), `---\ntitle: A\ntype: decision\n---\n[[b]]\n`);
      fs.writeFileSync(path.join(notes, 'b.md'), `---\ntitle: B\ntype: evidence\n---\nbody\n`);
      const res = await supertest(buildApp(root)).get('/knowledge/graph?demo=300').set('X-Api-Key', KEY);
      expect(res.body.demo).toBe(false);
      expect(res.body.nodes.length).toBe(2);
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

  describe('scope=agent (Lane-2 per-agent memory)', () => {
    it('builds the graph from that agent workspace/memory/*.md', async () => {
      seedAgentMemory(root, 'alpha', {
        'x.md': `---\ntitle: X\ntype: decision\n---\nlinks [[y]]\n`,
        'y.md': `---\ntitle: Y\ntype: evidence\n---\nbody\n`,
      });
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app).get('/knowledge/graph?scope=agent:alpha').set('X-Api-Key', KEY);
      expect(res.status).toBe(200);
      expect(res.body.scope).toBe('agent:alpha');
      expect(res.body.demo).toBe(false);
      expect(res.body.nodes.map((n: { id: string }) => n.id).sort()).toEqual(['x.md', 'y.md']);
      expect(res.body.edges).toEqual([{ source: 'x.md', target: 'y.md' }]);
    });

    it('rejects an unknown agent id with 404 (no filesystem access for un-allowlisted ids)', async () => {
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app).get('/knowledge/graph?scope=agent:../../etc').set('X-Api-Key', KEY);
      expect(res.status).toBe(404);
    });

    it('still requires auth', async () => {
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app).get('/knowledge/graph?scope=agent:alpha');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /knowledge/sources', () => {
    it('lists Shared KB plus agents that have memory notes', async () => {
      seedAgentMemory(root, 'alpha', { 'x.md': `---\ntitle: X\n---\n[[y]]\n`, 'y.md': `---\ntitle: Y\n---\nb\n` });
      // beta has an empty memory dir → must be omitted from sources.
      fs.mkdirSync(path.join(root, 'agents', 'beta', 'workspace', 'memory'), { recursive: true });
      const app = buildAppWithAgents(root, root, ['alpha', 'beta']);
      const res = await supertest(app).get('/knowledge/sources').set('X-Api-Key', KEY);
      expect(res.status).toBe(200);
      const ids = res.body.sources.map((s: { id: string }) => s.id);
      expect(ids).toContain('shared');
      expect(ids).toContain('agent:alpha');
      expect(ids).not.toContain('agent:beta');
      const alpha = res.body.sources.find((s: { id: string }) => s.id === 'agent:alpha');
      expect(alpha.count).toBe(2);
    });

    it('requires auth', async () => {
      const res = await supertest(buildApp(root)).get('/knowledge/sources');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /knowledge/note', () => {
    it('returns the full markdown body (frontmatter stripped) for an agent note', async () => {
      seedAgentMemory(root, 'alpha', {
        'x.md': `---\ntitle: X\ntype: project\n---\n# Heading\n\nBody **bold** line.\n`,
      });
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app)
        .get('/knowledge/note?scope=agent:alpha&id=x.md')
        .set('X-Api-Key', KEY);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('x.md');
      expect(res.body.body).toContain('# Heading');
      expect(res.body.body).toContain('Body **bold** line.');
      // Frontmatter must not leak into the rendered body.
      expect(res.body.body).not.toContain('title: X');
      // Header enrichments: an ISO last-modified date + a readable path that ends
      // in the note id (so the panel can show WHERE + WHEN).
      expect(typeof res.body.updated).toBe('string');
      expect(res.body.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof res.body.path).toBe('string');
      expect(res.body.path).toMatch(/x\.md$/);
    });

    it('reads a Shared KB note by default scope', async () => {
      const notes = path.join(root, 'test', 'notes');
      fs.mkdirSync(notes, { recursive: true });
      fs.writeFileSync(path.join(notes, 'n.md'), `---\ntitle: N\n---\nshared body\n`);
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app).get('/knowledge/note?id=notes/n.md').set('X-Api-Key', KEY);
      expect(res.status).toBe(200);
      expect(res.body.body).toContain('shared body');
    });

    it('rejects a traversal id with 400 (never escapes the vault)', async () => {
      // A `.md` id that tries to climb out of the vault — must be blocked by the
      // path-escape guard (not merely the extension check). Seed a real .md file
      // outside the vault so a broken guard would actually leak it.
      fs.writeFileSync(path.join(root, 'secret.md'), `---\ntitle: S\n---\ntop secret\n`);
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app)
        .get('/knowledge/note?scope=agent:alpha&id=' + encodeURIComponent('../../../../secret.md'))
        .set('X-Api-Key', KEY);
      expect(res.status).toBe(400);
      // Also a non-.md traversal is rejected by the extension guard.
      const res2 = await supertest(app)
        .get('/knowledge/note?scope=agent:alpha&id=' + encodeURIComponent('../../../../etc/passwd'))
        .set('X-Api-Key', KEY);
      expect(res2.status).toBe(400);
    });

    it('rejects a non-.md id with 400', async () => {
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app)
        .get('/knowledge/note?scope=agent:alpha&id=x.txt')
        .set('X-Api-Key', KEY);
      expect(res.status).toBe(400);
    });

    it('404s for an unknown agent and for a missing note; requires auth', async () => {
      seedAgentMemory(root, 'alpha', { 'x.md': `---\ntitle: X\n---\nb\n` });
      const app = buildAppWithAgents(root, root, ['alpha']);
      const unknownAgent = await supertest(app)
        .get('/knowledge/note?scope=agent:ghost&id=x.md')
        .set('X-Api-Key', KEY);
      expect(unknownAgent.status).toBe(404);
      const missing = await supertest(app)
        .get('/knowledge/note?scope=agent:alpha&id=nope.md')
        .set('X-Api-Key', KEY);
      expect(missing.status).toBe(404);
      const unauth = await supertest(app).get('/knowledge/note?scope=agent:alpha&id=x.md');
      expect(unauth.status).toBe(401);
    });
  });

  describe('GET /knowledge/dreams', () => {
    const DREAMS = `## 2026-08-17T05:19:23.664Z — proposed (propose)\n\nA summary\n\n- **add** \`MEMORY.md\` [x] — reason _(score 0.85, recall 3)_\n\n_propose mode: proposals logged only — memory not modified._\n\n_tokens: 6351, sessions: 2_\n\n---\n`;
    const PROMOS = JSON.stringify({ ts: Date.parse('2026-08-17T05:19:23.664Z'), mode: 'propose', op: 'add', file: 'MEMORY.md', target: 'x', content: 'body', reason: 'reason', score: 0.85, recallCount: 3 });

    it('returns parsed runs per agent, newest first', async () => {
      seedAgentDreams(root, 'alpha', DREAMS, PROMOS);
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app).get('/knowledge/dreams').set('X-Api-Key', KEY);
      expect(res.status).toBe(200);
      expect(res.body.agents).toContain('alpha');
      expect(res.body.runs.length).toBe(1);
      const run = res.body.runs[0];
      expect(run.agent).toBe('alpha');
      expect(run.mode).toBe('propose');
      expect(run.tokens).toBe(6351);
      expect(run.proposals[0]).toMatchObject({ op: 'add', file: 'MEMORY.md', content: 'body' });
    });

    it('omits agents that have never dreamed and requires auth', async () => {
      const app = buildAppWithAgents(root, root, ['alpha']); // no .dreaming seeded
      const ok = await supertest(app).get('/knowledge/dreams').set('X-Api-Key', KEY);
      expect(ok.status).toBe(200);
      expect(ok.body.runs).toEqual([]);
      expect(ok.body.agents).toEqual([]);
      const unauth = await supertest(app).get('/knowledge/dreams');
      expect(unauth.status).toBe(401);
    });
  });

  describe('POST /knowledge/dreams/apply', () => {
    const TS = 1_700_000_000_000;
    const PROMOS = JSON.stringify({
      ts: TS, mode: 'propose', op: 'add', file: 'MEMORY.md',
      content: '- accepted from dashboard', reason: 'durable', score: 0.9, recallCount: 3,
    }) + '\n';
    const DREAMS = `## ${new Date(TS).toISOString()} — proposed (propose)\n\nA run\n\n- **add** \`MEMORY.md\` — durable _(score 0.90, recall 3)_\n\n_propose mode: proposals logged only — memory not modified._\n\n_tokens: 100, sessions: 1_\n\n---\n`;

    function seedMemory(id: string, body: string): void {
      const wsDir = path.join(root, 'agents', id, 'workspace');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'MEMORY.md'), body);
    }

    it('requires auth (401 without a credential)', async () => {
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app).post('/knowledge/dreams/apply').send({ agentId: 'alpha', ts: TS });
      expect(res.status).toBe(401);
    });

    it('404 for an unknown agent (also guards path traversal)', async () => {
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app).post('/knowledge/dreams/apply')
        .set('X-Api-Key', KEY).send({ agentId: '../../etc', ts: TS });
      expect(res.status).toBe(404);
    });

    it('400 when ts is not a finite number', async () => {
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app).post('/knowledge/dreams/apply')
        .set('X-Api-Key', KEY).send({ agentId: 'alpha', ts: 'soon' });
      expect(res.status).toBe(400);
    });

    it('400 when indexes is not an array of non-negative integers', async () => {
      const app = buildAppWithAgents(root, root, ['alpha']);
      const res = await supertest(app).post('/knowledge/dreams/apply')
        .set('X-Api-Key', KEY).send({ agentId: 'alpha', ts: TS, indexes: [-1] });
      expect(res.status).toBe(400);
    });

    it('applies a proposal to MEMORY.md and marks it accepted in the report', async () => {
      seedMemory('alpha', '# Memory\n\n- existing\n');
      seedAgentDreams(root, 'alpha', DREAMS, PROMOS);
      const app = buildAppWithAgents(root, root, ['alpha']);

      const res = await supertest(app).post('/knowledge/dreams/apply')
        .set('X-Api-Key', KEY).send({ agentId: 'alpha', ts: TS, indexes: [0] });
      expect(res.status).toBe(200);
      expect(res.body.applied).toBe(1);

      const mem = fs.readFileSync(path.join(root, 'agents', 'alpha', 'workspace', 'MEMORY.md'), 'utf8');
      expect(mem).toContain('accepted from dashboard');

      // The report now reflects the accepted proposal.
      const report = await supertest(app).get('/knowledge/dreams').set('X-Api-Key', KEY);
      const run = report.body.runs.find((r: { ts: number }) => r.ts === TS);
      expect(run.proposals[0].accepted).toBe(true);
    });

    it('is idempotent — re-accepting reports alreadyAccepted and does not double-write', async () => {
      seedMemory('alpha', '# Memory\n');
      seedAgentDreams(root, 'alpha', DREAMS, PROMOS);
      const app = buildAppWithAgents(root, root, ['alpha']);

      await supertest(app).post('/knowledge/dreams/apply').set('X-Api-Key', KEY).send({ agentId: 'alpha', ts: TS });
      const res2 = await supertest(app).post('/knowledge/dreams/apply').set('X-Api-Key', KEY).send({ agentId: 'alpha', ts: TS });
      expect(res2.status).toBe(200);
      expect(res2.body.applied).toBe(0);
      expect(res2.body.alreadyAccepted).toBe(1);

      const mem = fs.readFileSync(path.join(root, 'agents', 'alpha', 'workspace', 'MEMORY.md'), 'utf8');
      expect((mem.match(/accepted from dashboard/g) || []).length).toBe(1);
    });
  });
});
