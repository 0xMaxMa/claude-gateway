/**
 * Integration tests: Phase 3 — Heartbeat / Cron (I-HB-01 through I-HB-10)
 *
 * Uses real AgentRunner subprocesses (mock-claude-heartbeat.js) and
 * CronScheduler.triggerTask() to manually fire tasks without waiting for
 * real cron ticks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import express from 'express';
import supertest from 'supertest';
import { AgentRunner } from '../../src/agent-runner';
import { GatewayRouter } from '../../src/gateway-router';
import { CronScheduler } from '../../src/cron-scheduler';
import { HeartbeatHistory } from '../../src/heartbeat-history';
import { AgentConfig, GatewayConfig, HeartbeatResult } from '../../src/types';

// ─── constants ────────────────────────────────────────────────────────────────

const MOCK_HB_BIN = path.resolve(__dirname, '../helpers/mock-claude-heartbeat.js');

// Use a short response timeout so tests complete quickly
process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS = '500';
process.env.NODE_ENV = 'test';

// ─── helpers ──────────────────────────────────────────────────────────────────

function createTempWorkspace(prefix = 'hb-ws-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const files: Record<string, string> = {
    'AGENTS.md': '# Agent\nYou are a test assistant.',
    'SOUL.md': '# Soul\nBe helpful.',
    'TOOLS.md': '# Tools\nNo tools.',
    'USER.md': '# User\nTester.',
    'HEARTBEAT.md': '# Heartbeat\n',
    'MEMORY.md': '# Memory\n',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

function createTempDir(prefix = 'hb-tmp-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAgentConfig(
  id: string,
  botToken: string,
  workspace: string,
  rateLimitMinutes = 30,
): AgentConfig {
  return {
    id,
    description: `HB test agent ${id}`,
    workspace,
    env: '',
    telegram: { botToken, allowedUsers: [], dmPolicy: 'open' },
    claude: { model: 'claude-test', dangerouslySkipPermissions: false, extraFlags: [] },
    heartbeat: { rateLimitMinutes },
  };
}

function makeGatewayConfig(logDir: string): GatewayConfig {
  return {
    gateway: { logDir, timezone: 'UTC' },
    agents: [],
  };
}

/** Start a mock Telegram API that records sendMessage calls. */
function startMockTelegramServer(): Promise<{
  server: http.Server;
  getMessages: () => Array<{ token: string; body: Record<string, unknown> }>;
  baseUrl: () => string;
  clearMessages: () => void;
}> {
  return new Promise((resolve) => {
    const messages: Array<{ token: string; body: Record<string, unknown> }> = [];
    const app = express();
    app.use(express.json());

    app.post('/bot:token/sendMessage', (req, res) => {
      messages.push({ token: req.params.token, body: req.body });
      res.json({ ok: true, result: { message_id: 1 } });
    });

    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        getMessages: () => [...messages],
        baseUrl: () => `http://127.0.0.1:${addr.port}`,
        clearMessages: () => messages.splice(0, messages.length),
      });
    });
  });
}

