import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { printResult, exitAfterFlush, helpStream, writeCommandHelp } from '../../src/cli/output';

describe('cli output printResult', () => {
  let written: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    written = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(chunk.toString());
      return true;
    });
  });
  afterEach(() => spy.mockRestore());

  it('pretty-prints by default and minifies with compact', () => {
    printResult({ a: 1 }, false);
    expect(written.join('')).toBe('{\n  "a": 1\n}\n');
    written = [];
    printResult({ a: 1 }, true);
    expect(written.join('')).toBe('{"a":1}\n');
  });

  it('passes a string through unchanged', () => {
    printResult('done', true);
    expect(written.join('')).toBe('done\n');
  });
});

/**
 * `process.exit()` discards whatever stdout still has buffered, and stdout is
 * asynchronous when it is a pipe. A large `--json` payload piped into `jq`
 * therefore arrived truncated at the pipe buffer, which is exactly the
 * workflow the JSON-only stdout convention exists for.
 *
 * Run out-of-process: the failure only exists for a real pipe, so an in-process
 * mock of `process.stdout.write` cannot observe it.
 */
describe('cli output exitAfterFlush', () => {
  const PAYLOAD_BYTES = 5 * 1024 * 1024; // comfortably past a 64 KiB pipe buffer
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-flush-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Runs `body` in a child whose stdout is a pipe; returns the bytes received. */
  function pipedBytes(body: string): { bytes: number; status: number } {
    const script = path.join(dir, 'run.js');
    fs.writeFileSync(script, body);
    try {
      const out = execFileSync(process.execPath, ['-r', 'ts-node/register', script], {
        maxBuffer: PAYLOAD_BYTES * 2,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
      });
      return { bytes: out.length, status: 0 };
    } catch (err) {
      const e = err as { stdout?: Buffer; status?: number };
      return { bytes: e.stdout?.length ?? 0, status: e.status ?? -1 };
    }
  }

  it('delivers the whole payload through a pipe, unlike a bare process.exit()', () => {
    const write = `process.stdout.write('x'.repeat(${PAYLOAD_BYTES}) + '\\n');`;
    const flushed = pipedBytes(
      `${write}\nrequire(${JSON.stringify(path.resolve('src/cli/output.ts'))}).exitAfterFlush(0);`,
    );
    const truncated = pipedBytes(`${write}\nprocess.exit(0);`);

    expect(flushed.bytes).toBe(PAYLOAD_BYTES + 1);
    expect(flushed.status).toBe(0);
    // The bug this guards against, demonstrated in the same run.
    expect(truncated.bytes).toBeLessThan(PAYLOAD_BYTES);
  });

  it('preserves a non-zero exit code', () => {
    const res = pipedBytes(
      `process.stdout.write('short\\n');\nrequire(${JSON.stringify(path.resolve('src/cli/output.ts'))}).exitAfterFlush(3);`,
    );
    expect(res.status).toBe(3);
    expect(res.bytes).toBe(6);
  });
});

/**
 * A stream reports a failed write *after* the call that made it returns, so
 * "have my writes landed?" and "did any of them fail?" are the same question.
 * `gateway logs` decides its exit code on the answer, and detaches its stdout
 * 'error' listener once it has one — settling early would both hide the failure
 * and leave the event to the process as an uncaught exception.
 *
 * Out-of-process again: a real failing stdout is the only thing that exercises
 * this, and `/dev/full` is that failure without needing to fill a disk.
 */
describe('cli output flushStream', () => {
  const OUTPUT = JSON.stringify(path.resolve('src/cli/output.ts'));
  const hasDevFull = process.platform === 'linux' && fs.existsSync('/dev/full');
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-flushstream-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Runs `body` with stdout pointed at `/dev/full`; returns its stderr and code. */
  function onFullDisk(body: string): { stderr: string; status: number | null } {
    const script = path.join(dir, 'run.js');
    fs.writeFileSync(script, body);
    const full = fs.openSync('/dev/full', 'w');
    try {
      const res = spawnSync(process.execPath, ['-r', 'ts-node/register', script], {
        stdio: ['ignore', full, 'pipe'],
        encoding: 'utf8',
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
      });
      return { stderr: res.stderr ?? '', status: res.status };
    } finally {
      fs.closeSync(full);
    }
  }

  (hasDevFull ? it : it.skip)('settles only after a failed write has been reported', () => {
    const res = onFullDisk(`
      const { flushStream } = require(${OUTPUT});
      const seen = [];
      process.stdout.on('error', (e) => seen.push('error:' + e.code));
      process.stdout.write('some output\\n');
      flushStream(process.stdout).then(() => {
        seen.push('settled');
        process.stderr.write(JSON.stringify(seen) + '\\n');
      });
    `);
    // Not merely "contains error": the order is the whole point.
    expect(res.stderr.trim()).toBe('["error:ENOSPC","settled"]');
  });

  (hasDevFull ? it : it.skip)('leaves nothing for the caller to catch after it settles', () => {
    const res = onFullDisk(`
      const { flushStream } = require(${OUTPUT});
      const onError = () => {};
      process.stdout.on('error', onError);
      process.stdout.write('some output\\n');
      flushStream(process.stdout).then(() => {
        // What a command does once it has its answer: stdout is nobody's
        // responsibility again. Any write still owed an error now ends the
        // process — including one this flush made itself.
        process.stdout.off('error', onError);
        setTimeout(() => process.exit(0), 50);
      });
    `);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });

  it('waits for buffered bytes to reach a pipe', () => {
    const script = path.join(dir, 'drain.js');
    const size = 5 * 1024 * 1024;
    fs.writeFileSync(
      script,
      `const { flushStream } = require(${OUTPUT});
       process.stdout.write('x'.repeat(${size}) + '\\n');
       flushStream(process.stdout).then(() => process.exit(0));`,
    );
    const res = spawnSync(process.execPath, ['-r', 'ts-node/register', script], {
      maxBuffer: size * 2,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    expect(res.stdout.length).toBe(size + 1);
    expect(res.status).toBe(0);
  });
});

/**
 * `--help` used to go to stderr in every case, so `claude-gateway --help | less`
 * showed an empty screen. An explicitly requested help listing is the command's
 * result and belongs on stdout; the same listing shown because the invocation
 * was wrong is diagnostic and stays on stderr, which keeps stdout carrying
 * results only.
 */
describe('cli output help routing', () => {
  it('sends requested help to stdout and error help to stderr', () => {
    expect(helpStream(true)).toBe(process.stdout);
    expect(helpStream(false)).toBe(process.stderr);
  });

  it('renders every command help through one banner shape', () => {
    const out: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(c.toString());
      return true;
    });
    try {
      writeCommandHelp(true, 'gateway', 'manage the gateway process', 'claude-gateway gateway <verb>', ['  extra']);
    } finally {
      spy.mockRestore();
    }
    const text = out.join('');
    expect(text).toContain('claude-gateway gateway — manage the gateway process');
    expect(text).toContain('Usage: claude-gateway gateway <verb>');
    expect(text).toContain('  extra');
  });
});
