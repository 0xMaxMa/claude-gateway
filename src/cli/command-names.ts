/**
 * CLI invocation classification, deliberately cheap (no heavy imports) so the
 * boot entry point can decide what an invocation means without loading either
 * the CLI runner or the server.
 *
 * Starting the gateway is explicit: only `gateway start` boots. Everything else
 * — a bare `claude-gateway`, `--help`, a typo — goes to the CLI, so discovery
 * can never leave a stray server listening on the port.
 */
/** How src/index.ts should handle an invocation. */
export type Invocation =
  /** `gateway start [...]` — boot the server in the foreground. */
  | 'boot'
  /**
   * A pre-1.8 supervised launch (`ExecStart=/usr/local/bin/claude-gateway`)
   * with no command. Boots with a deprecation warning so existing systemd/PM2
   * units keep working instead of restart-looping on an instant exit-0 help.
   */
  | 'legacy-boot'
  /** Anything else — hand the argv to the CLI runner. */
  | 'cli';

export interface InvocationEnv {
  /** Set by systemd for every service invocation (v232+). */
  INVOCATION_ID?: string;
  /** Set by PM2 for managed processes. */
  pm_id?: string;
  PM2_HOME?: string;
}

/** True only for the explicit foreground-server invocation. */
export function isGatewayStartInvocation(argv: readonly string[]): boolean {
  return argv[0] === 'gateway' && argv[1] === 'start';
}

/** True when this process was launched by a supervisor we generate units for. */
export function isSupervised(env: InvocationEnv): boolean {
  return !!(env.INVOCATION_ID || env.PM2_HOME || env.pm_id !== undefined);
}

const HELP_OR_VERSION_FLAGS = new Set(['--help', '-h', '--version', '-V']);

/**
 * True when argv contains no command name — only flags and their values.
 * `--config /etc/cg.json` counts as flag-only: the path is the flag's value,
 * not a command.
 */
function hasCommandToken(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) return true;
    // `--flag value` consumes the next token; `--flag=value` does not.
    if (!token.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i++;
  }
  return false;
}

/**
 * Classify `argv` (already sliced past node + script).
 *
 * The legacy shim is intentionally narrow: it applies only when a supervisor
 * launched us with no command at all (flags such as `--config` are allowed,
 * since old units pass them), and never for help/version flags.
 */
export function classifyInvocation(argv: readonly string[], env: InvocationEnv): Invocation {
  if (isGatewayStartInvocation(argv)) return 'boot';
  const asksForHelp = argv.some((token) => HELP_OR_VERSION_FLAGS.has(token));
  if (!hasCommandToken(argv) && !asksForHelp && isSupervised(env)) return 'legacy-boot';
  return 'cli';
}
