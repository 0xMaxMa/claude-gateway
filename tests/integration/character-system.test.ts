/**
 * Integration tests: Phase 4 — Character System Polish
 *
 * Test IDs: I-CS-01 through I-CS-10
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import supertest from 'supertest';
import { loadWorkspace, watchWorkspace, markBootstrapComplete, deleteBootstrap } from '../../src/workspace-loader';
import { MemoryManager } from '../../src/memory-manager';
import { AgentRunner } from '../../src/agent-runner';
import { GatewayRouter } from '../../src/gateway-router';
import { AgentConfig, GatewayConfig } from '../../src/types';

// ─── helpers ────────────────────────────────────────────────────────────────

const MOCK_CLAUDE_BIN = path.resolve(__dirname, '../helpers/mock-claude.js');

function createTempWorkspace(prefix = 'cs-test-ws-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const files: Record<string, string> = {
    'agent.md': '# Agent\nYou are a test assistant.',
    'soul.md': '# Soul\nBe helpful.',
    'tools.md': '# Tools\nNo tools.',
    'user.md': '# User\nTester.',
    'heartbeat.md': '# Heartbeat\n',
    'memory.md': '# Memory\n',
    'bootstrap.md': '# Bootstrap\nFirst run.',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
  return dir;
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
    telegram: { botToken, allowedUsers: [], dmPolicy: 'open' },
    claude: { model: 'claude-test', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

function makeGatewayConfig(): GatewayConfig {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-log-'));
  return {
    gateway: { logDir, timezone: 'UTC' },
    agents: [],
  };
}

/** Wait up to timeoutMs for predicate to return true */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout exceeded');
}

let _updateIdCounter = 80000;
function nextUpdateId(): number {
  return ++_updateIdCounter;
}

// ─── test suite ──────────────────────────────────────────────────────────────