/** Wait up to timeoutMs for predicate to return true. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 30,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout exceeded');
}

// ─── shared mock Telegram server ──────────────────────────────────────────────

let telegramServer: http.Server;
let getTelegramMessages: () => Array<{ token: string; body: Record<string, unknown> }>;
let telegramBaseUrl: string;
let clearTelegramMessages: () => void;

beforeAll(async () => {
  const srv = await startMockTelegramServer();
  telegramServer = srv.server;
  getTelegramMessages = srv.getMessages;
  telegramBaseUrl = srv.baseUrl();
  clearTelegramMessages = srv.clearMessages;

  process.env.TELEGRAM_API_BASE = telegramBaseUrl;
});

afterAll(async () => {
  delete process.env.TELEGRAM_API_BASE;
  delete process.env.MOCK_RESPONSE;
  await new Promise<void>((resolve, reject) =>
    telegramServer.close((err) => (err ? reject(err) : resolve())),
  );
});

// ─── test suite ───────────────────────────────────────────────────────────────

describe('Heartbeat E2E (I-HB)', () => {
  // ─── I-HB-01: Cron task fires via triggerTask() ──────────────────────────
  it('I-HB-01: Cron task fires when triggerTask() is called', async () => {
    process.env.MOCK_RESPONSE = 'HEARTBEAT_OK';
    const ws = createTempWorkspace('hb01-');
    const logDir = createTempDir('hb01-log-');
    const agentId = 'hb01-agent';
    const agentCfg = makeAgentConfig(agentId, 'token-hb01', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;
    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);
    scheduler.load(`tasks:
  - name: test-task
    cron: "0 8 * * *"
    prompt: "Check status."
`);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    await scheduler.triggerTask('test-task');

    expect(results).toHaveLength(1);
    expect(results[0].taskName).toBe('test-task');

    scheduler.stop();
    await runner.stop();
  }, 10000);

  // ─── I-HB-02: Agent responds HEARTBEAT_OK → no Telegram sendMessage ──────
  it('I-HB-02: Agent responds HEARTBEAT_OK → no Telegram sendMessage called', async () => {
    process.env.MOCK_RESPONSE = 'HEARTBEAT_OK';
    clearTelegramMessages();

    const ws = createTempWorkspace('hb02-');
    const logDir = createTempDir('hb02-log-');
    const agentId = 'hb02-agent';
    const agentCfg = makeAgentConfig(agentId, 'token-hb02', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;
    process.env.MOCK_CHAT_ID = '88888';

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);
    scheduler.load(`tasks:
  - name: hb-check
    cron: "0 8 * * *"
    prompt: "Are you ok?"
`);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    await scheduler.triggerTask('hb-check');

    expect(results[0].suppressed).toBe(true);
    expect(results[0].rateLimited).toBe(false);

    // No Telegram sendMessage should have been triggered by the mock subprocess
    // (mock-claude-heartbeat.js skips sendTelegramMessage for HEARTBEAT_OK responses)
    await new Promise((r) => setTimeout(r, 200));
    const msgs = getTelegramMessages().filter((m) => m.token === 'hb02-agent');
    // The mock skips Telegram for HEARTBEAT_OK, so 0 messages expected
    expect(msgs).toHaveLength(0);

    delete process.env.MOCK_CHAT_ID;
    scheduler.stop();
    await runner.stop();
  }, 10000);

  // ─── I-HB-03: Agent responds with real message → mock Telegram gets it ──
  it('I-HB-03: Agent responds with real message → mock Telegram API receives sendMessage', async () => {
    const botToken = 'token-hb03';
    process.env.MOCK_RESPONSE = 'Good morning! Here is your daily summary.';
    clearTelegramMessages();

    const ws = createTempWorkspace('hb03-');
    const logDir = createTempDir('hb03-log-');
    const agentId = 'hb03-agent';
    const agentCfg = makeAgentConfig(agentId, botToken, ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;
    process.env.MOCK_CHAT_ID = '77777';

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);
    scheduler.load(`tasks:
  - name: morning-brief
    cron: "0 8 * * *"
    prompt: "Send morning brief."
`);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    await scheduler.triggerTask('morning-brief');

    expect(results[0].suppressed).toBe(false);

    // Wait for mock subprocess to POST to mock Telegram
    await waitFor(() => getTelegramMessages().length > 0, 3000);
    const msgs = getTelegramMessages();
    expect(msgs.length).toBeGreaterThan(0);
    const sent = msgs.find((m) =>
      String((m.body as { text?: string }).text).includes('Good morning'),
    );
    expect(sent).toBeDefined();

    delete process.env.MOCK_CHAT_ID;
    scheduler.stop();
    await runner.stop();
  }, 10000);

  // ─── I-HB-04: HeartbeatHistory records result after each run ─────────────
  it('I-HB-04: HeartbeatHistory records result after each cron run', async () => {
    process.env.MOCK_RESPONSE = 'HEARTBEAT_OK';

    const ws = createTempWorkspace('hb04-');
    const logDir = createTempDir('hb04-log-');
    const agentId = 'hb04-agent';
    const agentCfg = makeAgentConfig(agentId, 'token-hb04', ws, 0); // no rate limit
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);
    scheduler.load(`tasks:
  - name: status-check
    cron: "0 8 * * *"
    prompt: "Status check."
`);

    // Run twice
    await scheduler.triggerTask('status-check');
    await scheduler.triggerTask('status-check');

    const allResults = history.getHistory(agentId, 'status-check');
    expect(allResults).toHaveLength(2);

    scheduler.stop();
    await runner.stop();
  }, 15000);

  // ─── I-HB-05: Two tasks with different names have separate history entries ─
  it('I-HB-05: Two tasks with different names have separate history entries', async () => {
    process.env.MOCK_RESPONSE = 'HEARTBEAT_OK';

    const ws = createTempWorkspace('hb05-');
    const logDir = createTempDir('hb05-log-');
    const agentId = 'hb05-agent';
    const agentCfg = makeAgentConfig(agentId, 'token-hb05', ws, 0); // no rate limit
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);
    scheduler.load(`tasks:
  - name: morning-brief
    cron: "0 8 * * *"
    prompt: "Morning brief."
  - name: idle-checkin
    cron: "0 */2 * * *"
    prompt: "Idle checkin."
