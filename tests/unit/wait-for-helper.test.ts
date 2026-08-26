/**
 * The shared poller is now load-bearing for every integration suite, so its
 * two non-obvious behaviours are pinned here: a predicate that throws while the
 * system settles must not fail the test, and a timeout must say what it was
 * waiting for (a bare "waitFor timeout exceeded" is what made the previous
 * eight copies undiagnosable when they fired in CI).
 */

import { WAIT_TIMEOUT_MS, waitFor, waitForCondition } from '../helpers/wait-for';

describe('waitForCondition', () => {
  it('returns as soon as the predicate holds', async () => {
    let ticks = 0;
    await waitForCondition(() => ++ticks >= 3, 2000, 1);
    expect(ticks).toBe(3);
  });

  it('accepts an async predicate', async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 20);
    await waitForCondition(async () => ready, 2000, 1);
    expect(ready).toBe(true);
  });

  it('treats a throwing predicate as "not yet" while it can still come true', async () => {
    let attempts = 0;
    await waitForCondition(() => {
      if (++attempts < 3) throw new Error('ENOENT: still settling');
      return true;
    }, 2000, 1);
    expect(attempts).toBe(3);
  });

  it('names the condition in the timeout message', async () => {
    await expect(waitForCondition(() => false, 30, 5)).rejects.toThrow(/waiting for: false/);
  });

  it('prefers an explicit label over the predicate source', async () => {
    await expect(
      waitForCondition(() => false, 30, 5, 'the gateway to bind'),
    ).rejects.toThrow(/waiting for: the gateway to bind/);
  });

  it('reports the last error rather than swallowing it when it never succeeds', async () => {
    await expect(
      waitForCondition(() => { throw new Error('EACCES: permission denied'); }, 30, 5),
    ).rejects.toThrow(/last attempt threw: EACCES: permission denied/);
  });

  it('reports how long it waited', async () => {
    await expect(waitForCondition(() => false, 40, 5)).rejects.toThrow(/Timed out after \d+ms/);
  });

  it('defaults to a budget generous enough not to encode machine speed', () => {
    expect(WAIT_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('waitFor', () => {
  it('resolves false instead of throwing when the condition never holds', async () => {
    await expect(waitFor(() => false, 30, 5)).resolves.toBe(false);
  });

  it('re-checks once after the deadline so a just-in-time change still counts', async () => {
    let flipped = false;
    setTimeout(() => { flipped = true; }, 25);
    // Budget shorter than the flip: the post-deadline re-check is what saves it.
    await expect(waitFor(() => flipped, 10, 100)).resolves.toBe(true);
  });
});
