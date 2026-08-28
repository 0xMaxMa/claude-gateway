/**
 * CLI invocation classification, deliberately cheap (no heavy imports) so the
 * boot entry point can decide what an invocation means without loading either
 * the CLI runner or the server.
 *
 * Starting the gateway is explicit: only `gateway start` boots. Everything else
 * — a bare `claude-gateway`, `--help`, a typo — goes to the CLI, so discovery
 * can never leave a stray server listening on the port.
 */
import * as fs from 'fs';

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
  /**
   * True when this process's immediate parent is systemd itself, per
   * `isDirectSystemdChild()`. Undefined/false means "not proven" — callers
   * that don't check ancestry (most unit tests) get the safe default.
   */
  parentIsSystemd?: boolean;
}

/**
 * True when this process's immediate parent is systemd itself — not merely a
 * descendant of some process that systemd happens to manage.
 *
 * `INVOCATION_ID` is inherited by every descendant of a systemd unit's main
 * process, including a shell that unit opens. A unit whose only job is to host
 * a terminal (a web-terminal service, say) taints every command a human types
 * into it with an `INVOCATION_ID` that was never meant to identify *that*
 * command. This check is what lets `isSupervised()` tell "systemd forked me
 * directly" from "I'm several processes deep inside something systemd manages".
 *
 * `ppid === 1` covers system-level units (systemd is always pid 1) and most
 * containers. A `systemd --user` unit's parent is the per-user manager
 * instead, at an unpredictable pid, so it's identified by its `comm` name —
 * the same reasoning `orphan-receivers.ts` uses for the mirror-image
 * "reparented to init" check.
 *
 * Linux-only (systemd itself is Linux-only) and fails closed: any error, or
 * any other platform, returns `false`. A false negative costs a legacy unit a
 * help screen instead of booting; a false positive risks a second server on
 * the gateway's port, which is the worse failure.
 */
export function isDirectSystemdChild(ppid: number = process.ppid): boolean {
  if (ppid === 1) return true;
  try {
    return fs.readFileSync(`/proc/${ppid}/comm`, 'utf8').trim() === 'systemd';
  } catch {
    return false;
  }
}

/** True only for the explicit foreground-server invocation. */
export function isGatewayStartInvocation(argv: readonly string[]): boolean {
  return argv[0] === 'gateway' && argv[1] === 'start';
}

/**
 * True when this process *is* the service main process of a supervisor we
 * generate units for.
 *
 * The supervisor variables are inherited by every descendant, so on their own
 * they identify the whole process tree rather than its root. That matters
 * because the gateway spawns agents that have shell access: a bare
 * `claude-gateway` typed in one of those shells would otherwise take the
 * legacy-boot path and start a second server on the gateway's port.
 *
 * `CHILD_MARKER` settles it: a booting gateway stamps it on its own environment
 * (`claimSupervisorEnv`), so every descendant carries it and a service main
 * process never does. It is checked first and nothing else can override it.
 *
 * The remaining variables are not equal evidence, so they are not weighed
 * equally:
 *
 * - `INVOCATION_ID` is *identity minted by systemd*, but only for the exact
 *   process it forked — every descendant of that process inherits the same
 *   value, including a shell some *other*, unrelated unit opens (a
 *   web-terminal service, say). So it is trusted only alongside
 *   `signals.parentIsSystemd`, which proves this process — not some ancestor
 *   several levels up — is the one systemd actually launched. Once proven, a
 *   terminal being attached doesn't overrule it, so a legacy unit with
 *   `StandardInput=tty` still boots rather than printing help at its service
 *   manager.
 * - `pm_id` is trusted unconditionally, same as before this file's
 *   `parentIsSystemd` check was added — PM2-managed processes aren't
 *   generally used to host an interactive terminal the way a systemd unit can
 *   (see `isDirectSystemdChild`), so the same inheritance risk hasn't been
 *   observed for it. That is an asymmetry, not a proof it can't happen.
 * - `PM2_HOME` is *configuration* — where PM2 keeps its data. An operator can
 *   reasonably export it from a shell profile, where it says nothing about how
 *   this process was launched. It counts only when no terminal is attached.
 */
export function isSupervised(env: InvocationEnv, signals: InvocationSignals = {}): boolean {
  if (env[CHILD_MARKER]) return false;
  if (env.INVOCATION_ID) return signals.parentIsSystemd === true;
  if (env.pm_id !== undefined) return true;
  return !!env.PM2_HOME && !signals.hasTty;
}

/**
 * Take ownership of the supervisor markers at boot: record which supervisor
 * started us, drop the ones that would misidentify a descendant as a service,
 * and stamp `CHILD_MARKER` so no descendant can classify itself as one.
 *
 * Called once, on the boot path only, after the invocation has been classified.
 * Doing it here rather than at each `spawn()` covers every child the server
 * creates, including ones added later.
 *
 * `PM2_HOME` is deliberately left in place. Unlike the other two it is not a
 * launch marker but the location of PM2's own data directory, and the gateway
 * spawns agents with shells: stripping it would silently point any `pm2` they
 * run at the default `~/.pm2` instead of the configured one. `CHILD_MARKER`
 * already prevents it from being misread here.
 */
export function claimSupervisorEnv(env: NodeJS.ProcessEnv): void {
  const supervisor = env.INVOCATION_ID ? 'systemd' : env.PM2_HOME || env.pm_id !== undefined ? 'pm2' : null;
  delete env.INVOCATION_ID;
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