`);

    await scheduler.triggerTask('morning-brief');
    await scheduler.triggerTask('idle-checkin');

    const mbResults = history.getHistory(agentId, 'morning-brief');
    const icResults = history.getHistory(agentId, 'idle-checkin');

    expect(mbResults).toHaveLength(1);
    expect(icResults).toHaveLength(1);
    expect(mbResults[0].taskName).toBe('morning-brief');
    expect(icResults[0].taskName).toBe('idle-checkin');

    scheduler.stop();
    await runner.stop();
  }, 15000);

  // ─── I-HB-06: Rate limit: two tasks within 30 min → second is rateLimited ─
  it('I-HB-06: Rate limit — two tasks fire within window → second is rateLimited', async () => {
    process.env.MOCK_RESPONSE = 'HEARTBEAT_OK';

    const ws = createTempWorkspace('hb06-');
    const logDir = createTempDir('hb06-log-');
    const agentId = 'hb06-agent';
    // 30-minute rate limit
    const agentCfg = makeAgentConfig(agentId, 'token-hb06', ws, 30);
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);
    scheduler.load(`tasks:
  - name: hb-task
    cron: "0 8 * * *"
    prompt: "Check."
`);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    await scheduler.triggerTask('hb-task');
    await scheduler.triggerTask('hb-task');

    expect(results).toHaveLength(2);
    expect(results[0].rateLimited).toBe(false);
    expect(results[1].rateLimited).toBe(true);
    expect(results[1].suppressed).toBe(true);

    scheduler.stop();
    await runner.stop();
  }, 10000);

  // ─── I-HB-07: Reload heartbeat.md → old tasks cancelled, new scheduled ───
  it('I-HB-07: Reload heartbeat.md — old tasks cancelled, new tasks scheduled', async () => {
    process.env.MOCK_RESPONSE = 'HEARTBEAT_OK';

    const ws = createTempWorkspace('hb07-');
    const logDir = createTempDir('hb07-log-');
    const agentId = 'hb07-agent';
    const agentCfg = makeAgentConfig(agentId, 'token-hb07', ws, 0);
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);

    // Load initial heartbeat
    scheduler.load(`tasks:
  - name: old-task
    cron: "0 8 * * *"
    prompt: "Old task prompt."
`);

    // Verify old-task is accessible
    await scheduler.triggerTask('old-task');
    expect(history.getLastResult(agentId, 'old-task')).not.toBeNull();

    // Reload with new task definition
    scheduler.load(`tasks:
  - name: new-task
    cron: "0 9 * * *"
    prompt: "New task prompt."
`);

    // old-task should no longer exist
    await expect(scheduler.triggerTask('old-task')).rejects.toThrow('No task named');

    // new-task should work
    await scheduler.triggerTask('new-task');
    expect(history.getLastResult(agentId, 'new-task')).not.toBeNull();

    scheduler.stop();
    await runner.stop();
  }, 10000);

  // ─── I-HB-08: GET /status returns correct heartbeat lastResults ──────────
  it('I-HB-08: GET /status returns correct heartbeat lastResults', async () => {
    process.env.MOCK_RESPONSE = 'HEARTBEAT_OK';

    const ws = createTempWorkspace('hb08-');
    const logDir = createTempDir('hb08-log-');
    const agentId = 'hb08-agent';
    const agentCfg = makeAgentConfig(agentId, 'token-hb08', ws, 0);
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);
    scheduler.load(`tasks:
  - name: status-task
    cron: "0 8 * * *"
    prompt: "Status check."
