import * as fs from 'fs';
import * as path from 'path';
import { HistoryDB } from './db';

const DEFAULT_RETENTION_DAYS = 60;

export interface CleanupOptions {
  db: HistoryDB;
  agentMediaRoot: string; // absolute path to agent's media/ dir
  logPath: string;        // absolute path for cleanup.log
  retentionDays: number;
  cleanupHour: number;    // 0-23, in cleanupTimezone
  cleanupTimezone: string; // IANA timezone, e.g. "UTC" or "Asia/Bangkok"
}

const MAX_LOG_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_LOG_LINES_KEPT = 400;

function appendLog(logPath: string, line: string): void {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}\n`;
  try {
    // Rotate: keep last N lines when file exceeds size cap
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_LOG_BYTES) {
        const content = fs.readFileSync(logPath, 'utf8');
        const kept = content.split('\n').filter(Boolean).slice(-MAX_LOG_LINES_KEPT).join('\n') + '\n';
        fs.writeFileSync(logPath, kept);
      }
    } catch {
      // file may not exist yet — that's fine
    }
    fs.appendFileSync(logPath, entry);
  } catch {
    // log write failure is non-fatal
  }
}

/**
 * Compute milliseconds until the next occurrence of `hour` in `timezone`.
 * If the current hour already matches and no minutes have passed, fires in 24h.
 */
export function msUntilNextHour(hour: number, timezone: string, now = new Date()): number {
  const hourFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  });
  const currentHour = parseInt(hourFormatter.format(now), 10);

  let hoursUntil = hour - currentHour;
  if (hoursUntil <= 0) hoursUntil += 24;

  // Compute ms elapsed since start of current hour in the target timezone.
  // Using formatToParts so we handle half-hour/45-min offset timezones correctly.
  const minSecFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = minSecFormatter.formatToParts(now);
  const minutes = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const seconds = parseInt(parts.find((p) => p.type === 'second')?.value ?? '0', 10);
  const msIntoCurrentHour = (minutes * 60 + seconds) * 1000 + (now.getTime() % 1000);

  const msPerHour = 60 * 60 * 1000;
  return hoursUntil * msPerHour - msIntoCurrentHour;
}

function doCleanup(opts: CleanupOptions): void {
  const { db, agentMediaRoot, logPath, retentionDays } = opts;
  if (retentionDays === 0) return;

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let mediaPaths: string[];
  try {
    mediaPaths = db.pruneOlderThan(cutoffMs);
  } catch (err) {
    appendLog(logPath, `ERROR pruneOlderThan failed: ${(err as Error).message}`);
    return;
  }

  let deletedFiles = 0;
  const dirsToCheck = new Set<string>();

  for (const relPath of mediaPaths) {
    // Strip leading "media/" prefix if present
    const withoutPrefix = relPath.startsWith('media/') ? relPath.slice(6) : relPath;
    const absPath = path.resolve(agentMediaRoot, withoutPrefix);

    // Path traversal guard: resolved path must stay inside agentMediaRoot
    if (!absPath.startsWith(agentMediaRoot + path.sep) && absPath !== agentMediaRoot) continue;

    try {
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        deletedFiles++;
        dirsToCheck.add(path.dirname(absPath));
      }
    } catch (err) {
      appendLog(logPath, `WARN failed to delete ${absPath}: ${(err as Error).message}`);
    }
  }

  // Remove empty parent directories (within agentMediaRoot only)
  for (const dir of dirsToCheck) {
    if (!dir.startsWith(agentMediaRoot + path.sep)) continue;
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) fs.rmdirSync(dir);
    } catch {
      // non-fatal
    }
  }

  appendLog(
    logPath,
    `cleanup done: retentionDays=${retentionDays} cutoff=${new Date(cutoffMs).toISOString()} deletedFiles=${deletedFiles}`,
  );
}

/**
 * Schedule daily cleanup at cleanupHour in cleanupTimezone.
 * Returns a cancel function that stops the timer.
 */
export function scheduleCleanup(opts: CleanupOptions): () => void {
  if (opts.retentionDays === 0) return () => {};

  let timer: ReturnType<typeof setTimeout>;

  const schedule = () => {
    const delay = msUntilNextHour(opts.cleanupHour, opts.cleanupTimezone);
    timer = setTimeout(() => {
      doCleanup(opts);
      schedule(); // reschedule for next day
    }, delay);
    // Don't hold the event loop open just for a cleanup timer
    if (typeof (timer as NodeJS.Timeout).unref === 'function') {
      (timer as NodeJS.Timeout).unref();
    }
  };

  schedule();
  return () => clearTimeout(timer);
}

export function resolveRetentionDays(
  agentRetention?: number,
  globalRetention?: number,
): number {
  if (agentRetention !== undefined) return agentRetention;
  if (globalRetention !== undefined) return globalRetention;
  return DEFAULT_RETENTION_DAYS;
}
