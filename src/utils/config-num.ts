/**
 * Numeric resolution for values that arrive from config files.
 *
 * Config is untrusted input: a hand-edited `config.json` can put a string,
 * `null`, `NaN` or a wildly out-of-range number where a number is declared, and
 * the type system does not see it. Every consumer needs the same shape — clamp
 * to a sane range, otherwise fall back to the built-in default — so it lives
 * here once instead of being re-derived per subsystem.
 */

/**
 * `value` when it is a finite number inside `[min, max]`, otherwise `fallback`.
 * Non-numbers, `NaN` and `Infinity` all take the fallback.
 */
export function numOr(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

/**
 * A millisecond budget destined for `setTimeout`, where `0`, a negative and
 * `NaN` all mean "no ceiling at all" — the opposite of what a timeout is for.
 * Anything that is not a positive finite number degrades to `fallbackMs`, and
 * the result is floored because a fractional delay is meaningless here.
 */
export function msOr(value: unknown, fallbackMs: number): number {
  return Math.floor(numOr(value, fallbackMs, 1, Number.MAX_SAFE_INTEGER));
}
