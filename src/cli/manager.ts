import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Which process manager owns the running gateway. User systemd is preferred
 * because `service systemd install` deliberately creates a user-scoped unit. */
export type Manager = 'systemd-user' | 'systemd-system' | 'pm2' | 'foreground' | 'unknown';

export function defaultPidfilePath(): string {
  return path.join(os.homedir(), '.claude-gateway', 'gateway.pid');
}

export interface DetectDeps {
  /** Run a trusted manager command and return stdout; injectable for tests. */
  exec?: (args: string[]) => string;
  pidfilePath?: string;
  /** True if a process with this pid is alive; injectable for tests. */
  isAlive?: (pid: number) => boolean;
  readPidfile?: (p: string) => string | null;
  /** The command line of a live process, or null when it cannot be read;
   *  injectable for tests. See pidLooksLikeGateway(). */
  readCmdline?: (pid: number) => string | null;
}

function realExec(args: string[]): string {
  const [file, ...argv] = args;
  return execFileSync(file, argv, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function realIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Process command line, NUL-separated on Linux, space-joined elsewhere.
 *  `/proc` first because it needs no subprocess; `ps` covers macOS/BSD. */
function realReadCmdline(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    /* not Linux, or the process is gone — fall through to ps */
  }
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Best-effort check that `pid` is a gateway and not an unrelated process that
 * inherited a recycled pid.
 *
 * readLocalGateway() deliberately stops at signal-0 — it runs on every CLI
 * invocation and must stay cheap — but that only proves *something* holds the
 * pid. A gateway lost to SIGKILL or the OOM killer leaves its pidfile behind,
 * and once the kernel reuses that pid, anything reading the file would call a
 * stranger "the gateway". Only callers about to act on the pid destructively
 * (`gateway stop`, `gateway restart`) pay for this second check.
 *
 * Returns false when the command line cannot be read at all: an unverifiable
 * pid is treated as not-a-gateway, because the cost of being wrong is
 * terminating someone else's process.
 */
export function pidLooksLikeGateway(pid: number, deps: Pick<DetectDeps, 'readCmdline'> = {}): boolean {
  const cmdline = (deps.readCmdline ?? realReadCmdline)(pid);
  if (!cmdline) return false;
  // Either the installed binary/package path, or a checkout started straight
  // from its entry point (`node /opt/gw/dist/index.js gateway start`), whose
  // directory need not be named after the project.
  return /claude-gateway/.test(cmdline) || /(^|[\\/])(dist|src)[\\/]index\.(js|ts)\b/.test(cmdline);
}

function realReadPidfile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Detect the manager that currently owns the gateway, in priority order:
 * user-systemd → system-systemd (legacy external install) → PM2 → foreground.
 * Commands use fixed argument arrays, never user-controlled shell fragments.
 */
export function detectManager(deps: DetectDeps = {}): Manager {
  const exec = deps.exec ?? realExec;
  const isAlive = deps.isAlive ?? realIsAlive;
  const readPidfile = deps.readPidfile ?? realReadPidfile;

  try {
    if (exec(['systemctl', '--user', 'is-active', 'claude-gateway.service']).trim() === 'active') return 'systemd-user';
  } catch {
    /* no reachable user manager or inactive unit */
  }

  try {
    if (exec(['systemctl', 'is-active', 'claude-gateway.service']).trim() === 'active') return 'systemd-system';
  } catch {
    /* system service absent or inactive */
  }

  try {
    const pid = exec(['pm2', 'pid', 'gateway']).trim();
    if (/^\d+$/.test(pid) && Number(pid) > 0) return 'pm2';
  } catch {
    /* pm2 absent or process not found */
  }

  if (localGatewayIsLive({ pidfilePath: deps.pidfilePath, isAlive, readPidfile })) return 'foreground';

  return 'unknown';
}

/** A gateway process running on this host, as recorded by its pidfile. */
export interface LocalGateway {
  pid: number;
  /** The port it is listening on, when the pidfile records one. Absent for a
   *  pidfile written by an older version (pid only). */
  port?: number;
}

/**
 * The gateway process alive on THIS host, per the pidfile the server writes on
 * boot, or null when there is none. Every manager runs the same entry point, so
 * the pidfile is present under systemd and PM2 too, not only in the foreground.
 *
 * Pidfile format is one field per line: pid, then the listening port. The port
 * matters because the CLI cannot otherwise know it — `$PORT` is set in whatever
 * shell launched the server, not necessarily in the one running the CLI, so
 * deriving the port from the CLI's own environment can address a port nothing
 * listens on. A pidfile from an older version has no second line; the port is
 * then simply unknown and callers fall back to the environment.
 *
 * Deliberately cheap — one file read and one signal-0 — because `resolveUrl()`
 * consults it on every CLI invocation. `detectManager()` is not usable there:
 * it shells out to systemctl and pm2.
 */
export function readLocalGateway(deps: Pick<DetectDeps, 'pidfilePath' | 'isAlive' | 'readPidfile'> = {}): LocalGateway | null {
  const isAlive = deps.isAlive ?? realIsAlive;
  const readPidfile = deps.readPidfile ?? realReadPidfile;
  const raw = readPidfile(deps.pidfilePath ?? defaultPidfilePath());
  if (!raw) return null;
  const [pidLine, portLine] = raw.split('\n');
  const pid = parseInt((pidLine ?? '').trim(), 10);
  if (!(pid > 0) || !isAlive(pid)) return null;
  const port = parseInt((portLine ?? '').trim(), 10);
  // Port 0 means "let the OS choose" and is never a dialable address, so it is
  // treated as unrecorded rather than written into a URL.
  return { pid, port: port > 0 && port < 65536 ? port : undefined };
}

/** True when a gateway process is alive on this host. See readLocalGateway(). */
export function localGatewayIsLive(deps: Pick<DetectDeps, 'pidfilePath' | 'isAlive' | 'readPidfile'> = {}): boolean {
  return readLocalGateway(deps) !== null;
}
