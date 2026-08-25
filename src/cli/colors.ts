/**
 * Minimal ANSI colouring for CLI output.
 *
 * Colour is opt-out safe: it is emitted only when the target stream is a TTY,
 * never when `NO_COLOR` is set (https://no-color.org), and always when
 * `FORCE_COLOR` is set — which is what lets tests assert on coloured output
 * while piped runs (including every integration test) stay plain text.
 *
 * Only human-facing text on **stderr** is coloured. `--json` output goes to
 * stdout and must stay machine-parseable, so it is never painted.
 */

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

export type Paint = (s: string) => string;

export interface Palette {
  enabled: boolean;
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  cyan: Paint;
}

/** Decide whether `stream` should receive colour, given `env`. */
export function colorsEnabled(
  stream: { isTTY?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return stream?.isTTY === true;
}

/** Build a palette for `stream`. When colour is off every paint is identity,
 *  so call sites need no branching and can never leak escape codes. */
export function paletteFor(
  stream: { isTTY?: boolean } | undefined = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): Palette {
  const enabled = colorsEnabled(stream, env);
  const wrap =
    (code: string): Paint =>
    (s: string) =>
      enabled ? `${code}${s}${CODES.reset}` : s;
  return {
    enabled,
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    red: wrap(CODES.red),
    green: wrap(CODES.green),
    yellow: wrap(CODES.yellow),
    cyan: wrap(CODES.cyan),
  };
}