`);

    await scheduler.triggerTask('status-task');

    const agents = new Map([[agentId, runner]]);
    const configs = new Map([[agentId, agentCfg]]);
    const schedulers = new Map([[agentId, scheduler]]);
    const router = new GatewayRouter(agents, configs, schedulers);
    await router.start(0);

    const res = await supertest(router.getApp()).get('/status');
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);

    const agentStatus = res.body.agents[0];
    expect(agentStatus.id).toBe(agentId);
    expect(agentStatus.heartbeat).toBeDefined();
    expect(agentStatus.heartbeat.tasks).toContain('status-task');
    expect(agentStatus.heartbeat.lastResults).toHaveLength(1);
    expect(agentStatus.heartbeat.lastResults[0].taskName).toBe('status-task');
    expect(agentStatus.heartbeat.lastResults[0].suppressed).toBe(true);
    expect(typeof agentStatus.heartbeat.lastResults[0].durationMs).toBe('number');
    expect(agentStatus.heartbeat.lastResults[0].ts).toBeDefined();

    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.startedAt).toBeDefined();

    await router.stop();
    scheduler.stop();
    await runner.stop();
  }, 10000);

  // ─── I-HB-09: Ephemeral session ID is unique per run ────────────────────
  it('I-HB-09: Ephemeral session ID is unique per run and not the DM session ID', async () => {
    process.env.MOCK_RESPONSE = 'HEARTBEAT_OK';

    const ws = createTempWorkspace('hb09-');
    const logDir = createTempDir('hb09-log-');
    const agentId = 'hb09-agent';
    const agentCfg = makeAgentConfig(agentId, 'token-hb09', ws, 0);
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);
    scheduler.load(`tasks:
  - name: session-test
    cron: "0 8 * * *"
    prompt: "Session test."
`);

    // Wait a bit between runs to ensure different timestamps
    await scheduler.triggerTask('session-test');
    await new Promise((r) => setTimeout(r, 5));
    await scheduler.triggerTask('session-test');

    const allResults = history.getHistory(agentId, 'session-test');
    expect(allResults).toHaveLength(2);

    const [run2, run1] = allResults; // newest first

    // Session IDs should be unique
    expect(run1.sessionId).not.toBe(run2.sessionId);

    // Session IDs should follow the heartbeat format
    expect(run1.sessionId).toMatch(/^heartbeat:hb09-agent:session-test:\d+$/);
    expect(run2.sessionId).toMatch(/^heartbeat:hb09-agent:session-test:\d+$/);

    // Session IDs should NOT look like DM sessions (agent:<id>:telegram:<chatId>)
    expect(run1.sessionId).not.toMatch(/^agent:/);
    expect(run2.sessionId).not.toMatch(/^agent:/);

    scheduler.stop();
    await runner.stop();
  }, 10000);

  // ─── I-HB-10: CronScheduler stop() → no more tasks fire ─────────────────
  it('I-HB-10: CronScheduler stop() → triggerTask() throws for any task', async () => {
    process.env.MOCK_RESPONSE = 'HEARTBEAT_OK';

    const ws = createTempWorkspace('hb10-');
    const logDir = createTempDir('hb10-log-');
    const agentId = 'hb10-agent';
    const agentCfg = makeAgentConfig(agentId, 'token-hb10', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    process.env.CLAUDE_BIN = `node ${MOCK_HB_BIN}`;

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(agentId, runner, makeLogger(), agentCfg, history);
    scheduler.load(`tasks:
  - name: stop-test
    cron: "0 8 * * *"
    prompt: "Stop test."
`);

    // Task is accessible before stop
    await scheduler.triggerTask('stop-test');

    // Stop all tasks
    scheduler.stop();

    // After stop, triggerTask() should throw because taskDefs are cleared
    await expect(scheduler.triggerTask('stop-test')).rejects.toThrow('No task named');

    await runner.stop();
  }, 10000);
});

// ─── logger helper ────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: (_msg: string, _data?: Record<string, unknown>) => {},
    warn: (_msg: string, _data?: Record<string, unknown>) => {},
    error: (_msg: string, _data?: Record<string, unknown>) => {},
    debug: (_msg: string, _data?: Record<string, unknown>) => {},
  };
}
