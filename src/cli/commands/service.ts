import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliConfigView, resolveLocalUrl } from '../http-client';
import { createRl, ask, printFilePreview } from '../prompt';
import { probeHealth } from '../health';
import { printJson } from '../output';
import { writeCommandHelp } from '../output';

/**
 * `service install|status|uninstall` — run the gateway under a process manager.
 *
 * systemd defaults to installing a *user* unit (`~/.config/systemd/user/`) so no
 * privilege escalation is needed and the service runs as the same user that owns
 * ~/.claude-gateway. `--scope system` opts into a root-owned unit at
 * `/etc/systemd/system/` for automated/infra provisioning that needs the gateway
 * to run under a fixed system account — it never auto-escalates via sudo; the
 * caller must already be root. PM2 is offered for hosts that already standardise
 * on it (user scope only — `--scope system` is systemd-only).
 *
 * Everything the generated unit references is an absolute path resolved here
 * (node binary, entry point, config, working directory) — a unit that inherits
 * PATH or cwd from an interactive shell breaks the moment systemd starts it at
 * boot. Secrets are never written into the unit: the gateway reads
 * ~/.claude-gateway/.env itself. `--env` is for non-secret overrides only — use
 * `--env-file` (EnvironmentFile=) to point at a file holding actual secrets.
 */

const UNIT_NAME = 'claude-gateway.service';
const PM2_NAME = 'gateway';
const HEALTH_ATTEMPTS = 20;
const HEALTH_INTERVAL_MS = 500;
/** `install`'s exit code when everything succeeded (unit written, enabled/
 *  started) but `/health` never answered within the poll window — distinct
 *  from `1` (install/enable itself failed, or a validation/confirmation gate
 *  refused) so a caller checking the exit code alone, not just the JSON
 *  result on stdout, can tell "didn't happen" apart from "happened, health
 *  unconfirmed". */
const EXIT_HEALTH_TIMEOUT = 2;
/** Env var names the installer itself sets — `--env` may not override these. */
const RESERVED_ENV_KEYS = new Set(['HOME', 'PATH', 'GATEWAY_CONFIG']);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ServiceManager = 'systemd' | 'pm2';
type ServiceAction = 'install' | 'status' | 'uninstall';
/** systemd install scope. `user` (default) needs no privileges; `system`
 *  targets /etc/systemd/system and is for root-driven provisioning. */
export type ServiceScope = 'user' | 'system';

export interface LaunchSpec {
  node: string;
  entry: string;
  cwd: string;
  config: string;
  home: string;
  pathEnv: string;
}

function gatewayHome(home: string = os.homedir()): string {
  return path.join(home, '.claude-gateway');
}

/** Same `~`/`~/...` expansion as the shared `expandHome()` (src/utils/paths.ts),
 *  but against an explicit `home` rather than always `os.homedir()`. That
 *  shared helper is used by the server too and means "this process's own
 *  home" everywhere else — for a `--scope system --run-as <user>` install,
 *  this process's own home is root's, not the target user's, so a `~` in
 *  `--config`/`--env-file` needs its own expansion here instead. */
function expandHomeAs(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** `allowEnvFallback` is false for a `--scope system` install: `$GATEWAY_CONFIG`
 *  belongs to the *installing* (root) process's environment, which has no
 *  reliable relationship to `--run-as`'s intended config — inheriting it
 *  would silently point the unit at a path the run-as user can't read. */
function configPath(flags: Record<string, string | boolean>, home: string = os.homedir(), allowEnvFallback: boolean = true): string {
  const explicit = typeof flags.config === 'string' ? flags.config : allowEnvFallback ? process.env.GATEWAY_CONFIG : undefined;
  return path.resolve(expandHomeAs(explicit ?? path.join(gatewayHome(home), 'config.json'), home));
}

/**
 * Build the PATH the service will run with.
 *
 * The inherited PATH is not usable: an interactive shell's PATH is full of
 * session-scoped entries (editor servers, per-project node_modules/.bin) that
 * may not exist when systemd starts the unit at boot. Instead, pin the
 * directories the gateway actually needs — the node that will run it, the
 * `claude` binary it spawns, and the standard system paths — keeping only
 * those that exist.
 *
 * `home` defaults to the *installing* process's home (`os.homedir()`), but a
 * `--scope system --run-as <user>` install passes the run-as user's home
 * instead — a root-run install must not bake root's own `~/.local/bin` /
 * `~/.bun/bin` into a unit that runs as someone else entirely.
 */
export function servicePath(home: string = os.homedir()): string {
  const candidates = [
    path.dirname(process.execPath),
    claudeBinDir(),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ];
  const seen = new Set<string>();
  const dirs = candidates.filter((dir): dir is string => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return fs.existsSync(dir);
  });
  return dirs.join(':');
}

/** Where the `claude` binary the gateway spawns currently lives, if resolvable. */
function claudeBinDir(): string | null {
  try {
    const resolved = capture('which', ['claude']).trim();
    return resolved ? path.dirname(resolved) : null;
  } catch {
    return null;
  }
}

/**
 * `getent passwd <user>` → that user's uid/gid/home, or null if the user
 * doesn't exist or `getent` itself isn't available. NSS-aware (works for
 * LDAP/sssd-backed accounts, not just local `/etc/passwd` entries), which a
 * naive `/etc/passwd` file parse would silently miss — the standard,
 * distro-agnostic way to resolve this on Linux.
 */
function resolveRunAsUser(username: string): { uid: number; gid: number; home: string } | null {
  try {
    const line = capture('getent', ['passwd', username]).trim();
    // name:password:UID:GID:GECOS:directory:shell
    const fields = line.split(':');
    const uid = Number(fields[2]);
    const gid = Number(fields[3]);
    const home = fields[5];
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || !home || !path.isAbsolute(home)) return null;
    return { uid, gid, home };
  } catch {
    return null;
  }
}

