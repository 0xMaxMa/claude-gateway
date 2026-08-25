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

/**
 * True when a gateway process is alive on THIS host, per the pidfile the
 * server writes on boot. Every manager runs the same entry point, so the
 * pidfile is present under systemd and PM2 too, not only in the foreground.
 *
 * Deliberately cheap — one file read and one signal-0 — because `resolveUrl()`
 * consults it on every CLI invocation. `detectManager()` is not usable there:
 * it shells out to systemctl and pm2.
 */
export function localGatewayIsLive(deps: Pick<DetectDeps, 'pidfilePath' | 'isAlive' | 'readPidfile'> = {}): boolean {
  const isAlive = deps.isAlive ?? realIsAlive;
  const readPidfile = deps.readPidfile ?? realReadPidfile;
  const raw = readPidfile(deps.pidfilePath ?? defaultPidfilePath());
  if (!raw) return false;
  const pid = parseInt(raw.trim(), 10);
  return pid > 0 && isAlive(pid);
}
