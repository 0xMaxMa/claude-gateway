/**
 * Signal wiring for the gateway's graceful shutdown.
 *
 * Extracted from index.ts so the two properties that actually matter can be
 * tested without booting a gateway:
 *
 *   1. Which signals run `shutdown()` at all. SIGHUP was missing, and Node's
 *      default disposition for it is to terminate the process WITHOUT running
 *      any handler — so a closed tmux pane, `tmux kill-session`, or a dropped
 *      SSH connection killed the gateway while every spawned receiver child was
 *      reparented to init and kept running. See issue #405.
 *
 *   2. That a second signal joins the in-flight shutdown instead of racing it.
 *      Previously the guard returned `undefined` immediately, so the second
 *      handler's `.then(() => process.exit(0))` fired at once and terminated the
 *      process partway through the first shutdown — the exact outcome the
 *      graceful path exists to avoid.
 */

/**
 * Every signal that means "wind down cleanly".
 *
 * SIGHUP belongs here for the same reason it does in
 * `src/shell/claude-pty-shell.ts:407` (issue #371): it is the ordinary way a
 * hand-run process is stopped, and its default action skips handlers entirely.
 */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/**
 * sysexits.h `EX_TEMPFAIL` — "temporary failure, user is invited to retry".
 * Used by callers that trigger their own shutdown (see `requestExitCode`) but
 * need `Restart=on-failure` systemd units to treat the exit as failure-worth-
 * restarting, rather than the default clean-shutdown code 0. See issue #450:
 * an API-triggered update SIGTERMs the gateway itself expecting the
 * supervisor to bring it back, but `on-failure` only restarts on a non-zero
 * exit or a signal kill, not on a graceful `exit(0)`.
 */
export const EX_TEMPFAIL = 75;

let pendingExitCode = 0;

/**
 * Overrides the exit code the *next* signal-driven shutdown uses, then resets
 * to 0 (the default clean-exit code) once consumed — so a caller that
 * triggers its own shutdown (e.g. the package updater sending itself
 * SIGTERM) can request `on-failure` supervisors restart it, without pinning
 * every future shutdown to the same code.
 */
export function requestExitCode(code: number): void {
  pendingExitCode = code;
}

export interface ShutdownSignalOptions {
  /** The teardown itself. Invoked at most once, no matter how many signals arrive. */
  run: (signal: string) => Promise<void>;
  /** Called synchronously when the first shutdown begins (before `run`). */
  onBegin?: (signal: string) => void;
  /** Overridable for tests. Defaults to terminating the process. */
  exit?: (code: number) => void;
  /** Reports a teardown that threw. Defaults to stderr. */
  onError?: (err: unknown) => void;
  /** Overridable for tests. Defaults to the real `process`. */
  target?: { on(event: string, listener: () => void): unknown };
}

/**
 * Register a handler for every shutdown signal and return the deduplicated
 * shutdown function, so callers (e.g. the crash handlers) can trigger the same
 * single teardown.
 */
export function registerShutdownSignals(
  opts: ShutdownSignalOptions,
): (signal: string) => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const onError =
    opts.onError ?? ((err: unknown) => console.error('[gateway] Shutdown failed:', err));
  const target = opts.target ?? process;

  let inFlight: Promise<void> | null = null;

  const shutdown = (signal: string): Promise<void> => {
    if (inFlight) return inFlight;
    opts.onBegin?.(signal);
    inFlight = opts.run(signal);
    return inFlight;
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    target.on(signal, () => {
      // A teardown that throws must still terminate the process. Previously the
      // rejection skipped `.then(exit)` entirely and the gateway hung on the
      // signal — holding its port and its children — which is a worse outcome
      // than an unclean exit. Exit non-zero so the failure stays visible.
      void shutdown(signal).then(
        () => {
          const code = pendingExitCode;
          pendingExitCode = 0;
          exit(code);
        },
        (err) => {
          pendingExitCode = 0;
          onError(err);
          exit(1);
        },
      );
    });
  }

  return shutdown;
}