/** Resolve the absolute launch triple (node, entry, cwd) for a generated unit.
 *  Returns null — with a message — when the entry point can't be located, so a
 *  broken install never produces a unit that silently fails at boot.
 *
 *  `home` defaults to the installing process's own home. A `--scope system
 *  --run-as <user>` install passes that user's real home instead — the unit
 *  runs as them (`User=<user>`), so its WorkingDirectory/HOME/config path
 *  must be theirs, not the root process that wrote the unit. `allowEnvConfig`
 *  is false for that same case — see `configPath()`. */
export function resolveLaunchSpec(
  flags: Record<string, string | boolean>,
  home: string = os.homedir(),
  allowEnvConfig: boolean = true,
): LaunchSpec | null {
  // dist/cli/commands/service.js → dist/entry.js, the thin dispatcher that
  // loads only the side it needs. index.js is still a working boot entry and is
  // used when a partially-updated install predates the split, so a unit is
  // never written pointing at a file that is not there.
  const dir = path.resolve(__dirname, '..', '..');
  const thin = path.join(dir, 'entry.js');
  const entry = fs.existsSync(thin) ? thin : path.join(dir, 'index.js');
  const node = process.execPath;
  if (!path.isAbsolute(node) || !fs.existsSync(entry)) {
    process.stderr.write(
      `Cannot resolve the installed claude-gateway entry point (looked for ${entry}). ` +
        'Reinstall the package and try again.\n',
    );
    return null;
  }
  return {
    node,
    entry,
    cwd: gatewayHome(home),
    config: configPath(flags, home, allowEnvConfig),
    home,
    pathEnv: servicePath(home),
  };
}

/** systemd unit values are double-quoted here, so backslashes and quotes must
 *  be escaped or a path containing them would terminate the value early. */
function systemdQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Extra, opt-in shape of the rendered unit — on top of the LaunchSpec triple
 *  every manager shares. Systemd-only (PM2 has no equivalent concept), which is
 *  why this is a separate parameter rather than folded into LaunchSpec. */
export interface SystemdUnitOptions {
  scope: ServiceScope;
  /** Required by the caller when scope === 'system'; ignored for 'user'. */
  runAs?: string;
  /** Extra `After=` targets appended after the default `network-online.target`. */
  after: string[];
  /** Adds `EnvironmentFile=-<path>` — the sanctioned way to feed secrets in,
   *  since they never appear in the unit text itself. */
  envFile?: string;
  /** Additional `Environment="KEY=VALUE"` lines. Never for secrets — this text
   *  is written straight into the unit file. */
  extraEnv: Record<string, string>;
}

/** Default when a caller (or an existing test) passes no options — matches the
 *  behavior this command had before --scope existed exactly, so `--scope user`
 *  (or omitting it) is a strict no-op change. */
const DEFAULT_SYSTEMD_UNIT_OPTIONS: SystemdUnitOptions = { scope: 'user', after: [], extraEnv: {} };

/** Pure renderer — exported so `--print` and the tests see the exact bytes that
 *  would be written to disk. */
export function renderSystemdUnit(spec: LaunchSpec, opts: SystemdUnitOptions = DEFAULT_SYSTEMD_UNIT_OPTIONS): string {
  const q = systemdQuote;
  const after = ['network-online.target', ...opts.after].join(' ');
  const extraEnvLines = Object.entries(opts.extraEnv)
    .map(([key, value]) => `Environment="${key}=${q(value)}"`)
    .join('\n');
  const userLine = opts.scope === 'system' && opts.runAs ? `User=${opts.runAs}\n` : '';
  // Unquoted, like WorkingDirectory= above: EnvironmentFile= takes a single
  // bare path (with an optional leading `-`), not a quoted value — wrapping it
  // in quotes makes systemd read the quote character as part of the path and
  // reject it as "not absolute" (verified with `systemd-analyze verify`).
  const envFileLine = opts.envFile ? `EnvironmentFile=-${opts.envFile}\n` : '';
  const wantedBy = opts.scope === 'system' ? 'multi-user.target' : 'default.target';
  return `[Unit]
Description=Claude Gateway
Documentation=https://github.com/0xMaxMa/claude-gateway
Wants=network-online.target
After=${after}

[Service]
# exec (not simple): the unit is only considered "started" once the actual
# execve() succeeds — simple would report started right after fork(), before
# knowing whether ExecStart could even run at all, which reports a healthier
# state than reality if the binary/entry can't be exec'd. No known downside
# for a plain, long-running daemon like this.
Type=exec
${userLine}# WorkingDirectory is deliberately unquoted, unlike every other value here:
# systemd takes the rest of the line as the path, and rejects a quoted one
# ("path is not absolute"). Escaping is unnecessary for the same reason.
WorkingDirectory=${spec.cwd}
Environment="HOME=${q(spec.home)}"
Environment="PATH=${q(spec.pathEnv)}"
Environment="GATEWAY_CONFIG=${q(spec.config)}"
${extraEnvLines ? extraEnvLines + '\n' : ''}${envFileLine}ExecStart="${q(spec.node)}" "${q(spec.entry)}" gateway start --config "${q(spec.config)}"
Restart=always
RestartSec=5
# Without this, systemd's default OOMPolicy=stop treats an OOM-killed
# process ANYWHERE in this unit's cgroup (e.g. a dev server an agent spawned
# on its own) as the whole unit failing, and Restart=always then restarts
# the entire gateway — dropping every agent's session for an OOM kill that
# had nothing to do with gateway health.
OOMPolicy=continue

[Install]
WantedBy=${wantedBy}
`;
}

