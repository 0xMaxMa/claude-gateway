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

/**
 * Poll until `predicate` holds. `label` is a thunk so the diagnostic it builds
 * describes the moment the wait gave up, not the moment it started — the
 * child's stderr is always empty at call time, which is exactly when it is
 * useless.
 *
 * The budget is well under the 15s `npm run integration` imposes, so a real
 * regression fails with this message rather than jest's generic timeout.
 */
async function waitUntil(label: () => string, predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label()}`);
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
    await waitUntil(() => `the tail to be printed (stderr: ${stderr})`, () => stdout.includes('first line'));

    // Appended only now: a follower that already exited can never report it,
    // and one that read it as part of the tail would not prove anything.
    fs.appendFileSync(file, record('appended while following'));

    await waitUntil(
      () => `the appended line to stream — the process exits here when the poll timer cannot hold the loop open (stderr: ${stderr})`,
      () => stdout.includes('appended while following'),
    );
    expect(exitCode).toBeNull(); // still following, not finished

    child.kill('SIGINT');
    await waitUntil(() => `the child to exit after SIGINT (stderr: ${stderr})`, () => exitCode !== null);
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
    await waitUntil(() => 'the plain read to exit on its own', () => exitCode !== null);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('only line');
  });

  it('I-LOGS-439c: a reader that closes early ends the follow quietly instead of erroring', async () => {
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

    await waitUntil(() => `the tail to be printed (stderr: ${stderr})`, () => stdout.includes('first line'));

    // `gateway logs --follow | head -5`: the reader has what it wanted and goes
    // away. Destroying our end of the pipe is what the shell does to the CLI.
    child.stdout!.destroy();

    // Keep writing, so a follower that ignored the closed pipe would keep
    // trying to write into it rather than sitting idle. Each append ends
    // mid-line on purpose, so the file never ends in a newline and the final
    // flush after the loop always has a held-back fragment to emit.
    const writer = setInterval(() => {
      try { fs.appendFileSync(file, `${record('nobody is reading this')}{"unterminated":`); } catch { /* dir gone */ }
    }, 20);
    try {
      await waitUntil(() => `the follow to end once its reader is gone (stderr: ${stderr})`, () => exitCode !== null);
    } finally {
      clearInterval(writer);
    }

    // The operator asked for output and got it; a broken pipe afterwards is the
    // end of the pipeline, not a failure to report.
    expect(stderr).not.toMatch(/EPIPE|Error:/);
    expect(exitCode).toBe(0);
  });

  // Treating *every* stdout error as "the reader left" would be worse than the
  // crash it replaced: attaching a listener marks the 'error' handled, so a
  // genuine write failure would leave the follow polling forever into nothing
  // and still exit 0. /dev/full reports ENOSPC on every write, which is that
  // failure without needing to fill a real disk.
  const hasDevFull = process.platform === 'linux' && fs.existsSync('/dev/full');
  (hasDevFull ? it : it.skip)(
    'I-LOGS-439d: a stdout failure that is not a closed pipe is reported, not swallowed',
    async () => {
      const file = path.join(dir, 'gateway.log');
      fs.writeFileSync(file, record('first line'));

      let stderr = '';
      let exitCode: number | null = null;
      const full = fs.openSync('/dev/full', 'w');
      try {
        child = spawn(process.execPath, ['-r', TS_NODE, HARNESS, 'gateway', 'logs', '--follow', '--logDir', dir], {
          stdio: ['ignore', full, 'pipe'],
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
        });
      } finally {
        fs.closeSync(full);
      }
      child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('exit', (code) => { exitCode = code; });

      await waitUntil(() => `the follow to give up on an unwritable stdout (stderr: ${stderr})`, () => exitCode !== null);

      expect(stderr).toContain('ENOSPC');
      expect(exitCode).toBe(1);
    },
  );

  // The same failure without `--follow`. It used to exit 0 with an empty
  // stderr: stdout reports a failed write after the call that made it returns,
  // so a command that returned as soon as the last line was handed over settled
  // its exit code before the failure arrived. Only the follow path escaped it,
  // and only because following keeps the process there long enough. A script
  // doing `gateway logs > snapshot.log` on a full disk got a truncated file and
  // a success code — the "answered when it should have spoken up" failure this
  // command exists to avoid.
  (hasDevFull ? it : it.skip)(
    'I-LOGS-439e: a plain read that cannot write its output fails loudly too',
    async () => {
      const file = path.join(dir, 'gateway.log');
      fs.writeFileSync(file, record('first line') + record('second line'));

      let stderr = '';
      let exitCode: number | null = null;
      const full = fs.openSync('/dev/full', 'w');
      try {
        child = spawn(process.execPath, ['-r', TS_NODE, HARNESS, 'gateway', 'logs', '--logDir', dir], {
          stdio: ['ignore', full, 'pipe'],
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
        });
      } finally {
        fs.closeSync(full);
      }
      child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('exit', (code) => { exitCode = code; });

      await waitUntil(() => `the plain read to exit (stderr: ${stderr})`, () => exitCode !== null);

      expect(stderr).toContain('Cannot write output (ENOSPC)');
      expect(exitCode).toBe(1);
    },
  );

  // Whoever calls `runGatewayLogs` should not have to finish its writes for it.
  // The command detaches the only 'error' listener stdout has when it returns,
  // so a write still in flight at that moment is left to the process — an
  // uncaught exception, stack trace and all. Nothing crashed only because
  // src/entry.ts calls `exitAfterFlush` on the next tick and its drain happened
  // to attach a listener in time; the bare harness removes that coincidence.
  (hasDevFull ? it : it.skip)(
    'I-LOGS-439f: reports the failure by itself, without the caller draining stdout',
    async () => {
      const file = path.join(dir, 'gateway.log');
      fs.writeFileSync(file, record('first line'));

      let stderr = '';
      let exitCode: number | null = null;
      const full = fs.openSync('/dev/full', 'w');
      try {
        child = spawn(process.execPath, ['-r', TS_NODE, HARNESS, 'gateway', 'logs', '--logDir', dir], {
          stdio: ['ignore', full, 'pipe'],
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', LOGS_HARNESS_EXIT: 'bare' },
        });
      } finally {
        fs.closeSync(full);
      }
      child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('exit', (code) => { exitCode = code; });

      await waitUntil(() => `the bare-exit read to finish (stderr: ${stderr})`, () => exitCode !== null);

      // The reported failure, and only that — no stack trace behind it.
      expect(stderr).toContain('Cannot write output (ENOSPC)');
      expect(stderr).not.toMatch(/at .*\(/);
      expect(exitCode).toBe(1);
    },
  );
});
