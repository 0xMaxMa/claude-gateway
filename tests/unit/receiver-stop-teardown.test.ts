import { EventEmitter } from 'events';
import * as path from 'path';

// ── Mock child_process ────────────────────────────────────────────────────────

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
  // A real ChildProcess has these as null until the child exits; stopChildProcess
  // reads them to detect an already-dead child, so the mock must model them.
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  /** When false the child ignores SIGTERM, as a wedged long-poll would. */
  exitsOnTerm: boolean;
}

let lastProcess: MockChildProcess | null = null;

function makeMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.pid = 4242;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.exitsOnTerm = true;
  proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    proc.exitCode = code;
    proc.signalCode = signal;
  });
  proc.kill = jest.fn((signal?: string) => {
    if (signal === 'SIGTERM' && !proc.exitsOnTerm) return true;
    proc.killed = true;
    setImmediate(() => proc.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  });
  return proc;
}

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    lastProcess = makeMockProcess();
    return lastProcess;
  }),
}));

import { TelegramReceiver } from '../../src/telegram/receiver';
import { DiscordReceiver } from '../../src/discord/receiver';
import { AgentConfig } from '../../src/types';
import { findOrphanedReceivers } from '../../src/utils/orphan-receivers';
import { stopChildProcess } from '../../src/utils/stop-child';
import type { ChildProcess } from 'child_process';

const LOG_DIR = '/tmp/claude-gateway-test-logs';

function makeAgentConfig(): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace: '/tmp/claude-gateway-test-ws',
    env: '',
    telegram: { botToken: 'tg-token' },
    discord: { botToken: 'dc-token' },
    claude: {},
  } as unknown as AgentConfig;
}

type Receiver = TelegramReceiver | DiscordReceiver;

/**
 * Await stop() in a way that compiles against the pre-fix `stop(): void` too, so
 * these tests fail on the old code for the behaviour they assert rather than for
 * a type error. Pre-fix this resolves immediately without the child having gone.
 */
function awaitStop(receiver: Receiver): Promise<void> {
  return Promise.resolve(receiver.stop());
}

const CHANNELS: Array<[string, () => Receiver]> = [
  ['TelegramReceiver', () => new TelegramReceiver(makeAgentConfig(), 4321, LOG_DIR)],
  ['DiscordReceiver', () => new DiscordReceiver(makeAgentConfig(), 4321, LOG_DIR)],
];