/** The exact argv `service install --manager pm2` would run. Exported for
 *  `--print` and tests so the preview can never drift from the real call. */
export function pm2StartArgs(spec: LaunchSpec): string[] {
  return [
    'start',
    spec.node,
    '--name',
    PM2_NAME,
    '--cwd',
    spec.cwd,
    '--',
    spec.entry,
    'gateway',
    'start',
    '--config',
    spec.config,
  ];
}

function unitPath(scope: ServiceScope): string {
  return scope === 'system'
    ? path.join('/etc', 'systemd', 'system', UNIT_NAME)
    : path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME);
}

/** True when this process is already root. Systemd `--scope system` never
 *  auto-escalates via sudo (unlike `gateway restart`/`stop`, which is driving
 *  an *existing* unit rather than deciding what account a new one runs as) —
 *  it fails fast instead, so the caller stays in control of the escalation. */
function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** `systemctl`/`journalctl` args for the given scope. */
function scopeCliArgs(scope: ServiceScope): string[] {
  return scope === 'user' ? ['--user'] : [];
}

/** Same, rendered for a hint message — with a trailing space so `system`
 *  scope (an empty args array) doesn't leave a double space before the next
 *  word, e.g. "journalctl  -u ...". */
function scopeHintPrefix(scope: ServiceScope): string {
  return scope === 'user' ? '--user ' : '';
}

function run(file: string, args: string[]): void {
  execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function capture(file: string, args: string[]): string {
  return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

/** True when the failure was "no such binary" rather than the command itself
 *  reporting a problem — so "PM2 is not installed" never gets reported as
 *  "PM2 refused to save its process list". */
function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Ask before changing service state — installing one, or stopping and removing
 * one. `--yes` skips the prompt; a non-interactive stdin without `--yes`
 * refuses rather than blocking forever, so this is safe in scripts and CI.
 */
async function confirm(
  flags: Record<string, string | boolean>,
  action: ServiceAction,
  question: string,
): Promise<boolean> {
  if (flags.yes === true) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write(`Refusing to ${action} non-interactively without --yes.\n`);
    return false;
  }
  const rl = createRl();
  try {
    const answer = (await ask(rl, `${question} (y/N): `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Poll /health so `service install` reports whether the service actually came
 *  up, instead of only whether the manager accepted the unit.
 *
 *  Probes the local bind address, never config.publicUrl: a proxy in front of a
 *  still-running old instance would answer for a service that never started. */
async function waitForHealth(config: CliConfigView, flags: Record<string, string | boolean>): Promise<boolean> {
  const baseUrl = resolveLocalUrl({ flagUrl: typeof flags.url === 'string' ? flags.url : undefined, env: process.env, config });
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
    if ((await probeHealth(baseUrl, 2000)).ok) return true;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
  }
  return false;
}

// ─── systemd ───────────────────────────────────────────────────────────────

/** `is-enabled`/`is-active` for `UNIT_NAME` at the given scope — the query
 *  both `systemdState()` (the install's own scope, for `service status`) and
 *  `crossScopeConflict()` (the opposite scope, for the install-time check
 *  below) need, differing only in scope. A named boolean rather than a raw
 *  argv fragment (`['--user']`/`[]`) so a future call site passing the wrong
 *  array fails to compile instead of silently querying the wrong scope. */
function unitFlagState(userScope: boolean): { enabled: boolean; active: boolean } {
  const scopeArgs = userScope ? ['--user'] : [];
  let enabled = false;
  let active = false;
  try {
    enabled = capture('systemctl', [...scopeArgs, 'is-enabled', UNIT_NAME]).trim() === 'enabled';
  } catch {
    /* systemctl absent, or the unit is disabled/missing */
  }
  try {
    active = capture('systemctl', [...scopeArgs, 'is-active', UNIT_NAME]).trim() === 'active';
  } catch {
    /* systemctl absent, or the unit is inactive */
  }
  return { enabled, active };
}

function systemdState(scope: ServiceScope): { installed: boolean; enabled: boolean; active: boolean } {
  return { installed: fs.existsSync(unitPath(scope)), ...unitFlagState(scope === 'user') };
}

function systemdManagerLabel(scope: ServiceScope): 'systemd-user' | 'systemd-system' {
  return scope === 'user' ? 'systemd-user' : 'systemd-system';
}

function systemdStatus(flags: Record<string, string | boolean>, scope: ServiceScope): number {
  const state = systemdState(scope);
  printJson({ manager: systemdManagerLabel(scope), unit: unitPath(scope), ...state }, flags);
  return state.active ? 0 : 1;
}

/**
 * True when a same-named unit already exists and is enabled or active at the
 * scope OPPOSITE to the one being installed — e.g. installing user scope
 * while an externally-provisioned system-scope unit is already enabled (the
 * original case, issue #450), or installing system scope while a prior
 * user-scope install is still active (issue #457 review — a system-scope
 * install only ever self-checked, missing this direction entirely). Either
 * way, two independent units end up racing for the same port on the next
 * boot.
 *
 * Reading the opposite scope needs no privileges: `systemctl
 * is-enabled`/`is-active` in either scope queries as any user, so this check
 * costs nothing extra.
 */
function crossScopeConflict(scope: ServiceScope): boolean {
  const { enabled, active } = unitFlagState(scope === 'system');
  return enabled || active;
}

/** Written to stderr when `crossScopeConflict()` refuses an install — shared
 *  by both the pre-prompt check and the re-check right after `confirm()`
 *  below, so the two call sites can't drift into different wording. */
function writeCrossScopeConflictRefusal(scope: ServiceScope): void {
  const otherScope: ServiceScope = scope === 'user' ? 'system' : 'user';
  const disableHint = otherScope === 'system' ? `  sudo systemctl disable --now ${UNIT_NAME}\n` : `  systemctl --user disable --now ${UNIT_NAME}\n`;
  process.stderr.write(
    `A ${UNIT_NAME} unit already exists at ${otherScope} scope (${unitPath(otherScope)}) and is enabled or active.\n` +
      `Installing a second, independent unit at ${scope} scope would race it for the port on the next reboot.\n` +
      `Disable the existing one first, then re-run this command:\n` +
      disableHint +
      'Pass --force to install anyway.\n',
  );
}

/** Every flag parsed below is spliced into a single line of the rendered unit
 *  verbatim (target names, env values, the run-as user, the env-file path) —
 *  a NUL or newline in any of them would let the caller inject an extra
 *  directive, or a whole new `[Section]`, into unit text meant to hold one
 *  value (NUL also throws downstream at spawn — same convention as the
 *  settings.json value guard in src/session/process.ts). Reject outright
 *  rather than encoding: this codebase never trusts external input without
 *  validating it at the boundary. */
function hasUnsafeUnitChars(value: string): boolean {
  return /[\0\r\n]/.test(value);
}

/** `--after <target1,target2,...>` — extra `After=` ordering targets, appended
 *  to the unit's default `network-online.target`. Comma-separated rather than
 *  a repeatable flag: the shared CLI parser (src/cli/args.ts) has no concept
 *  of repeated flags accumulating into an array, and adding one there would
 *  change every command's flag type, not just this one. */
function parseAfterTargets(flags: Record<string, string | boolean>): string[] | null {
  const raw = flags.after;
  if (raw === undefined) return [];
  if (typeof raw !== 'string' || raw.trim() === '') {
    process.stderr.write('--after requires a comma-separated list of systemd unit/target names.\n');
    return null;
  }
  const targets = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const target of targets) {
    if (hasUnsafeUnitChars(target)) {
      process.stderr.write(`Invalid --after target "${target}" — must not contain a NUL byte or line break.\n`);
      return null;
    }
    // No valid systemd unit/target name contains whitespace — a space
    // inside one comma-separated entry almost always means the caller meant
    // two separate targets and used a space instead of a comma by mistake.
    // Silently accepting it would splice an unintended second `After=`
    // target in via renderSystemdUnit()'s space-join, rather than erroring
    // on the typo.
    if (/\s/.test(target)) {
      process.stderr.write(`Invalid --after target "${target}" — systemd unit/target names cannot contain whitespace (use a comma to separate multiple targets).\n`);
      return null;
    }
  }
  return targets;
}

/** `--env KEY=VALUE[,KEY=VALUE...]` — extra `Environment=` lines. Rejects
 *  malformed pairs and the three variable names the installer itself sets, so
 *  a typo silently overriding HOME/PATH/GATEWAY_CONFIG fails loudly instead of
 *  producing a unit that starts the wrong binary. Never for secrets — this
 *  text is written straight into the unit file; point at --env-file instead. */
function parseExtraEnv(flags: Record<string, string | boolean>): Record<string, string> | null {
  const raw = flags.env;
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.trim() === '') {
    process.stderr.write('--env requires a comma-separated list of KEY=VALUE pairs.\n');
    return null;
  }
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      process.stderr.write(`Invalid --env entry "${trimmed}" — expected KEY=VALUE.\n`);
      return null;
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!ENV_KEY_RE.test(key)) {
      process.stderr.write(`Invalid --env key "${key}" — must match [A-Za-z_][A-Za-z0-9_]*.\n`);
      return null;
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      process.stderr.write(`--env cannot override "${key}" — it is set by the installer itself.\n`);
      return null;
    }
    if (hasUnsafeUnitChars(value)) {
      process.stderr.write(`Invalid --env value for "${key}" — must not contain a NUL byte or line break.\n`);
      return null;
    }
    out[key] = value;
  }
  return out;
}

