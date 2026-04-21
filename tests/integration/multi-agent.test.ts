/**
 * Integration tests: Multi-Agent Routing (Option A architecture)
 *
 * Each agent has its own claude subprocess + separate workspace + separate TELEGRAM_STATE_DIR.
 * GatewayRouter is monitoring-only. Routing is handled by Claude plugin per bot token.
 *
 * Test IDs: I-MA-01 through I-MA-10
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import supertest from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { ContextIsolationGuard, WorkspaceConflictError, TokenConflictError } from '../../src/agent/context-isolation';
import { SessionStore } from '../../src/session/store';
import { SessionProcess } from '../../src/session/process';

// ─── helpers ────────────────────────────────────────────────────────────────

const MOCK_CLAUDE_BIN = path.resolve(__dirname, '../helpers/mock-claude.js');

let _updateIdCounter = 10000;
function nextUpdateId(): number {
  return ++_updateIdCounter;
}
void nextUpdateId; // available for future tests

function createTempWorkspace(prefix = 'ma-test-ws-'): string {
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

function createTempDir(prefix = 'ma-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
    telegram: { botToken },
    claude: { model: 'claude-test', dangerouslySkipPermissions: false, extraFlags: [] },
    ...extra,
  };
}

function makeGatewayConfig(logDir: string): GatewayConfig {
  return {
    gateway: { logDir, timezone: 'UTC' },
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

describe('Multi-Agent (Option A)', () => {
  beforeAll(() => {
    process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE_BIN}`;
  });

  afterAll(() => {
    delete process.env.CLAUDE_BIN;
  });

  // ─── I-MA-01 ──────────────────────────────────────────────────────────────
  it('I-MA-01: Two agents start independently with separate workspaces', async () => {
    const ws1 = createTempWorkspace('ma01-a-');
    const ws2 = createTempWorkspace('ma01-b-');
    const logDir = createTempDir('ma01-log-');
    const cfg1 = makeAgentConfig('ma01-alpha', 'token-ma01-a', ws1);
    const cfg2 = makeAgentConfig('ma01-beta', 'token-ma01-b', ws2);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner1 = new AgentRunner(cfg1, gatewayCfg);
    const runner2 = new AgentRunner(cfg2, gatewayCfg);

    await runner1.start();
    await runner2.start();

    await waitFor(() => runner1.isRunning() && runner2.isRunning());

    expect(runner1.isRunning()).toBe(true);
    expect(runner2.isRunning()).toBe(true);
    expect(ws1).not.toBe(ws2);

    await runner1.stop();
    await runner2.stop();
  });

  // ─── I-MA-02: TELEGRAM_STATE_DIR set per agent ───────────────────────────
  it('I-MA-02: SessionProcess writes workspace-scoped TELEGRAM_STATE_DIR and BOT_TOKEN in MCP config', () => {
    const ws = createTempWorkspace('ma02-');
    const logDir = createTempDir('ma02-log-');
    const cfg = makeAgentConfig('ma02-agent', 'token-ma02', ws);
    const gatewayCfg = makeGatewayConfig(logDir);
    const baseDir = path.resolve(ws, '..', '..');
    const store = new SessionStore(baseDir);

    const proc = new SessionProcess('chat-ma02', 'telegram', cfg, gatewayCfg, store);
    // writeMcpConfig is private — access via reflection to test the generated file
    const configPath = (proc as unknown as { writeMcpConfig: () => string | null }).writeMcpConfig();

    expect(configPath).not.toBeNull();
    const mcpConfig = JSON.parse(fs.readFileSync(configPath!, 'utf-8'));
    const env = mcpConfig.mcpServers.gateway.env;

    expect(env.TELEGRAM_STATE_DIR).toBeDefined();
    expect(env.TELEGRAM_STATE_DIR).toBe(path.join(ws, '.telegram-state'));
    expect(env.TELEGRAM_BOT_TOKEN).toBe('token-ma02');
  });

  // ─── I-MA-03: Two agents have separate TELEGRAM_STATE_DIR ──────────────────
  it('I-MA-03: Two agents have different TELEGRAM_STATE_DIR paths in MCP config', () => {
    const ws1 = createTempWorkspace('ma03-a-');
    const ws2 = createTempWorkspace('ma03-b-');
    const logDir = createTempDir('ma03-log-');
    const cfg1 = makeAgentConfig('ma03-alpha', 'token-ma03-a', ws1);
    const cfg2 = makeAgentConfig('ma03-beta', 'token-ma03-b', ws2);
    const gatewayCfg = makeGatewayConfig(logDir);
    const base1 = path.resolve(ws1, '..', '..');
    const base2 = path.resolve(ws2, '..', '..');
    const store1 = new SessionStore(base1);
    const store2 = new SessionStore(base2);

    const proc1 = new SessionProcess('chat-ma03', 'telegram', cfg1, gatewayCfg, store1);
    const proc2 = new SessionProcess('chat-ma03', 'telegram', cfg2, gatewayCfg, store2);

    const configPath1 = (proc1 as unknown as { writeMcpConfig: () => string | null }).writeMcpConfig();
    const configPath2 = (proc2 as unknown as { writeMcpConfig: () => string | null }).writeMcpConfig();

    const env1 = JSON.parse(fs.readFileSync(configPath1!, 'utf-8')).mcpServers.gateway.env;
    const env2 = JSON.parse(fs.readFileSync(configPath2!, 'utf-8')).mcpServers.gateway.env;

    expect(env1.TELEGRAM_STATE_DIR).not.toBe(env2.TELEGRAM_STATE_DIR);
    expect(env1.TELEGRAM_STATE_DIR).toBe(path.join(ws1, '.telegram-state'));
    expect(env2.TELEGRAM_STATE_DIR).toBe(path.join(ws2, '.telegram-state'));
  });

  // ─── I-MA-04 ──────────────────────────────────────────────────────────────
  it('I-MA-04: listAgents() returns both agents', async () => {
    const ws1 = createTempWorkspace('ma04-a-');
    const ws2 = createTempWorkspace('ma04-b-');
    const logDir = createTempDir('ma04-log-');
    const cfg1 = makeAgentConfig('ma04-alpha', 'token-ma04-a', ws1);
    const cfg2 = makeAgentConfig('ma04-beta', 'token-ma04-b', ws2);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner1 = new AgentRunner(cfg1, gatewayCfg);
    const runner2 = new AgentRunner(cfg2, gatewayCfg);
    await runner1.start();
    await runner2.start();

    const agents = new Map<string, AgentRunner>([
      ['ma04-alpha', runner1],
      ['ma04-beta', runner2],
    ]);
    const configs = new Map<string, AgentConfig>([
      ['ma04-alpha', cfg1],
      ['ma04-beta', cfg2],
    ]);
    const router = new GatewayRouter(agents, configs);

    const listed = router.listAgents();
    expect(listed).toHaveLength(2);
    const ids = listed.map((a) => a.id);
    expect(ids).toContain('ma04-alpha');
    expect(ids).toContain('ma04-beta');

    await runner1.stop();
    await runner2.stop();
  });

  // ─── I-MA-05: getAgentStats returns per-agent data ────────────────────────
  it('I-MA-05: getAgentStats() returns stats for all agents', async () => {
    const ws1 = createTempWorkspace('ma05-a-');
    const ws2 = createTempWorkspace('ma05-b-');
    const logDir = createTempDir('ma05-log-');
    const cfg1 = makeAgentConfig('ma05-alpha', 'token-ma05-a', ws1);
    const cfg2 = makeAgentConfig('ma05-beta', 'token-ma05-b', ws2);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner1 = new AgentRunner(cfg1, gatewayCfg);
    const runner2 = new AgentRunner(cfg2, gatewayCfg);
    await runner1.start();
    await runner2.start();
    await waitFor(() => runner1.isRunning() && runner2.isRunning());

    const agents = new Map<string, AgentRunner>([
      ['ma05-alpha', runner1],
      ['ma05-beta', runner2],
    ]);
    const configs = new Map<string, AgentConfig>([
      ['ma05-alpha', cfg1],
      ['ma05-beta', cfg2],
    ]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    // Wait briefly so that initial-prompt echoes from both subprocesses arrive
    // and are counted before we snapshot the baseline.
    await new Promise(r => setTimeout(r, 200));

    // Snapshot baseline counts (initial-prompt echoes may have arrived already)
    const baseline = router.getAgentStats();
    const alphaBaseline = baseline.find((s) => s.id === 'ma05-alpha')?.messagesSent ?? 0;
    const betaBaseline = baseline.find((s) => s.id === 'ma05-beta')?.messagesSent ?? 0;

    // messagesSent is tracked from subprocess output (via runner 'output' events).
    // Send to runner1 stdin and wait for its count to increment.
    runner1.sendMessage('ping from alpha');
    await waitFor(async () => {
      const stats = router.getAgentStats();
      return (stats.find((s) => s.id === 'ma05-alpha')?.messagesSent ?? 0) > alphaBaseline;
    }, 3000);

    const stats = router.getAgentStats();
    expect(stats).toHaveLength(2);

    const alphaStats = stats.find((s) => s.id === 'ma05-alpha');
    const betaStats = stats.find((s) => s.id === 'ma05-beta');

    expect(alphaStats).toBeDefined();
    expect(betaStats).toBeDefined();
    // Alpha's count increased (ping echo received)
    expect(alphaStats!.messagesSent).toBeGreaterThan(alphaBaseline);
    // Beta's count did not increase (no message sent to beta)
    expect(betaStats!.messagesSent).toBe(betaBaseline);

    await router.stop();
    await runner1.stop();
    await runner2.stop();
  });

  // ─── I-MA-06 ──────────────────────────────────────────────────────────────
  it('I-MA-06: ContextIsolationGuard throws WorkspaceConflictError on duplicate workspace', () => {
    const sharedWs = createTempWorkspace('ma06-shared-');
    const cfg1 = makeAgentConfig('ma06-agent1', 'token-ma06-a', sharedWs);
    const cfg2 = makeAgentConfig('ma06-agent2', 'token-ma06-b', sharedWs);

    const guard = new ContextIsolationGuard();
    expect(() => guard.validate([cfg1, cfg2])).toThrow(WorkspaceConflictError);
    expect(() => guard.validate([cfg1, cfg2])).toThrow(/ma06-agent1.*ma06-agent2|ma06-agent2.*ma06-agent1/);
  });

  // ─── I-MA-07 ──────────────────────────────────────────────────────────────
  it('I-MA-07: ContextIsolationGuard throws TokenConflictError on duplicate token', () => {
    const ws1 = createTempWorkspace('ma07-a-');
    const ws2 = createTempWorkspace('ma07-b-');
    const cfg1 = makeAgentConfig('ma07-agent1', 'same-token', ws1);
    const cfg2 = makeAgentConfig('ma07-agent2', 'same-token', ws2);

    const guard = new ContextIsolationGuard();
    expect(() => guard.validate([cfg1, cfg2])).toThrow(TokenConflictError);
    expect(() => guard.validate([cfg1, cfg2])).toThrow(/ma07-agent1.*ma07-agent2|ma07-agent2.*ma07-agent1/);
  });

  // ─── I-MA-08 ──────────────────────────────────────────────────────────────
  it('I-MA-08: Agent-A failure at startup does not stop Agent-B from starting', async () => {
    const badWorkspace = path.join(os.tmpdir(), `ma08-nonexistent-${Date.now()}`);
    const ws2 = createTempWorkspace('ma08-b-');
    const logDir = createTempDir('ma08-log-');
    const cfgA = makeAgentConfig('ma08-alpha', 'token-ma08-a', badWorkspace);
    const cfgB = makeAgentConfig('ma08-beta', 'token-ma08-b', ws2);
    const gatewayCfg = makeGatewayConfig(logDir);

    const agentRunners = new Map<string, AgentRunner>();
    const agentConfigs = new Map<string, AgentConfig>();

    for (const agentConfig of [cfgA, cfgB]) {
      if (!fs.existsSync(agentConfig.workspace)) {
        continue;
      }
      const runner = new AgentRunner(agentConfig, gatewayCfg);
      await runner.start();
      agentRunners.set(agentConfig.id, runner);
      agentConfigs.set(agentConfig.id, agentConfig);
    }

    expect(agentRunners.has('ma08-alpha')).toBe(false);
    expect(agentRunners.has('ma08-beta')).toBe(true);

    const runner = agentRunners.get('ma08-beta')!;
    await waitFor(() => runner.isRunning());
    expect(runner.isRunning()).toBe(true);

    await runner.stop();
  });

  // ─── I-MA-09: /health lists all running agents ────────────────────────────
  it('I-MA-09: /health lists all running agents (replaces webhook routing test)', async () => {
    const ws1 = createTempWorkspace('ma09-a-');
    const ws2 = createTempWorkspace('ma09-b-');
    const logDir = createTempDir('ma09-log-');
    const cfg1 = makeAgentConfig('ma09-alpha', 'token-ma09-a', ws1);
    const cfg2 = makeAgentConfig('ma09-beta', 'token-ma09-b', ws2);
    const gatewayCfg = makeGatewayConfig(logDir);

    const runner1 = new AgentRunner(cfg1, gatewayCfg);
    const runner2 = new AgentRunner(cfg2, gatewayCfg);
    await runner1.start();
    await runner2.start();
    await waitFor(() => runner1.isRunning() && runner2.isRunning());

    const agents = new Map<string, AgentRunner>([
      ['ma09-alpha', runner1],
      ['ma09-beta', runner2],
    ]);
    const configs = new Map<string, AgentConfig>([
      ['ma09-alpha', cfg1],
      ['ma09-beta', cfg2],
    ]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    const res = await supertest(router.getApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.agents).toContain('ma09-alpha');
    expect(res.body.agents).toContain('ma09-beta');

    await router.stop();
    await runner1.stop();
    await runner2.stop();
  });

  // ─── I-MA-10 ──────────────────────────────────────────────────────────────
  it('I-MA-10: Cross-agent session isolation: agent-A and agent-B have separate .jsonl files', async () => {
    const baseDir = createTempDir('ma10-sessions-');
    const store = new SessionStore(baseDir);

    const chatId = '99999';

    await store.appendMessage('ma10-agent-a', chatId, {
      role: 'user',
      content: 'Message from agent A context',
      ts: Date.now(),
    });

    await store.appendMessage('ma10-agent-b', chatId, {
      role: 'user',
      content: 'Message from agent B context',
      ts: Date.now(),
    });

    const sessA = await store.loadSession('ma10-agent-a', chatId);
    const sessB = await store.loadSession('ma10-agent-b', chatId);

    expect(sessA).toHaveLength(1);
    expect(sessA[0].content).toBe('Message from agent A context');

    expect(sessB).toHaveLength(1);
    expect(sessB[0].content).toBe('Message from agent B context');

    const fileA = path.join(baseDir, 'ma10-agent-a', 'sessions', `${chatId}.jsonl`);
    const fileB = path.join(baseDir, 'ma10-agent-b', 'sessions', `${chatId}.jsonl`);
    expect(fs.existsSync(fileA)).toBe(true);
    expect(fs.existsSync(fileB)).toBe(true);
    expect(fileA).not.toBe(fileB);

    const contentA = fs.readFileSync(fileA, 'utf-8');
    const contentB = fs.readFileSync(fileB, 'utf-8');
    expect(contentA).toContain('agent A context');
    expect(contentB).toContain('agent B context');
    expect(contentA).not.toContain('agent B context');
    expect(contentB).not.toContain('agent A context');
  });
});
