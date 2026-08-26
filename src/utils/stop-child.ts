import { ChildProcess } from 'child_process';

/** How long a supervised child gets to exit on SIGTERM before it is SIGKILLed. */
export const STOP_GRACE_MS = 5_000;

export interface StopChildOptions {
  /** Milliseconds to wait for a clean exit before escalating. */
  graceMs?: number;
  /** Called just before SIGKILL, so the caller can log with its own identity. */
  onEscalate?: (pid: number | undefined) => void;
}

/**
 * Terminate a supervised child and resolve only once it has actually exited.
 *
 * A bare `kill('SIGTERM')` is not enough: a receiver blocked in an in-flight
 * long-poll can sit in its own handler indefinitely, and the caller had no way to
 * know. Escalating to SIGKILL after a bounded grace period guarantees the child
 * cannot outlive the gateway's shutdown. See issue #405.
 *
 * Never rejects — a shutdown path must not be derailed by a teardown failure.
 */
export function stopChildProcess(
  proc: ChildProcess | null,
  opts: StopChildOptions = {},
): Promise<void> {
  if (!proc) return Promise.resolve();

  const graceMs = opts.graceMs ?? STOP_GRACE_MS;

  return new Promise<void>((resolve) => {
    // An already-exited child never emits another 'exit', and `kill()` on it
    // returns false *without throwing* (Node has cleared its handle) — so the
    // catch below would not fire and the promise would idle for the whole grace
    // period before "escalating" with a SIGKILL that does nothing.
    //
    // Loose `!= null` is deliberate: a real ChildProcess always exposes both
    // fields as null while running, but anything that does not expose them at
    // all must be treated as ALIVE and signalled, never assumed dead and
    // silently skipped. Failing safe here means attempting the kill.
    if (proc.exitCode != null || proc.signalCode != null) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };

    const killTimer = setTimeout(() => {
      opts.onEscalate?.(proc.pid);
      // SIGKILL is delivered by the kernel whether or not we stay alive to
      // observe the exit, so resolving here cannot leave the child running.
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      finish();
    }, graceMs);

    proc.once('exit', finish);
    // Returns false rather than throwing if the child died in the moment before
    // this line; the exit event that clears the handle also settles us.
    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}
