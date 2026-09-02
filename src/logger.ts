import * as fs from 'fs';
import * as path from 'path';
import { Logger, LogsConfig } from './types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Ordering for the level gate. Only the relative order matters. */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LEVEL_RANK;
}

/**
 * Defaults applied when `gateway.logs` is absent or partial.
 *
 * `level: 'info'` is the load-bearing one. Session processes log every stream
 * event at debug (src/session/process.ts), which on a live host measured as
 * 19,995 debug lines to 5 info lines in a single 217 MB file — so `debug`
 * on-by-default was, in practice, the whole log directory. Rotation alone would
 * not have helped: it bounds what is *kept*, not what is *written*.
 */
export const LOGS_DEFAULTS: Required<LogsConfig> = {
  level: 'info',
  maxFileBytes: 16 * 1024 * 1024,
  maxFiles: 3,
  retentionDays: 14,
};

let active: Required<LogsConfig> = { ...LOGS_DEFAULTS };

/**
 * Install the process-wide logging policy. Called once at boot, before the
 * first logger exists.
 *
 * Policy is module state rather than a per-logger argument because there is one
 * of it per process, and `createLogger()` has 13 call sites — several of which
 * (routers, the session process) have no access to the gateway config. Threading
 * an options bag through all of them would put the same value in 13 places and
 * let them drift.
 */
export function configureLogging(cfg: LogsConfig | undefined): Required<LogsConfig> {
  const level = isLogLevel(cfg?.level) ? cfg.level : LOGS_DEFAULTS.level;
  active = {
    level,
    maxFileBytes: positiveOrDefault(cfg?.maxFileBytes, LOGS_DEFAULTS.maxFileBytes),
    maxFiles: nonNegativeOrDefault(cfg?.maxFiles, LOGS_DEFAULTS.maxFiles),
    retentionDays: nonNegativeOrDefault(cfg?.retentionDays, LOGS_DEFAULTS.retentionDays),
  };
  return { ...active };
}

/** The policy currently in force (a copy — callers must not mutate it). */
export function loggingConfig(): Required<LogsConfig> {
  return { ...active };
}

/** Test hook: restore defaults and forget per-file state. */
export function resetLoggingForTests(): void {
  active = { ...LOGS_DEFAULTS };
  fileSizes.clear();
  writeFailureReported = false;
}

/** 0 is meaningful for `maxFiles`/`retentionDays` (= disabled) but not for a
 *  size threshold, where it would rotate on every line. */
function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * Live size per log file, keyed by absolute path.
 *
 * Kept at module scope rather than on the instance because one file can have
 * several loggers writing to it — `createLogger(agentConfig.id, …)` is called
 * from both the boot path and the runner constructor. Per-instance counters
 * would each see only their own share of the file and rotate late. Seeded from
 * `statSync` once per file, then maintained by arithmetic so the common path
 * costs no syscall.
 *
 * One entry per log file, and session logs create a new file each. The
 * retention sweep deletes its entry along with the file, which bounds the map
 * for any configuration that keeps retention on; with `retentionDays: 0` it
 * grows with the session count, at roughly a path string per session. That is
 * small enough not to be worth a second eviction mechanism whose only job would
 * be to duplicate the sweep.
 */
const fileSizes = new Map<string, number>();

/**
 * A failed append is latched and reported once per process.
 *
 * This used to be a bare `catch {}` — a full disk or a permission change
 * silently stopped all file logging, which is precisely the failure that makes
 * the next incident undiagnosable. Reporting every occurrence would be its own
 * denial of service (the failing call is in the logger), so it is reported once
 * and then suppressed.
 */
let writeFailureReported = false;

function reportWriteFailure(file: string, err: unknown): void {
  if (writeFailureReported) return;
  writeFailureReported = true;
  const reason = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? String(err);
  process.stderr.write(
    `[logger] cannot write to ${file} (${reason}) — file logging is degraded for the rest of this process. ` +
      'Further write failures will not be reported.\n',
  );
}

