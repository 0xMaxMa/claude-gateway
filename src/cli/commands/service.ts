import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliConfigView, resolveLocalUrl } from '../http-client';
import { createRl, ask, printFilePreview } from '../prompt';
import { probeHealth } from '../health';
import { printJson } from '../output';
import { expandHome } from '../../utils/paths';
import { writeCommandHelp } from '../output';

/**
 * `service install|status|uninstall` — run the gateway under a process manager.
 *
 * systemd installs a *user* unit (`~/.config/systemd/user/`) so no privilege
 * escalation is needed and the service runs as the same user that owns
 * ~/.claude-gateway. PM2 is offered for hosts that already standardise on it.
 *
 * Everything the generated unit references is an absolute path resolved here
 * (node binary, entry point, config, working directory) — a unit that inherits
 * PATH or cwd from an interactive shell breaks the moment systemd starts it at
 * boot. Secrets are never written into the unit: the gateway reads
 * ~/.claude-gateway/.env itself.
 */

const UNIT_NAME = 'claude-gateway.service';
const PM2_NAME = 'gateway';
const HEALTH_ATTEMPTS = 20;
const HEALTH_INTERVAL_MS = 500;

export type ServiceManager = 'systemd' | 'pm2';
type ServiceAction = 'install' | 'status' | 'uninstall';

export interface LaunchSpec {
  node: string;
  entry: string;
  cwd: string;
  config: string;
  home: string;
  pathEnv: string;
}

function gatewayHome(): string {
  return path.join(os.homedir(), '.claude-gateway');
}

