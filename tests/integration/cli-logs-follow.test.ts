import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * End-to-end proof for issue #439.
 *
 * `tests/unit/cli-logs.test.ts` already covers what following *does* —
 * streaming appends, reopening across a rotation, never splitting a line — by
 * calling `runGatewayLogs()` in-process with an AbortSignal. All three passed
 * while `--follow` was completely inert in every released build, because Jest's
 * own handles keep the event loop alive, so the unref'ed poll interval still
 * fired. The bug was never in the follow logic; it was in whether the process
 * survives long enough to run it.
 *
 * That property only exists in a real process, so this test spawns one. A
 * regression that unref's the timer again — or otherwise stops holding the loop
 * open — exits the child right after the tail, and the appended line never
 * arrives.
 */

const HARNESS = path.join(__dirname, '..', 'fixtures', 'logs-follow-harness.ts');
const TS_NODE = require.resolve('ts-node/register');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function record(message: string): string {
  return `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'info', message })}\n`;
}

describe('gateway logs --follow keeps the CLI process alive (issue #439)', () => {
  let dir = '';
  let child: ChildProcess | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-logs-follow-'));
  });

  afterEach(() => {
    if (child?.pid && isAlive(child.pid)) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    child = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('I-LOGS-439: streams a line appended after start, then exits 0 on SIGINT', async () => {
    const file = path.join(dir, 'gateway.log');
    fs.writeFileSync(file, record('first line'));

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;

    child = spawn(process.execPath, ['-r', TS_NODE, HARNESS, 'gateway', 'logs', '--follow', '--logDir', dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => { exitCode = code; });

    // The tail is written before following begins, so its arrival means the
    // process has reached the point where the bug decided whether to exit.
    await waitUntil(`the tail to be printed (stderr: ${stderr})`, () => stdout.includes('first line'));

    // Appended only now: a follower that already exited can never report it,
    // and one that read it as part of the tail would not prove anything.
    fs.appendFileSync(file, record('appended while following'));

    await waitUntil(
      'the appended line to stream (the process exits here when the poll timer cannot hold the loop open)',
      () => stdout.includes('appended while following'),
    );
    expect(exitCode).toBeNull(); // still following, not finished

    child.kill('SIGINT');
    await waitUntil('the child to exit after SIGINT', () => exitCode !== null);
    expect(exitCode).toBe(0);
  });

  it('I-LOGS-439b: without --follow the same command still exits immediately', async () => {
    const file = path.join(dir, 'gateway.log');
    fs.writeFileSync(file, record('only line'));

    let stdout = '';
    let exitCode: number | null = null;

    child = spawn(process.execPath, ['-r', TS_NODE, HARNESS, 'gateway', 'logs', '--logDir', dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('exit', (code) => { exitCode = code; });

    // Holding the loop open for `--follow` must not make the plain read hang:
    // the fix has to be scoped to the follow path, not to the command.
    await waitUntil('the plain read to exit on its own', () => exitCode !== null);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('only line');
  });
});