interface LogEntry {
  ts: string;
  agentId: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Remove every rotated generation at or above `maxFiles`.
 *
 * Deleting only `<file>.<maxFiles>` would be dead code: `renameSync` clobbers
 * its destination, so the top generation is overwritten by the shift below
 * anyway — but only while `maxFiles` stays where it was. Lower it in the config
 * (5 → 2) and generations 2..5 are orphaned: nothing renames onto them, and the
 * age sweep is the only thing that would ever collect them. A rotation happens
 * once per `maxFileBytes`, so it can afford one readdir to stay bounded.
 */
function pruneGenerations(file: string, maxFiles: number): void {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // best-effort
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const gen = Number(name.slice(prefix.length));
    if (!Number.isInteger(gen) || gen < maxFiles) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** `<name>.log` → `<name>.log.1`, dropping generations past `maxFiles`.
 *
 *  Synchronous and best-effort by design: it runs inside a logging call, so it
 *  must neither block on I/O the caller did not ask for nor throw into code
 *  that was only trying to log. A rotation that fails leaves the live file in
 *  place and logging simply continues into it. */
function rotate(file: string, maxFiles: number): void {
  if (maxFiles <= 0) {
    // No generations kept: the live file is the only file, so start it over.
    try {
      fs.unlinkSync(file);
    } catch {
      /* best-effort */
    }
    return;
  }
  pruneGenerations(file, maxFiles);
  for (let gen = maxFiles - 1; gen >= 1; gen--) {
    try {
      fs.renameSync(`${file}.${gen}`, `${file}.${gen + 1}`);
    } catch {
      /* a generation that does not exist yet is the normal case */
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* best-effort */
  }
}

class AgentLogger implements Logger {
  private readonly agentId: string;
  private readonly logFilePath: string;

  constructor(agentId: string, logDir: string) {
    this.agentId = agentId;
    fs.mkdirSync(logDir, { recursive: true });
    this.logFilePath = path.join(logDir, `${agentId}.log`);
  }

  private currentSize(): number {
    const known = fileSizes.get(this.logFilePath);
    if (known !== undefined) return known;
    let size = 0;
    try {
      size = fs.statSync(this.logFilePath).size;
    } catch {
      size = 0; // not created yet
    }
    fileSizes.set(this.logFilePath, size);
    return size;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[active.level]) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      agentId: this.agentId,
      level,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    const line = JSON.stringify(entry);
    const pretty = JSON.stringify(entry, null, 2);

    // Write to stdout (pretty-printed for readability)
    process.stdout.write(pretty + '\n');

    // Write to log file (compact, one entry per line)
    const bytes = Buffer.byteLength(line, 'utf-8') + 1;
    try {
      if (active.maxFileBytes > 0 && this.currentSize() + bytes > active.maxFileBytes) {
        rotate(this.logFilePath, active.maxFiles);
        fileSizes.set(this.logFilePath, 0);
      }
      fs.appendFileSync(this.logFilePath, line + '\n', 'utf-8');
      fileSizes.set(this.logFilePath, this.currentSize() + bytes);
    } catch (err) {
      // Logging must never throw into a caller, but it must not vanish either.
      reportWriteFailure(this.logFilePath, err);
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }
}

export function createLogger(agentId: string, logDir: string): Logger {
  return new AgentLogger(agentId, logDir);
}

/**
 * Delete log files (live and rotated generations) last modified more than
 * `retentionDays` ago. Returns the paths removed.
 *
 * Age, not count, is what bounds a directory of *session* logs: each session
 * gets its own `<agent>:session:<uuid>.log` that is never written again once the
 * session ends, so `maxFiles` — which only prunes generations of one stream —
 * never touches them.
 */
export function sweepOldLogs(logDir: string, retentionDays: number, now = Date.now()): string[] {
  const removed: string[] = [];
  if (!(retentionDays > 0)) return removed; // 0 = keep forever
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return removed; // no directory yet, or unreadable — nothing to sweep
  }
  for (const name of names) {
    // `.log` and its rotated generations (`.log.1`), and nothing else: the
    // directory is not exclusively ours to delete from.
    if (!/\.log(\.\d+)?$/.test(name)) continue;
    const full = path.join(logDir, name);
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) continue;
      fs.rmSync(full, { force: true });
      fileSizes.delete(full);
      removed.push(full);
    } catch {
      /* best-effort — a file that vanished or cannot be read is not fatal */
    }
  }
  return removed;
}

/**
 * Sweep now, then once a day. Returns a stop function.
 *
 * Modelled on `AppInstaller.startBackupCleanup()`: the timer is unref'd so it
 * never keeps the process alive, and a failing sweep is swallowed rather than
 * escalated — retention is housekeeping, not a reason to take the gateway down.
 *
 * The timer is created unconditionally, including when retention is currently
 * off. `retentionDays` is read on each run rather than captured, so a policy
 * reloaded from `gateway.logs` takes effect at the next sweep — and a timer
 * that was never started because retention happened to be 0 at boot could not
 * do that. A disabled sweep costs one no-op call a day.
 */
export function startLogRetentionSweep(
  logDir: string,
  onSwept?: (removed: string[]) => void,
): () => void {
  const run = (): void => {
    try {
      const removed = sweepOldLogs(logDir, active.retentionDays);
      if (removed.length > 0) onSwept?.(removed);
    } catch {
      /* best-effort */
    }
  };
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
