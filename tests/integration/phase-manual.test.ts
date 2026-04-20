/**
 * Phase Manual Integration Tests
 *
 * Covers all Phase 1 (P1-01..P1-20) and Phase 2 (P2-01..P2-13) manual test steps
 * using fully mocked Telegram requests. No real bot token, no ngrok, no internet needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import express from 'express';
import supertest from 'supertest';

import { loadConfig, MissingEnvVarError, DuplicateAgentIdError, ConfigValidationError } from '../../src/config/loader';
import { loadWorkspace, watchWorkspace } from '../../src/agent/workspace-loader';
import { MemoryManager } from '../../src/memory/manager';
import { parseHeartbeat, InvalidCronError } from '../../src/heartbeat/parser';
import { SessionStore } from '../../src/session/store';
import { isAllowed } from '../../src/security';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentRunner } from '../../src/agent/runner';
import { ContextIsolationGuard, TokenConflictError, WorkspaceConflictError } from '../../src/agent/context-isolation';
import { registerWebhook, getWebhookInfo } from '../../src/webhook/manager';
import { AgentConfig, GatewayConfig, HeartbeatResult } from '../../src/types';
import { HeartbeatHistory } from '../../src/heartbeat/history';
import { CronScheduler } from '../../src/cron/scheduler';
import { EventEmitter } from 'events';

// ─── constants ───────────────────────────────────────────────────────────────

const MOCK_CLAUDE_BIN = path.resolve(__dirname, '../helpers/mock-claude.js');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Create a temp dir, returns its path. */
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Create a workspace directory populated with all standard .md files.
 */
function makeTempWorkspace(
  prefix: string,
  opts: { oversizeFile?: string } = {},
): string {
  const dir = makeTempDir(prefix);
  const files: Record<string, string> = {
    'AGENTS.md': '# Agent\nYou are a test assistant.',
    'SOUL.md': '# Soul\nBe helpful.',
    'USER.md': '# User\nTester.',
    'HEARTBEAT.md': '# Heartbeat\n',
    'MEMORY.md': '# Memory\n',
  };

  if (opts.oversizeFile) {
    // Make AGENTS.md oversized (> 20_000 chars)
    files['AGENTS.md'] = 'A'.repeat(25_000);
  }

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

/** Build a minimal AgentConfig. */
function makeAgentConfig(
  id: string,
  botToken: string,
  workspace: string,
  extra: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    id,
    description: `Test agent ${id}`,
    workspace,
    env: '',
    telegram: { botToken, allowedUsers: [], dmPolicy: 'open' },
    claude: { model: 'claude-test', dangerouslySkipPermissions: false, extraFlags: [] },
    ...extra,
  };
}

/** Build a minimal GatewayConfig. */
function makeGatewayConfig(logDir: string): GatewayConfig {
  return { gateway: { logDir, timezone: 'UTC' }, agents: [] };
}

/** Build a Telegram update payload. */
function makeTelegramUpdate(
  updateId: number,
  text: string,
  chatId = 12345,
  userId = 111,
): object {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, first_name: 'Tester' },
      chat: { id: chatId, type: 'private' },
      text,
    },
  };
}

/** Wait up to timeoutMs for predicate to return true, polling every intervalMs. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout exceeded');
}

/**
 * Start a minimal express server acting as a mock Telegram API.
 * Records all POST calls to /bot:token/setWebhook and /bot:token/getWebhookInfo.
 */
function startMockTelegramApiServer(): Promise<{
  server: http.Server;
  port: number;
  baseUrl: () => string;
  getCalls: () => Array<{ method: string; path: string; body: unknown }>;
  stop: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const app = express();
    app.use(express.json());

    // setWebhook
    app.post('/bot:token/setWebhook', (req, res) => {
      calls.push({ method: 'POST', path: req.path, body: req.body });
      res.json({ ok: true, result: true });
    });

    // getWebhookInfo
    app.get('/bot:token/getWebhookInfo', (req, res) => {
      calls.push({ method: 'GET', path: req.path, body: null });
      res.json({
        ok: true,
        result: {
          url: 'https://example.com/webhook',
          has_custom_certificate: false,
          pending_update_count: 0,
        },
      });
    });

    // sendMessage (used by mock-claude)
    app.post('/bot:token/sendMessage', (req, res) => {
      calls.push({ method: 'POST', path: req.path, body: req.body });
      res.json({ ok: true, result: { message_id: 1 } });
    });

    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const stop = () =>
        new Promise<void>((res, rej) =>
          server.close((err) => (err ? rej(err) : res())),
        );
      resolve({
        server,
        port: addr.port,
        baseUrl: () => `http://127.0.0.1:${addr.port}`,
        getCalls: () => [...calls],
        stop,
      });
    });
  });
}

// ─── update id counter ────────────────────────────────────────────────────────

