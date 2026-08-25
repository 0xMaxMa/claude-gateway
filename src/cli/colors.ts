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
  /** Bold + bright orange (xterm-256 colour 208) for the program name. */
  brand256: '\x1b[1m\x1b[38;5;208m',
  /** Fallback for terminals that advertise only the 16-colour palette: the
   *  nearest warm tone. Orange has no 16-colour code, so yellow stands in. */
  brand16: '\x1b[1m\x1b[33m',
} as const;

export type Paint = (s: string) => string;

export interface Palette {
  enabled: boolean;
  /** The program name — bold orange. */
  brand: Paint;
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  cyan: Paint;
}

/** True when the terminal advertises the 256-colour palette (or truecolor),
 *  which is what the orange brand tone needs. `COLORTERM` is set by terminals
 *  that support 24-bit colour; otherwise `TERM` names the palette. */
export function supports256Colors(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COLORTERM !== undefined && env.COLORTERM !== '') return true;
  return /-256(color)?\b|truecolor|direct/i.test(env.TERM ?? '');
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
    brand: wrap(supports256Colors(env) ? CODES.brand256 : CODES.brand16),
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    red: wrap(CODES.red),
    green: wrap(CODES.green),
    yellow: wrap(CODES.yellow),
    cyan: wrap(CODES.cyan),
  };
}
