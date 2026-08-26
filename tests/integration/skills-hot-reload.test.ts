/**
 * Integration tests for skills hot-reload end-to-end:
 * Watcher detects SKILL.md change -> workspace reloads -> CLAUDE.md rewritten
 * -> registry refreshed -> idle session subprocesses stopped so the next message
 * re-spawns with the updated system prompt.
 *
 * Mirrors the wiring in src/index.ts (watchSkills callback) while keeping the
 * subprocess layer fully mocked through the existing child_process jest mock
 * used by agent-runner.test.ts.
 *
 * HR1 — add shared skill triggers restart of idle session
 * HR2 — modify shared skill triggers restart
 * HR3 — delete shared skill triggers restart
 * HR4 — busy session is NOT stopped; CLAUDE.md still refreshed
 * HR5 — module-dir skill change behaves the same as shared-dir change
 * HR6 — busy session survives EVEN AFTER its turn completes (no self-restart
 *       footgun): the skills-reload path must pass skipBusy:true, otherwise a
 *       session that triggered the SKILL.md change is stopped the instant its
 *       turn ends. Regression guard for the missing skipBusy on src/index.ts.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock child_process to prevent real subprocess spawns ──────────────────────

interface MockStdin {
  writable: boolean;
  write: jest.Mock;
}

interface MockChildProcess extends EventEmitter {
  stdin: MockStdin | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

const allProcesses: MockChildProcess[] = [];

function makeMockProcess(): MockChildProcess {
  const stdin: MockStdin = { writable: true, write: jest.fn() };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const proc = new EventEmitter() as MockChildProcess;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 90000) + 10000;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = true;
    process.nextTick(() => proc.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  });

  allProcesses.push(proc);
  return proc;
}

jest.mock('child_process', () => ({
  spawn: jest.fn((..._args) => makeMockProcess()),
}));

// ── Imports (after jest.mock) ─────────────────────────────────────────────────

import { AgentRunner } from '../../src/agent/runner';
import { loadWorkspace } from '../../src/agent/workspace-loader';
import { watchSkills } from '../../src/skills/watcher';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { SessionProcess } from '../../src/session/process';
import type { WatchHandle } from '../../src/watch/factory';
import { waitForCondition } from '../helpers/wait-for';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'alfred',
    description: 'hot-reload integration agent',
    workspace,
    env: '',
    telegram: {
      botToken: 'test-token',
    },
    claude: {
      model: 'claude-opus-4-6',
      dangerouslySkipPermissions: false,
      extraFlags: [],
    },
  };
}

function makeGatewayConfig(): GatewayConfig {
  return {
    gateway: { logDir: '/tmp/test-hr-logs', timezone: 'UTC' },
    agents: [],
  };
}

async function sendChannelPost(
  port: number,
  chatId: string,
  content: string,
): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      meta: {
        chat_id: chatId,
        message_id: '1',
        user: 'tester',
        ts: new Date().toISOString(),
      },
    }),
  });
}

function getCallbackPort(runner: AgentRunner): number {
  return (runner as unknown as { callbackPort: number }).callbackPort;
}

function getSessions(runner: AgentRunner): Map<string, SessionProcess> {
  return (runner as unknown as { sessions: Map<string, SessionProcess> }).sessions;
}

function setLastActivity(proc: SessionProcess, msAgo: number): void {
  (proc as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - msAgo;
}

function writeSkillFile(dir: string, name: string, body = ''): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const frontmatter = `---\nname: ${name}\ndescription: integration test skill ${name}\nuser-invocable: true\n---\n\n${body || `# ${name}`}\n`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), frontmatter);
}

function deleteSkillFile(dir: string, name: string): void {
  fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

// Replicates the inline watcher callback in src/index.ts so the integration
// test exercises the same sequence (reload -> setSkillRegistry ->
// write CLAUDE.md -> restartOrDefer). Must stay a faithful mirror of the
// production callback, including the { skipBusy: true, deferIdle: true } guard
// on the skills path: skipBusy avoids the self-restart footgun for the busy
// authoring session (see HR6), and deferIdle keeps idle bystanders alive
// (armed for a lossless respawn on their next message) instead of SIGKILLing
// them for zero benefit — CLAUDE.md's skills section is frozen-at-spawn.
function wireSkillsWatcher(
  runner: AgentRunner,
  workspaceDir: string,
  sharedSkillsDir: string,
  mcpToolsDir: string,
): WatchHandle {
  const workspaceSkillsDir = path.join(workspaceDir, 'skills');
  return watchSkills({
    dirs: [workspaceSkillsDir, mcpToolsDir, sharedSkillsDir],
    debounceMs: 50,
    onChange: async () => {
      const updated = await loadWorkspace(workspaceDir, {
        mcpToolsDir,
        sharedSkillsDir,
      });
      if (updated.skillRegistry) {
        runner.setSkillRegistry(updated.skillRegistry);
      }
      await fs.promises.writeFile(
        path.join(workspaceDir, 'CLAUDE.md'),
        updated.systemPrompt,
        'utf8',
      );
      await runner.restartOrDefer({ skipBusy: true, deferIdle: true });
    },
  });
}

// Read the runner's private pendingRestarts set (armed idle sessions that will
// respawn on their next message). Used to assert deferral instead of stop.
function hasPendingRestart(runner: AgentRunner, chatId: string): boolean {
  return (runner as unknown as { pendingRestarts: Set<string> }).pendingRestarts.has(chatId);
}


// ── Test suite ────────────────────────────────────────────────────────────────

describe('Skills hot-reload end-to-end', () => {
  let tmpRoot: string;
  let workspaceDir: string;
  let sharedSkillsDir: string;
  let mcpToolsDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;
  let watcher: WatchHandle;

  beforeEach(() => {
    // Plain text is now coalesced too (#290) — shrink the debounce so a lone
    // 'hello' spawns almost immediately, as these tests assume.
    process.env.CHANNEL_COALESCE_WINDOW_MS = '20';
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-hotreload-'));
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Integration Agent\n');
    // Pre-create the workspace skills dir so chokidar has something to attach to
    // when the watcher starts. (It only walks existing paths up to `depth`.)
    fs.mkdirSync(path.join(workspaceDir, 'skills'), { recursive: true });

    sharedSkillsDir = path.join(tmpRoot, 'shared-skills');
    fs.mkdirSync(sharedSkillsDir, { recursive: true });

    mcpToolsDir = path.join(tmpRoot, 'mcp-tools');
    fs.mkdirSync(mcpToolsDir, { recursive: true });

    agentConfig = makeAgentConfig(workspaceDir);
    gatewayConfig = makeGatewayConfig();

    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    await watcher?.close();
    if (runner) {
      await runner.stop();
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    jest.clearAllMocks();
    delete process.env.CHANNEL_COALESCE_WINDOW_MS;
  });

  async function bootRunnerWithIdleSession(chatId: string): Promise<SessionProcess> {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);
    await sendChannelPost(port, chatId, 'hello');
    await waitForCondition(() => getSessions(runner).has(chatId));
    const sess = getSessions(runner).get(chatId)!;
    expect(sess).toBeDefined();
    // Simulate turn completed so restartOrDefer() stops the session immediately.
    sess.setProcessing(false);
    return sess;
  }

  // --------------------------------------------------------------------------
  // HR1 — add shared skill DEFERS idle session (armed, not SIGKILLed) + updates
  //       CLAUDE.md. The idle bystander stays in the pool and respawns on its
  //       next message; killing it now would buy nothing (frozen-at-spawn).
  // --------------------------------------------------------------------------
  it('HR1: adding a shared skill defers idle session (not stopped) and updates CLAUDE.md', async () => {
    await bootRunnerWithIdleSession('chat:hr1');
    watcher = wireSkillsWatcher(runner, workspaceDir, sharedSkillsDir, mcpToolsDir);

    await watcher.ready;
    writeSkillFile(sharedSkillsDir, 'hr1-skill');

    // The onChange armed a deferred restart rather than stopping the session.
    await waitForCondition(() => hasPendingRestart(runner, 'chat:hr1'));
    // Idle bystander is NOT dropped from the pool — it is still alive, armed.
    expect(getSessions(runner).has('chat:hr1')).toBe(true);

    const claudeMd = fs.readFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('/hr1-skill');
    expect(claudeMd).toContain('**Shared Skills**');
  }, 10000);

  // --------------------------------------------------------------------------
  // HR2 — modifying a shared skill defers idle session (not stopped)
  // --------------------------------------------------------------------------
  it('HR2: modifying a shared skill defers idle session (not stopped)', async () => {
    // Seed the skill BEFORE the watcher so the "add" event doesn't fire.
    writeSkillFile(sharedSkillsDir, 'hr2-skill');

    await bootRunnerWithIdleSession('chat:hr2');
    watcher = wireSkillsWatcher(runner, workspaceDir, sharedSkillsDir, mcpToolsDir);
    await watcher.ready;

    // Modify: rewrite with different description.
    const skillFile = path.join(sharedSkillsDir, 'hr2-skill', 'SKILL.md');
    fs.writeFileSync(
      skillFile,
      `---\nname: hr2-skill\ndescription: updated description\nuser-invocable: true\n---\n\n# hr2-skill v2\n`,
    );

    await waitForCondition(() => hasPendingRestart(runner, 'chat:hr2'));
    expect(getSessions(runner).has('chat:hr2')).toBe(true);

    const claudeMd = fs.readFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('updated description');
  }, 10000);

  // --------------------------------------------------------------------------
  // HR3 — deleting a shared skill defers idle session + removes from CLAUDE.md
  // --------------------------------------------------------------------------
  it('HR3: deleting a shared skill defers idle session and removes skill from CLAUDE.md', async () => {
    writeSkillFile(sharedSkillsDir, 'hr3-skill');

    await bootRunnerWithIdleSession('chat:hr3');
    watcher = wireSkillsWatcher(runner, workspaceDir, sharedSkillsDir, mcpToolsDir);
    await watcher.ready;

    deleteSkillFile(sharedSkillsDir, 'hr3-skill');

    await waitForCondition(() => hasPendingRestart(runner, 'chat:hr3'));
    expect(getSessions(runner).has('chat:hr3')).toBe(true);

    const claudeMd = fs.readFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).not.toContain('/hr3-skill');
  }, 10000);

  // --------------------------------------------------------------------------
  // HR4 — busy session is NOT stopped; CLAUDE.md still refreshed
  // --------------------------------------------------------------------------
  it('HR4: busy session is left running; CLAUDE.md still updated', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:hr4', 'hi');
    await waitForCondition(() => getSessions(runner).has('chat:hr4'));
    const sess = getSessions(runner).get('chat:hr4')!;
    // Session is processing (isProcessing === true from sendChannelPost) — with
    // skipBusy:true it is left running (skipped), not deferred and not stopped.

    watcher = wireSkillsWatcher(runner, workspaceDir, sharedSkillsDir, mcpToolsDir);
    await watcher.ready;

    writeSkillFile(sharedSkillsDir, 'hr4-skill');

    await waitForCondition(() =>
      fs
        .readFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'utf8')
        .includes('/hr4-skill'),
    );

    // Busy session survives the reload.
    expect(getSessions(runner).has('chat:hr4')).toBe(true);
    expect(sess.isRunning()).toBe(true);
  }, 10000);

  // --------------------------------------------------------------------------
  // HR5 — workspace-dir skill change also defers the idle session
  // --------------------------------------------------------------------------
  it('HR5: skill added under workspace skills dir also defers idle session', async () => {
    await bootRunnerWithIdleSession('chat:hr5');
    watcher = wireSkillsWatcher(runner, workspaceDir, sharedSkillsDir, mcpToolsDir);
    await watcher.ready;

    // Workspace skills: <workspace>/skills/<skill-name>/SKILL.md
    const workspaceSkillsDir = path.join(workspaceDir, 'skills');
    writeSkillFile(workspaceSkillsDir, 'hr5-skill');

    await waitForCondition(() => hasPendingRestart(runner, 'chat:hr5'));
    expect(getSessions(runner).has('chat:hr5')).toBe(true);

    const claudeMd = fs.readFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('/hr5-skill');
    expect(claudeMd).toContain('**Workspace Skills**');
  }, 10000);

  // --------------------------------------------------------------------------
  // HR6 — busy session survives EVEN AFTER its turn completes (footgun guard)
  //
  // This is the regression test for the self-restart footgun: a session that
  // triggers a SKILL.md change while busy must NOT be marked for a deferred
  // restart, otherwise it is stopped the instant its turn ends. HR4 only checks
  // survival *during* the turn (which passes even on the buggy code, since the
  // deferred restart hasn't fired yet); HR6 completes the turn and asserts the
  // session is still alive — which only holds when the skills-reload path passes
  // skipBusy:true.
  // --------------------------------------------------------------------------
  it('HR6: busy session survives after its turn completes (no deferred restart)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:hr6', 'hi');
    await waitForCondition(() => getSessions(runner).has('chat:hr6'));
    const sess = getSessions(runner).get('chat:hr6')!;
    expect(sess).toBeDefined();
    // Session is busy (isProcessing === true from sendChannelPost), as if it is
    // mid-turn editing its own SKILL.md.

    watcher = wireSkillsWatcher(runner, workspaceDir, sharedSkillsDir, mcpToolsDir);
    await watcher.ready;

    writeSkillFile(sharedSkillsDir, 'hr6-skill');

    // Wait for the reload to land (CLAUDE.md rewritten).
    await waitForCondition(() =>
      fs
        .readFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'utf8')
        .includes('/hr6-skill'),
    );

    // The turn now completes. On the buggy path (no skipBusy) the session was
    // marked pendingRestart and this stops it; with skipBusy:true it survives.
    sess.setProcessing(false);
    await new Promise((r) => setTimeout(r, 100));

    expect(getSessions(runner).has('chat:hr6')).toBe(true);
    expect(sess.isRunning()).toBe(true);
  }, 10000);
});
