import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Which process manager owns the running gateway. */
export type Manager = 'systemd' | 'pm2' | 'foreground' | 'unknown';

export function defaultPidfilePath(): string {
  return path.join(os.homedir(), '.claude-gateway', 'gateway.pid');
}

export interface DetectDeps {
  /** Run a command, return stdout; throw on non-zero exit. Injectable for tests. */
  exec?: (cmd: string) => string;
  pidfilePath?: string;
  /** True if a process with this pid is alive. Injectable for tests. */
  isAlive?: (pid: number) => boolean;
  readPidfile?: (p: string) => string | null;
}

function realExec(cmd: string): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
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
 * Detect the process manager that owns the gateway, in priority order:
 *   systemd (unit `claude-gateway` active) → pm2 (process `gateway`) →
 *   foreground (a live pid in the pidfile) → unknown.
 */
export function detectManager(deps: DetectDeps = {}): Manager {
  const exec = deps.exec ?? realExec;
  const isAlive = deps.isAlive ?? realIsAlive;
  const readPidfile = deps.readPidfile ?? realReadPidfile;

  try {
    if (exec('systemctl is-active claude-gateway').trim() === 'active') return 'systemd';
  } catch {
    /* systemctl absent or unit not active */
  }

  try {
    const pid = exec('pm2 pid gateway').trim();
    if (/^\d+$/.test(pid) && Number(pid) > 0) return 'pm2';
  } catch {
    /* pm2 absent or process not found */
  }

  const pf = deps.pidfilePath ?? defaultPidfilePath();
  const raw = readPidfile(pf);
  if (raw) {
    const pid = parseInt(raw.trim(), 10);
    if (pid > 0 && isAlive(pid)) return 'foreground';
  }

  return 'unknown';
}
