import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatLogLine, runGatewayLogs, tailLines } from '../../src/cli/commands/logs';
import { runGatewayLifecycle } from '../../src/cli/commands/gateway';
import type { CliConfigView } from '../../src/cli/http-client';

/**
 * `gateway logs` (issue #435) — reads the log files directly, so every test
 * here writes real files and runs the real command. There is no gateway
 * process: that is the point of the command, and of testing it this way.
 */
describe('cli gateway logs', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];
  let outSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  const entry = (level: string, message: string, data?: Record<string, unknown>): string =>
    JSON.stringify({ ts: '2026-09-02T00:00:00.000Z', agentId: 'gateway', level, message, ...(data ? { data } : {}) });

  const write = (name: string, lines: string[]): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cli-logs-'));
    stdout = [];
    stderr = [];
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(chunk.toString());
      return true;
    });
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── U-LOGS-01..04: the default read ───────────────────────────────────────

  it('U-LOGS-01: prints the tail of gateway.log and exits 0', async () => {
    write('gateway.log', [entry('info', 'booted'), entry('warn', 'slow start')]);

    const code = await runGatewayLogs({ logDir: dir });

    expect(code).toBe(0);
    expect(stdout.join('')).toBe(
      '2026-09-02T00:00:00.000Z INFO  booted\n2026-09-02T00:00:00.000Z WARN  slow start\n',
    );
  });

  it('U-LOGS-02: renders data compactly beside the message', async () => {
    write('gateway.log', [entry('error', 'agent skipped', { agentId: 'aika', varName: 'AIKA_TOKEN' })]);

    await runGatewayLogs({ logDir: dir });

    expect(stdout.join('')).toContain('ERROR agent skipped {"agentId":"aika","varName":"AIKA_TOKEN"}');
  });

  it('U-LOGS-03: --json output is byte-identical to the stored lines', async () => {
    const lines = [entry('info', 'one', { a: 1 }), entry('debug', 'two')];
    write('gateway.log', lines);

    const code = await runGatewayLogs({ logDir: dir, json: true });

    expect(code).toBe(0);
    expect(stdout.join('')).toBe(lines.join('\n') + '\n');
  });

  it('U-LOGS-04: --lines caps the tail at the newest n lines', async () => {
    write('gateway.log', Array.from({ length: 20 }, (_, i) => entry('info', `m${i}`)));

    await runGatewayLogs({ logDir: dir, lines: '3' });

    const printed = stdout.join('').trim().split('\n');
    expect(printed).toHaveLength(3);
    expect(printed[0]).toContain('m17');
    expect(printed[2]).toContain('m19');
  });

  // ── U-LOGS-05..08: explicit failures, never a silent empty result ─────────

  it('U-LOGS-05: an unknown --agent exits non-zero, naming the path tried and the ids available', async () => {
    write('gateway.log', [entry('info', 'x')]);
    write('aika:receiver.log', [entry('info', 'x')]);

    const code = await runGatewayLogs({ logDir: dir, agent: 'nope' });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain(path.join(dir, 'nope.log'));
    expect(stderr.join('')).toContain('aika:receiver');
    expect(stderr.join('')).toContain('gateway');
    expect(stdout.join('')).toBe('');
  });

  it('U-LOGS-06: an unreadable directory reports the errno rather than an empty listing', async () => {
    const missing = path.join(dir, 'not-here');

    const code = await runGatewayLogs({ logDir: missing });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain(`${missing} does not exist`);
  });

  it('U-LOGS-07: --lines is validated as a positive integer', async () => {
    write('gateway.log', [entry('info', 'x')]);

    for (const bad of ['abc', '0', '-5', '2.5', '']) {
      stderr.length = 0;
      const code = await runGatewayLogs({ logDir: dir, lines: bad });
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('--lines must be a positive integer');
    }
    // `--lines` with no value parses as boolean true, which is its own message.
    stderr.length = 0;
    expect(await runGatewayLogs({ logDir: dir, lines: true })).toBe(1);
    expect(stderr.join('')).toContain('--lines requires a value');
  });

  it('U-LOGS-08: a stream id cannot escape the log directory', async () => {
    const code = await runGatewayLogs({ logDir: dir, agent: '../../etc/passwd' });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('cannot contain a path separator');
  });

  // ── U-LOGS-09: --agent reads that stream ─────────────────────────────────

  it('U-LOGS-09: --agent <id> reads <id>.log, including a session id with colons', async () => {
    write('gateway.log', [entry('info', 'wrong file')]);
    write('meguri:session:abc-123.log', [entry('info', 'right file')]);

    const code = await runGatewayLogs({ logDir: dir, agent: 'meguri:session:abc-123' });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('right file');
    expect(stdout.join('')).not.toContain('wrong file');
  });

  // ── U-LOGS-10..12: --follow ───────────────────────────────────────────────

  it('U-LOGS-10: --follow streams appended lines and exits 0 when interrupted', async () => {
    const file = write('gateway.log', [entry('info', 'before')]);
    const ctl = new AbortController();

    const run = runGatewayLogs({ logDir: dir, follow: true }, { signal: ctl.signal, pollMs: 10 });
    await new Promise((r) => setTimeout(r, 40));
    fs.appendFileSync(file, entry('info', 'after') + '\n');
    await new Promise((r) => setTimeout(r, 60));
    ctl.abort();

    expect(await run).toBe(0);
    expect(stdout.join('')).toContain('before');
    expect(stdout.join('')).toContain('after');
  });

  it('U-LOGS-11: --follow reopens the file across a rotation instead of following the old inode', async () => {
    // This is where the two halves of #435 meet: the reader holds a file the
    // writer is free to rename out from under it.
    const file = write('gateway.log', [entry('info', 'first')]);
    const ctl = new AbortController();

    const run = runGatewayLogs({ logDir: dir, follow: true }, { signal: ctl.signal, pollMs: 10 });
    await new Promise((r) => setTimeout(r, 40));

    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, entry('info', 'after rotation') + '\n');
    await new Promise((r) => setTimeout(r, 80));
    ctl.abort();

    expect(await run).toBe(0);
    expect(stdout.join('')).toContain('after rotation');
  });

  it('U-LOGS-12: --follow never emits half a line', async () => {
    const file = write('gateway.log', []);
    const ctl = new AbortController();
    const line = entry('info', 'split across two writes');

    const run = runGatewayLogs({ logDir: dir, follow: true }, { signal: ctl.signal, pollMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    fs.appendFileSync(file, line.slice(0, 20));
    await new Promise((r) => setTimeout(r, 40));
    // Nothing may have been printed yet — the line is not terminated.
    expect(stdout.join('')).toBe('');
    fs.appendFileSync(file, line.slice(20) + '\n');
    await new Promise((r) => setTimeout(r, 40));
    ctl.abort();

    expect(await run).toBe(0);
    expect(stdout.join('')).toBe('2026-09-02T00:00:00.000Z INFO  split across two writes\n');
  });

  // ── U-LOGS-13..15: the verb is wired up ───────────────────────────────────

  it('U-LOGS-13: `gateway logs` reaches the command through the lifecycle dispatcher', async () => {
    write('gateway.log', [entry('info', 'through the verb')]);

    const code = await runGatewayLifecycle(['logs'], { logDir: dir }, {} as CliConfigView);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('through the verb');
  });

  it('U-LOGS-14: the unknown-verb message lists logs', async () => {
    const code = await runGatewayLifecycle(['nope'], {}, {} as CliConfigView);

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('start|status|restart|stop|logs');
  });

  it('U-LOGS-15: `gateway logs --help` is read-only and exits 0', async () => {
    const code = await runGatewayLogs({ help: true, logDir: dir });

    expect(code).toBe(0);
    expect(stdout.join('') + stderr.join('')).toContain('--follow');
  });

  // ── U-LOGS-16..18: the pure helpers ───────────────────────────────────────

  it('U-LOGS-16: a line that is not a log record is passed through verbatim', () => {
    expect(formatLogLine('not json at all')).toBe('not json at all');
    expect(formatLogLine('{"ts":"t","level":"info"}')).toBe('{"ts":"t","level":"info"}');
  });

  it('U-LOGS-17: tailLines returns whole lines when the tail spans several read chunks', () => {
    // Each line is ~1 KB, so 200 of them cross the 64 KB chunk boundary and the
    // reverse read has to stitch chunks without leaving a fragment behind.
    const lines = Array.from({ length: 200 }, (_, i) => `${i}:${'x'.repeat(1000)}`);
    const file = write('big.log', lines);

    const tail = tailLines(file, 5);

    expect(tail).toHaveLength(5);
    expect(tail[0]).toBe(lines[195]);
    expect(tail[4]).toBe(lines[199]);
  });

  it('U-LOGS-18: asking for more lines than the file holds returns the whole file', () => {
    const file = write('small.log', ['a', 'b']);
    expect(tailLines(file, 500)).toEqual(['a', 'b']);
  });

  it('U-LOGS-19: an empty log file is not an error', async () => {
    write('gateway.log', []);

    const code = await runGatewayLogs({ logDir: dir });

    expect(code).toBe(0);
    expect(stdout.join('')).toBe('');
  });
});