/** `--env-file <path>` — adds `EnvironmentFile=-<path>` so a caller can feed
 *  secrets to the unit without ever putting them in its text. `-` means
 *  systemd tolerates the file being absent. Returns null (with a message
 *  already on stderr) for a path containing a line break — everything else
 *  reuses the null-on-invalid contract `resolveSystemdUnitOptions()` expects.
 *  `home` expands a leading `~` — the --run-as user's home for a system-scope
 *  install, not the installing (root) process's own. */
function parseEnvFile(flags: Record<string, string | boolean>, home: string): string | undefined | null {
  const raw = flags['env-file'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    // Distinct from "not passed at all": the shared CLI parser (src/cli/args.ts)
    // reads a flag with no following value (last token, or immediately
    // followed by another flag) as boolean `true` — silently treating that as
    // "omitted" would install with no EnvironmentFile= line while the caller
    // believes their secrets file is wired in.
    process.stderr.write('--env-file requires a path.\n');
    return null;
  }
  const resolved = path.resolve(expandHomeAs(raw, home));
  if (hasUnsafeUnitChars(resolved)) {
    process.stderr.write('Invalid --env-file path — must not contain a NUL byte or line break.\n');
    return null;
  }
  return resolved;
}

/** Validate/trim `--run-as`'s format and its combination with `scope` — not
 *  whether the named user actually exists (that's `resolveRunAsUser()`, a
 *  separate concern this function knows nothing about, since it also needs
 *  no privilege but does need a subprocess call). Returns `undefined` when
 *  `scope !== 'system'` and `--run-as` wasn't passed (the normal case), or
 *  null (message already on stderr) on any invalid combination. Split out
 *  from `resolveSystemdUnitOptions()` so the caller can resolve `--run-as`'s
 *  home *before* parsing `--env-file`, which needs that home to expand a
 *  leading `~` correctly. */