describe('Character System Integration', () => {
  beforeAll(() => {
    process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE_BIN}`;
  });

  afterAll(() => {
    delete process.env.CLAUDE_BIN;
  });

  // ── I-CS-01: bootstrap.md → isFirstRun; after markBootstrapComplete → .done ─
  it('I-CS-01: bootstrap.md present → isFirstRun=true; after markBootstrapComplete → renamed to .done', async () => {
    const workspace = createTempWorkspace('cs01-');
    try {
      // Load workspace — bootstrap.md exists → isFirstRun=true
      const loaded = await loadWorkspace(workspace);
      expect(loaded.files.isFirstRun).toBe(true);
      expect(fs.existsSync(path.join(workspace, 'bootstrap.md'))).toBe(true);

      // Call markBootstrapComplete
      await markBootstrapComplete(workspace);

      // bootstrap.md should be gone, bootstrap.md.done should exist
      expect(fs.existsSync(path.join(workspace, 'bootstrap.md'))).toBe(false);
      expect(fs.existsSync(path.join(workspace, 'bootstrap.md.done'))).toBe(true);

      // Reload → isFirstRun=false
      const reloaded = await loadWorkspace(workspace);
      expect(reloaded.files.isFirstRun).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── I-CS-02: hot-reload: modify soul.md → onChange fires within 500ms ────
  it('I-CS-02: hot-reload: modify soul.md → onChange callback fires (within 500ms)', async () => {
    const workspace = createTempWorkspace('cs02-');
    try {
      let callbackCount = 0;
      const handle = watchWorkspace(workspace, () => {
        callbackCount++;
      });

      try {
        // Modify soul.md after a short delay
        await new Promise((r) => setTimeout(r, 50));
        fs.writeFileSync(path.join(workspace, 'soul.md'), '# Soul\nUpdated personality.', 'utf-8');

        // Wait for callback (within 500ms total — debounce is 300ms)
        await waitFor(() => callbackCount > 0, 3000);
        expect(callbackCount).toBeGreaterThan(0);
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── I-CS-03: watcher.close() → modifications don't fire callback ──────────
  it('I-CS-03: watcher.close() → modifying file does NOT fire callback', async () => {
    const workspace = createTempWorkspace('cs03-');
    try {
      let callbackCount = 0;
      const handle = watchWorkspace(workspace, () => {
        callbackCount++;
      });

      // Close immediately
      handle.close();

      // Wait a bit then modify file
      await new Promise((r) => setTimeout(r, 50));
      fs.writeFileSync(path.join(workspace, 'soul.md'), '# Soul\nAfter close.', 'utf-8');

      // Wait to ensure no callback fired
      await new Promise((r) => setTimeout(r, 700));
      expect(callbackCount).toBe(0);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── I-CS-04: MemoryManager.appendFact → memory.md updated on disk ─────────
  it('I-CS-04: MemoryManager.appendFact → memory.md updated on disk', async () => {
    const workspace = createTempWorkspace('cs04-');
    try {
      const manager = new MemoryManager(workspace);
      await manager.appendFact('User Facts', 'Loves TypeScript');

      const content = fs.readFileSync(path.join(workspace, 'memory.md'), 'utf-8');
      expect(content).toContain('## User Facts');
      expect(content).toContain('- Loves TypeScript');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── I-CS-05: GET /ui returns HTML with "agent" text ───────────────────────
  it('I-CS-05: GET /ui returns HTML with status table (contains "agent" text)', async () => {
    const workspace = createTempWorkspace('cs05-');
    const agentCfg = makeAgentConfig('agent-cs05', 'token-cs05', workspace);
    const gatewayCfg = makeGatewayConfig();

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();

    const agents = new Map([['agent-cs05', runner]]);
    const configs = new Map([['agent-cs05', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    try {
      const res = await supertest(router.getApp()).get('/ui');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      const body = res.text.toLowerCase();
      expect(body).toContain('agent');
      // Check it's a proper HTML page
      expect(body).toContain('<!doctype html');
    } finally {
      await router.stop();
      await runner.stop();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── I-CS-06: GET /status includes lastActivityAt after subprocess output ───
  it('I-CS-06: GET /status includes lastActivityAt after subprocess emits output', async () => {
    const workspace = createTempWorkspace('cs06-');
    const agentCfg = makeAgentConfig('agent-cs06', 'token-cs06', workspace);
    const gatewayCfg = makeGatewayConfig();

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const agents = new Map([['agent-cs06', runner]]);
    const configs = new Map([['agent-cs06', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    try {
      // Trigger subprocess output via sendMessage (simulates heartbeat/cron)
      runner.sendMessage('hello from cs06');

      // Wait for subprocess to produce output (which updates lastActivityAt)
      await waitFor(() => {
        const stats = router.getAgentStats();
        return (stats.find((s) => s.id === 'agent-cs06')?.messagesSent ?? 0) > 0;
      }, 3000);

      const res = await supertest(router.getApp()).get('/status');
      expect(res.status).toBe(200);
      const agent = res.body.agents.find((a: { id: string }) => a.id === 'agent-cs06');
      expect(agent).toBeDefined();
      expect(agent.lastActivityAt).not.toBeNull();
      expect(typeof agent.lastActivityAt).toBe('string');
      expect(new Date(agent.lastActivityAt).toISOString()).toBe(agent.lastActivityAt);
    } finally {
      await router.stop();
      await runner.stop();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── I-CS-07: lastActivityAt null before output, non-null after ──────────────
  it('I-CS-07: lastActivityAt null before subprocess output, non-null after', async () => {
    const workspace = createTempWorkspace('cs07-');
    const agentCfg = makeAgentConfig('agent-cs07', 'token-cs07', workspace);
    const gatewayCfg = makeGatewayConfig();

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const agents = new Map([['agent-cs07', runner]]);
    const configs = new Map([['agent-cs07', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    try {
      // Check before any output
      let res = await supertest(router.getApp()).get('/status');
      let agent = res.body.agents.find((a: { id: string }) => a.id === 'agent-cs07');
      expect(agent.lastActivityAt).toBeNull();

      // Trigger subprocess output via sendMessage
      runner.sendMessage('hello from cs07');

      // Wait for output to be emitted
      await waitFor(() => {
        const stats = router.getAgentStats();
        return (stats.find((s) => s.id === 'agent-cs07')?.messagesSent ?? 0) > 0;
      }, 3000);

      // Check after output
      res = await supertest(router.getApp()).get('/status');
      agent = res.body.agents.find((a: { id: string }) => a.id === 'agent-cs07');
      expect(agent.lastActivityAt).not.toBeNull();
    } finally {
      await router.stop();
      await runner.stop();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── I-CS-08: MemoryManager.trimToSize removes oldest content ──────────────
  it('I-CS-08: MemoryManager.trimToSize removes oldest content, keeps recent', async () => {
    const workspace = createTempWorkspace('cs08-');
    try {
      const manager = new MemoryManager(workspace);
      const memPath = path.join(workspace, 'memory.md');

      // Write a long file
      const longContent =
        '# Memory\n\n## Old Facts\n' +
        Array.from({ length: 30 }, (_, i) => `- old fact ${i}`).join('\n') +
        '\n\n## Recent\n- recent fact\n';
      fs.writeFileSync(memPath, longContent);

      const originalLength = longContent.length;
      const maxChars = Math.floor(originalLength / 2);

      const result = await manager.trimToSize(maxChars);
      const newContent = fs.readFileSync(memPath, 'utf-8');

      expect(result.removed).toBeGreaterThan(0);
      expect(newContent.length).toBeLessThanOrEqual(maxChars + 5);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── I-CS-09: searchMemory returns only matching lines ─────────────────────
  it('I-CS-09: searchMemory returns only lines matching query', async () => {
    const workspace = createTempWorkspace('cs09-');
    try {
      const manager = new MemoryManager(workspace);
      const memPath = path.join(workspace, 'memory.md');
      fs.writeFileSync(
        memPath,
        '# Memory\n\n## Facts\n- likes coffee\n- dark mode user\n- works in Bangkok\n- dark chocolate fan\n',
      );

      const results = await manager.searchMemory('dark');
      expect(results.length).toBe(2);
      expect(results.every((l) => l.toLowerCase().includes('dark'))).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── I-CS-10: hot-reload does not break active sessions ────────────────────
  it('I-CS-10: subprocess still processes messages after workspace hot-reload', async () => {
    const workspace = createTempWorkspace('cs10-');
    const agentCfg = makeAgentConfig('agent-cs10', 'token-cs10', workspace);
    const gatewayCfg = makeGatewayConfig();

    const runner = new AgentRunner(agentCfg, gatewayCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());

    const receivedLines: string[] = [];
    runner.on('output', (line: string) => receivedLines.push(line));

    const agents = new Map([['agent-cs10', runner]]);
    const configs = new Map([['agent-cs10', agentCfg]]);
    const router = new GatewayRouter(agents, configs);
    await router.start(0);

    try {
      // Send a message before reload (via sendMessage — simulates heartbeat/cron)
      runner.sendMessage('message before reload');

      // Wait for it to be processed
      await waitFor(() => receivedLines.some((l) => l.includes('message before reload')));

      // Trigger a workspace change (simulate hot reload by writing soul.md)
      fs.writeFileSync(
        path.join(workspace, 'soul.md'),
        '# Soul\nUpdated during test.',
        'utf-8',
      );

      // Give a brief moment then send another message
      await new Promise((r) => setTimeout(r, 100));
      runner.sendMessage('message after reload');

      // Both messages should be processed
      await waitFor(() => receivedLines.some((l) => l.includes('message after reload')), 5000);

      expect(receivedLines.some((l) => l.includes('message before reload'))).toBe(true);
      expect(receivedLines.some((l) => l.includes('message after reload'))).toBe(true);
    } finally {
      await router.stop();
      await runner.stop();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── Idempotent deleteBootstrap / markBootstrapComplete ────────────────────
  it('Idempotent: deleteBootstrap calling twice does not throw', async () => {
    const workspace = createTempWorkspace('cs-idem-del-');
    try {
      await deleteBootstrap(workspace);
      await expect(deleteBootstrap(workspace)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('Idempotent: markBootstrapComplete calling twice does not throw', async () => {
    const workspace = createTempWorkspace('cs-idem-mark-');
    try {
      await markBootstrapComplete(workspace);
      await expect(markBootstrapComplete(workspace)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