function configPath(flags: Record<string, string | boolean>): string {
  const explicit = typeof flags.config === 'string' ? flags.config : process.env.GATEWAY_CONFIG;
  return path.resolve(expandHome(explicit ?? path.join(gatewayHome(), 'config.json')));
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
 */
export function servicePath(): string {
  const candidates = [
    path.dirname(process.execPath),
    claudeBinDir(),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.bun', 'bin'),
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

/** Resolve the absolute launch triple (node, entry, cwd) for a generated unit.
 *  Returns null — with a message — when the entry point can't be located, so a
 *  broken install never produces a unit that silently fails at boot. */
export function resolveLaunchSpec(flags: Record<string, string | boolean>): LaunchSpec | null {
  // dist/cli/commands/service.js → dist/index.js
  const entry = path.resolve(__dirname, '..', '..', 'index.js');
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
    cwd: gatewayHome(),
    config: configPath(flags),
    home: os.homedir(),
    pathEnv: servicePath(),
  };
}

/** systemd unit values are double-quoted here, so backslashes and quotes must
 *  be escaped or a path containing them would terminate the value early. */
function systemdQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Pure renderer — exported so `--print` and the tests see the exact bytes that
 *  would be written to disk. */
export function renderSystemdUnit(spec: LaunchSpec): string {
  const q = systemdQuote;
  return `[Unit]
Description=Claude Gateway
Documentation=https://github.com/0xMaxMa/claude-gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
# WorkingDirectory is deliberately unquoted, unlike every other value here:
# systemd takes the rest of the line as the path, and rejects a quoted one
# ("path is not absolute"). Escaping is unnecessary for the same reason.
WorkingDirectory=${spec.cwd}
Environment="HOME=${q(spec.home)}"
Environment="PATH=${q(spec.pathEnv)}"
Environment="GATEWAY_CONFIG=${q(spec.config)}"
ExecStart="${q(spec.node)}" "${q(spec.entry)}" gateway start --config "${q(spec.config)}"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
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

function unitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME);
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

// ─── systemd (user scope) ─────────────────────────────────────────────────────

function systemdState(): { installed: boolean; enabled: boolean; active: boolean } {
  let enabled = false;
  let active = false;
  try {
    enabled = capture('systemctl', ['--user', 'is-enabled', UNIT_NAME]).trim() === 'enabled';
  } catch {
    /* systemctl absent, or the unit is disabled/missing */
  }
  try {
    active = capture('systemctl', ['--user', 'is-active', UNIT_NAME]).trim() === 'active';
  } catch {
    /* systemctl absent, or the unit is inactive */
  }
  return { installed: fs.existsSync(unitPath()), enabled, active };
}

function systemdStatus(flags: Record<string, string | boolean>): number {
  const state = systemdState();
  printJson({ manager: 'systemd-user', unit: unitPath(), ...state }, flags);
  return state.active ? 0 : 1;
}

async function systemdInstall(
  flags: Record<string, string | boolean>,
  config: CliConfigView,
): Promise<number> {
  const spec = resolveLaunchSpec(flags);
  if (!spec) return 1;
  const unit = renderSystemdUnit(spec);
  const file = unitPath();

  // stderr, not stdout: stdout carries the JSON result (see printJson).
  printFilePreview(file, unit, (line) => process.stderr.write(line + '\n'));
  if (flags.print === true) return 0;
  if (!(await confirm(flags, 'install', `Install and start ${UNIT_NAME} for user ${os.userInfo().username}?`))) {
    process.stderr.write('Aborted — nothing was written.\n');
    return 1;
  }

  try {
    fs.mkdirSync(spec.cwd, { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, unit, { encoding: 'utf8', mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
  } catch (err) {
    process.stderr.write(
      `Could not install or start the user service: ${(err as Error).message}\n` +
        `Inspect it with: systemctl --user status ${UNIT_NAME} --no-pager\n`,
    );
    return 1;
  }

  const healthy = await waitForHealth(config, flags);
  printJson({ manager: 'systemd-user', unit: file, ...systemdState(), health: healthy ? 'up' : 'down' }, flags);
  process.stderr.write(
    `Installed ${UNIT_NAME}.\n` +
      `To keep it running after you log out: loginctl enable-linger ${os.userInfo().username}\n`,
  );
  if (!healthy) {
    process.stderr.write(`Service did not answer /health yet — check: journalctl --user -u ${UNIT_NAME} -n 50 --no-pager\n`);
    return 1;
  }
  return 0;
}

async function systemdUninstall(flags: Record<string, string | boolean>): Promise<number> {
  const file = unitPath();
  const before = systemdState();
  if (!before.installed && !before.enabled && !before.active) {
    // Nothing to stop — prompting to stop a service that isn't there only
    // teaches people to answer these prompts without reading them.
    printJson({ manager: 'systemd-user', unit: file, ...before }, flags);
    process.stderr.write(`${UNIT_NAME} is not installed — nothing to remove.\n`);
    return 0;
  }
  // `disable --now` stops a running gateway, so this asks like install does.
  if (!(await confirm(flags, 'uninstall', `Stop and remove ${UNIT_NAME}?`))) {
    process.stderr.write('Aborted — the service was left in place.\n');
    return 1;
  }
  try {
    run('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
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
    run('systemctl', ['--user', 'daemon-reload']);
  } catch {
    /* nothing to reload without systemd */
  }
  // Report what systemd actually says, not what was intended: the disable above
  // is best-effort, and claiming a stopped service that is still running would
  // be exactly the silent failure this codebase forbids.
  const state = systemdState();
  printJson({ manager: 'systemd-user', unit: file, ...state }, flags);
  if (state.active || state.installed) {
    process.stderr.write(`${UNIT_NAME} is still present — check: systemctl --user status ${UNIT_NAME} --no-pager\n`);
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
    return 1;
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
  'claude-gateway service <install|status|uninstall> [--manager systemd|pm2] [--config <path>] [--yes] [--print]';

/** Pick the manager to act on when `--manager` is omitted. `status`/`uninstall`
 *  act on whatever is actually installed; `install` always defaults to systemd
 *  so it can't silently pick a different manager than the one documented. */
function detectServiceManager(action: ServiceAction): ServiceManager {
  if (action === 'install') return 'systemd';
  if (fs.existsSync(unitPath())) return 'systemd';
  try {
    if (pm2Entry()) return 'pm2';
  } catch {
    /* PM2 not installed */
  }
  return 'systemd';
}

function parseManager(flags: Record<string, string | boolean>, action: ServiceAction): ServiceManager | null {
  const raw = flags.manager;
  if (raw === undefined) return detectServiceManager(action);
  if (raw === 'systemd' || raw === 'pm2') return raw;
  process.stderr.write('Unknown --manager. Expected systemd or pm2.\n');
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
      ['  systemd installs a user unit in ~/.config/systemd/user (no sudo).'],
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

  const manager = parseManager(flags, action);
  if (!manager) return 1;

  if (manager === 'systemd') {
    if (action === 'install') return systemdInstall(flags, config);
    return action === 'status' ? systemdStatus(flags) : await systemdUninstall(flags);
  }
  if (action === 'install') return pm2Install(flags, config);
  return action === 'status' ? pm2Status(flags) : await pm2Uninstall(flags);
}