function resolveRunAsFlag(flags: Record<string, string | boolean>, scope: ServiceScope): string | undefined | null {
  if (scope !== 'system') {
    if (flags['run-as'] !== undefined) {
      // Loudly rejected rather than silently dropped, like every other
      // nonsensical combination this function checks — --run-as only means
      // anything for a unit that runs as a fixed system account.
      process.stderr.write('--run-as only applies to --scope system.\n');
      return null;
    }
    return undefined;
  }
  if (typeof flags['run-as'] !== 'string' || flags['run-as'].trim() === '') {
    process.stderr.write('--scope system requires --run-as <user>.\n');
    return null;
  }
  if (hasUnsafeUnitChars(flags['run-as'])) {
    process.stderr.write('Invalid --run-as value — must not contain a NUL byte or line break.\n');
    return null;
  }
  return flags['run-as'].trim();
}

/** Resolve and validate `--after`/`--env`/`--env-file` beyond the shared
 *  LaunchSpec triple. Returns null (with a message already on stderr) on any
 *  invalid input — install must never write a unit from a half-parsed flag
 *  set. `runAs` and `home` are already resolved by the caller (see
 *  `resolveRunAsFlag()`/`resolveRunAsUser()`). */
function resolveSystemdUnitOptions(
  flags: Record<string, string | boolean>,
  scope: ServiceScope,
  runAs: string | undefined,
  home: string,
): SystemdUnitOptions | null {
  const after = parseAfterTargets(flags);
  if (after === null) return null;
  const extraEnv = parseExtraEnv(flags);
  if (extraEnv === null) return null;
  const envFile = parseEnvFile(flags, home);
  if (envFile === null) return null;

  return { scope, runAs, after, envFile, extraEnv };
}

