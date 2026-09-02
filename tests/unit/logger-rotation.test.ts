import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configureLogging,
  createLogger,
  loggingConfig,
  LOGS_DEFAULTS,
  resetLoggingForTests,
  startLogRetentionSweep,
  sweepOldLogs,
} from '../../src/logger';

/**
 * Log verbosity, rotation and retention (issue #435).
 *
 * The directory that motivated this measured 557 MB across 59 files on a live
 * host after hours of uptime, 99% of it session logs and 99.98% of the largest
 * file a single `debug` message. So the level gate is tested first and hardest:
 * rotation bounds what is *kept*, but only the gate bounds what is *written*.
 */
describe('logger level gate, rotation and retention (#435)', () => {
  let dir: string;
  let outSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-logger-'));
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
    resetLoggingForTests();
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    resetLoggingForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readLines = (file: string): string[] =>
    fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter(Boolean);

  // ── U-LOG-01..04: the level gate ──────────────────────────────────────────

  it('U-LOG-01: drops debug at the default level, on disk and on stdout', () => {
    const log = createLogger('a1', dir);
    log.debug('per-event noise', { line: 'x'.repeat(100) });
    log.info('kept');

    const lines = readLines('a1.log');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe('info');
    // stdout is duplicated into the journal under systemd, so the gate has to
    // cover it too or the on-disk saving is paid for twice elsewhere.
    expect(stdout.join('')).not.toContain('per-event noise');
  });

  it('U-LOG-02: level "debug" restores the old behaviour verbatim', () => {
    configureLogging({ level: 'debug' });
    const log = createLogger('a2', dir);
    log.debug('now kept');
    log.info('also kept');

    expect(readLines('a2.log')).toHaveLength(2);
  });

  it('U-LOG-03: a higher level still lets warn and error through', () => {
    configureLogging({ level: 'warn' });
    const log = createLogger('a3', dir);
    log.debug('no');
    log.info('no');
    log.warn('yes');
    log.error('yes');

    expect(readLines('a3.log').map((l) => JSON.parse(l).level)).toEqual(['warn', 'error']);
  });

  it('U-LOG-04: an unknown level falls back to the default instead of dropping everything', () => {
    configureLogging({ level: 'verbose' as never });
    expect(loggingConfig().level).toBe(LOGS_DEFAULTS.level);
    const log = createLogger('a4', dir);
    log.info('kept');
    expect(readLines('a4.log')).toHaveLength(1);
  });

  // ── U-LOG-05..09: rotation ────────────────────────────────────────────────

  it('U-LOG-05: a file past maxFileBytes is rotated and a new one started', () => {
    configureLogging({ maxFileBytes: 400, maxFiles: 3 });
    const log = createLogger('r1', dir);
    for (let i = 0; i < 10; i++) log.info(`message ${i}`, { pad: 'y'.repeat(50) });

    expect(fs.existsSync(path.join(dir, 'r1.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'r1.log.1'))).toBe(true);
    // The live file is always below the threshold — that is the whole point.
    expect(fs.statSync(path.join(dir, 'r1.log')).size).toBeLessThanOrEqual(400);
  });

  it('U-LOG-06: at most maxFiles generations are kept, and the oldest is deleted', () => {
    configureLogging({ maxFileBytes: 200, maxFiles: 2 });
    const log = createLogger('r2', dir);
    for (let i = 0; i < 40; i++) log.info(`message ${i}`, { pad: 'z'.repeat(50) });

    const generations = fs.readdirSync(dir).filter((n) => /^r2\.log\.\d+$/.test(n)).sort();
    expect(generations).toEqual(['r2.log.1', 'r2.log.2']);
    expect(fs.existsSync(path.join(dir, 'r2.log.3'))).toBe(false);
  });

  it('U-LOG-07: generations shift, so .log.1 always holds the most recently rotated content', () => {
    configureLogging({ maxFileBytes: 150, maxFiles: 2 });
    const log = createLogger('r3', dir);
    log.info('first', { pad: 'a'.repeat(100) });
    log.info('second', { pad: 'b'.repeat(100) });
    log.info('third', { pad: 'c'.repeat(100) });

    expect(fs.readFileSync(path.join(dir, 'r3.log.1'), 'utf-8')).toContain('second');
    expect(fs.readFileSync(path.join(dir, 'r3.log.2'), 'utf-8')).toContain('first');
  });

  it('U-LOG-08: maxFiles 0 keeps no generations — the live file simply starts over', () => {
    configureLogging({ maxFileBytes: 150, maxFiles: 0 });
    const log = createLogger('r4', dir);
    log.info('first', { pad: 'a'.repeat(100) });
    log.info('second', { pad: 'b'.repeat(100) });

    expect(fs.readdirSync(dir).filter((n) => n.startsWith('r4.log'))).toEqual(['r4.log']);
    const live = fs.readFileSync(path.join(dir, 'r4.log'), 'utf-8');
    expect(live).toContain('second');
    // Started over, not merely appended to — otherwise "keep no generations"
    // would be indistinguishable from "never rotate", which is unbounded growth.
    expect(live).not.toContain('first');
  });

  it('U-LOG-20: lowering maxFiles collects the generations it orphaned', () => {
    // A rename clobbers its destination, so the cap looks self-enforcing until
    // the config changes underneath it: generations above the new cap have
    // nothing renaming onto them and would sit there until they aged out.
    configureLogging({ maxFileBytes: 150, maxFiles: 5 });
    const log5 = createLogger('r6', dir);
    for (let i = 0; i < 8; i++) log5.info(`m${i}`, { pad: 'a'.repeat(100) });
    expect(fs.readdirSync(dir).filter((n) => /^r6\.log\.\d+$/.test(n)).length).toBeGreaterThan(2);

    resetLoggingForTests();
    configureLogging({ maxFileBytes: 150, maxFiles: 2 });
    const log2 = createLogger('r6', dir);
    for (let i = 0; i < 4; i++) log2.info(`n${i}`, { pad: 'b'.repeat(100) });

    expect(fs.readdirSync(dir).filter((n) => /^r6\.log\.\d+$/.test(n)).sort()).toEqual([
      'r6.log.1',
      'r6.log.2',
    ]);
  });

  it('U-LOG-09: two loggers on the same file share one size counter, so rotation is not late', () => {
    // `createLogger(agentConfig.id, …)` is called from both the boot path and
    // the runner constructor, so one file really does have several writers.
    // Per-instance counters would each see half the bytes and rotate late.
    configureLogging({ maxFileBytes: 400, maxFiles: 1 });
    const a = createLogger('shared', dir);
    const b = createLogger('shared', dir);
    const file = path.join(dir, 'shared.log');

    // Sampled after every write, not just at the end: a late-rotating writer
    // overshoots and then rotates back under the threshold, so the final size
    // alone cannot tell the two apart.
    const sizes: number[] = [];
    for (let i = 0; i < 8; i++) {
      a.info(`a${i}`, { pad: 'x'.repeat(40) });
      sizes.push(fs.statSync(file).size);
      b.info(`b${i}`, { pad: 'x'.repeat(40) });
      sizes.push(fs.statSync(file).size);
    }

    expect(Math.max(...sizes)).toBeLessThanOrEqual(400);
  });

  it('U-LOG-10: rotation never throws into the caller', () => {
    configureLogging({ maxFileBytes: 100, maxFiles: 2 });
    const log = createLogger('r5', dir);
    log.info('seed', { pad: 'q'.repeat(200) });
    // A directory where the rotated generation should go makes every rename
    // fail. Logging must still be a call that returns.
    fs.mkdirSync(path.join(dir, 'r5.log.1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'r5.log.1', 'blocker'), 'x');

    expect(() => log.info('after', { pad: 'q'.repeat(200) })).not.toThrow();
  });

  // ── U-LOG-11..13: the write-failure latch ─────────────────────────────────

  it('U-LOG-11: a failed append is reported once, not swallowed and not repeated', () => {
    // A real failure rather than a mocked one: a directory sitting where the
    // log file belongs makes every append throw EISDIR, which is the same shape
    // as the full disk / permission change this latch exists for.
    fs.mkdirSync(path.join(dir, 'w1.log'), { recursive: true });
    const log = createLogger('w1', dir);

    expect(() => log.info('one')).not.toThrow();
    log.info('two');
    log.info('three');

    const reports = stderr.filter((s) => s.includes('[logger] cannot write'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('EISDIR');
    expect(reports[0]).toContain(path.join(dir, 'w1.log'));
  });

  // ── U-LOG-12..16: age-based retention ─────────────────────────────────────

  it('U-LOG-12: files older than retentionDays are removed, newer ones kept', () => {
    const old = path.join(dir, 'old.log');
    const fresh = path.join(dir, 'fresh.log');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(old, longAgo / 1000, longAgo / 1000);

    const removed = sweepOldLogs(dir, 14);

    expect(removed).toEqual([old]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('U-LOG-13: rotated generations age out too', () => {
    const gen = path.join(dir, 'a.log.2');
    fs.writeFileSync(gen, 'x');
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(gen, longAgo / 1000, longAgo / 1000);

    expect(sweepOldLogs(dir, 14)).toEqual([gen]);
  });

  it('U-LOG-14: retentionDays 0 keeps forever', () => {
    const old = path.join(dir, 'old.log');
    fs.writeFileSync(old, 'x');
    const longAgo = Date.now() - 900 * 24 * 60 * 60 * 1000;
    fs.utimesSync(old, longAgo / 1000, longAgo / 1000);

    expect(sweepOldLogs(dir, 0)).toEqual([]);
    expect(fs.existsSync(old)).toBe(true);
  });

  it('U-LOG-15: the sweep only deletes log files — the directory is not exclusively ours', () => {
    const stranger = path.join(dir, 'notes.txt');
    fs.writeFileSync(stranger, 'x');
    const longAgo = Date.now() - 900 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stranger, longAgo / 1000, longAgo / 1000);

    expect(sweepOldLogs(dir, 1)).toEqual([]);
    expect(fs.existsSync(stranger)).toBe(true);
  });

  it('U-LOG-16: startLogRetentionSweep sweeps at boot and reports what it removed', () => {
    configureLogging({ retentionDays: 14 });
    const old = path.join(dir, 'stale.log');
    fs.writeFileSync(old, 'x');
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(old, longAgo / 1000, longAgo / 1000);

    const seen: string[][] = [];
    const stop = startLogRetentionSweep(dir, (removed) => seen.push(removed));
    stop();

    expect(seen).toEqual([[old]]);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('U-LOG-17: an unreadable log directory is not a crash at boot', () => {
    expect(() => sweepOldLogs(path.join(dir, 'nope'), 14)).not.toThrow();
    expect(sweepOldLogs(path.join(dir, 'nope'), 14)).toEqual([]);
  });

  it('U-LOG-21: the daily sweep is scheduled even when retention starts disabled', () => {
    // `retentionDays` is read on each run, so a policy reloaded later takes
    // effect at the next sweep — but only if a timer exists to reach it. One
    // that was never started because retention happened to be 0 at boot could
    // not, and retention would stay off until a restart.
    configureLogging({ retentionDays: 0 });
    const timers = jest.spyOn(global, 'setInterval');
    const stop = startLogRetentionSweep(dir);
    expect(timers).toHaveBeenCalledTimes(1);

    // Turn retention on the way a config reload would, then let the timer fire.
    const old = path.join(dir, 'stale.log');
    fs.writeFileSync(old, 'x');
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(old, longAgo / 1000, longAgo / 1000);
    configureLogging({ retentionDays: 14 });

    const tick = timers.mock.calls[0][0] as () => void;
    tick();

    expect(fs.existsSync(old)).toBe(false);
    stop();
    timers.mockRestore();
  });

  // ── U-LOG-18: defaults ────────────────────────────────────────────────────

  it('U-LOG-18: a config with no gateway.logs block runs on defaults', () => {
    const applied = configureLogging(undefined);
    expect(applied).toEqual(LOGS_DEFAULTS);
  });

  it('U-LOG-19: nonsense thresholds fall back rather than rotating every line', () => {
    const applied = configureLogging({ maxFileBytes: 0, maxFiles: -1, retentionDays: Number.NaN });
    expect(applied.maxFileBytes).toBe(LOGS_DEFAULTS.maxFileBytes);
    expect(applied.maxFiles).toBe(LOGS_DEFAULTS.maxFiles);
    expect(applied.retentionDays).toBe(LOGS_DEFAULTS.retentionDays);
  });
});
