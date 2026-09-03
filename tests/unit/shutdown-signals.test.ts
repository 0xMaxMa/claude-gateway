import { EventEmitter } from 'events';
import { EX_TEMPFAIL, SHUTDOWN_SIGNALS, registerShutdownSignals, requestExitCode } from '../../src/shutdown-signals';

describe('shutdown signal wiring (issue #405)', () => {
  // ── U-SD-405a: the defect itself ───────────────────────────────────────────
  it('U-SD-405a: SIGHUP runs the same graceful shutdown as SIGTERM', async () => {
    const target = new EventEmitter();
    const signalled: string[] = [];

    registerShutdownSignals({
      run: async (signal) => { signalled.push(signal); },
      exit: () => {},
      target,
    });

    target.emit('SIGHUP');
    await new Promise((r) => setImmediate(r));

    expect(signalled).toEqual(['SIGHUP']);
  });

  it('U-SD-405b: every shutdown signal is wired, and SIGHUP is one of them', () => {
    const target = new EventEmitter();
    registerShutdownSignals({ run: async () => {}, exit: () => {}, target });

    expect([...SHUTDOWN_SIGNALS]).toEqual(expect.arrayContaining(['SIGTERM', 'SIGINT', 'SIGHUP']));
    for (const signal of SHUTDOWN_SIGNALS) {
      expect(target.listenerCount(signal)).toBe(1);
    }
  });

  // ── U-SD-405c: a second signal must not exit mid-teardown ──────────────────
  it('U-SD-405c: a signal during an in-flight shutdown joins it instead of exiting early', async () => {
    const target = new EventEmitter();
    let releaseShutdown!: () => void;
    const teardownDone = new Promise<void>((resolve) => { releaseShutdown = resolve; });

    const runs: string[] = [];
    const exits: number[] = [];

    registerShutdownSignals({
      run: async (signal) => { runs.push(signal); await teardownDone; },
      exit: (code) => exits.push(code),
      target,
    });

    target.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));
    // Teardown is deliberately still running here.
    expect(runs).toEqual(['SIGTERM']);
    expect(exits).toEqual([]);

    // The hangup arrives mid-shutdown. It must NOT start a second teardown, and
    // must NOT reach exit() while the first is still unfinished.
    target.emit('SIGHUP');
    await new Promise((r) => setImmediate(r));
    expect(runs).toEqual(['SIGTERM']);
    expect(exits).toEqual([]);

    releaseShutdown();
    await new Promise((r) => setImmediate(r));

    // Both handlers exit only now, and only one teardown ever ran.
    expect(runs).toEqual(['SIGTERM']);
    expect(exits).toEqual([0, 0]);
  });

  it('U-SD-405d: onBegin fires once, for the first signal only', async () => {
    const target = new EventEmitter();
    const began: string[] = [];

    registerShutdownSignals({
      run: async () => {},
      onBegin: (signal) => began.push(signal),
      exit: () => {},
      target,
    });

    target.emit('SIGHUP');
    target.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));

    expect(began).toEqual(['SIGHUP']);
  });

  it('U-SD-405e: the returned shutdown shares the in-flight run with the handlers', async () => {
    const target = new EventEmitter();
    let runs = 0;

    const shutdown = registerShutdownSignals({
      run: async () => { runs++; },
      exit: () => {},
      target,
    });

    // The crash handlers call this directly; it must not duplicate a
    // signal-initiated teardown.
    target.emit('SIGTERM');
    await shutdown('uncaughtException');
    await new Promise((r) => setImmediate(r));

    expect(runs).toBe(1);
  });

  // ── U-SD-405f: a failed teardown must not hang the gateway ─────────────────
  it('U-SD-405f: exits non-zero when shutdown throws instead of hanging on the signal', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    const errors: unknown[] = [];

    registerShutdownSignals({
      run: async () => { throw new Error('router.stop() blew up'); },
      exit: (code) => exits.push(code),
      onError: (err) => errors.push(err),
      target,
    });

    target.emit('SIGHUP');
    await new Promise((r) => setImmediate(r));

    // A rejection used to skip .then(exit) entirely, leaving the process alive
    // and still holding its port and its children.
    expect(exits).toEqual([1]);
    expect((errors[0] as Error).message).toBe('router.stop() blew up');
  });
});

describe('requestExitCode (issue #450)', () => {
  it('overrides the exit code for the very next signal-driven shutdown', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];

    registerShutdownSignals({ run: async () => {}, exit: (code) => exits.push(code), target });

    requestExitCode(EX_TEMPFAIL);
    target.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));

    expect(exits).toEqual([EX_TEMPFAIL]);
  });

  it('defaults to exit 0 when nothing requested a code', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];

    registerShutdownSignals({ run: async () => {}, exit: (code) => exits.push(code), target });

    target.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));

    expect(exits).toEqual([0]);
  });

  it('is consumed once — a requested code does not leak into a later shutdown', async () => {
    const targetA = new EventEmitter();
    const exitsA: number[] = [];
    requestExitCode(EX_TEMPFAIL);
    registerShutdownSignals({ run: async () => {}, exit: (code) => exitsA.push(code), target: targetA });
    targetA.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(exitsA).toEqual([EX_TEMPFAIL]);

    const targetB = new EventEmitter();
    const exitsB: number[] = [];
    registerShutdownSignals({ run: async () => {}, exit: (code) => exitsB.push(code), target: targetB });
    targetB.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(exitsB).toEqual([0]);
  });

  it('a shutdown that throws still exits 1, ignoring any requested code', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    requestExitCode(EX_TEMPFAIL);

    registerShutdownSignals({
      run: async () => { throw new Error('boom'); },
      exit: (code) => exits.push(code),
      onError: () => {},
      target,
    });

    target.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));

    expect(exits).toEqual([1]);
  });

  // A second, unrelated `requestExitCode()` call landing *after* a teardown
  // has already started (but before it resolves) must not change that
  // teardown's exit code — e.g. an operator's own `kill <pid>` starts the
  // shutdown with nothing pending, and the update endpoint's timer (racing
  // to self-restart) calls `requestExitCode(EX_TEMPFAIL)` while it's still
  // draining. The operator's deliberate stop must still exit 0, not inherit
  // a code requested for a shutdown it didn't start.
  it('a requestExitCode() call made after a shutdown has already started does not affect it', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    let releaseShutdown!: () => void;
    const teardownDone = new Promise<void>((resolve) => { releaseShutdown = resolve; });

    registerShutdownSignals({
      run: async () => { await teardownDone; },
      exit: (code) => exits.push(code),
      target,
    });

    // Nothing pending yet — this teardown starts wanting exit 0.
    target.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([]);

    // A later, unrelated request while the teardown above is still running.
    requestExitCode(EX_TEMPFAIL);

    releaseShutdown();
    await new Promise((r) => setImmediate(r));

    // The already-started teardown must exit with the code it began with (0),
    // not the EX_TEMPFAIL requested after it was already under way.
    expect(exits).toEqual([0]);
  });
});
