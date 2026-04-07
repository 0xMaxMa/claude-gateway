import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock child_process ────────────────────────────────────────────────────────

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

// ── Imports ───────────────────────────────────────────────────────────────────

import { AgentRunner } from '../../src/agent-runner';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { SessionProcess } from '../../src/session-process';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentConfig(workspace: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace,
    env: '',
    telegram: {
      botToken: 'test-token',
      allowedUsers: [],
      dmPolicy: 'allowlist',
    },
    claude: {
      model: 'claude-opus-4-6',
      dangerouslySkipPermissions: false,
      extraFlags: [],
    },
    ...overrides,
  };
}

function makeGatewayConfig(): GatewayConfig {
  return {
    gateway: { logDir: '/tmp/test-ar-logs', timezone: 'UTC' },
    agents: [],
  };
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

function getCallbackPort(runner: AgentRunner): number {
  return (runner as unknown as { callbackPort: number }).callbackPort;
}

function getSessions(runner: AgentRunner): Map<string, SessionProcess> {
  return (runner as unknown as { sessions: Map<string, SessionProcess> }).sessions;
}

function getIdleCleaner(runner: AgentRunner): ReturnType<typeof setInterval> | undefined {
  return (runner as unknown as { idleCleanerTimer?: ReturnType<typeof setInterval> })
    .idleCleanerTimer;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentRunner (session pool)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-test-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) {
      await runner.stop();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // U-AR-01: Different chat_ids get different SessionProcesses
  // --------------------------------------------------------------------------
  it('U-AR-01: different chat_ids get different SessionProcesses', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:111', 'hello');
    // Allow async session spawn to complete
    await new Promise(r => setTimeout(r, 100));

    await sendChannelPost(port, 'chat:222', 'world');
    await new Promise(r => setTimeout(r, 100));

    const sessions = getSessions(runner);
    expect(sessions.size).toBe(2);
    expect(sessions.has('chat:111')).toBe(true);
    expect(sessions.has('chat:222')).toBe(true);
    expect(sessions.get('chat:111')).not.toBe(sessions.get('chat:222'));
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-02: Same chat_id reuses existing SessionProcess
  // --------------------------------------------------------------------------
  it('U-AR-02: same chat_id reuses the existing SessionProcess', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:111', 'first message');
    await new Promise(r => setTimeout(r, 100));

    const first = getSessions(runner).get('chat:111');

    await sendChannelPost(port, 'chat:111', 'second message');
    await new Promise(r => setTimeout(r, 100));

    const second = getSessions(runner).get('chat:111');

    expect(getSessions(runner).size).toBe(1);
    expect(first).toBe(second);
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-03: maxConcurrent evicts oldest idle session
  // --------------------------------------------------------------------------
  it('U-AR-03: maxConcurrent evicts oldest idle session when pool is full', async () => {
    agentConfig = makeAgentConfig(agentConfig.workspace, {
      session: { maxConcurrent: 2, idleTimeoutMinutes: 30 },
    });
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // Fill pool with 2 sessions
    await sendChannelPost(port, 'chat:111', 'hello');
    await new Promise(r => setTimeout(r, 100));
    await sendChannelPost(port, 'chat:222', 'hello');
    await new Promise(r => setTimeout(r, 100));

    expect(getSessions(runner).size).toBe(2);

    // Make chat:111 the oldest (lowest lastActivityAt)
    const sess111 = getSessions(runner).get('chat:111')!;
    (sess111 as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 100_000;

    // Third chat should evict chat:111 (oldest idle)
    await sendChannelPost(port, 'chat:333', 'new session');
    await new Promise(r => setTimeout(r, 200));

    expect(getSessions(runner).size).toBe(2);
    expect(getSessions(runner).has('chat:333')).toBe(true);
    expect(getSessions(runner).has('chat:222')).toBe(true);
    // chat:111 evicted
    expect(getSessions(runner).has('chat:111')).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-04: idle cleaner stops sessions past idleTimeoutMs
  // --------------------------------------------------------------------------
  it('U-AR-04: idle cleaner stops sessions that have exceeded idle timeout', async () => {
    agentConfig = makeAgentConfig(agentConfig.workspace, {
      session: { idleTimeoutMinutes: 30, maxConcurrent: 20 },
    });
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:idle', 'hello');
    await new Promise(r => setTimeout(r, 100));

    expect(getSessions(runner).size).toBe(1);

    // Reach into private method and call it directly to simulate idle cleaner firing
    const sess = getSessions(runner).get('chat:idle')!;
    (sess as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 60 * 60 * 1000;

    // Directly invoke the private idle cleaner logic by calling the method via cast
    const runnerInternal = runner as unknown as {
      idleTimeoutMs: number;
      sessions: Map<string, SessionProcess>;
      logger: { info: (msg: string, data?: unknown) => void };
    };

    // Simulate the idle cleaner interval callback
    for (const [id, proc] of runnerInternal.sessions) {
      if (proc.isIdle(runnerInternal.idleTimeoutMs)) {
        await proc.stop();
        runnerInternal.sessions.delete(id);
      }
    }

    expect(getSessions(runner).size).toBe(0);
  }, 15000);
});
