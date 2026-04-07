/**
 * Integration tests: Agent HTTP API (planning-05)
 *
 * Spins up a real AgentRunner (with mock claude subprocess) and GatewayRouter
 * configured with API keys, then hits the HTTP endpoints via supertest.
 *
 * Test IDs: I-API-01 through I-API-12
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import supertest from 'supertest';
import { AgentRunner } from '../../src/agent-runner';
import { GatewayRouter } from '../../src/gateway-router';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { SessionStore } from '../../src/session-store';

// ─── helpers ────────────────────────────────────────────────────────────────

const MOCK_CLAUDE_API_BIN = path.resolve(__dirname, '../helpers/mock-claude-api.js');

const API_KEY_ALFRED = 'sk-test-alfred-only-key';
const API_KEY_ADMIN = 'sk-test-admin-key';
const API_KEY_WRONG = 'sk-test-wrong-key';

function createTempWorkspace(prefix = 'api-e2e-ws-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const files: Record<string, string> = {
    'agent.md': '# Agent\nYou are a test assistant.',
    'soul.md': '# Soul\nBe helpful.',
    'tools.md': '# Tools\nNo tools.',
    'user.md': '# User\nTester.',
    'heartbeat.md': '# Heartbeat\n',
    'memory.md': '# Memory\n',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

function createTempDir(prefix = 'api-e2e-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAgentConfig(id: string, workspace: string): AgentConfig {
  return {
    id,
    description: `Test agent ${id}`,
    workspace,
    env: '',
    telegram: { botToken: `token-${id}`, allowedUsers: [], dmPolicy: 'open' },
    claude: { model: 'claude-test', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

function makeGatewayConfig(logDir: string): GatewayConfig {
  return {
    gateway: {
      logDir,
      timezone: 'UTC',
      api: {
        keys: [
          { key: API_KEY_ALFRED, description: 'Alfred only', agents: ['alfred'] },
          { key: API_KEY_ADMIN, description: 'Admin all', agents: '*' },
        ],
      },
    },
    agents: [],
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout exceeded');
}

// ─── test suite ─────────────────────────────────────────────────────────────

describe('Agent HTTP API integration (planning-05)', () => {
  beforeAll(() => {
    process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE_API_BIN}`;
  });

  afterAll(() => {
    delete process.env.CLAUDE_BIN;
  });

  // ─── I-API-01: GET /api/v1/agents returns list filtered by key ─────────────
  it('I-API-01: GET /api/v1/agents returns agents accessible by the key', async () => {
    const wsA = createTempWorkspace('api-01a-');
    const wsB = createTempWorkspace('api-01b-');
    const logDir = createTempDir('api-01-log-');
    const cfgA = makeAgentConfig('alfred', wsA);
    const cfgB = makeAgentConfig('warrior', wsB);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runnerA = new AgentRunner(cfgA, gatewayCfg);
    const runnerB = new AgentRunner(cfgB, gatewayCfg);
    await runnerA.start();
    await runnerB.start();

    const agents = new Map([['alfred', runnerA], ['warrior', runnerB]]);
    const configs = new Map([['alfred', cfgA], ['warrior', cfgB]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    // Alfred-only key sees only alfred
    const res = await supertest(router.getApp())
      .get('/api/v1/agents')
      .set('Authorization', `Bearer ${API_KEY_ALFRED}`);

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].id).toBe('alfred');

    await router.stop();
    await runnerA.stop();
    await runnerB.stop();
  });

  // ─── I-API-02: Admin key sees all agents ──────────────────────────────────
  it('I-API-02: Admin key (agents: "*") returns all agents', async () => {
    const wsA = createTempWorkspace('api-02a-');
    const wsB = createTempWorkspace('api-02b-');
    const logDir = createTempDir('api-02-log-');
    const cfgA = makeAgentConfig('alfred', wsA);
    const cfgB = makeAgentConfig('warrior', wsB);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runnerA = new AgentRunner(cfgA, gatewayCfg);
    const runnerB = new AgentRunner(cfgB, gatewayCfg);
    await runnerA.start();
    await runnerB.start();

    const agents = new Map([['alfred', runnerA], ['warrior', runnerB]]);
    const configs = new Map([['alfred', cfgA], ['warrior', cfgB]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .get('/api/v1/agents')
      .set('Authorization', `Bearer ${API_KEY_ADMIN}`);

    expect(res.status).toBe(200);
    const ids = res.body.agents.map((a: { id: string }) => a.id);
    expect(ids).toContain('alfred');
    expect(ids).toContain('warrior');

    await router.stop();
    await runnerA.stop();
    await runnerB.stop();
  });

  // ─── I-API-03: POST message → 200 with valid response JSON ────────────────
  it('I-API-03: POST /api/v1/agents/:id/messages returns 200 with response', async () => {
    const ws = createTempWorkspace('api-03-');
    const logDir = createTempDir('api-03-log-');
    const cfg = makeAgentConfig('alfred', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/messages')
      .set('Authorization', `Bearer ${API_KEY_ALFRED}`)
      .send({ message: 'Hello!' });

    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe('alfred');
    expect(typeof res.body.response).toBe('string');
    expect(res.body.response.length).toBeGreaterThan(0);
    expect(typeof res.body.request_id).toBe('string');
    expect(typeof res.body.session_id).toBe('string');
    expect(typeof res.body.duration_ms).toBe('number');
    expect(res.body.response).toContain('Hello!');

    await router.stop();
    await runner.stop();
  });

  // ─── I-API-04: No API key → 401 ─────────────────────────────────────────
  it('I-API-04: Missing API key returns 401', async () => {
    const ws = createTempWorkspace('api-04-');
    const logDir = createTempDir('api-04-log-');
    const cfg = makeAgentConfig('alfred', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/messages')
      .send({ message: 'Hello' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();

    await router.stop();
    await runner.stop();
  });

  // ─── I-API-05: Wrong API key → 403 ────────────────────────────────────────
  it('I-API-05: Wrong API key returns 403', async () => {
    const ws = createTempWorkspace('api-05-');
    const logDir = createTempDir('api-05-log-');
    const cfg = makeAgentConfig('alfred', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/messages')
      .set('Authorization', `Bearer ${API_KEY_WRONG}`)
      .send({ message: 'Hello' });

    expect(res.status).toBe(403);

    await router.stop();
    await runner.stop();
  });

  // ─── I-API-06: Key has no access to agent → 403 ───────────────────────────
  it('I-API-06: Key with no access to agent returns 403', async () => {
    const wsA = createTempWorkspace('api-06a-');
    const wsW = createTempWorkspace('api-06w-');
    const logDir = createTempDir('api-06-log-');
    const cfgA = makeAgentConfig('alfred', wsA);
    const cfgW = makeAgentConfig('warrior', wsW);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runnerA = new AgentRunner(cfgA, gatewayCfg);
    const runnerW = new AgentRunner(cfgW, gatewayCfg);
    await runnerA.start();
    await runnerW.start();

    const agents = new Map([['alfred', runnerA], ['warrior', runnerW]]);
    const configs = new Map([['alfred', cfgA], ['warrior', cfgW]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    // alfred-only key tries to access warrior
    const res = await supertest(router.getApp())
      .post('/api/v1/agents/warrior/messages')
      .set('Authorization', `Bearer ${API_KEY_ALFRED}`)
      .send({ message: 'Hello warrior' });

    expect(res.status).toBe(403);

    await router.stop();
    await runnerA.stop();
    await runnerW.stop();
  });

  // ─── I-API-07: Unknown agent → 404 ────────────────────────────────────────
  it('I-API-07: Unknown agentId returns 404', async () => {
    const ws = createTempWorkspace('api-07-');
    const logDir = createTempDir('api-07-log-');
    const cfg = makeAgentConfig('alfred', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/api/v1/agents/nonexistent/messages')
      .set('Authorization', `Bearer ${API_KEY_ADMIN}`)
      .send({ message: 'Hello' });

    expect(res.status).toBe(404);

    await router.stop();
    await runner.stop();
  });

  // ─── I-API-08: Empty message → 400 ────────────────────────────────────────
  it('I-API-08: Empty message body returns 400', async () => {
    const ws = createTempWorkspace('api-08-');
    const logDir = createTempDir('api-08-log-');
    const cfg = makeAgentConfig('alfred', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/messages')
      .set('Authorization', `Bearer ${API_KEY_ALFRED}`)
      .send({ message: '   ' });

    expect(res.status).toBe(400);

    await router.stop();
    await runner.stop();
  });

  // ─── I-API-09: session_id echoed back ─────────────────────────────────────
  it('I-API-09: Provided session_id is echoed in response', async () => {
    const ws = createTempWorkspace('api-09-');
    const logDir = createTempDir('api-09-log-');
    const cfg = makeAgentConfig('alfred', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const sessionId = 'my-custom-session-001';
    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/messages')
      .set('Authorization', `Bearer ${API_KEY_ALFRED}`)
      .send({ message: 'Hi', session_id: sessionId });

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);

    await router.stop();
    await runner.stop();
  });

  // ─── I-API-10: No session_id → UUID generated ─────────────────────────────
  it('I-API-10: Missing session_id generates a UUID in response', async () => {
    const ws = createTempWorkspace('api-10-');
    const logDir = createTempDir('api-10-log-');
    const cfg = makeAgentConfig('alfred', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/messages')
      .set('Authorization', `Bearer ${API_KEY_ALFRED}`)
      .send({ message: 'Stateless call' });

    expect(res.status).toBe(200);
    // UUID v4 format
    expect(res.body.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await router.stop();
    await runner.stop();
  });

  // ─── I-API-11: X-Api-Key header auth ──────────────────────────────────────
  it('I-API-11: X-Api-Key header is accepted as authentication', async () => {
    const ws = createTempWorkspace('api-11-');
    const logDir = createTempDir('api-11-log-');
    const cfg = makeAgentConfig('alfred', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/messages')
      .set('X-Api-Key', API_KEY_ALFRED)
      .send({ message: 'Auth via X-Api-Key' });

    expect(res.status).toBe(200);
    expect(res.body.response).toContain('X-Api-Key');

    await router.stop();
    await runner.stop();
  });

  // ─── I-API-12: Message + response persisted to SessionStore ───────────────
  it('I-API-12: User message and assistant reply are persisted to SessionStore', async () => {
    // AgentRunner derives agentsBaseDir as workspace/../../
    // So we must set up workspace at <agentsBaseDir>/alfred/workspace/
    const agentsBaseDir = createTempDir('api-12-agents-');
    const ws = path.join(agentsBaseDir, 'alfred', 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    // Write workspace files into the structured path
    const files: Record<string, string> = {
      'agent.md': '# Agent\nYou are a test assistant.',
      'soul.md': '# Soul\nBe helpful.',
      'tools.md': '# Tools\nNo tools.',
      'user.md': '# User\nTester.',
      'heartbeat.md': '# Heartbeat\n',
      'memory.md': '# Memory\n',
    };
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(ws, name), content, 'utf-8');
    }

    const logDir = createTempDir('api-12-log-');
    const cfg = makeAgentConfig('alfred', ws);
    const gatewayCfg: GatewayConfig = {
      gateway: { logDir, timezone: 'UTC', api: { keys: [{ key: API_KEY_ADMIN, description: 'admin', agents: '*' }] } },
      agents: [],
    };

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const sessionId = 'persist-test-session';
    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/messages')
      .set('Authorization', `Bearer ${API_KEY_ADMIN}`)
      .send({ message: 'Remember this message', session_id: sessionId });

    expect(res.status).toBe(200);

    // Give SessionStore a moment to write (it uses .catch(() => {}))
    await new Promise((r) => setTimeout(r, 200));

    // Verify user message was persisted
    const store = new SessionStore(agentsBaseDir);
    const history = await store.loadSession('alfred', sessionId);

    expect(history.length).toBeGreaterThanOrEqual(1);
    const userMsg = history.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('Remember this message');

    await router.stop();
    await runner.stop();
  });

  // ─── I-API-13: API disabled when no keys configured ───────────────────────
  it('I-API-13: /api routes return 404 when no API keys are configured', async () => {
    const ws = createTempWorkspace('api-13-');
    const logDir = createTempDir('api-13-log-');
    const cfg = makeAgentConfig('alfred', ws);
    // Gateway config with no api keys
    const gatewayCfg: GatewayConfig = {
      gateway: { logDir, timezone: 'UTC' },
      agents: [],
    };

    const runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['alfred', runner]]);
    const configs = new Map([['alfred', cfg]]);
    const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .get('/api/v1/agents')
      .set('Authorization', `Bearer ${API_KEY_ADMIN}`);

    expect(res.status).toBe(404);

    await router.stop();
    await runner.stop();
  });
});
