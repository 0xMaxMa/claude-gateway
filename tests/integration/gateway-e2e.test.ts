/**
 * Integration tests: Gateway E2E flow (fully mocked, Option A architecture).
 *
 * Architecture: claude --channels handles Telegram directly (long polling).
 * GatewayRouter provides monitoring endpoints only — no webhook message routing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import supertest from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { loadWorkspace } from '../../src/agent/workspace-loader';

// ─── helpers ────────────────────────────────────────────────────────────────

const MOCK_CLAUDE_BIN = path.resolve(__dirname, '../helpers/mock-claude.js');

/** Create a workspace directory with all required .md files. */
function createTempWorkspace(prefix = 'gw-test-ws-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const files: Record<string, string> = {
    'AGENTS.md': '# Agent\nYou are a test assistant.',
    'SOUL.md': '# Soul\nBe helpful.',
    'USER.md': '# User\nTester.',
    'HEARTBEAT.md': '# Heartbeat\n',
    'MEMORY.md': '# Memory\n',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

function createTempDir(prefix = 'gw-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAgentConfig(
  id: string,
  botToken: string,
  workspace: string,
): AgentConfig {
  return {
    id,
    description: `Test agent ${id}`,
    workspace,
    env: '',
    telegram: { botToken },
    claude: { model: 'claude-test', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

function makeGatewayConfig(logDir: string, apiKeys: import('../../src/types').ApiKey[] = []): GatewayConfig {
  return {
    gateway: { logDir, timezone: 'UTC', ...(apiKeys.length ? { api: { keys: apiKeys } } : {}) },
    agents: [],
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
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

describe('Gateway E2E (Option A — monitoring only)', () => {
  beforeAll(() => {
    process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE_BIN}`;
  });

  afterAll(() => {
    delete process.env.CLAUDE_BIN;
  });

  // ─── I-E2E-01 ─────────────────────────────────────────────────────────────
  it('I-E2E-01: Gateway starts and /health responds ok', async () => {
    const workspace = createTempWorkspace('e2e-01-');
    const logDir = createTempDir('e2e-01-log-');
    const agentCfg = makeAgentConfig('agent-01', 'token-agent-01', workspace);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['agent-01', runner]]);
    const configs = new Map([['agent-01', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    const res = await supertest(router.getApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    // /health is intentionally minimal (no agent ids leaked); agent listing moved
    // to /status, which is open here because no API keys are configured.
    const statusRes = await supertest(router.getApp()).get('/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.agents.map((a: { id: string }) => a.id)).toContain('agent-01');

    await router.stop();
    await runner.stop();
  });

  // ─── I-E2E-02 (Option A) ──────────────────────────────────────────────────
  // Webhook route removed — Claude handles Telegram via --channels long polling.
  it('I-E2E-02: POST /webhook returns 404 (webhook route removed in Option A)', async () => {
    const workspace = createTempWorkspace('e2e-02-');
    const logDir = createTempDir('e2e-02-log-');
    const agentCfg = makeAgentConfig('agent-02', 'token-agent-02', workspace);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['agent-02', runner]]);
    const configs = new Map([['agent-02', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/webhook/token-agent-02')
      .send({ update_id: 1, message: { text: 'hi' } });

    expect(res.status).toBe(404);

    await router.stop();
    await runner.stop();
  });

  // ─── I-E2E-03 ─────────────────────────────────────────────────────────────
  it('I-E2E-03: POST /webhook with any token returns 404 (all webhook routes removed)', async () => {
    const workspace = createTempWorkspace('e2e-03-');
    const logDir = createTempDir('e2e-03-log-');
    const agentCfg = makeAgentConfig('agent-03', 'token-agent-03', workspace);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['agent-03', runner]]);
    const configs = new Map([['agent-03', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/webhook/totally-wrong-token')
      .send({ update_id: 1 });

    expect(res.status).toBe(404);

    await router.stop();
    await runner.stop();
  });

  // ─── I-E2E-04: CLAUDE.md injection ────────────────────────────────────────
  it('I-E2E-04: loadWorkspace assembles system prompt with all sections', async () => {
    const workspace = createTempWorkspace('e2e-04-');

    const loaded = await loadWorkspace(workspace);

    expect(loaded.systemPrompt).toContain('--- AGENT IDENTITY ---');
    expect(loaded.systemPrompt).toContain('You are a test assistant.');
    expect(loaded.systemPrompt).toContain('--- SOUL ---');
    expect(loaded.systemPrompt).toContain('Be helpful.');
    expect(loaded.systemPrompt).toContain('--- USER PROFILE ---');
    expect(loaded.systemPrompt).toContain('Tester.');
    expect(loaded.systemPrompt).toContain('--- LONG-TERM MEMORY ---');
    expect(loaded.systemPrompt).toContain('--- HEARTBEAT CONFIG ---');
    expect(loaded.truncated).toBe(false);
  });

  // ─── I-E2E-05: CLAUDE.md written before spawn ─────────────────────────────
  it('I-E2E-05: CLAUDE.md is written to workspace with system prompt content', async () => {
    const workspace = createTempWorkspace('e2e-05-');

    // Simulate what index.ts does: load workspace + write CLAUDE.md
    const loaded = await loadWorkspace(workspace);
    const claudeMdPath = path.join(workspace, 'CLAUDE.md');
    await fs.promises.writeFile(claudeMdPath, loaded.systemPrompt, 'utf8');

    // Verify CLAUDE.md exists and contains assembled content
    expect(fs.existsSync(claudeMdPath)).toBe(true);
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('--- AGENT IDENTITY ---');
    expect(content).toContain('You are a test assistant.');
    expect(content).toContain('--- SOUL ---');
    expect(content.length).toBe(loaded.systemPrompt.length);
  });

  // ─── I-E2E-06: CLAUDE.md updates on workspace change ─────────────────────
  it('I-E2E-06: CLAUDE.md content updates when workspace markdown files change', async () => {
    const workspace = createTempWorkspace('e2e-06-');

    // Initial write
    const loaded1 = await loadWorkspace(workspace);
    const claudeMdPath = path.join(workspace, 'CLAUDE.md');
    await fs.promises.writeFile(claudeMdPath, loaded1.systemPrompt, 'utf8');

    const content1 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content1).toContain('You are a test assistant.');

    // Modify SOUL.md
    fs.writeFileSync(path.join(workspace, 'SOUL.md'), '# Soul\nUpdated soul content.', 'utf-8');

    // Reload and rewrite
    const loaded2 = await loadWorkspace(workspace);
    await fs.promises.writeFile(claudeMdPath, loaded2.systemPrompt, 'utf8');

    const content2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content2).toContain('Updated soul content.');
  });

  // ─── I-E2E-07: Two agents with separate workspaces ─────────────────────────
  it('I-E2E-07: Two agents start independently with separate workspaces', async () => {
    const ws1 = createTempWorkspace('e2e-07a-');
    const ws2 = createTempWorkspace('e2e-07b-');
    const logDir = createTempDir('e2e-07-log-');
    const cfg1 = makeAgentConfig('agent-07a', 'token-07a', ws1);
    const cfg2 = makeAgentConfig('agent-07b', 'token-07b', ws2);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner1 = new AgentRunner(cfg1, gatewayCfg);
    const runner2 = new AgentRunner(cfg2, gatewayCfg);
    await runner1.start();
    await runner2.start();
    await waitFor(() => runner1.isRunning() && runner2.isRunning());

    expect(runner1.isRunning()).toBe(true);
    expect(runner2.isRunning()).toBe(true);
    expect(ws1).not.toBe(ws2);

    const agents = new Map<string, AgentRunner>([
      ['agent-07a', runner1],
      ['agent-07b', runner2],
    ]);
    const configs = new Map<string, AgentConfig>([
      ['agent-07a', cfg1],
      ['agent-07b', cfg2],
    ]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    // /status should list both agents (/health no longer leaks agent ids; open
    // here because no API keys are configured).
    const res = await supertest(router.getApp()).get('/status');
    expect(res.status).toBe(200);
    const ids = res.body.agents.map((a: { id: string }) => a.id);
    expect(ids).toContain('agent-07a');
    expect(ids).toContain('agent-07b');

    await router.stop();
    await runner1.stop();
    await runner2.stop();
  });

  // ─── I-E2E-08: /status endpoint ─────────────────────────────────────────
  it('I-E2E-08: GET /status returns structured monitoring data per agent', async () => {
    const workspace = createTempWorkspace('e2e-08-');
    const logDir = createTempDir('e2e-08-log-');
    const agentCfg = makeAgentConfig('agent-08', 'token-agent-08', workspace);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const agents = new Map([['agent-08', runner]]);
    const configs = new Map([['agent-08', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    const res = await supertest(router.getApp()).get('/status');
    expect(res.status).toBe(200);

    const body = res.body;
    expect(body.agents).toHaveLength(1);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.startedAt).toBeTruthy();

    const agentStatus = body.agents[0];
    expect(agentStatus.id).toBe('agent-08');
    expect(agentStatus.isRunning).toBe(true);
    expect(typeof agentStatus.messagesReceived).toBe('number');
    expect(typeof agentStatus.messagesSent).toBe('number');
    expect(agentStatus.heartbeat).toBeDefined();

    await router.stop();
    await runner.stop();
  });

  // ─── I-E2E-09: messagesSent counted from subprocess output ─────────────────
  it('I-E2E-09: messagesSent increments when subprocess emits output lines', async () => {
    const workspace = createTempWorkspace('e2e-09-');
    const logDir = createTempDir('e2e-09-log-');
    const agentCfg = makeAgentConfig('agent-09', 'token-agent-09', workspace);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const agents = new Map([['agent-09', runner]]);
    const configs = new Map([['agent-09', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    // Send via stdin (simulates heartbeat/cron sending)
    runner.sendMessage('test message for output counting');

    // Wait for subprocess to echo back
    await waitFor(async () => {
      const stats = router.getAgentStats();
      return (stats.find((s) => s.id === 'agent-09')?.messagesSent ?? 0) > 0;
    }, 3000);

    const stats = router.getAgentStats();
    const agentStats = stats.find((s) => s.id === 'agent-09');
    expect(agentStats).toBeDefined();
    expect(agentStats!.messagesSent).toBeGreaterThan(0);

    await router.stop();
    await runner.stop();
  });

  // ─── I-E2E-10: Gateway shuts down cleanly ─────────────────────────────────
  it('I-E2E-10: Gateway shuts down cleanly (SIGTERM to all subprocesses)', async () => {
    const workspace = createTempWorkspace('e2e-10-');
    const logDir = createTempDir('e2e-10-log-');
    const agentCfg = makeAgentConfig('agent-10', 'token-agent-10', workspace);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    expect(runner.isRunning()).toBe(true);

    const agents = new Map([['agent-10', runner]]);
    const configs = new Map([['agent-10', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    const healthRes = await supertest(router.getApp()).get('/health');
    expect(healthRes.status).toBe(200);

    await router.stop();
    await runner.stop();

    expect(runner.isRunning()).toBe(false);
  });

  // ─── I-E2E-12: Ephemeral PTY ticket endpoint ─────────────────────────────
  describe('POST /api/v1/pty-stream-ticket', () => {
    async function makeRouter(agentId: string) {
      const workspace = createTempWorkspace(`e2e-ticket-${agentId}-`);
      const logDir = createTempDir(`e2e-ticket-${agentId}-log-`);
      const agentCfg = makeAgentConfig(agentId, `token-${agentId}`, workspace);
      const gatewayCfg = makeGatewayConfig(logDir, [{ key: 'secret-key', agents: '*' }]);
      const runner = new AgentRunner(agentCfg, gatewayCfg);
      await runner.start();
      // Tickets are bound to a session; stub one live session so the endpoint's
      // session-belongs-to-agent check passes without spawning a real PTY.
      jest.spyOn(runner, 'getSessionsSummary').mockReturnValue([{ sessionId: 'sess-x' } as any]);
      const agents = new Map([[agentId, runner]]);
      const configs = new Map([[agentId, agentCfg]]);
      const router = new GatewayRouter(agents, configs, undefined, gatewayCfg);
      await router.start(0);
      return { router, runner };
    }

    it('T-01: valid API key + known agent → 200 with ticket', async () => {
      const { router, runner } = await makeRouter('ticket-agent-01');
      const res = await supertest(router.getApp())
        .post('/api/v1/pty-stream-ticket')
        .set('X-Api-Key', 'secret-key')
        .send({ agentId: 'ticket-agent-01', sessionId: 'sess-x' });
      expect(res.status).toBe(200);
      expect(typeof res.body.ticket).toBe('string');
      expect(res.body.ticket).toHaveLength(32); // 16 bytes hex
      expect(typeof res.body.expiresAt).toBe('string');
      await router.stop(); await runner.stop();
    });

    it('T-02: invalid API key → 401', async () => {
      const { router, runner } = await makeRouter('ticket-agent-02');
      const res = await supertest(router.getApp())
        .post('/api/v1/pty-stream-ticket')
        .set('X-Api-Key', 'wrong-key')
        .send({ agentId: 'ticket-agent-02' });
      expect([401, 403]).toContain(res.status); // auth middleware may return 401 or 403
      await router.stop(); await runner.stop();
    });

    it('T-03: unknown agent → 404', async () => {
      const { router, runner } = await makeRouter('ticket-agent-03');
      const res = await supertest(router.getApp())
        .post('/api/v1/pty-stream-ticket')
        .set('X-Api-Key', 'secret-key')
        .send({ agentId: 'no-such-agent' });
      expect(res.status).toBe(404);
      await router.stop(); await runner.stop();
    });

    it('T-04: dashboard session cookie (from /dashboard/login) → 200 with ticket, and is multi-use', async () => {
      const { router, runner } = await makeRouter('ticket-agent-04');
      // Unauthenticated /dashboard serves the login page, not the dashboard, and
      // no longer embeds any token in the HTML.
      const dashRes = await supertest(router.getApp()).get('/dashboard');
      expect(dashRes.status).toBe(200);
      expect(dashRes.text).toContain('Enter an API key');
      expect(dashRes.text).not.toContain('name="dash-token"');

      // Log in with a configured API key → HttpOnly session cookie.
      const login = await supertest(router.getApp())
        .post('/dashboard/login')
        .send({ key: 'secret-key' });
      expect(login.status).toBe(200);
      const setCookie = login.headers['set-cookie'][0];
      expect(setCookie).toMatch(/dash_session=/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      const cookie = setCookie.split(';')[0];

      // First use with the cookie: should succeed.
      const first = await supertest(router.getApp())
        .post('/api/v1/pty-stream-ticket')
        .set('Cookie', cookie)
        .send({ agentId: 'ticket-agent-04', sessionId: 'sess-x' });
      expect(first.status).toBe(200);

      // Second use with the same cookie: session is multi-use (unlike the old
      // one-time meta token), so it must succeed again.
      const second = await supertest(router.getApp())
        .post('/api/v1/pty-stream-ticket')
        .set('Cookie', cookie)
        .send({ agentId: 'ticket-agent-04', sessionId: 'sess-x' });
      expect(second.status).toBe(200);

      // Wrong API key at login → 401, no cookie.
      const bad = await supertest(router.getApp())
        .post('/dashboard/login')
        .send({ key: 'wrong-key' });
      expect(bad.status).toBe(401);

      await router.stop(); await runner.stop();
    });

    it('T-05: Bearer Authorization header accepted alongside X-Api-Key', async () => {
      const { router, runner } = await makeRouter('ticket-agent-05');
      const res = await supertest(router.getApp())
        .post('/api/v1/pty-stream-ticket')
        .set('Authorization', 'Bearer secret-key')
        .send({ agentId: 'ticket-agent-05', sessionId: 'sess-x' });
      expect(res.status).toBe(200);
      await router.stop(); await runner.stop();
    });

    it('T-06: known agent but missing/unknown sessionId → 404', async () => {
      const { router, runner } = await makeRouter('ticket-agent-06');
      // Missing sessionId.
      const missing = await supertest(router.getApp())
        .post('/api/v1/pty-stream-ticket')
        .set('X-Api-Key', 'secret-key')
        .send({ agentId: 'ticket-agent-06' });
      expect(missing.status).toBe(404);
      // Unknown sessionId (not one of the agent's sessions).
      const unknown = await supertest(router.getApp())
        .post('/api/v1/pty-stream-ticket')
        .set('X-Api-Key', 'secret-key')
        .send({ agentId: 'ticket-agent-06', sessionId: 'not-a-real-session' });
      expect(unknown.status).toBe(404);
      await router.stop(); await runner.stop();
    });
  });

  // ─── I-E2E-11: Session store works correctly ──────────────────────────────
  it('I-E2E-11: Session persisted to .jsonl after message stored', async () => {
    const { SessionStore } = await import('../../src/session/store');

    const baseDir = createTempDir('e2e-11-sessions-');
    const store = new SessionStore(baseDir);

    const agentId = 'agent-11';
    const chatId = '55555';

    await store.appendMessage(agentId, chatId, {
      role: 'user',
      content: 'Hello from session test',
      ts: Date.now(),
    });

    const messages = await store.loadSession(agentId, chatId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Hello from session test');
    expect(messages[0].role).toBe('user');

    const sessionFile = path.join(baseDir, agentId, 'sessions', `${chatId}.jsonl`);
    expect(fs.existsSync(sessionFile)).toBe(true);

    const raw = fs.readFileSync(sessionFile, 'utf-8');
    expect(raw.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(raw.trim());
    expect(parsed.content).toBe('Hello from session test');
  });
});
