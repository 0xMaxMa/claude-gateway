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

/**
 * Set on the gateway's own environment once it has decided to boot, so every
 * process it spawns — agents, and any shell they open — is identifiable as a
 * descendant rather than a service main process.
 */
export const CHILD_MARKER = 'CLAUDE_GATEWAY_CHILD';

/** Records which supervisor started the gateway, after the inherited markers
 *  are scrubbed. Only the boot process sets it; children inherit it unused. */
export const SUPERVISOR_MARKER = 'CLAUDE_GATEWAY_SUPERVISOR';

export interface InvocationEnv {
  /** Set by systemd for every service invocation (v232+). */
  INVOCATION_ID?: string;
  /** Set by PM2 for managed processes. */
  pm_id?: string;
  PM2_HOME?: string;
  /** Present when a running gateway spawned this process. */
  CLAUDE_GATEWAY_CHILD?: string;
}

/** Facts about the invocation that are not environment variables. */
export interface InvocationSignals {
  /** True when a terminal is attached to stdin. */
  hasTty?: boolean;
}

/** True only for the explicit foreground-server invocation. */
export function isGatewayStartInvocation(argv: readonly string[]): boolean {
  return argv[0] === 'gateway' && argv[1] === 'start';
}

/**
 * True when this process *is* the service main process of a supervisor we
 * generate units for.
 *
 * `INVOCATION_ID`, `PM2_HOME` and `pm_id` are inherited by every descendant,
 * so on their own they identify the whole process tree rather than its root.
 * That matters because the gateway spawns agents that have shell access: a
 * bare `claude-gateway` typed in one of those shells would otherwise take the
 * legacy-boot path and start a second server on the gateway's port. Two
 * signals rule that out:
 *
 * - `CHILD_MARKER`, which a booting gateway stamps on its own environment
 *   (`claimSupervisorEnv`) after scrubbing the inherited supervisor markers.
 *   Any descendant carries it; a service main process never does.
 * - An attached terminal. Neither systemd nor PM2 gives a service one, so a
 *   TTY means a human is typing — covering an operator whose shell profile
 *   exports `PM2_HOME`.
 */
export function isSupervised(env: InvocationEnv, signals: InvocationSignals = {}): boolean {
  if (env[CHILD_MARKER]) return false;
  if (signals.hasTty) return false;
  return !!(env.INVOCATION_ID || env.PM2_HOME || env.pm_id !== undefined);
}

/**
 * Take ownership of the supervisor markers at boot: remove them so they are not
 * inherited, and leave a record of which supervisor started us.
 *
 * Called once, on the boot path only, after the invocation has been classified.
 * Doing it here rather than at each `spawn()` covers every child the server
 * creates, including ones added later.
 */
export function claimSupervisorEnv(env: NodeJS.ProcessEnv): void {
  const supervisor = env.INVOCATION_ID ? 'systemd' : env.PM2_HOME || env.pm_id !== undefined ? 'pm2' : null;
  delete env.INVOCATION_ID;
  delete env.PM2_HOME;
  delete env.pm_id;
  if (supervisor) env[SUPERVISOR_MARKER] = supervisor;
  env[CHILD_MARKER] = '1';
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
export function classifyInvocation(
  argv: readonly string[],
  env: InvocationEnv,
  signals: InvocationSignals = {},
): Invocation {
  if (isGatewayStartInvocation(argv)) return 'boot';
  const asksForHelp = argv.some((token) => HELP_OR_VERSION_FLAGS.has(token));
  if (!hasCommandToken(argv) && !asksForHelp && isSupervised(env, signals)) return 'legacy-boot';
  return 'cli';
}
