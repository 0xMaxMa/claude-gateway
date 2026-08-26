/**
 * Generic condition poller for async tests. Prefer this over a fixed
 * `setTimeout` sleep + direct assertion — a fixed sleep either wastes time
 * (waiting longer than needed) or is too short under load (flaky failures
 * unrelated to the code under test).
 *
 * ── Two rules these helpers exist to enforce ────────────────────────────────
 *
 * 1. NEVER sleep to wait for a subsystem to become ready, then fire a one-shot
 *    event at it. If the subsystem is not ready yet the event is *lost*, and
 *    the test then waits out its entire deadline for something that will never
 *    arrive. `watchWorkspace()` / `watchSkills()` / `createWatcher()` all
 *    return a handle with a `ready` promise for exactly this reason (chokidar
 *    runs with `ignoreInitial: true`, so a write landing before its initial
 *    scan completes produces no event at all — verified). Await the readiness
 *    signal the subsystem gives you.
 *
 * 2. A timeout is a SAFETY NET, not an assertion. Sizing one just above what
 *    the machine happens to need turns "the behaviour is correct" into "the
 *    machine was fast enough", and the test fails on an unrelated busy CPU.
 *    If elapsed time is genuinely what a test asserts, assert on it explicitly
 *    and say so — don't smuggle it in as a poll budget.
 */

/**
 * Default poll budget. Deliberately generous: it only bounds how long a
 * *broken* build takes to fail, and every millisecond under it is free on a
 * healthy one. Tests share this constant so a single machine-speed assumption
 * can't drift out across a dozen local copies of `waitFor`.
 */
export const WAIT_TIMEOUT_MS = 10_000;

export function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Polls `pred` every `intervalMs` until it returns true or `timeoutMs`
 * elapses. Resolves to the final result of `pred()` either way — callers
 * that want a hard failure on timeout should assert on the return value.
 */
export async function waitFor(
  pred: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await waitMs(intervalMs);
  }
  return pred();
}

/**
 * Poll until `predicate` holds, throwing if it never does.
 *
 * This is the shared replacement for eleven near-identical local pollers: nine
 * named `waitFor` (eight suites plus the PTY harness) and two more named
 * `waitForCondition`. Their timeouts had drifted to 3000 / 4000 / 5000 /
 * 10000ms — eleven independent guesses at how fast the machine is, and the
 * shorter ones lost that bet under a full parallel run.
 *
 * The failure message quotes the predicate's own source, so a timeout says
 * which condition never came true instead of just "waitFor timeout exceeded".
 * Pass `label` when the source alone isn't self-explanatory.
 */
export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = WAIT_TIMEOUT_MS,
  intervalMs = 50,
  label?: string,
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  // A predicate may throw while the system is still settling — reading a file
  // the code under test has not written yet is the common case — so a throw
  // counts as "not true yet". It is NOT discarded, though: swallowing the cause
  // is what makes a timeout impossible to diagnose, so the last error is
  // attached to the failure if the condition never comes true.
  let lastError: unknown;
  const attempt = async (): Promise<boolean> => {
    try {
      return await predicate();
    } catch (err) {
      lastError = err;
      return false;
    }
  };

  while (Date.now() < deadline) {
    if (await attempt()) return;
    await waitMs(intervalMs);
  }
  if (await attempt()) return;

  const because =
    lastError instanceof Error
      ? `; last attempt threw: ${lastError.message}`
      : lastError !== undefined
        ? `; last attempt threw: ${String(lastError)}`
        : '';
  throw new Error(
    `Timed out after ${Date.now() - startedAt}ms waiting for: ${label ?? describe(predicate)}${because}`,
  );
}

/** Best-effort one-line rendering of a predicate for failure messages. */
function describe(predicate: () => unknown): string {
  const src = String(predicate).replace(/\s+/g, ' ').trim();
  const body = src.replace(/^\(\s*\)\s*=>\s*/, '');
  return body.length > 160 ? `${body.slice(0, 157)}...` : body;
}