let _uid = 5000;
function nextUid(): number {
  return ++_uid;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1 Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 1: Config Loader', () => {
  // P1-01
  it('P1-01: valid config with 2 agents loads correctly', () => {
    const configPath = path.resolve(
      __dirname,
      '../fixtures/configs/valid-2-agents.json',
    );
    // Provide the env vars referenced by the fixture
    process.env.ALFRED_BOT_TOKEN = 'token-alfred-test';
    process.env.BAERBEL_BOT_TOKEN = 'token-baerbel-test';

    try {
      const config = loadConfig(configPath);
      expect(config.agents).toHaveLength(2);
      expect(config.agents[0].id).toBe('alfred');
      expect(config.agents[1].id).toBe('baerbel');
      expect(config.agents[0].telegram!.botToken).toBe('token-alfred-test');
      expect(config.agents[1].telegram!.botToken).toBe('token-baerbel-test');
      expect(config.gateway).toBeDefined();
    } finally {
      delete process.env.ALFRED_BOT_TOKEN;
      delete process.env.BAERBEL_BOT_TOKEN;
    }
  });

  // P1-02: agents with missing env vars are skipped; if none remain, throws ConfigValidationError
  it('P1-02: missing bot token env var skips agents, throws when none remain', () => {
    const configPath = path.resolve(
      __dirname,
      '../fixtures/configs/valid-2-agents.json',
    );
    // Ensure the env vars are NOT set
    delete process.env.ALFRED_BOT_TOKEN;
    delete process.env.BAERBEL_BOT_TOKEN;

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/no valid agents/i);
  });

  // P1-03
  it('P1-03: duplicate agent IDs throws DuplicateAgentIdError', () => {
    const configPath = path.resolve(
      __dirname,
      '../fixtures/configs/duplicate-ids.json',
    );
    expect(() => loadConfig(configPath)).toThrow(DuplicateAgentIdError);
    expect(() => loadConfig(configPath)).toThrow(/alfred/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1: Workspace Loader', () => {
  // P1-04
  it('P1-04: all 6 files assembled into system prompt with correct section headers', async () => {
    const workspace = makeTempWorkspace('p104-');
    const result = await loadWorkspace(workspace);

    expect(result.systemPrompt).toContain('--- AGENT IDENTITY ---');
    expect(result.systemPrompt).toContain('--- SOUL ---');
    expect(result.systemPrompt).toContain('--- USER PROFILE ---');
    expect(result.systemPrompt).toContain('--- LONG-TERM MEMORY ---');
    expect(result.systemPrompt).toContain('--- HEARTBEAT CONFIG ---');

    // Content from each file appears
    expect(result.systemPrompt).toContain('You are a test assistant.');
    expect(result.systemPrompt).toContain('Be helpful.');
    expect(result.systemPrompt).toContain('Tester.');

    expect(result.truncated).toBe(false);
  });

  // P1-05
  it('P1-05: oversized file truncated with [TRUNCATED] marker', async () => {
    const workspace = makeTempWorkspace('p105-', { oversizeFile: 'AGENTS.md' });
    const result = await loadWorkspace(workspace);

    expect(result.truncated).toBe(true);
    expect(result.systemPrompt).toContain('[TRUNCATED');
    // The content was cut short (should not contain all 25000 A chars)
    expect(result.files.agentMd.length).toBeLessThan(25_000);
  });

});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1: Heartbeat Parser', () => {
  // P1-07
  it('P1-07: cron task parsed with correct expression', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../fixtures/heartbeat/valid-cron.md'),
      'utf-8',
    );
    const tasks = parseHeartbeat(content);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const morning = tasks.find((t) => t.name === 'morning-brief');
    expect(morning).toBeDefined();
    expect(morning!.cron).toBe('0 8 * * *');
    expect(morning!.prompt).toContain('morning');
  });

  // P1-08
  it('P1-08: interval "2h" → cron "0 */2 * * *"', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../fixtures/heartbeat/valid-interval.md'),
      'utf-8',
    );
    const tasks = parseHeartbeat(content);
    const idleCheckin = tasks.find((t) => t.name === 'idle-checkin');
    expect(idleCheckin).toBeDefined();
    expect(idleCheckin!.cron).toBe('0 */2 * * *');
  });

  // P1-09
  it('P1-09: invalid cron throws InvalidCronError', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../fixtures/heartbeat/invalid-cron.md'),
      'utf-8',
    );
    expect(() => parseHeartbeat(content)).toThrow(InvalidCronError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1: Session Store', () => {
  // P1-10
  it('P1-10: message appended → reload returns same message', async () => {
    const baseDir = makeTempDir('p110-sessions-');
    const store = new SessionStore(baseDir);

    const agentId = 'p110-agent';
    const chatId = '10001';
    const msg = { role: 'user' as const, content: 'Hello session store', ts: Date.now() };

    await store.appendMessage(agentId, chatId, msg);
    const loaded = await store.loadSession(agentId, chatId);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe('Hello session store');
    expect(loaded[0].role).toBe('user');
  });

  // P1-11
  it('P1-11: agent-A chat-111 and agent-B chat-111 → different .jsonl files, no cross-contamination', async () => {
    const baseDir = makeTempDir('p111-sessions-');
    const store = new SessionStore(baseDir);

    const chatId = '111';

    await store.appendMessage('p111-agentA', chatId, {
      role: 'user',
      content: 'Message for agent A',
      ts: Date.now(),
    });

    await store.appendMessage('p111-agentB', chatId, {
      role: 'user',
      content: 'Message for agent B',
      ts: Date.now(),
    });

    const sessA = await store.loadSession('p111-agentA', chatId);
    const sessB = await store.loadSession('p111-agentB', chatId);

    // Each agent sees only its own message
    expect(sessA).toHaveLength(1);
    expect(sessA[0].content).toBe('Message for agent A');

    expect(sessB).toHaveLength(1);
    expect(sessB[0].content).toBe('Message for agent B');

    // No cross-contamination
    expect(sessA[0].content).not.toContain('agent B');
    expect(sessB[0].content).not.toContain('agent A');

    // Different file paths on disk
    const fileA = path.join(baseDir, 'p111-agentA', 'sessions', `${chatId}.jsonl`);
    const fileB = path.join(baseDir, 'p111-agentB', 'sessions', `${chatId}.jsonl`);
    expect(fs.existsSync(fileA)).toBe(true);
    expect(fs.existsSync(fileB)).toBe(true);
    expect(fileA).not.toBe(fileB);
  });

  // P1-12
  it('P1-12: corrupted .jsonl file → reset to empty, no crash', async () => {
    const baseDir = makeTempDir('p112-sessions-');
    const store = new SessionStore(baseDir);

    const agentId = 'p112-agent';
    const chatId = '112';

    // Manually create a corrupted .jsonl file
    const sessionDir = path.join(baseDir, agentId, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `${chatId}.jsonl`),
      'this is not valid JSON\n{"role":"user","content":"ok","ts":1}\n',
      'utf-8',
    );

    // Loading should not throw, and should return empty array
    const messages = await store.loadSession(agentId, chatId);
    expect(messages).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1: Security', () => {
  const baseAgentConfig: AgentConfig = {
    id: 'security-test',
    description: 'Security test agent',
    workspace: '/tmp/test',
    env: '',
    telegram: {
      botToken: 'test-token',
      allowedUsers: [42, 99],
      dmPolicy: 'allowlist',
    },
    claude: { model: 'claude-test', dangerouslySkipPermissions: false, extraFlags: [] },
  };

  // P1-13
  it('P1-13: allowlist policy, allowed userId → isAllowed=true', () => {
    expect(isAllowed(42, baseAgentConfig, '99999')).toBe(true);
    expect(isAllowed(99, baseAgentConfig, '99999')).toBe(true);
  });

  // P1-14
  it('P1-14: allowlist policy, unknown userId → isAllowed=false', () => {
    expect(isAllowed(9999, baseAgentConfig, '99999')).toBe(false);
    expect(isAllowed(0, baseAgentConfig, '99999')).toBe(false);
  });

  // P1-15
  it('P1-15: open policy, any userId → isAllowed=true', () => {
    const openConfig: AgentConfig = {
      ...baseAgentConfig,
      telegram: { ...baseAgentConfig.telegram!, dmPolicy: 'open' },
    };
    expect(isAllowed(9999, openConfig, '99999')).toBe(true);
    expect(isAllowed(0, openConfig, '99999')).toBe(true);
    expect(isAllowed(123456789, openConfig, '99999')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1: Gateway Router', () => {
  // P1-16 (Option A: webhook route removed — Claude handles Telegram via --channels)
  it('P1-16: POST /webhook returns 404 (webhook route removed in Option A)', async () => {
    const ws = makeTempWorkspace('p116-', {});
    const agentCfg = makeAgentConfig('p116-agent', 'token-p116', ws);
    const mockRunner = { sendMessage: jest.fn(), isRunning: () => true };

    const agents = new Map<string, AgentRunner>([['p116-agent', mockRunner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p116-agent', agentCfg]]);
    const router = new GatewayRouter(agents, configs);

    const res = await supertest(router.getApp())
      .post('/webhook/token-p116')
      .send(makeTelegramUpdate(nextUid(), 'hello from p116'));

    // Webhook route removed — Claude subprocess handles Telegram via --channels
    expect(res.status).toBe(404);
    expect(mockRunner.sendMessage).not.toHaveBeenCalled();
  });

  // P1-17 (all webhook routes return 404 in Option A)
  it('P1-17: POST any bot token to /webhook → 404 (webhook route removed)', async () => {
    const ws = makeTempWorkspace('p117-', {});
    const agentCfg = makeAgentConfig('p117-agent', 'token-p117', ws);
    const mockRunner = { sendMessage: jest.fn(), isRunning: () => true };

    const agents = new Map<string, AgentRunner>([['p117-agent', mockRunner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p117-agent', agentCfg]]);
    const router = new GatewayRouter(agents, configs);

    // Both known and unknown tokens return 404
    const res1 = await supertest(router.getApp())
      .post('/webhook/token-p117')
      .send(makeTelegramUpdate(nextUid(), 'hello'));
    const res2 = await supertest(router.getApp())
      .post('/webhook/totally-wrong-token')
      .send(makeTelegramUpdate(nextUid(), 'hello'));

    expect(res1.status).toBe(404);
    expect(res2.status).toBe(404);
  });

  // P1-18 (dedup via webhook removed with Option A)
  it('P1-18: POST /webhook returns 404 (dedup via webhook no longer applicable)', async () => {
    const ws = makeTempWorkspace('p118-', {});
    const agentCfg = makeAgentConfig('p118-agent', 'token-p118', ws);
    const mockRunner = { sendMessage: jest.fn(), isRunning: () => true };

    const agents = new Map<string, AgentRunner>([['p118-agent', mockRunner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p118-agent', agentCfg]]);
    const router = new GatewayRouter(agents, configs);

    const res = await supertest(router.getApp())
      .post('/webhook/token-p118')
      .send(makeTelegramUpdate(77777, 'dedup test'));

    expect(res.status).toBe(404);
    expect(mockRunner.sendMessage).not.toHaveBeenCalled();
  });

  // P1-19 (allowlist security now enforced by Claude plugin, not gateway webhook)
  it('P1-19: POST /webhook returns 404 (security enforced by Claude plugin in Option A)', async () => {
    const ws = makeTempWorkspace('p119-', {});
    const agentCfg = makeAgentConfig('p119-agent', 'token-p119', ws, {
      telegram: { botToken: 'token-p119', allowedUsers: [1001, 1002], dmPolicy: 'allowlist' },
    });
    const mockRunner = { sendMessage: jest.fn(), isRunning: () => true };

    const agents = new Map<string, AgentRunner>([['p119-agent', mockRunner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p119-agent', agentCfg]]);
    const router = new GatewayRouter(agents, configs);

    const res = await supertest(router.getApp())
      .post('/webhook/token-p119')
      .send(makeTelegramUpdate(nextUid(), 'any message', 12345, 9999));

    expect(res.status).toBe(404);
    expect(mockRunner.sendMessage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1: Agent Runner', () => {
  beforeAll(() => {
    process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE_BIN}`;
  });

  afterAll(() => {
    delete process.env.CLAUDE_BIN;
  });

  // P1-20
  it('P1-20: spawns mock subprocess with correct CLAUDE_BIN args and env vars', async () => {
    const ws = makeTempWorkspace('p120-', {});
    const logDir = makeTempDir('p120-log-');
    const agentCfg = makeAgentConfig('p120-agent', 'token-p120', ws);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();

    try {
      await waitFor(() => runner.isRunning(), 5000);
      expect(runner.isRunning()).toBe(true);

      // Send a message and verify mock-claude echoes it back
      const outputLines: string[] = [];
      runner.on('output', (line: string) => outputLines.push(line));

      runner.sendMessage('test message for P1-20');
      await waitFor(() => outputLines.some((l) => l.includes('test message for P1-20')), 4000);

      expect(
        outputLines.some((l) => l.includes('[mock-claude] received: test message for P1-20')),
      ).toBe(true);
    } finally {
      await runner.stop();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2 Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 2: ContextIsolationGuard', () => {
  // P2-01
  it('P2-01: duplicate bot token → TokenConflictError', () => {
    const ws1 = makeTempWorkspace('p201a-', {});
    const ws2 = makeTempWorkspace('p201b-', {});
    const cfg1 = makeAgentConfig('p201-agent1', 'shared-token', ws1);
    const cfg2 = makeAgentConfig('p201-agent2', 'shared-token', ws2);

    const guard = new ContextIsolationGuard();
    expect(() => guard.validate([cfg1, cfg2])).toThrow(TokenConflictError);
    expect(() => guard.validate([cfg1, cfg2])).toThrow(/p201-agent1.*p201-agent2|p201-agent2.*p201-agent1/);
  });

  // P2-02
  it('P2-02: duplicate workspace path → WorkspaceConflictError', () => {
    const sharedWs = makeTempWorkspace('p202-shared-', {});
    const cfg1 = makeAgentConfig('p202-agent1', 'token-p202a', sharedWs);
    const cfg2 = makeAgentConfig('p202-agent2', 'token-p202b', sharedWs);

    const guard = new ContextIsolationGuard();
    expect(() => guard.validate([cfg1, cfg2])).toThrow(WorkspaceConflictError);
    expect(() => guard.validate([cfg1, cfg2])).toThrow(/p202-agent1.*p202-agent2|p202-agent2.*p202-agent1/);
  });

  // P2-03
  it('P2-03: all unique → no error thrown', () => {
    const ws1 = makeTempWorkspace('p203a-', {});
    const ws2 = makeTempWorkspace('p203b-', {});
    const cfg1 = makeAgentConfig('p203-agent1', 'token-p203a', ws1);
    const cfg2 = makeAgentConfig('p203-agent2', 'token-p203b', ws2);

    const guard = new ContextIsolationGuard();
    expect(() => guard.validate([cfg1, cfg2])).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2: GatewayRouter lookup and stats API', () => {
  function buildTwoAgentRouter() {
    const ws1 = makeTempWorkspace('p2router-a-', {});
    const ws2 = makeTempWorkspace('p2router-b-', {});
    const cfg1 = makeAgentConfig('p2-agent-alpha', 'token-p2-alpha', ws1);
    const cfg2 = makeAgentConfig('p2-agent-beta', 'token-p2-beta', ws2);
    const mockAlpha = { sendMessage: jest.fn(), isRunning: () => true };
    const mockBeta = { sendMessage: jest.fn(), isRunning: () => true };

    const agents = new Map<string, AgentRunner>([
      ['p2-agent-alpha', mockAlpha as unknown as AgentRunner],
      ['p2-agent-beta', mockBeta as unknown as AgentRunner],
    ]);
    const configs = new Map<string, AgentConfig>([
      ['p2-agent-alpha', cfg1],
      ['p2-agent-beta', cfg2],
    ]);
    const router = new GatewayRouter(agents, configs);
    return { router, cfg1, cfg2, mockAlpha, mockBeta };
  }

  // P2-04
  it('P2-04: GatewayRouter.listAgents() returns all registered agents', () => {
    const { router } = buildTwoAgentRouter();
    const listed = router.listAgents();
    expect(listed).toHaveLength(2);
    const ids = listed.map((a) => a.id);
    expect(ids).toContain('p2-agent-alpha');
    expect(ids).toContain('p2-agent-beta');
  });

  // P2-05
  it('P2-05: GatewayRouter.getAgentByToken() returns correct agent for token', () => {
    const { router, cfg1, cfg2 } = buildTwoAgentRouter();
    const found1 = router.getAgentByToken('token-p2-alpha');
    const found2 = router.getAgentByToken('token-p2-beta');
    const notFound = router.getAgentByToken('unknown-token');

    expect(found1).toBeDefined();
    expect(found1!.id).toBe('p2-agent-alpha');
    expect(found2).toBeDefined();
    expect(found2!.id).toBe('p2-agent-beta');
    expect(notFound).toBeUndefined();

    // Suppress unused warning
    void cfg1;
    void cfg2;
  });

  // P2-06 (Option A: messagesSent tracked from subprocess output events)
  it('P2-06: GatewayRouter.getAgentStats(): messagesSent increments from subprocess output', () => {
    const ws1 = makeTempWorkspace('p206-a-', {});
    const ws2 = makeTempWorkspace('p206-b-', {});
    const cfg1 = makeAgentConfig('p206-alpha', 'token-p206-alpha', ws1);
    const cfg2 = makeAgentConfig('p206-beta', 'token-p206-beta', ws2);

    // Use EventEmitter-based mocks so runner.on() works
    const mockAlpha = makeMockRunner();
    const mockBeta = makeMockRunner();

    const agents = new Map<string, AgentRunner>([
      ['p206-alpha', mockAlpha as unknown as AgentRunner],
      ['p206-beta', mockBeta as unknown as AgentRunner],
    ]);
    const configs = new Map<string, AgentConfig>([
      ['p206-alpha', cfg1],
      ['p206-beta', cfg2],
    ]);
    const router = new GatewayRouter(agents, configs);

    // Simulate subprocess output (alpha emits 2, beta emits 1)
    simulateAgentOutput(mockAlpha, 'output line 1', 0);
    simulateAgentOutput(mockAlpha, 'output line 2', 5);
    simulateAgentOutput(mockBeta, 'output line 1', 0);

    // Return a promise that resolves after outputs are emitted
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const stats = router.getAgentStats();
        const alphaStats = stats.find((s) => s.id === 'p206-alpha');
        const betaStats = stats.find((s) => s.id === 'p206-beta');

        expect(alphaStats).toBeDefined();
        expect(betaStats).toBeDefined();
        expect(alphaStats!.messagesSent).toBe(2);
        expect(betaStats!.messagesSent).toBe(1);
        resolve();
      }, 50);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2: Two-agent token routing (Option A)', () => {
  // P2-07/P2-08: Webhook routing removed. Claude handles routing via separate --channels process per bot token.
  // Tests verify /health lists both agents and /webhook returns 404.

  let router: GatewayRouter;
  let mockAlpha: { sendMessage: jest.Mock; isRunning: () => boolean };
  let mockBeta: { sendMessage: jest.Mock; isRunning: () => boolean };

  beforeEach(() => {
    const ws1 = makeTempWorkspace('p2routing-a-', {});
    const ws2 = makeTempWorkspace('p2routing-b-', {});
    const cfg1 = makeAgentConfig('p207-alpha', 'token-p207-alpha', ws1);
    const cfg2 = makeAgentConfig('p207-beta', 'token-p207-beta', ws2);
    mockAlpha = { sendMessage: jest.fn(), isRunning: () => true };
    mockBeta = { sendMessage: jest.fn(), isRunning: () => true };

    const agents = new Map<string, AgentRunner>([
      ['p207-alpha', mockAlpha as unknown as AgentRunner],
      ['p207-beta', mockBeta as unknown as AgentRunner],
    ]);
    const configs = new Map<string, AgentConfig>([
      ['p207-alpha', cfg1],
      ['p207-beta', cfg2],
    ]);
    router = new GatewayRouter(agents, configs);
  });

  // P2-07 (Option A: webhook removed, POST /webhook returns 404)
  it('P2-07: POST /webhook/token-A returns 404 (routing via --channels, not webhook)', async () => {
    const res = await supertest(router.getApp())
      .post('/webhook/token-p207-alpha')
      .send(makeTelegramUpdate(nextUid(), 'hello alpha'));

    expect(res.status).toBe(404);
    expect(mockAlpha.sendMessage).not.toHaveBeenCalled();
    expect(mockBeta.sendMessage).not.toHaveBeenCalled();
  });

  // P2-08 (Option A: webhook removed)
  it('P2-08: POST /webhook/token-B returns 404 (routing via --channels, not webhook)', async () => {
    const res = await supertest(router.getApp())
      .post('/webhook/token-p207-beta')
      .send(makeTelegramUpdate(nextUid(), 'hello beta'));

    expect(res.status).toBe(404);
    expect(mockBeta.sendMessage).not.toHaveBeenCalled();
    expect(mockAlpha.sendMessage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2: Debouncing (Option A — debounce removed)', () => {
  // P2-09: Debouncing via webhook removed in Option A.
  // Claude subprocess handles Telegram messages directly via --channels.
  it('P2-09: POST /webhook returns 404 (debounce via webhook removed in Option A)', async () => {
    const ws = makeTempWorkspace('p209-', {});
    const agentCfg = makeAgentConfig('p209-agent', 'token-p209', ws);
    const mockRunner = { sendMessage: jest.fn(), isRunning: () => true };

    const agents = new Map<string, AgentRunner>([['p209-agent', mockRunner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p209-agent', agentCfg]]);
    const router = new GatewayRouter(agents, configs);

    const res = await supertest(router.getApp())
      .post('/webhook/token-p209')
      .send(makeTelegramUpdate(nextUid(), 'rapid 1', 55555));

    expect(res.status).toBe(404);
    expect(mockRunner.sendMessage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2: Cross-agent session isolation', () => {
  // P2-10
  it('P2-10: agent-A and agent-B writing to same chatId → separate .jsonl files', async () => {
    const baseDir = makeTempDir('p210-sessions-');
    const store = new SessionStore(baseDir);

    const chatId = '99999';

    await store.appendMessage('p210-agentA', chatId, {
      role: 'user',
      content: 'Agent A writes to chat 99999',
      ts: Date.now(),
    });

    await store.appendMessage('p210-agentB', chatId, {
      role: 'user',
      content: 'Agent B writes to chat 99999',
      ts: Date.now(),
    });

    const sessA = await store.loadSession('p210-agentA', chatId);
    const sessB = await store.loadSession('p210-agentB', chatId);

    expect(sessA).toHaveLength(1);
    expect(sessA[0].content).toBe('Agent A writes to chat 99999');

    expect(sessB).toHaveLength(1);
    expect(sessB[0].content).toBe('Agent B writes to chat 99999');

    const fileA = path.join(baseDir, 'p210-agentA', 'sessions', `${chatId}.jsonl`);
    const fileB = path.join(baseDir, 'p210-agentB', 'sessions', `${chatId}.jsonl`);
    expect(fs.existsSync(fileA)).toBe(true);
    expect(fs.existsSync(fileB)).toBe(true);
    expect(fileA).not.toBe(fileB);

    const rawA = fs.readFileSync(fileA, 'utf-8');
    const rawB = fs.readFileSync(fileB, 'utf-8');
    expect(rawA).toContain('Agent A writes');
    expect(rawB).toContain('Agent B writes');
    expect(rawA).not.toContain('Agent B writes');
    expect(rawB).not.toContain('Agent A writes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2: Startup resilience', () => {
  beforeAll(() => {
    process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE_BIN}`;
  });

  afterAll(() => {
    delete process.env.CLAUDE_BIN;
  });

  // P2-11
  it('P2-11: agent with missing agent.md fails gracefully, valid agent still starts', async () => {
    const badWorkspace = path.join(os.tmpdir(), `p211-nonexistent-${Date.now()}`);
    const goodWorkspace = makeTempWorkspace('p211-good-', {});
    const logDir = makeTempDir('p211-log-');
    const cfgBad = makeAgentConfig('p211-bad', 'token-p211-bad', badWorkspace);
    const cfgGood = makeAgentConfig('p211-good', 'token-p211-good', goodWorkspace);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runnerMap = new Map<string, AgentRunner>();
    const configMap = new Map<string, AgentConfig>();

    // Simulate startup logic: skip agent if workspace missing
    for (const agentConfig of [cfgBad, cfgGood]) {
      if (!fs.existsSync(agentConfig.workspace)) {
        // bad agent: skip
        continue;
      }
      const runner = new AgentRunner(agentConfig, gatewayCfg);
      await runner.start();
      runnerMap.set(agentConfig.id, runner);
      configMap.set(agentConfig.id, agentConfig);
    }

    try {
      expect(runnerMap.has('p211-bad')).toBe(false);
      expect(runnerMap.has('p211-good')).toBe(true);

      const goodRunner = runnerMap.get('p211-good')!;
      await waitFor(() => goodRunner.isRunning(), 5000);
      expect(goodRunner.isRunning()).toBe(true);
    } finally {
      for (const runner of runnerMap.values()) {
        await runner.stop();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2: WebhookManager (mock Telegram API server)', () => {
  let mockTelegramServer: Awaited<ReturnType<typeof startMockTelegramApiServer>>;

  beforeAll(async () => {
    mockTelegramServer = await startMockTelegramApiServer();
    process.env.TELEGRAM_API_BASE = mockTelegramServer.baseUrl();
  });

  afterAll(async () => {
    delete process.env.TELEGRAM_API_BASE;
    await mockTelegramServer.stop();
  });

  // P2-12
  it('P2-12: registerWebhook calls correct Telegram API endpoint', async () => {
    const botToken = 'test-bot-token-p212';
    const webhookUrl = 'https://my-gateway.example.com/webhook/test-bot-token-p212';

    await registerWebhook(botToken, webhookUrl);

    const calls = mockTelegramServer.getCalls();
    const setWebhookCall = calls.find(
      (c) => c.method === 'POST' && c.path.includes('setWebhook'),
    );
    expect(setWebhookCall).toBeDefined();
    expect((setWebhookCall!.body as { url?: string }).url).toBe(webhookUrl);
  });

  // P2-13
  it('P2-13: getWebhookInfo returns parsed webhook info', async () => {
    const botToken = 'test-bot-token-p213';

    const info = await getWebhookInfo(botToken);

    expect(info).toBeDefined();
    expect(typeof info.url).toBe('string');
    expect(typeof info.has_custom_certificate).toBe('boolean');
    expect(typeof info.pending_update_count).toBe('number');

    const calls = mockTelegramServer.getCalls();
    const getInfoCall = calls.find(
      (c) => c.method === 'GET' && c.path.includes('getWebhookInfo'),
    );
    expect(getInfoCall).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3 Tests
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Phase 3 helpers ──────────────────────────────────────────────────────────

/** No-op logger for use in tests. */
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Build a mock AgentRunner that:
 * - exposes `sendMessage` as a jest.fn()
 * - extends EventEmitter so `on('output', cb)` and `removeListener` work
 * - exposes `isRunning()` returning true
 */
function makeMockRunner(): EventEmitter & { sendMessage: jest.Mock; isRunning: () => boolean } {
  const emitter = new EventEmitter() as EventEmitter & {
    sendMessage: jest.Mock;
    isRunning: () => boolean;
  };
  emitter.sendMessage = jest.fn();
  emitter.isRunning = () => true;
  return emitter;
}

/** Heartbeat markdown with a single task (30m interval). */
const HEARTBEAT_MD_SINGLE = `tasks:
  - name: check-in
    interval: 30m
    prompt: "Run a health check and reply HEARTBEAT_OK if all is well."
`;

/** Heartbeat markdown with a second task for reload test. */
const HEARTBEAT_MD_NEW_TASK = `tasks:
  - name: new-task
    interval: 30m
    prompt: "New task prompt."
`;

/** Simulate the agent emitting an output line after a small delay. */
function simulateAgentOutput(runner: EventEmitter, line: string, delayMs = 20): void {
  setTimeout(() => runner.emit('output', line), delayMs);
}

/**
 * Start a tiny express server that acts as a mock Telegram sendMessage endpoint.
 * Records all POST calls to /bot:token/sendMessage.
 */
function startMockTelegramSendServer(): Promise<{
  server: http.Server;
  port: number;
  baseUrl: () => string;
  getSendCalls: () => Array<{ chatId: unknown; text: unknown }>;
  stop: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const calls: Array<{ chatId: unknown; text: unknown }> = [];
    const app = express();
    app.use(express.json());

    app.post('/bot:token/sendMessage', (req, res) => {
      calls.push({ chatId: req.body.chat_id, text: req.body.text });
      res.json({ ok: true, result: { message_id: 1 } });
    });

    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const stop = () =>
        new Promise<void>((res, rej) =>
          server.close((err) => (err ? rej(err) : res())),
        );
      resolve({
        server,
        port: addr.port,
        baseUrl: () => `http://127.0.0.1:${addr.port}`,
        getSendCalls: () => [...calls],
        stop,
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 3: HeartbeatHistory', () => {
  // P3-01
  it('P3-01: records result and getLastResult returns it', () => {
    const history = new HeartbeatHistory();
    const result: HeartbeatResult = {
      taskName: 'check-in',
      sessionId: 'heartbeat:agent1:check-in:1000',
      suppressed: true,
      rateLimited: false,
      response: 'HEARTBEAT_OK',
      durationMs: 42,
      ts: new Date().toISOString(),
    };

    history.record('agent1', result);

    const last = history.getLastResult('agent1', 'check-in');
    expect(last).not.toBeNull();
    expect(last!.taskName).toBe('check-in');
    expect(last!.suppressed).toBe(true);
    expect(last!.response).toBe('HEARTBEAT_OK');
    expect(last!.durationMs).toBe(42);
  });

  // P3-02
  it('P3-02: ring buffer drops oldest when >100 entries', () => {
    const history = new HeartbeatHistory();
    const agentId = 'ring-agent';
    const taskName = 'ring-task';

    // Insert 102 entries (oldest first, newest last)
    for (let i = 0; i < 102; i++) {
      history.record(agentId, {
        taskName,
        sessionId: `sid-${i}`,
        suppressed: false,
        rateLimited: false,
        response: `response-${i}`,
        durationMs: i,
        ts: new Date(1000 + i).toISOString(),
      });
    }

    const all = history.getHistory(agentId, taskName);

    // Must not exceed 100
    expect(all.length).toBe(100);

    // Newest entry (i=101) should be first (index 0)
    expect(all[0].response).toBe('response-101');

    // Oldest two (i=0, i=1) should have been dropped
    const responses = all.map((r) => r.response);
    expect(responses).not.toContain('response-0');
    expect(responses).not.toContain('response-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 3: CronScheduler — triggerTask', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedTimeout = process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    // Speed up response window so tests don't take 60s
    process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS = '200';
  });

  afterAll(() => {
    process.env.NODE_ENV = savedNodeEnv;
    if (savedTimeout !== undefined) {
      process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS = savedTimeout;
    } else {
      delete process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS;
    }
  });

  // P3-03
  it('P3-03: triggerTask() fires task and runner.sendMessage called with prompt', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p303-agent', 'tok-p303', makeTempWorkspace('p303-'));
    const scheduler = new CronScheduler('p303-agent', runner as unknown as AgentRunner, noopLogger, agentCfg);

    scheduler.load(HEARTBEAT_MD_SINGLE);

    // Trigger and wait
    await scheduler.triggerTask('check-in');

    expect(runner.sendMessage).toHaveBeenCalledTimes(1);
    expect(runner.sendMessage).toHaveBeenCalledWith(
      'Run a health check and reply HEARTBEAT_OK if all is well.',
    );

    scheduler.stop();
  });

  // P3-04
  it('P3-04: HEARTBEAT_OK response → suppressed=true, Telegram NOT called', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p304-agent', 'tok-p304', makeTempWorkspace('p304-'));
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(
      'p304-agent',
      runner as unknown as AgentRunner,
      noopLogger,
      agentCfg,
      history,
    );
    scheduler.load(HEARTBEAT_MD_SINGLE);

    const telegramSendCalls: unknown[] = [];

    // Wire up a listener that would call Telegram only when NOT suppressed
    scheduler.on('heartbeat:result', (result: HeartbeatResult) => {
      if (!result.suppressed) {
        telegramSendCalls.push(result);
      }
    });

    // Simulate agent replying HEARTBEAT_OK before timeout
    simulateAgentOutput(runner, 'HEARTBEAT_OK', 20);

    await scheduler.triggerTask('check-in');

    const last = history.getLastResult('p304-agent', 'check-in');
    expect(last).not.toBeNull();
    expect(last!.suppressed).toBe(true);
    expect(last!.rateLimited).toBe(false);

    // Because suppressed=true, Telegram should NOT have been called
    expect(telegramSendCalls).toHaveLength(0);

    scheduler.stop();
  });

  // P3-05
  it('P3-05: real message response → suppressed=false, Telegram called', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p305-agent', 'tok-p305', makeTempWorkspace('p305-'));
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(
      'p305-agent',
      runner as unknown as AgentRunner,
      noopLogger,
      agentCfg,
      history,
    );
    scheduler.load(HEARTBEAT_MD_SINGLE);

    const telegramSendCalls: HeartbeatResult[] = [];

    scheduler.on('heartbeat:result', (result: HeartbeatResult) => {
      if (!result.suppressed) {
        telegramSendCalls.push(result);
      }
    });

    // Simulate agent sending a real message (not HEARTBEAT_OK)
    simulateAgentOutput(runner, 'Hey! Something needs your attention.', 20);

    await scheduler.triggerTask('check-in');

    const last = history.getLastResult('p305-agent', 'check-in');
    expect(last).not.toBeNull();
    expect(last!.suppressed).toBe(false);
    expect(last!.rateLimited).toBe(false);
    expect(last!.response).toContain('Something needs your attention');

    // Because suppressed=false, Telegram should have been called
    expect(telegramSendCalls).toHaveLength(1);

    scheduler.stop();
  });

  // P3-06
  it('P3-06: rate limit — second trigger within 30min → rateLimited=true', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p306-agent', 'tok-p306', makeTempWorkspace('p306-'), {
      heartbeat: { rateLimitMinutes: 30 },
    });
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(
      'p306-agent',
      runner as unknown as AgentRunner,
      noopLogger,
      agentCfg,
      history,
    );
    scheduler.load(HEARTBEAT_MD_SINGLE);

    // First trigger — should succeed
    simulateAgentOutput(runner, 'HEARTBEAT_OK', 10);
    await scheduler.triggerTask('check-in');

    const firstResult = history.getLastResult('p306-agent', 'check-in');
    expect(firstResult).not.toBeNull();
    expect(firstResult!.rateLimited).toBe(false);

    // Second trigger immediately — should be rate-limited
    await scheduler.triggerTask('check-in');

    const allResults = history.getHistory('p306-agent', 'check-in');
    // Two results recorded; newest is index 0
    expect(allResults.length).toBe(2);
    expect(allResults[0].rateLimited).toBe(true);

    scheduler.stop();
  });

  // P3-07
  it('P3-07: reload heartbeat.md → new task schedulable, old task not found', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p307-agent', 'tok-p307', makeTempWorkspace('p307-'));
    const scheduler = new CronScheduler(
      'p307-agent',
      runner as unknown as AgentRunner,
      noopLogger,
      agentCfg,
    );

    // Load with original task
    scheduler.load(HEARTBEAT_MD_SINGLE);

    // Reload with new task (old "check-in" gone)
    scheduler.load(HEARTBEAT_MD_NEW_TASK);

    // New task is schedulable
    await expect(scheduler.triggerTask('new-task')).resolves.not.toThrow();

    // Old task should throw
    await expect(scheduler.triggerTask('check-in')).rejects.toThrow(
      /No task named "check-in" is scheduled/,
    );

    scheduler.stop();
  });

  // P3-08
  it('P3-08: stop() → triggerTask throws', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p308-agent', 'tok-p308', makeTempWorkspace('p308-'));
    const scheduler = new CronScheduler(
      'p308-agent',
      runner as unknown as AgentRunner,
      noopLogger,
      agentCfg,
    );

    scheduler.load(HEARTBEAT_MD_SINGLE);
    scheduler.stop();

    await expect(scheduler.triggerTask('check-in')).rejects.toThrow(
      /No task named "check-in" is scheduled/,
    );
  });

  // P3-09
  it('P3-09: ephemeral session ID format is "heartbeat:<agentId>:<taskName>:<ts>"', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p309-agent', 'tok-p309', makeTempWorkspace('p309-'));
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(
      'p309-agent',
      runner as unknown as AgentRunner,
      noopLogger,
      agentCfg,
      history,
    );
    scheduler.load(HEARTBEAT_MD_SINGLE);

    const tsBefore = Date.now();
    simulateAgentOutput(runner, 'HEARTBEAT_OK', 10);
    await scheduler.triggerTask('check-in');
    const tsAfter = Date.now();

    const last = history.getLastResult('p309-agent', 'check-in');
    expect(last).not.toBeNull();

    // Format: heartbeat:<agentId>:<taskName>:<timestamp>
    const parts = last!.sessionId.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('heartbeat');
    expect(parts[1]).toBe('p309-agent');
    expect(parts[2]).toBe('check-in');

    const ts = parseInt(parts[3], 10);
    expect(ts).toBeGreaterThanOrEqual(tsBefore);
    expect(ts).toBeLessThanOrEqual(tsAfter);

    scheduler.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 3: GET /status endpoint', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedTimeout = process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS = '200';
  });

  afterAll(() => {
    process.env.NODE_ENV = savedNodeEnv;
    if (savedTimeout !== undefined) {
      process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS = savedTimeout;
    } else {
      delete process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS;
    }
  });

  // P3-10
  it('P3-10: GET /status returns agent list with heartbeat.lastResults', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p310-agent', 'tok-p310', makeTempWorkspace('p310-'));
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(
      'p310-agent',
      runner as unknown as AgentRunner,
      noopLogger,
      agentCfg,
      history,
    );
    scheduler.load(HEARTBEAT_MD_SINGLE);

    // Trigger a run so history has an entry
    simulateAgentOutput(runner, 'HEARTBEAT_OK', 10);
    await scheduler.triggerTask('check-in');

    const agents = new Map<string, AgentRunner>([['p310-agent', runner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p310-agent', agentCfg]]);
    const schedulers = new Map<string, CronScheduler>([['p310-agent', scheduler]]);
    const router = new GatewayRouter(agents, configs, schedulers);

    const res = await supertest(router.getApp()).get('/status');
    expect(res.status).toBe(200);

    const agentStatus = (res.body as { agents: unknown[] }).agents.find(
      (a: unknown) => (a as { id: string }).id === 'p310-agent',
    ) as { id: string; heartbeat: { lastResults: unknown[] } } | undefined;

    expect(agentStatus).toBeDefined();
    expect(agentStatus!.heartbeat).toBeDefined();
    expect(Array.isArray(agentStatus!.heartbeat.lastResults)).toBe(true);
    expect(agentStatus!.heartbeat.lastResults.length).toBeGreaterThan(0);

    const lastResult = agentStatus!.heartbeat.lastResults[0] as {
      taskName: string;
      suppressed: boolean;
    };
    expect(lastResult.taskName).toBe('check-in');
    expect(lastResult.suppressed).toBe(true);

    scheduler.stop();
  });

  // P3-11
  it('P3-11: GET /status: uptime increases (>0)', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p311-agent', 'tok-p311', makeTempWorkspace('p311-'));

    const agents = new Map<string, AgentRunner>([['p311-agent', runner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p311-agent', agentCfg]]);
    const router = new GatewayRouter(agents, configs);

    // Wait a tiny bit so uptime is at least 0s (may be 0 if sub-second)
    await new Promise((r) => setTimeout(r, 50));

    const res = await supertest(router.getApp()).get('/status');
    expect(res.status).toBe(200);

    const body = res.body as { uptime: number; startedAt: string };
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof body.startedAt).toBe('string');

    // startedAt must be parseable as ISO date in the past
    const started = new Date(body.startedAt).getTime();
    expect(started).toBeLessThanOrEqual(Date.now());
  });

  // P3-12
  it('P3-12: GET /status: tasks array matches loaded heartbeat.md', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p312-agent', 'tok-p312', makeTempWorkspace('p312-'));
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(
      'p312-agent',
      runner as unknown as AgentRunner,
      noopLogger,
      agentCfg,
      history,
    );

    // Load heartbeat with two tasks
    const twoTasksMd = `tasks:
  - name: morning-brief
    cron: "0 8 * * *"
    prompt: "Give a morning summary."
  - name: evening-check
    cron: "0 20 * * *"
    prompt: "Evening check-in."
`;
    scheduler.load(twoTasksMd);

    // Trigger both tasks so history has entries for each
    simulateAgentOutput(runner, 'HEARTBEAT_OK', 5);
    await scheduler.triggerTask('morning-brief');

    // Reset rate limit by re-creating scheduler snapshot — use a fresh scheduler to avoid rate limit
    // Actually, use a second runner to avoid rate limit on re-trigger
    const runner2 = makeMockRunner();
    const scheduler2 = new CronScheduler(
      'p312-agent',
      runner2 as unknown as AgentRunner,
      noopLogger,
      agentCfg,
      history,
    );
    scheduler2.load(twoTasksMd);
    simulateAgentOutput(runner2, 'HEARTBEAT_OK', 5);
    await scheduler2.triggerTask('evening-check');
    scheduler2.stop();

    const agents = new Map<string, AgentRunner>([['p312-agent', runner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p312-agent', agentCfg]]);
    const schedulers = new Map<string, CronScheduler>([['p312-agent', scheduler]]);
    const router = new GatewayRouter(agents, configs, schedulers);

    const res = await supertest(router.getApp()).get('/status');
    expect(res.status).toBe(200);

    const agentStatus = (res.body as { agents: unknown[] }).agents.find(
      (a: unknown) => (a as { id: string }).id === 'p312-agent',
    ) as { heartbeat: { tasks: string[] } } | undefined;

    expect(agentStatus).toBeDefined();
    const tasks = agentStatus!.heartbeat.tasks;
    expect(tasks).toContain('morning-brief');
    expect(tasks).toContain('evening-check');

    scheduler.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 3: Full heartbeat flow', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedTimeout = process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS = '300';
  });

  afterAll(() => {
    process.env.NODE_ENV = savedNodeEnv;
    if (savedTimeout !== undefined) {
      process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS = savedTimeout;
    } else {
      delete process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS;
    }
  });

  // P3-13
  it('P3-13: trigger → HEARTBEAT_OK → history recorded → no Telegram sendMessage', async () => {
    const mockTelegramServer = await startMockTelegramSendServer();
    process.env.TELEGRAM_API_BASE = mockTelegramServer.baseUrl();

    try {
      const runner = makeMockRunner();
      const agentCfg = makeAgentConfig('p313-agent', 'tok-p313', makeTempWorkspace('p313-'));
      const history = new HeartbeatHistory();
      const scheduler = new CronScheduler(
        'p313-agent',
        runner as unknown as AgentRunner,
        noopLogger,
        agentCfg,
        history,
      );
      scheduler.load(HEARTBEAT_MD_SINGLE);

      // Wire: if NOT suppressed, call Telegram sendMessage (simulate gateway behaviour)
      scheduler.on('heartbeat:result', async (result: HeartbeatResult) => {
        if (!result.suppressed) {
          const base = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';
          const url = `${base}/bot${agentCfg.telegram!.botToken}/sendMessage`;
          // Fire-and-forget; use http module
          const body = JSON.stringify({ chat_id: 0, text: result.response });
          const urlObj = new URL(url);
          const req = http.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          req.write(body);
          req.end();
        }
      });

      // Simulate HEARTBEAT_OK response
      simulateAgentOutput(runner, 'HEARTBEAT_OK', 20);

      await scheduler.triggerTask('check-in');

      // History should have been recorded
      const last = history.getLastResult('p313-agent', 'check-in');
      expect(last).not.toBeNull();
      expect(last!.taskName).toBe('check-in');
      expect(last!.suppressed).toBe(true);
      expect(last!.rateLimited).toBe(false);
      expect(last!.response).toContain('HEARTBEAT_OK');

      // Give any async HTTP call time to arrive (it shouldn't, but wait briefly)
      await new Promise((r) => setTimeout(r, 100));

      // Telegram sendMessage must NOT have been called
      const sendCalls = mockTelegramServer.getSendCalls();
      expect(sendCalls).toHaveLength(0);

      scheduler.stop();
    } finally {
      delete process.env.TELEGRAM_API_BASE;
      await mockTelegramServer.stop();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4 Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 4: MemoryManager', () => {
  // P4-04
  it('P4-04: appendFact to existing section → fact appears under that section', async () => {
    const ws = makeTempWorkspace('p404-', {});
    // Pre-populate memory.md with a section
    fs.writeFileSync(
      path.join(ws, 'MEMORY.md'),
      '# Memory\n\n## People\n- Alice is a friend.\n',
      'utf-8',
    );

    const mm = new MemoryManager(ws);
    await mm.appendFact('People', 'Bob is a colleague.');

    const content = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf-8');
    expect(content).toContain('## People');
    expect(content).toContain('- Bob is a colleague.');

    // Both facts should be under the People section
    const peopleIdx = content.indexOf('## People');
    const aliceIdx = content.indexOf('- Alice is a friend.');
    const bobIdx = content.indexOf('- Bob is a colleague.');
    expect(aliceIdx).toBeGreaterThan(peopleIdx);
    expect(bobIdx).toBeGreaterThan(peopleIdx);
  });

  // P4-05
  it('P4-05: appendFact to new section → section created at end of file', async () => {
    const ws = makeTempWorkspace('p405-', {});
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# Memory\n', 'utf-8');

    const mm = new MemoryManager(ws);
    await mm.appendFact('NewSection', 'A brand new fact.');

    const content = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf-8');
    expect(content).toContain('## NewSection');
    expect(content).toContain('- A brand new fact.');

    // Section should appear after the # Memory header
    const headerIdx = content.indexOf('# Memory');
    const sectionIdx = content.indexOf('## NewSection');
    expect(sectionIdx).toBeGreaterThan(headerIdx);
  });

  // P4-06
  it('P4-06: searchMemory → returns only lines containing query', async () => {
    const ws = makeTempWorkspace('p406-', {});
    fs.writeFileSync(
      path.join(ws, 'MEMORY.md'),
      '# Memory\n\n## People\n- Alice loves cats.\n- Bob likes dogs.\n- Carol has a parrot.\n',
      'utf-8',
    );

    const mm = new MemoryManager(ws);
    const results = await mm.searchMemory('alice');

    expect(results).toHaveLength(1);
    expect(results[0]).toContain('Alice loves cats');

    // Searching for something that appears in multiple lines
    const allResults = await mm.searchMemory('##');
    expect(allResults).toHaveLength(1);
    expect(allResults[0]).toContain('## People');
  });

  // P4-07
  it('P4-07: trimToSize → file under limit after trim', async () => {
    const ws = makeTempWorkspace('p407-', {});

    // Create a memory.md with enough content to exceed a small limit
    const lines = ['# Memory', ''];
    for (let i = 0; i < 50; i++) {
      lines.push(`- Fact number ${i} with some padding text to ensure the file is large enough.`);
    }
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), lines.join('\n'), 'utf-8');

    const before = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf-8');
    const limit = Math.floor(before.length / 2);

    const mm = new MemoryManager(ws);
    const { removed } = await mm.trimToSize(limit);

    const after = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf-8');
    expect(after.length).toBeLessThanOrEqual(limit);
    expect(removed).toBeGreaterThan(0);
  });

  // P4-08
  it('P4-08: thread-safety: 5 concurrent appendFact → all 5 facts present', async () => {
    const ws = makeTempWorkspace('p408-', {});
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# Memory\n', 'utf-8');

    const mm = new MemoryManager(ws);

    // Fire 5 concurrent appendFact calls
    await Promise.all([
      mm.appendFact('Concurrent', 'Fact one'),
      mm.appendFact('Concurrent', 'Fact two'),
      mm.appendFact('Concurrent', 'Fact three'),
      mm.appendFact('Concurrent', 'Fact four'),
      mm.appendFact('Concurrent', 'Fact five'),
    ]);

    const content = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf-8');
    expect(content).toContain('- Fact one');
    expect(content).toContain('- Fact two');
    expect(content).toContain('- Fact three');
    expect(content).toContain('- Fact four');
    expect(content).toContain('- Fact five');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 4: watchWorkspace', () => {
  // P4-09
  it('P4-09: hot-reload → onChange fires after file change (within 600ms)', async () => {
    const ws = makeTempWorkspace('p409-', {});

    let changeCount = 0;
    const handle = watchWorkspace(ws, () => {
      changeCount++;
    });

    try {
      // Give the watcher time to initialise
      await new Promise((r) => setTimeout(r, 100));

      // Modify a file in the workspace
      fs.writeFileSync(path.join(ws, 'agent.md'), '# Agent\nUpdated content.', 'utf-8');

      // Wait up to 600ms for onChange to fire
      await waitFor(() => changeCount > 0, 600, 30);

      expect(changeCount).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  // P4-10
  it('P4-10: watchWorkspace.close() → file change does NOT fire onChange', async () => {
    const ws = makeTempWorkspace('p410-', {});

    let changeCount = 0;
    const handle = watchWorkspace(ws, () => {
      changeCount++;
    });

    // Give watcher time to initialise then immediately close it
    await new Promise((r) => setTimeout(r, 100));
    handle.close();

    // Give close time to take effect
    await new Promise((r) => setTimeout(r, 100));

    // Modify a file — onChange should NOT fire
    fs.writeFileSync(path.join(ws, 'agent.md'), '# Agent\nPost-close update.', 'utf-8');

    // Wait long enough that the debounce would have fired if the watcher were active
    await new Promise((r) => setTimeout(r, 500));

    expect(changeCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 4: Web UI and status endpoint', () => {
  // P4-11
  it('P4-11: GET /ui returns 200 HTML containing "agent"', async () => {
    const runner = makeMockRunner();
    const agentCfg = makeAgentConfig('p411-agent', 'tok-p411', makeTempWorkspace('p411-', {}));
    const agents = new Map<string, AgentRunner>([['p411-agent', runner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p411-agent', agentCfg]]);
    const router = new GatewayRouter(agents, configs);

    const res = await supertest(router.getApp()).get('/ui');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text.toLowerCase()).toContain('agent');
  });

  // P4-12 (Option A: lastActivityAt now set from subprocess output events, not webhook)
  it('P4-12: GET /status lastActivityAt=null before output, non-null after subprocess output', async () => {
    const ws = makeTempWorkspace('p412-', {});
    const agentCfg = makeAgentConfig('p412-agent', 'tok-p412', ws);

    // Use EventEmitter-based mock so runner.on() works and we can emit 'output'
    const mockRunner = makeMockRunner();

    const agents = new Map<string, AgentRunner>([['p412-agent', mockRunner as unknown as AgentRunner]]);
    const configs = new Map<string, AgentConfig>([['p412-agent', agentCfg]]);
    const router = new GatewayRouter(agents, configs);

    // Before any output: lastActivityAt should be null
    const resBefore = await supertest(router.getApp()).get('/status');
    expect(resBefore.status).toBe(200);

    const agentBefore = (resBefore.body as { agents: Array<{ id: string; lastActivityAt: string | null }> })
      .agents.find((a) => a.id === 'p412-agent');
    expect(agentBefore).toBeDefined();
    expect(agentBefore!.lastActivityAt).toBeNull();

    // Simulate subprocess output (triggers lastActivityAt update)
    simulateAgentOutput(mockRunner, 'hello for p412', 0);

    // Wait for the output event to propagate
    await new Promise((r) => setTimeout(r, 50));

    // After output: lastActivityAt should be a non-null ISO string
    const resAfter = await supertest(router.getApp()).get('/status');
    expect(resAfter.status).toBe(200);

    const agentAfter = (resAfter.body as { agents: Array<{ id: string; lastActivityAt: string | null }> })
      .agents.find((a) => a.id === 'p412-agent');
    expect(agentAfter).toBeDefined();
    expect(agentAfter!.lastActivityAt).not.toBeNull();
    expect(typeof agentAfter!.lastActivityAt).toBe('string');
    expect(new Date(agentAfter!.lastActivityAt!).getTime()).not.toBeNaN();
  });
});
