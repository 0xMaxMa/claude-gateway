import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock child_process ────────────────────────────────────────────────────────

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

let lastProcess: MockChildProcess | null = null;
let spawnMock: jest.Mock;

function makeMockProcess(): MockChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.pid = 99999;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = true;
    process.nextTick(() => proc.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  });

  return proc;
}

jest.mock('child_process', () => ({
  spawn: jest.fn((..._args) => {
    lastProcess = makeMockProcess();
    return lastProcess;
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { TelegramReceiver } from '../../src/telegram-receiver';
import { AgentConfig } from '../../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace,
    env: '',
    telegram: {
      botToken: 'bot-test-token-123',
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TelegramReceiver', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  const LOG_DIR = '/tmp/test-logs';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-test-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    lastProcess = null;
    spawnMock = require('child_process').spawn as jest.Mock;
    spawnMock.mockClear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // U-TR-01: start() spawns bun with TELEGRAM_RECEIVER_MODE=true
  // --------------------------------------------------------------------------
  it('U-TR-01: start() spawns bun process with TELEGRAM_RECEIVER_MODE=true', () => {
    const receiver = new TelegramReceiver(agentConfig, 4321, LOG_DIR);
    receiver.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(cmd).toBe('bun');
    expect(opts.env.TELEGRAM_RECEIVER_MODE).toBe('true');
  });

  // --------------------------------------------------------------------------
  // U-TR-02: env has required vars
  // --------------------------------------------------------------------------
  it('U-TR-02: spawned process env has TELEGRAM_BOT_TOKEN, TELEGRAM_STATE_DIR, CLAUDE_CHANNEL_CALLBACK', () => {
    const receiver = new TelegramReceiver(agentConfig, 4321, LOG_DIR);
    receiver.start();

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(opts.env.TELEGRAM_BOT_TOKEN).toBe('bot-test-token-123');
    expect(opts.env.TELEGRAM_STATE_DIR).toContain('.telegram-state');
    expect(opts.env.CLAUDE_CHANNEL_CALLBACK).toBe('http://127.0.0.1:4321/channel');
  });

  // --------------------------------------------------------------------------
  // U-TR-03: stop() kills the process
  // --------------------------------------------------------------------------
  it('U-TR-03: stop() kills the spawned process', () => {
    const receiver = new TelegramReceiver(agentConfig, 4321, LOG_DIR);
    receiver.start();

    expect(lastProcess).not.toBeNull();
    receiver.stop();

    expect(lastProcess!.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // --------------------------------------------------------------------------
  // U-TR-04: schedules restart on unexpected exit
  // --------------------------------------------------------------------------
  it('U-TR-04: schedules restart on unexpected exit', () => {
    const receiver = new TelegramReceiver(agentConfig, 4321, LOG_DIR);
    receiver.start();

    const firstProcess = lastProcess!;
    spawnMock.mockClear();

    // Simulate unexpected exit (not via stop())
    firstProcess.emit('exit', 1, null);

    // Advance timer to trigger restart
    jest.advanceTimersByTime(6_000);

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // U-TR-05: does NOT restart when stop() was called first
  // --------------------------------------------------------------------------
  it('U-TR-05: does not restart after stop() was called', () => {
    const receiver = new TelegramReceiver(agentConfig, 4321, LOG_DIR);
    receiver.start();

    receiver.stop();
    spawnMock.mockClear();

    // Advance timers — no restart should occur
    jest.advanceTimersByTime(10_000);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // U-TR-06: isRunning() reflects subprocess state
  // --------------------------------------------------------------------------
  it('U-TR-06: isRunning() returns true when process is alive, false after stop', () => {
    const receiver = new TelegramReceiver(agentConfig, 4321, LOG_DIR);

    expect(receiver.isRunning()).toBe(false);

    receiver.start();
    // isRunning() = process !== null && !process.killed
    expect(receiver.isRunning()).toBe(true);

    receiver.stop();
    // kill() sets proc.killed = true synchronously in mock,
    // so isRunning() → false immediately (killed=true → !killed=false)
    expect(receiver.isRunning()).toBe(false);
  });
});
