/**
 * Generic condition poller for async tests. Prefer this over a fixed
 * `setTimeout` sleep + direct assertion — a fixed sleep either wastes time
 * (waiting longer than needed) or is too short under load (flaky failures
 * unrelated to the code under test).
 */

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
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await waitMs(intervalMs);
  }
  return pred();
}
