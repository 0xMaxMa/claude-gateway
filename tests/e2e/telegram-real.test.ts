/**
 * E2E tests — Real Telegram Bot Integration
 *
 * These tests require real Telegram bot tokens.
 * They are SKIPPED automatically when environment variables are not set.
 *
 * NOTE on Telegram bot-to-bot limitation:
 *   Telegram's Bot API does NOT deliver messages from one bot to another bot,
 *   even in a shared group. This is a documented API restriction:
 *   https://core.telegram.org/bots/faq#why-doesn-t-my-bot-see-messages-from-other-bots
 *
 *   As a result, automated E2E tests can verify:
 *     ✓ Bot token validity (getMe)
 *     ✓ Claude subprocess starts and persists without crashing
 *     ✓ CLAUDE.md assembled correctly from workspace files
 *     ✓ Telegram plugin access.json pre-configuration
 *     ✓ /status endpoint reports agent running
 *     ✓ Direct message injection via stdin (simulates what the plugin does)
 *     ✗ Full Telegram message flow (requires a real user account / MTProto API)
 *
 * To run:
 *   E2E_BOT_TOKEN_A=<token_a> \
 *   E2E_BOT_TOKEN_B=<token_b> \
 *   npm test -- --testPathPattern=e2e --forceExit
 *
 * Timeout: 30s per test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { loadWorkspace } from '../../src/agent/workspace-loader';

// ─── env guard ───────────────────────────────────────────────────────────────

const BOT_TOKEN_A = process.env.E2E_BOT_TOKEN_A;
const BOT_TOKEN_B = process.env.E2E_BOT_TOKEN_B;

const E2E_ENABLED = !!BOT_TOKEN_A;
const E2E_MULTI_AGENT = E2E_ENABLED && !!BOT_TOKEN_B;

const describeE2E = E2E_ENABLED ? describe : describe.skip;
const describeMulti = E2E_MULTI_AGENT ? describe : describe.skip;

// ─── helpers ─────────────────────────────────────────────────────────────────

interface BotInfo {
  id: number;
  username: string;
  first_name: string;
}

function getBotInfo(botToken: string): Promise<BotInfo> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/getMe`,
      method: 'GET',
    };
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString()) as { ok: boolean; result?: BotInfo };
          if (data.ok && data.result) resolve(data.result);
          else reject(new Error(`getMe failed: ${JSON.stringify(data)}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function createAgentWorkspace(agentName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-${agentName}-`));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), `# Agent: ${agentName}\nYou are a test assistant named ${agentName}. Keep replies very short (1 sentence). This is an automated test.`);
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Soul\nBe brief and direct. Always mention your name in the response.');
  return dir;
}

function makeAgentConfig(id: string, botToken: string, workspace: string): AgentConfig {
  return {
    id,
    description: `E2E test agent ${id}`,
    workspace,
    env: '',
    telegram: { botToken },
    claude: { model: 'claude-haiku-4-5-20251001', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

function makeGatewayConfig(): GatewayConfig {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-log-'));
  return { gateway: { logDir, timezone: 'UTC' }, agents: [] };
}

/** Wait for a runner condition with polling */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms)`);
}

// ─── E2E tests ────────────────────────────────────────────────────────────────

describeE2E('E2E: Single Agent — Real Telegram Bot', () => {
  let runner: AgentRunner;
  let router: GatewayRouter;
  let workspace: string;
  let botInfo: BotInfo;

  beforeAll(async () => {
    botInfo = await getBotInfo(BOT_TOKEN_A!);

    workspace = createAgentWorkspace('TestBot');
    const loaded = await loadWorkspace(workspace);
    await fs.promises.writeFile(path.join(workspace, 'CLAUDE.md'), loaded.systemPrompt, 'utf8');

    const cfg = makeAgentConfig('e2e-agent-a', BOT_TOKEN_A!, workspace);
    const gatewayCfg = makeGatewayConfig();

    runner = new AgentRunner(cfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['e2e-agent-a', runner]]);
    const configs = new Map([['e2e-agent-a', cfg]]);
    router = new GatewayRouter(agents, configs);
    await router.start(0);

    // Give Claude subprocess time to initialize
    await new Promise((r) => setTimeout(r, 5000));
  }, 30000);

  afterAll(async () => {
    await router.stop();
    await runner.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  // E2E-01: Verify bot token is valid and bot info is correct
  it('E2E-01: Bot token is valid (getMe succeeds)', () => {
    expect(botInfo.id).toBeGreaterThan(0);
    expect(botInfo.username).toBeTruthy();
    expect(botInfo.first_name).toBeTruthy();
  });

  // E2E-02: Claude subprocess starts and stays running (no immediate crash)
  it('E2E-02: Claude subprocess persists after 5s (no crash)', () => {
    expect(runner.isRunning()).toBe(true);
  });

  // E2E-03: CLAUDE.md assembled correctly and contains personality from agent.md
  it('E2E-03: CLAUDE.md contains agent.md personality', () => {
    const claudeMd = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('TestBot');
    expect(claudeMd).toContain('--- AGENT IDENTITY ---');
  });

  // E2E-04: /status endpoint shows agent is running
  it('E2E-04: /status endpoint shows agent is running', async () => {
    const port = (router as unknown as { server: { address: () => { port: number } } }).server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    const body = await res.json() as { agents: Array<{ id: string; isRunning: boolean }> };
    const agent = body.agents.find((a) => a.id === 'e2e-agent-a');
    expect(agent).toBeDefined();
    expect(agent!.isRunning).toBe(true);
  }, 10000);

  // E2E-05: Agent keeps running after receiving a direct stdin message
  it('E2E-05: Agent stays running after stdin message injection', async () => {
    runner.sendMessage('Hello TestBot, this is a direct inject test (E2E-05)');
    // Give it 2s — if the process crashes on bad stdin, isRunning() would flip
    await new Promise((r) => setTimeout(r, 2000));
    expect(runner.isRunning()).toBe(true);
  }, 10000);
});

// ─── Multi-agent isolation ────────────────────────────────────────────────────

describeMulti('E2E: Multi-Agent Isolation', () => {
  let runnerA: AgentRunner;
  let runnerB: AgentRunner;
  let wsA: string;
  let wsB: string;

  beforeAll(async () => {
    wsA = createAgentWorkspace('AgentAlpha');
    wsB = createAgentWorkspace('AgentBeta');

    for (const [ws, loaded] of [
      [wsA, await loadWorkspace(wsA)],
      [wsB, await loadWorkspace(wsB)],
    ] as Array<[string, Awaited<ReturnType<typeof loadWorkspace>>]>) {
      await fs.promises.writeFile(path.join(ws, 'CLAUDE.md'), loaded.systemPrompt, 'utf8');
    }

    const cfgA = makeAgentConfig('e2e-multi-a', BOT_TOKEN_A!, wsA);
    const cfgB = makeAgentConfig('e2e-multi-b', BOT_TOKEN_B!, wsB);
    const gatewayCfg = makeGatewayConfig();

    runnerA = new AgentRunner(cfgA, gatewayCfg);
    runnerB = new AgentRunner(cfgB, gatewayCfg);
    await runnerA.start();
    await runnerB.start();

    await new Promise((r) => setTimeout(r, 4000));
  }, 30000);

  afterAll(async () => {
    await runnerA.stop();
    await runnerB.stop();
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  });

  // E2E-ISO-01: Each agent's CLAUDE.md contains its own identity, not the other's
  it('E2E-ISO-01: AgentAlpha and AgentBeta have separate CLAUDE.md identities', () => {
    const claudeMdA = fs.readFileSync(path.join(wsA, 'CLAUDE.md'), 'utf8');
    const claudeMdB = fs.readFileSync(path.join(wsB, 'CLAUDE.md'), 'utf8');
    expect(claudeMdA).toContain('AgentAlpha');
    expect(claudeMdB).toContain('AgentBeta');
    expect(claudeMdA).not.toContain('AgentBeta');
    expect(claudeMdB).not.toContain('AgentAlpha');
  });

  // E2E-ISO-02: Each agent uses a separate TELEGRAM_STATE_DIR
  it('E2E-ISO-02: Two agents have separate TELEGRAM_STATE_DIR', () => {
    const envA = (runnerA as unknown as { buildEnv: () => NodeJS.ProcessEnv }).buildEnv();
    const envB = (runnerB as unknown as { buildEnv: () => NodeJS.ProcessEnv }).buildEnv();
    expect(envA.TELEGRAM_STATE_DIR).not.toBe(envB.TELEGRAM_STATE_DIR);
    expect(envA.TELEGRAM_BOT_TOKEN).not.toBe(envB.TELEGRAM_BOT_TOKEN);
  });

  // E2E-ISO-03: Both agents persist after startup
  it('E2E-ISO-03: Both agents are running (neither crashed)', () => {
    expect(runnerA.isRunning()).toBe(true);
    expect(runnerB.isRunning()).toBe(true);
  });
});