async function systemdInstall(
  flags: Record<string, string | boolean>,
  config: CliConfigView,
  scope: ServiceScope,
): Promise<number> {
  const runAsFlag = resolveRunAsFlag(flags, scope);
  if (runAsFlag === null) return 1;

  // A --scope system install runs this CLI as root, but the rendered unit
  // runs the gateway as runAsFlag — WorkingDirectory/HOME/config must be
  // *that* user's, not root's, or the process starts in the wrong place with
  // the wrong HOME entirely (getent is a read-only NSS lookup, so this needs
  // no privilege and can run even for a --print preview). Resolved before
  // parsing --env-file/--config below, which need this home to expand a
  // leading `~` against the right account.
  let home = os.homedir();
  let runAsIds: { uid: number; gid: number } | null = null;
  if (scope === 'system' && runAsFlag) {
    const resolved = resolveRunAsUser(runAsFlag);
    if (!resolved) {
      process.stderr.write(`Could not resolve --run-as ${runAsFlag} via \`getent passwd\` — does that user exist on this host?\n`);
      return 1;
    }
    home = resolved.home;
    runAsIds = { uid: resolved.uid, gid: resolved.gid };
  }

  const unitOpts = resolveSystemdUnitOptions(flags, scope, runAsFlag, home);
  if (!unitOpts) return 1;

  // $GATEWAY_CONFIG belongs to the installing (root) process's own
  // environment for a system-scope install — not reliably meaningful for
  // runAsFlag, so it's not consulted there; only an explicit --config is.
  const spec = resolveLaunchSpec(flags, home, scope !== 'system');
  if (!spec) return 1;
  const unit = renderSystemdUnit(spec, unitOpts);
  const file = unitPath(scope);
  const scopeArgs = scopeCliArgs(scope);

  // stderr, not stdout: stdout carries the JSON result (see printJson).
  printFilePreview(file, unit, (line) => process.stderr.write(line + '\n'));
  if (flags.print === true) return 0;

  // The root check goes here, after the print short-circuit above, matching
  // the crossScopeConflict() check below: both are STATE/PRIVILEGE gates
  // unrelated to what the unit would contain, so `--print` — a pure read —
  // must never need them just to render a preview. This is narrower than
  // "print always succeeds": resolveSystemdUnitOptions() above (e.g. the
  // --run-as requirement) still runs first, because without valid input
  // there is no unit content to preview at all — print can't show bytes
  // that could never be written.
  if (scope === 'system' && !isRoot()) {
    process.stderr.write(
      `--scope system must be run as root — it writes ${unitPath('system')} and can restart a system-wide unit.\n` +
        'Re-run as root; this command never escalates via sudo on its own.\n',
    );
    return 1;
  }

  // Guards against installing alongside an already-enabled/active unit at the
  // OTHER scope (either direction — see crossScopeConflict()'s doc comment).
  // A scope's install only ever conflicts with the opposite scope, never with
  // itself, so a repeated install of the same scope never trips this.
  if (flags.force !== true && crossScopeConflict(scope)) {
    writeCrossScopeConflictRefusal(scope);
    return 1;
  }

  const confirmQuestion =
    scope === 'system'
      ? `Install and start ${UNIT_NAME} at system scope, running as ${unitOpts.runAs}?`
      : `Install and start ${UNIT_NAME} for user ${os.userInfo().username}?`;
  if (!(await confirm(flags, 'install', confirmQuestion))) {
    process.stderr.write('Aborted — nothing was written.\n');
    return 1;
  }

  // `confirm()` can block indefinitely on the y/N prompt — re-check right
  // before writing anything, in case a conflicting unit appeared while it
  // was waiting on the operator.
  if (flags.force !== true && crossScopeConflict(scope)) {
    writeCrossScopeConflictRefusal(scope);
    return 1;
  }

  // Read the state a repeated install needs to decide enable vs. restart,
  // before anything is overwritten: whether the unit is already running, and
  // whether its content is about to change. A `daemon-reload` alone reloads
  // systemd's cached definition but does not restart an active unit, so a
  // repeated install used to apply an updated unit silently kept the stale
  // one running (issue #457) — restart explicitly when content changes under
  // an active unit, and leave an unchanged active unit alone otherwise.
  let previousContent: string | null;
  try {
    previousContent = fs.readFileSync(file, 'utf8') as unknown as string;
  } catch (err) {
    // Distinct from "no prior unit" (ENOENT, the normal first-install case):
    // any other error (e.g. EACCES) is surfaced rather than silently treated
    // as a fresh install, matching the unlinkSync error handling below.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`Could not read the existing unit at ${file}: ${(err as Error).message}\n`);
      return 1;
    }
    previousContent = null;
  }
  const wasActive = unitFlagState(scope === 'user').active;

  try {
    // A --scope system install creates this directory as root — if it didn't
    // already exist, it comes out root-owned, and the gateway (running as
    // runAsIds, not root) would be unable to write its pid file/logs into
    // its own WorkingDirectory. Also reassert ownership when the directory
    // already exists but belongs to someone other than the *current*
    // --run-as target — e.g. a prior install used a different --run-as user
    // and this one reassigns the service to another account — rather than
    // only checking "did this install just create it", which missed that
    // case entirely. A directory that already belongs to the right user is
    // left alone (no redundant chown).
    const cwdExisted = fs.existsSync(spec.cwd);
    fs.mkdirSync(spec.cwd, { recursive: true });
    if (runAsIds && (!cwdExisted || fs.statSync(spec.cwd).uid !== runAsIds.uid)) {
      fs.chownSync(spec.cwd, runAsIds.uid, runAsIds.gid);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: scope === 'user' ? 0o700 : 0o755 });
    fs.writeFileSync(file, unit, { encoding: 'utf8', mode: scope === 'user' ? 0o600 : 0o644 });
    // writeFileSync's `mode` option only applies when the file is newly
    // created — overwriting an existing one (e.g. adopting an
    // externally-provisioned unit, or a repeated install) leaves its current
    // permission bits untouched. chmod explicitly so the intended mode is
    // guaranteed either way — this file can carry --env values, so its
    // permissions are a real boundary, not cosmetic.
    fs.chmodSync(file, scope === 'user' ? 0o600 : 0o644);
    run('systemctl', [...scopeArgs, 'daemon-reload']);
    if (wasActive && previousContent !== null && previousContent !== unit) {
      // `restart` alone doesn't guarantee the unit is enabled — if it had
      // drifted to active-but-disabled (started manually, or an
      // externally-provisioned unit that was only ever started, not
      // enabled), only restarting would leave it silently unable to survive
      // the next reboot. The pre-#457 code always ran `enable --now`
      // unconditionally on every install, which held that invariant
      // regardless of prior state; this branch has to keep holding it too.
      run('systemctl', [...scopeArgs, 'enable', UNIT_NAME]);
      run('systemctl', [...scopeArgs, 'restart', UNIT_NAME]);
    } else {
      run('systemctl', [...scopeArgs, 'enable', '--now', UNIT_NAME]);
    }
  } catch (err) {
    process.stderr.write(
      `Could not install or start the ${scope} service: ${(err as Error).message}\n` +
        `Inspect it with: systemctl ${scopeHintPrefix(scope)}status ${UNIT_NAME} --no-pager\n`,
    );
    return 1;
  }

  const healthy = await waitForHealth(config, flags);
  printJson({ manager: systemdManagerLabel(scope), unit: file, ...systemdState(scope), health: healthy ? 'up' : 'down' }, flags);
  process.stderr.write(
    scope === 'system'
      ? `Installed ${UNIT_NAME} at system scope, running as ${unitOpts.runAs}.\n`
      : `Installed ${UNIT_NAME}.\n` + `To keep it running after you log out: loginctl enable-linger ${os.userInfo().username}\n`,
  );
  if (!healthy) {
    process.stderr.write(`Service did not answer /health yet — check: journalctl ${scopeHintPrefix(scope)}-u ${UNIT_NAME} -n 50 --no-pager\n`);
    return EXIT_HEALTH_TIMEOUT;
  }
  return 0;
}

async function systemdUninstall(flags: Record<string, string | boolean>, scope: ServiceScope): Promise<number> {
  if (scope === 'system' && !isRoot()) {
    process.stderr.write(`--scope system must be run as root — it removes ${unitPath('system')}.\n`);
    return 1;
  }
  const file = unitPath(scope);
  const scopeArgs = scopeCliArgs(scope);
  const before = systemdState(scope);
  if (!before.installed && !before.enabled && !before.active) {
    // Nothing to stop — prompting to stop a service that isn't there only
    // teaches people to answer these prompts without reading them.
    printJson({ manager: systemdManagerLabel(scope), unit: file, ...before }, flags);
    process.stderr.write(`${UNIT_NAME} is not installed — nothing to remove.\n`);
    return 0;
  }
  // `disable --now` stops a running gateway, so this asks like install does.
  if (!(await confirm(flags, 'uninstall', `Stop and remove ${UNIT_NAME}?`))) {
    process.stderr.write('Aborted — the service was left in place.\n');
    return 1;
  }
  try {
    run('systemctl', [...scopeArgs, 'disable', '--now', UNIT_NAME]);
  } catch {
    /* already stopped, or never installed */
  }
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`Could not remove ${file}: ${(err as Error).message}\n`);
      return 1;
    }
  }
  try {
    run('systemctl', [...scopeArgs, 'daemon-reload']);
  } catch {
    /* nothing to reload without systemd */
  }
  // Report what systemd actually says, not what was intended: the disable above
  // is best-effort, and claiming a stopped service that is still running would
  // be exactly the silent failure this codebase forbids.
  const state = systemdState(scope);
  printJson({ manager: systemdManagerLabel(scope), unit: file, ...state }, flags);
  if (state.active || state.installed) {
    process.stderr.write(`${UNIT_NAME} is still present — check: systemctl ${scopeHintPrefix(scope)}status ${UNIT_NAME} --no-pager\n`);
    return 1;
  }
  return 0;
}

