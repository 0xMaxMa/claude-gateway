import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

/**
 * End-to-end proof for issue #405.
 *
 * The unit tests pin which signals are registered; this one pins the thing that
 * actually broke — the OS behaviour. Node's default disposition for SIGHUP is to
 * terminate the process WITHOUT running any handler, so before the fix a hangup
 * (a closed tmux pane, `tmux kill-session`, a dropped SSH session) killed the
 * gateway and left every spawned receiver reparented to init.
 *
 * The harness supervises a real child through the real `registerShutdownSignals`,
 * so a regression that drops SIGHUP from the signal list fails here with a live
 * orphaned process, exactly as it did in production.
 */

const HARNESS = path.join(__dirname, '..', 'fixtures', 'sighup-harness.ts');
const TS_NODE = require.resolve('ts-node/register');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

describe('SIGHUP does not orphan supervised children (issue #405)', () => {
  let harness: ChildProcess | null = null;
  let childPid: number | null = null;

  afterEach(() => {
    // Never leave the test's own processes behind — that is the bug, after all.
    for (const pid of [childPid, harness?.pid]) {
      if (pid && isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    harness = null;
    childPid = null;
  });

  it('I-HUP-405: a hangup runs shutdown and reaps the child instead of orphaning it', async () => {
    let stdout = '';
    let harnessExited = false;

    harness = spawn(process.execPath, ['-r', TS_NODE, HARNESS], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    harness.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    harness.on('exit', () => { harnessExited = true; });

    await waitUntil('harness to report its child pid', () => /CHILD \d+/.test(stdout));
    childPid = Number(/CHILD (\d+)/.exec(stdout)![1]);
    expect(isAlive(childPid)).toBe(true);

    // The hangup. Before the fix this terminated the harness outright.
    process.kill(harness.pid!, 'SIGHUP');

    await waitUntil('harness to exit', () => harnessExited);

    // The load-bearing assertion: the child must be gone, not reparented to init.
    await waitUntil(
      'supervised child to be reaped',
      () => !isAlive(childPid!),
    );

    expect(stdout).toContain('SHUTDOWN SIGHUP');
  }, 40_000);
});