describe.each(CHANNELS)('%s.stop() teardown (issue #405)', (_name, make) => {
  beforeEach(() => {
    lastProcess = null;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── U-RS-405a: stop() must not resolve before the child is gone ────────────
  it('U-RS-405a: resolves only after the child has actually exited', async () => {
    const receiver = make();
    receiver.start();
    const proc = lastProcess!;

    let resolved = false;
    const stopped = awaitStop(receiver).then(() => { resolved = true; });

    // The child has been signalled but has not exited yet.
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await Promise.resolve();
    expect(resolved).toBe(false);

    await jest.advanceTimersByTimeAsync(0);
    await stopped;
    expect(resolved).toBe(true);
  });

  // ── U-RS-405b: the escalation the old fire-and-forget stop() never had ─────
  it('U-RS-405b: SIGKILLs a child that ignores SIGTERM, then resolves', async () => {
    const receiver = make();
    receiver.start();
    const proc = lastProcess!;
    proc.exitsOnTerm = false; // wedged in an in-flight long-poll

    let resolved = false;
    const stopped = awaitStop(receiver).then(() => { resolved = true; });

    await jest.advanceTimersByTimeAsync(0);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(resolved).toBe(false);

    // Past the grace period the child must be killed outright, not left running.
    await jest.advanceTimersByTimeAsync(5_000);
    await stopped;

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(resolved).toBe(true);
  });

  it('U-RS-405c: does not wait when nothing was ever started', async () => {
    const receiver = make();
    await expect(awaitStop(receiver)).resolves.toBeUndefined();
  });

  it('U-RS-405d: does not wait when the child already exited on its own', async () => {
    const receiver = make();
    receiver.start();
    lastProcess!.emit('exit', 1, null); // crash → this.process cleared

    await expect(awaitStop(receiver)).resolves.toBeUndefined();
  });

  it('U-RS-405e: still cancels a pending restart timer (SIGINT race, U-TR-07)', async () => {
    const receiver = make();
    receiver.start();
    const { spawn } = jest.requireMock('child_process') as { spawn: jest.Mock };

    lastProcess!.emit('exit', 0, null); // schedules a restart
    spawn.mockClear();

    await awaitStop(receiver);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(spawn).not.toHaveBeenCalled();
  });
});

// ── The link between the fixed stop() and the shutdown path ──────────────────
describe('AgentRunner.stop() awaits receiver teardown (issue #405)', () => {
  it('U-RS-405f: does not resolve while a receiver child is still shutting down', async () => {
    jest.useFakeTimers();
    try {
      const receiver = new TelegramReceiver(makeAgentConfig(), 4321, LOG_DIR);
      receiver.start();
      const proc = lastProcess!;
      proc.exitsOnTerm = false; // wedged

      // Exactly what AgentRunner.stop() now does with its receivers.
      let done = false;
      const stopped = Promise.all([receiver.stop()]).then(() => { done = true; });

      await jest.advanceTimersByTimeAsync(0);
      expect(done).toBe(false); // pre-fix this was already true

      await jest.advanceTimersByTimeAsync(5_000);
      await stopped;

      expect(done).toBe(true);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── The boot sweep is useless if its needle drifts from the real spawn path ───
describe('sweep needle matches the real receiver spawn path (issue #405)', () => {
  it.each([
    ['telegram', () => new TelegramReceiver(makeAgentConfig(), 4321, LOG_DIR)],
    ['discord', () => new DiscordReceiver(makeAgentConfig(), 4321, LOG_DIR)],
  ])('U-RS-405g: a %s receiver spawns under the directory index.ts sweeps', (_ch, make) => {
    const { spawn } = jest.requireMock('child_process') as { spawn: jest.Mock };
    spawn.mockClear();

    make().start();
    const [cmd, argv] = spawn.mock.calls[0] as [string, string[]];
    // Reconstruct the argv exactly as `ps` would render it, so this breaks if
    // either the runtime or the script path changes shape.
    const command = [cmd, ...argv].join(' ');

    // Exactly how src/index.ts derives mcpToolsDir, from this module's own
    // depth. Both entry points sit one directory below the package root, so
    // this holds for `src/` under ts-jest and for `dist/` in production.
    const mcpToolsDir = path.resolve(__dirname, '..', '..', 'mcp', 'tools');

    // If either path derivation moves, the sweep silently reclaims nothing —
    // so assert through the matcher itself rather than comparing strings.
    const found = findOrphanedReceivers(`  1234       1 ${command}`, mcpToolsDir);
    expect(found.map((o) => o.pid)).toEqual([1234]);
  });
  it('U-RS-405h: an already-exited child resolves at once instead of idling out the grace period', async () => {
    jest.useFakeTimers();
    try {
      const receiver = new TelegramReceiver(makeAgentConfig(), 4321, LOG_DIR);
      receiver.start();
      const proc = lastProcess!;
      // Node clears the handle on exit: kill() then returns false WITHOUT
      // throwing and no further 'exit' fires, so a naive implementation waits
      // out the full grace period and SIGKILLs a dead pid.
      proc.exitCode = 0;
      proc.kill.mockImplementation(() => false);

      let resolved = false;
      const stopped = stopChildProcess(proc as unknown as ChildProcess).then(() => { resolved = true; });

      await Promise.resolve();
      expect(resolved).toBe(true);
      expect(proc.kill).not.toHaveBeenCalled();

      await stopped;
    } finally {
      jest.useRealTimers();
    }
  });
  it('U-RS-405i: a child that does not expose exitCode is treated as alive and still signalled', async () => {
    // Regression guard: a strict `!== null` early-return here silently skipped
    // teardown entirely for any ChildProcess-like object lacking the field —
    // the child was never signalled at all. Absent must mean alive.
    const proc = new EventEmitter() as unknown as ChildProcess & { kill: jest.Mock };
    proc.kill = jest.fn(() => {
      setImmediate(() => (proc as unknown as EventEmitter).emit('exit', 0, 'SIGTERM'));
      return true;
    });

    await stopChildProcess(proc);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
