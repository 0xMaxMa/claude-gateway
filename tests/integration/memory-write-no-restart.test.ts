/**
 * Integration tests for the memory-write session-drop fix (issue #321):
 * an agent editing its own MEMORY.md/USER.md must NOT drop any live session.
 *
 * The workspace watcher recomposes CLAUDE.md (frozen-at-spawn) on every change,
 * then decides a restart strategy by change class (classifyWorkspaceRestart):
 *   - memory-only (MEMORY.md/USER.md) → restart NOTHING (the bug fix)
 *   - identity (SOUL.md/AGENTS.md)    → skipBusy + deferIdle (never SIGKILL idle)
 *   - non-writable (HEARTBEAT.md/...) → normal restart-or-defer (unchanged)
 *
 * This mirrors the src/index.ts watchWorkspace callback while keeping the
 * subprocess layer mocked (same child_process jest mock as the runner tests).
 *
 * MW1 — MEMORY.md write stops ZERO sessions (idle bystander survives, untouched)
 * MW2 — SOUL.md (identity) change defers the idle session (armed, not stopped)
 * MW3 — a non-writable .md change keeps today's behavior (idle session stopped)
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { waitForCondition } from '../helpers/wait-for';

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
import {
  loadWorkspace,
  watchWorkspace,
  classifyWorkspaceRestart,
} from '../../src/agent/workspace-loader';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { SessionProcess } from '../../src/session/process';
import type { WatchHandle } from '../../src/watch/factory';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'alfred',
    description: 'memory-write integration agent',
    workspace,
    env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

function makeGatewayConfig(): GatewayConfig {
  return { gateway: { logDir: '/tmp/test-mw-logs', timezone: 'UTC' }, agents: [] };
}

async function sendChannelPost(port: number, chatId: string, content: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      meta: { chat_id: chatId, message_id: '1', user: 'tester', ts: new Date().toISOString() },
    }),
  });
}

function getCallbackPort(runner: AgentRunner): number {
  return (runner as unknown as { callbackPort: number }).callbackPort;
}

function getSessions(runner: AgentRunner): Map<string, SessionProcess> {
  return (runner as unknown as { sessions: Map<string, SessionProcess> }).sessions;
}

function hasPendingRestart(runner: AgentRunner, chatId: string): boolean {
  return (runner as unknown as { pendingRestarts: Set<string> }).pendingRestarts.has(chatId);
}


// Faithful mirror of the src/index.ts watchWorkspace callback: always recompose
// CLAUDE.md, then branch the restart strategy on classifyWorkspaceRestart.
function wireWorkspaceWatcher(
  runner: AgentRunner,
  workspaceDir: string,
  opts: { mcpToolsDir: string; sharedSkillsDir: string },
): WatchHandle {
  return watchWorkspace(workspaceDir, async (changedFiles) => {
    const updated = await loadWorkspace(workspaceDir, opts);
    await fs.promises.writeFile(path.join(workspaceDir, 'CLAUDE.md'), updated.systemPrompt, 'utf8');
    const action = classifyWorkspaceRestart(changedFiles);
    if (action === 'none') {
      // memory-only: restart nothing
    } else if (action === 'defer-idle') {
      await runner.restartOrDefer({ skipBusy: true, deferIdle: true });
    } else {
      await runner.restartOrDefer({ skipBusy: false });
    }
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Memory-write session-drop fix (issue #321)', () => {
  let tmpRoot: string;
  let workspaceDir: string;
  let sharedSkillsDir: string;
  let mcpToolsDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;
  let watcher: WatchHandle;

  beforeEach(() => {
    process.env.CHANNEL_COALESCE_WINDOW_MS = '20';
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-restart-'));
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    // Standard workspace files so loadWorkspace succeeds and the watched *.md set
    // exists before the watcher attaches.
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Integration Agent\n');
    fs.writeFileSync(path.join(workspaceDir, 'SOUL.md'), '# Soul\ninitial identity\n');
    fs.writeFileSync(path.join(workspaceDir, 'MEMORY.md'), '# Memory\ninitial memory\n');
    fs.writeFileSync(path.join(workspaceDir, 'HEARTBEAT.md'), '# Heartbeat\ninitial\n');
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
    if (runner) await runner.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    jest.clearAllMocks();
    delete process.env.CHANNEL_COALESCE_WINDOW_MS;
  });

  async function bootIdleSession(chatId: string): Promise<SessionProcess> {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);
    await sendChannelPost(port, chatId, 'hello');
    await waitForCondition(() => getSessions(runner).has(chatId));
    const sess = getSessions(runner).get(chatId)!;
    expect(sess).toBeDefined();
    sess.setProcessing(false); // idle bystander
    return sess;
  }

  // MW1 — THE bug regression: a MEMORY.md write must stop zero sessions.
  it('MW1: writing MEMORY.md stops zero sessions (idle bystander survives)', async () => {
    const sess = await bootIdleSession('chat:mw1');
    const stopSpy = jest.spyOn(sess, 'stop');
    const restartSpy = jest.spyOn(runner, 'restartOrDefer');

    watcher = wireWorkspaceWatcher(runner, workspaceDir, { mcpToolsDir, sharedSkillsDir });
    await watcher.ready;

    fs.writeFileSync(path.join(workspaceDir, 'MEMORY.md'), '# Memory\nfact learned by the agent\n');

    // CLAUDE.md is recomposed with the new memory (frozen-at-spawn contract).
    await waitForCondition(() =>
      fs.readFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'utf8').includes('fact learned by the agent'),
    );
    // Let any (mistaken) restart settle before asserting the negative.
    await new Promise((r) => setTimeout(r, 100));

    // The whole fix: no restart path is taken, no session is stopped or dropped.
    expect(restartSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(getSessions(runner).has('chat:mw1')).toBe(true);
    expect(hasPendingRestart(runner, 'chat:mw1')).toBe(false);
  }, 10000);

  // MW2 — identity change defers the idle session (armed, never SIGKILLed).
  it('MW2: writing SOUL.md defers the idle session (armed, not stopped)', async () => {
    const sess = await bootIdleSession('chat:mw2');
    const stopSpy = jest.spyOn(sess, 'stop');

    watcher = wireWorkspaceWatcher(runner, workspaceDir, { mcpToolsDir, sharedSkillsDir });
    await watcher.ready;

    fs.writeFileSync(path.join(workspaceDir, 'SOUL.md'), '# Soul\nrevised identity\n');

    await waitForCondition(() => hasPendingRestart(runner, 'chat:mw2'));
    expect(stopSpy).not.toHaveBeenCalled();
    expect(getSessions(runner).has('chat:mw2')).toBe(true);
    const claudeMd = fs.readFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('revised identity');
  }, 10000);

  // MW3 — a non-writable .md change keeps today's behavior (idle stopped).
  it('MW3: writing a non-writable .md still restarts the idle session (no regression)', async () => {
    await bootIdleSession('chat:mw3');

    watcher = wireWorkspaceWatcher(runner, workspaceDir, { mcpToolsDir, sharedSkillsDir });
    await watcher.ready;

    fs.writeFileSync(path.join(workspaceDir, 'HEARTBEAT.md'), '# Heartbeat\nchanged\n');

    // Non-writable change → idle session is stopped and removed (unchanged path).
    await waitForCondition(() => !getSessions(runner).has('chat:mw3'));
    expect(getSessions(runner).has('chat:mw3')).toBe(false);
  }, 10000);
});
