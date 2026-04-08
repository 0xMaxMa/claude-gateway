/**
 * Integration tests: Typing Indicator Persistence
 *
 * Test IDs: I-TP-01 through I-TP-04
 *
 * Validates that the typing indicator file persists correctly during
 * multi-step agent work and is cleaned up at the right time.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock child_process ──────────────────────────────────────────────────────

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

// ── Imports (after mock) ────────────────────────────────────────────────────

import { AgentRunner } from '../../src/agent-runner';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { SessionProcess } from '../../src/session-process';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'typing-test-agent',
    description: 'test agent for typing persistence',
    workspace,
    env: '',
    telegram: {
      botToken: 'test-token-typing',
      allowedUsers: [],
      dmPolicy: 'allowlist',
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
    gateway: { logDir: '/tmp/test-typing-logs', timezone: 'UTC' },
    agents: [],
  };
}

function getCallbackPort(runner: AgentRunner): number {
  return (runner as unknown as { callbackPort: number }).callbackPort;
}

function getSessions(runner: AgentRunner): Map<string, SessionProcess> {
  return (runner as unknown as { sessions: Map<string, SessionProcess> }).sessions;
}

async function sendChannelPost(
  port: number,
  chatId: string,
  content: string,
  user = 'testuser',
): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      meta: {
        chat_id: chatId,
        message_id: '1',
        user,
        ts: new Date().toISOString(),
      },
    }),
  });
}

/** Build a JSON line simulating an assistant message with a reply tool_use block */
function makeReplyToolUseOutput(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__telegram__reply', id: 'tu_1', input: {} },
      ],
    },
  });
}

/** Build a JSON line simulating a generic assistant output (non-tool_use) */
function makeAssistantOutput(text = 'working...'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
    stop_reason: null,
  });
}

/** Build a JSON line simulating a result event */
function makeResultOutput(result = 'done'): string {
  return JSON.stringify({ type: 'result', result });
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe('Typing Indicator Persistence', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;
  let typingDir: string;
  const chatId = 'chat:typing-test';

  beforeEach(() => {
    jest.useFakeTimers();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();

    // Set up the typing signal directory and file (normally created by receiver typing plugin)
    typingDir = path.join(agentConfig.workspace, '.telegram-state', 'typing');
    fs.mkdirSync(typingDir, { recursive: true });
    fs.writeFileSync(path.join(typingDir, chatId), '');
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (runner) {
      await runner.stop();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function typingFileExists(): boolean {
    return fs.existsSync(path.join(typingDir, chatId));
  }

  /**
   * Spawn a session by sending a channel post, then return the SessionProcess.
   * Uses real timers briefly to allow the HTTP callback to complete.
   */
  async function spawnSession(): Promise<SessionProcess> {
    // Temporarily use real timers for the HTTP request
    jest.useRealTimers();

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, chatId, 'hello');

    // Wait for session to be created
    await new Promise(r => setTimeout(r, 200));

    // Switch back to fake timers
    jest.useFakeTimers();

    const session = getSessions(runner).get(chatId);
    if (!session) {
      throw new Error('Session was not created after sendChannelPost');
    }
    return session;
  }

  // --------------------------------------------------------------------------
  // I-TP-01: Agent replies then continues — typing persists
  // --------------------------------------------------------------------------
  it('I-TP-01: typing persists when agent sends reply then continues with more output within 3s', async () => {
    const session = await spawnSession();

    // Agent sends a reply via tool_use
    session.emit('output', makeReplyToolUseOutput());
    expect(typingFileExists()).toBe(true);

    // Result event fires (end of first turn)
    session.emit('output', makeResultOutput('first reply'));

    // Typing file should still exist — 3s delay hasn't elapsed
    expect(typingFileExists()).toBe(true);

    // Advance 1.5s (less than the 3s delay)
    jest.advanceTimersByTime(1500);
    expect(typingFileExists()).toBe(true);

    // New assistant output arrives within the 3s window (cancels pending timer)
    session.emit('output', makeAssistantOutput('still working'));
    expect(typingFileExists()).toBe(true);

    // Advance another 1.5s (total 3s from result, but timer was cancelled)
    jest.advanceTimersByTime(1500);
    expect(typingFileExists()).toBe(true);

    // Agent finishes second turn
    session.emit('output', makeResultOutput('second reply'));

    // Still within 3s of the new result — file should exist
    jest.advanceTimersByTime(2000);
    expect(typingFileExists()).toBe(true);

    // Full 3s after second result — now it should be deleted
    jest.advanceTimersByTime(1000);
    expect(typingFileExists()).toBe(false);
  }, 30000);

  // --------------------------------------------------------------------------
  // I-TP-02: Agent replies once and done — typing stops after 3s delay
  // --------------------------------------------------------------------------
  it('I-TP-02: typing stops 3s after result event when no further output arrives', async () => {
    const session = await spawnSession();

    // Agent sends a reply
    session.emit('output', makeReplyToolUseOutput());
    expect(typingFileExists()).toBe(true);

    // Result event fires
    session.emit('output', makeResultOutput('only reply'));

    // Typing file should still exist immediately after result
    expect(typingFileExists()).toBe(true);

    // Advance 2.9s — still within the delay
    jest.advanceTimersByTime(2900);
    expect(typingFileExists()).toBe(true);

    // Advance to 3s — delay has elapsed, typing file should be deleted
    jest.advanceTimersByTime(100);
    expect(typingFileExists()).toBe(false);
  }, 30000);

  // --------------------------------------------------------------------------
  // I-TP-03: Multi-turn work — typing stays active
  // --------------------------------------------------------------------------
  it('I-TP-03: typing stays active through multiple result/output cycles until 3s after last result', async () => {
    const session = await spawnSession();

    // First turn: result event
    session.emit('output', makeResultOutput('turn 1'));
    expect(typingFileExists()).toBe(true);

    // 2s later — new output arrives, cancelling the 3s timer
    jest.advanceTimersByTime(2000);
    expect(typingFileExists()).toBe(true);
    session.emit('output', makeAssistantOutput('starting turn 2'));

    // Second result
    session.emit('output', makeResultOutput('turn 2'));
    expect(typingFileExists()).toBe(true);

    // 1s later — yet more output
    jest.advanceTimersByTime(1000);
    session.emit('output', makeAssistantOutput('starting turn 3'));

    // Third result
    session.emit('output', makeResultOutput('turn 3'));
    expect(typingFileExists()).toBe(true);

    // Now no more output — 2.9s passes
    jest.advanceTimersByTime(2900);
    expect(typingFileExists()).toBe(true);

    // 3s after last result — typing file should be deleted
    jest.advanceTimersByTime(100);
    expect(typingFileExists()).toBe(false);
  }, 30000);

  // --------------------------------------------------------------------------
  // I-TP-04: Session exit stops typing immediately
  // --------------------------------------------------------------------------
  it('I-TP-04: session exit clears pending timer and deletes typing file immediately', async () => {
    const session = await spawnSession();

    // Result event fires — starts the 3s timer
    session.emit('output', makeResultOutput('partial work'));
    expect(typingFileExists()).toBe(true);

    // Only 1s has passed — timer is still pending
    jest.advanceTimersByTime(1000);
    expect(typingFileExists()).toBe(true);

    // Session exits before the 3s delay
    session.emit('exit', 0, 'SIGTERM');

    // Typing file should be deleted immediately on exit
    expect(typingFileExists()).toBe(false);
  }, 30000);
});