// ─── PM2 ──────────────────────────────────────────────────────────────────────

interface Pm2Entry {
  name?: string;
  pm2_env?: { status?: string };
}

function pm2Entry(): Pm2Entry | undefined {
  const list = JSON.parse(capture('pm2', ['jlist'])) as Pm2Entry[];
  return list.find((item) => item.name === PM2_NAME);
}

function pm2Status(flags: Record<string, string | boolean>): number {
  let entry: Pm2Entry | undefined;
  try {
    entry = pm2Entry();
  } catch (err) {
    process.stderr.write(
      isMissingBinary(err)
        ? 'PM2 is not installed or not on PATH.\n'
        : 'Could not read the PM2 process list. Is PM2 running?\n',
    );
    return 1;
  }
  const status = entry?.pm2_env?.status ?? 'absent';
  printJson({ manager: 'pm2', name: PM2_NAME, installed: !!entry, active: status === 'online', status }, flags);
  return status === 'online' ? 0 : 1;
}

async function pm2Install(
  flags: Record<string, string | boolean>,
  config: CliConfigView,
): Promise<number> {
  const spec = resolveLaunchSpec(flags);
  if (!spec) return 1;
  const args = pm2StartArgs(spec);

  process.stderr.write(`\nWould run:\n  pm2 ${args.join(' ')}\n  pm2 save\n`);
  if (flags.print === true) return 0;
  if (!(await confirm(flags, 'install', `Register and start the PM2 process "${PM2_NAME}"?`))) {
    process.stderr.write('Aborted — nothing was registered.\n');
    return 1;
  }

  try {
    fs.mkdirSync(spec.cwd, { recursive: true });
    // Replacing an existing entry is the documented way to change its argv.
    try {
      run('pm2', ['delete', PM2_NAME]);
    } catch {
      /* first install — nothing to delete */
    }
    run('pm2', args);
    run('pm2', ['save']);
  } catch (err) {
    process.stderr.write(
      isMissingBinary(err)
        ? 'PM2 is not installed. Install it first (`npm install -g pm2`), or use --manager systemd.\n'
        : `Could not install or start the PM2 service: ${(err as Error).message}\nCheck: pm2 logs ${PM2_NAME}\n`,
    );
    return 1;
  }

  const healthy = await waitForHealth(config, flags);
  printJson({ manager: 'pm2', name: PM2_NAME, installed: true, health: healthy ? 'up' : 'down' }, flags);
  process.stderr.write('PM2 process list saved. Run `pm2 startup` once if you also want start-on-boot.\n');
  if (!healthy) {
    process.stderr.write(`Service did not answer /health yet — check: pm2 logs ${PM2_NAME}\n`);
    return EXIT_HEALTH_TIMEOUT;
  }
  return 0;
}

async function pm2Uninstall(flags: Record<string, string | boolean>): Promise<number> {
  let before: Pm2Entry | undefined;
  try {
    before = pm2Entry();
  } catch (err) {
    if (isMissingBinary(err)) {
      process.stderr.write('PM2 is not installed — nothing to remove.\n');
      return 0;
    }
    process.stderr.write('Could not read the PM2 process list. Is PM2 running?\n');
    return 1;
  }
  if (!before) {
    printJson({ manager: 'pm2', name: PM2_NAME, installed: false, active: false }, flags);
    process.stderr.write(`No PM2 process named "${PM2_NAME}" — nothing to remove.\n`);
    return 0;
  }
  // `pm2 delete` stops a running gateway, so this asks like install does.
  if (!(await confirm(flags, 'uninstall', `Stop and remove the PM2 process "${PM2_NAME}"?`))) {
    process.stderr.write('Aborted — the process was left in place.\n');
    return 1;
  }
  try {
    run('pm2', ['delete', PM2_NAME]);
  } catch {
    /* already absent */
  }
  try {
    run('pm2', ['save']);
  } catch (err) {
    process.stderr.write(
      isMissingBinary(err)
        ? 'PM2 is not installed — nothing to remove.\n'
        : 'Could not save the PM2 process list — the process may come back on the next PM2 resurrect.\n',
    );
    return isMissingBinary(err) ? 0 : 1;
  }
  // Same reason as the systemd path: report the observed state, not the intent.
  let entry: Pm2Entry | undefined;
  try {
    entry = pm2Entry();
  } catch {
    /* PM2 gone entirely — nothing left to report as running */
  }
  printJson({ manager: 'pm2', name: PM2_NAME, installed: !!entry, active: entry?.pm2_env?.status === 'online' }, flags);
  return entry ? 1 : 0;
}

// ─── entry point ──────────────────────────────────────────────────────────────

const USAGE_LINE =
  'claude-gateway service <install|status|uninstall> [--manager systemd|pm2] [--scope user|system] [--run-as <user>] ' +
  '[--after <target,...>] [--env-file <path>] [--env KEY=VALUE,...] [--config <path>] [--yes] [--print] [--force]';

/** Pick the manager to act on when `--manager` is omitted. `status`/`uninstall`
 *  act on whatever is actually installed; `install` always defaults to systemd
 *  so it can't silently pick a different manager than the one documented. */
