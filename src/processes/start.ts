import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { constants, promises as fsp } from 'fs';
import * as path from 'path';
import { redactLines } from '../cli/redact';
import { resolveRealDir } from '../files/fs';
import { FilesErrorCode, parseRelPath, RelPath } from '../files/paths';
import { err, ok, Result } from '../utils/result';
import { collectListeners, listenersIn, listeningPorts } from './listeners';

export type StartErrorCode = FilesErrorCode | 'invalid_port' | 'no_start_command' | 'already_running' | 'port_in_use' | 'no_free_port' | 'start_failed';

export interface StartFailure {
  code: StartErrorCode;
  /** already_running: the port the folder listens on; absent while another start of the folder is still running. */
  port?: number;
  /** already_running: true when another start of the folder holds the lock. */
  starting?: boolean;
  /** start_failed: the last {@link LOG_TAIL_BYTES} of the log, with secret-looking values masked. */
  log?: string;
}

export interface Started {
  path: RelPath;
  port: number;
  pid: number;
  running: true;
}

export interface StartOptions {
  /** Where `<sha256 of the folder's real path>.log` is written. */
  logDir: string;
  /** Inclusive range searched for a free port when the body names none. */
  portRange: readonly [number, number];
  /** How long the started server has to listen. */
  timeoutMs: number;
  pollMs?: number;
  /** Relative script inside the selected folder, configured by the operator. */
  scriptPath: string;
}

export const DEFAULT_PORT_RANGE = [1024, 65535] as const;
export const START_TIMEOUT_MS = 20_000;
export const LOG_TAIL_BYTES = 4096;

/** Real folders with a start in flight. One gateway process starts servers, so memory is enough. */
const starting = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Require real directories on the way and a regular script, with no symlink. */
async function hasStartScript(dir: string, scriptPath: string): Promise<boolean> {
  let current = dir;
  const segments = scriptPath.split('/');
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const entry = await fsp.lstat(current).catch(() => null);
    if (!entry?.isDirectory()) return false;
  }
  const script = await fsp.lstat(path.join(current, segments[segments.length - 1])).catch(() => null);
  return script?.isFile() === true;
}

export function parsePort(raw: unknown): Result<number | undefined, 'invalid_port'> {
  if (raw === undefined || raw === null) return ok(undefined);
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? ok(raw) : err('invalid_port');
}

function alive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

/** TERM the whole session group, then KILL whatever is left after two seconds. */
async function killGroup(pgid: number): Promise<void> {
  try { process.kill(-pgid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 20 && alive(pgid); i++) await sleep(100);
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* Already gone. */ }
}

async function logTail(file: string): Promise<string> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return redactLines(buf.toString('utf8').split('\n')).join('\n');
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}

/** The log file, truncated, never followed through a symlink, readable only by the gateway's user. */
async function openLog(logDir: string, realDir: string): Promise<{ file: string; handle: fsp.FileHandle }> {
  await fsp.mkdir(logDir, { recursive: true, mode: 0o700 });
  const file = path.join(logDir, `${createHash('sha256').update(realDir).digest('hex')}.log`);
  const handle = await fsp.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  await handle.chmod(0o600);
  return { file, handle };
}

async function pickPort(wanted: number | undefined, range: readonly [number, number]): Promise<Result<number, StartFailure>> {
  const busy = await listeningPorts();
  if (wanted !== undefined) return busy.has(wanted) ? err({ code: 'port_in_use', port: wanted }) : ok(wanted);
  for (let p = range[0]; p <= range[1]; p++) if (!busy.has(p)) return ok(p);
  return err({ code: 'no_free_port' });
}

async function run(realDir: string, rel: RelPath, wanted: number | undefined, opts: StartOptions): Promise<Result<Started, StartFailure>> {
  if (!(await hasStartScript(realDir, opts.scriptPath))) return err({ code: 'no_start_command' });
  const existing = listenersIn(await collectListeners(), realDir)[0];
  if (existing) return err({ code: 'already_running', port: existing.port });
  const port = await pickPort(wanted, opts.portRange);
  if (!port.ok) return port;

  const { file, handle } = await openLog(opts.logDir, realDir);
  let exited = false;
  let child;
  try {
    // argv only: the command is fixed and the body never reaches it. `detached` gives the child its own session.
    child = spawn('sh', [opts.scriptPath], {
      cwd: realDir,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        LANG: process.env.LANG ?? 'C.UTF-8',
        PORT: String(port.value),
      },
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd],
    });
    child.once('exit', () => { exited = true; });
    child.once('error', () => { exited = true; });
    child.unref();
  } finally {
    await handle.close();
  }
  const pid = child.pid;
  if (pid === undefined) return err({ code: 'start_failed', log: await logTail(file) });

  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const mine = (await collectListeners()).find((l) => l.port === port.value && l.owners.some((o) => o.session === pid));
    if (mine) return ok({ path: rel, port: port.value, pid: mine.owners.find((o) => o.session === pid)!.pid, running: true });
    if (exited || Date.now() >= deadline) break;
    await sleep(opts.pollMs ?? 250);
  }
  await killGroup(pid);
  return err({ code: 'start_failed', log: await logTail(file) });
}

/**
 * Run the configured script in the folder `rel` names with PORT set, and wait until a process of its session listens
 * there. The folder must sit under `root` with no symlink on the way. One start per folder runs at a time; a second
 * one meanwhile is refused with `already_running` and `starting: true`.
 */
export async function startFolder(root: string, rel: RelPath, wanted: number | undefined, opts: StartOptions): Promise<Result<Started, StartFailure>> {
  if (!opts.scriptPath || !parseRelPath(opts.scriptPath, true).ok) return err({ code: 'no_start_command' });
  const dir = await resolveRealDir(root, rel);
  if (!dir.ok) return err({ code: dir.error });
  if (starting.has(dir.value)) return err({ code: 'already_running', starting: true });
  starting.add(dir.value);
  try {
    return await run(dir.value, rel, wanted, opts);
  } finally {
    starting.delete(dir.value);
  }
}
