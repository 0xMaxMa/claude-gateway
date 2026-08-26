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
    try {
      proc.kill('SIGTERM');
    } catch {
      // Already exited between the caller's null-check and here.
      finish();
    }
  });
}