function detectServiceManager(action: ServiceAction, scope: ServiceScope): ServiceManager {
  if (action === 'install') return 'systemd';
  if (fs.existsSync(unitPath(scope))) return 'systemd';
  try {
    if (pm2Entry()) return 'pm2';
  } catch {
    /* PM2 not installed */
  }
  return 'systemd';
}

function parseManager(flags: Record<string, string | boolean>, action: ServiceAction, scope: ServiceScope): ServiceManager | null {
  const raw = flags.manager;
  if (raw === undefined) return detectServiceManager(action, scope);
  if (raw === 'systemd' || raw === 'pm2') return raw;
  process.stderr.write('Unknown --manager. Expected systemd or pm2.\n');
  return null;
}

/** Pick the systemd scope to act on when `--scope` is omitted. `install`
 *  always defaults to `user` — it must never silently write a root-owned
 *  unit nobody explicitly asked for, no matter what already exists.
 *  `status`/`uninstall` instead detect: prefer an installed user-scope unit,
 *  fall back to system-scope. Without this, a bare `service status` after a
 *  `--scope system` install silently checks the (nonexistent) user-scope path
 *  and reports "not installed" — and `service uninstall` would report success
 *  (exit 0) while the system-scope unit keeps running untouched (issue #457
 *  review). Mirrors `detectServiceManager()`'s "detect what's actually there"
 *  approach for --manager. */
function detectServiceScope(action: ServiceAction): ServiceScope | null {
  if (action === 'install') return 'user';
  const userInstalled = fs.existsSync(unitPath('user'));
  const systemInstalled = fs.existsSync(unitPath('system'));
  // Both installed at once (e.g. a --force system-scope install alongside a
  // still-enabled user-scope one) is exactly the state crossScopeConflict()
  // exists to prevent — but --force means it can happen anyway. Silently
  // picking one would leave the other's real state unreported by `status`,
  // or untouched by `uninstall` while it reports success (issue #457
  // review) — refuse and make the caller say which one explicitly instead.
  if (userInstalled && systemInstalled) return null;
  if (userInstalled) return 'user';
  if (systemInstalled) return 'system';
  return 'user';
}

function parseScope(flags: Record<string, string | boolean>, action: ServiceAction): ServiceScope | null {
  const raw = flags.scope;
  if (raw === undefined) {
    // Scope is a systemd-only concept — skip probing for it entirely when
    // the manager is explicitly pm2. Beyond being pointless work, treating
    // unrelated systemd unit paths as ambiguous input to a decision pm2
    // never uses could wrongly refuse a pm2 action over a conflict that
    // doesn't apply to it at all.
    if (flags.manager === 'pm2') return 'user';
    const detected = detectServiceScope(action);
    if (detected === null) {
      process.stderr.write(
        `Both a user-scope and a system-scope ${UNIT_NAME} unit are installed — pass --scope user or --scope system to say which one.\n`,
      );
    }
    return detected;
  }
  if (raw === 'user' || raw === 'system') return raw;
  process.stderr.write('Unknown --scope. Expected user or system.\n');
  return null;
}

export async function runService(
  positionals: string[],
  flags: Record<string, string | boolean>,
  config: CliConfigView = {},
): Promise<number> {
  const action = positionals[0] as ServiceAction | undefined;
  if (!action) {
    // `service --help` is a help request (0); a bare `service` is a usage error (1).
    writeCommandHelp(
      flags.help === true,
      'service',
      'run the gateway as a systemd-user or PM2 service',
      USAGE_LINE,
      [
        '  systemd installs a user unit in ~/.config/systemd/user (no sudo) by default.',
        '  install refuses if a claude-gateway unit already exists at system scope;',
        '  --force overrides that check.',
        '  --scope system installs a root-owned unit in /etc/systemd/system instead —',
        '  requires running as root already (never escalates via sudo) and --run-as <user>.',
        '  --after, --env-file, and --env customize the generated unit further (systemd only).',
      ],
    );
    return flags.help === true ? 0 : 1;
  }
  if (action !== 'install' && action !== 'status' && action !== 'uninstall') {
    process.stderr.write(`Unknown: service ${action} (expected install|status|uninstall)\n`);
    return 1;
  }
  if (flags.print === true && action !== 'install') {
    // Rejected rather than ignored: silently accepting it would let someone
    // believe `service uninstall --print` was a dry run.
    process.stderr.write(`--print only applies to \`service install\` (it previews what would be written).\n`);
    return 1;
  }

  const scope = parseScope(flags, action);
  if (!scope) return 1;

  const manager = parseManager(flags, action, scope);
  if (!manager) return 1;

  if (manager === 'pm2') {
    if (scope === 'system') {
      process.stderr.write('--scope system only applies to the systemd manager, not pm2.\n');
      return 1;
    }
    // Every other systemd-only unit customization flag: reject rather than
    // silently drop, so `--manager pm2 --env-file secrets.env` doesn't exit 0
    // having wired in nothing the caller asked for.
    const systemdOnlyFlag = (['after', 'env', 'env-file', 'run-as'] as const).find((name) => flags[name] !== undefined);
    if (systemdOnlyFlag) {
      process.stderr.write(`--${systemdOnlyFlag} only applies to the systemd manager, not pm2.\n`);
      return 1;
    }
  }

  if (manager === 'systemd') {
    if (action === 'install') return systemdInstall(flags, config, scope);
    return action === 'status' ? systemdStatus(flags, scope) : await systemdUninstall(flags, scope);
  }
  if (action === 'install') return pm2Install(flags, config);
  return action === 'status' ? pm2Status(flags) : await pm2Uninstall(flags);
}
