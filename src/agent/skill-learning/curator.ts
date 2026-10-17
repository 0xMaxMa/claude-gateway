/**
 * Curator — the anti-rot half of the loop. Daily, per agent:
 *   - prune origin:auto skills that are BOTH unused (`times_loaded < minUsesToKeep`)
 *     AND stale (`age > maxAgeDays`) and not pinned;
 *   - enforce the `maxAutoSkills` cap by evicting least-recently-used auto skills;
 *   - NEVER touch hand-authored (non-auto) or pinned skills;
 *   - archive instead of delete: a removed skill moves to
 *     `skills/.archive/<YYYY-MM-DD>/<name>/` (outside the catalog) and is kept
 *     `ARCHIVE_RETENTION_DAYS`; restore by moving the directory back to `skills/`;
 *   - run telemetry retention even when learning is disabled (tables don't grow
 *     unbounded);
 *   - log the effectiveness rollup headline.
 *
 * The scheduler mirrors `scheduleCleanup` (history/cleanup.ts) + `msUntilNextHour`,
 * guarded by `isValidTimezone` fallback-to-UTC (boot-safety, lesson #310).
 */

import * as fs from 'fs';
import * as path from 'path';
import { msUntilNextHour } from '../../history/cleanup';
import { isValidTimezone } from './config';
import { isOwnedAutoSkillDir } from './writer';
import { computeRollup } from './metrics';
import type { HistoryDB } from '../../history/db';
import type { ResolvedSkillLearningCfg } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Telemetry retention window — keep this many days of turn_metrics/review rows. */
export const TELEMETRY_RETENTION_DAYS = 90;
/** Archived skills live here (dot-dir: the skill loader never lists it). */
export const ARCHIVE_DIRNAME = '.archive';
/** Days an archived skill is kept before the curator deletes it for good. */
export const ARCHIVE_RETENTION_DAYS = 30;
const ARCHIVE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CuratorDeps {
  db: HistoryDB;
  workspaceDir: string;
  agentId: string;
  cfg: ResolvedSkillLearningCfg;
  now: number;
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void };
}

export interface CuratorResult {
  pruned: string[];
  evicted: string[];
  telemetryRowsRemoved: number;
}

/**
 * Run one curation sweep. Always runs telemetry retention; skips skill pruning
 * when disabled. Pure w.r.t. time (`now` injected) and fs (remover injectable).
 */
export function curateOnce(deps: CuratorDeps): CuratorResult {
  const { db, workspaceDir, cfg, now } = deps;
  const result: CuratorResult = { pruned: [], evicted: [], telemetryRowsRemoved: 0 };

  // Telemetry and archive retention ALWAYS run (even when disabled) so both stay bounded.
  result.telemetryRowsRemoved = db.pruneTelemetry(now - TELEMETRY_RETENTION_DAYS * DAY_MS);
  expireArchive(workspaceDir, now);

  if (!cfg.enabled) {
    logRollup(deps);
    return result;
  }

  const auto = db.listSkillStats().filter((s) => s.origin === 'auto' && s.pinned !== 1);

  // 1. Stale + unused prune (both conditions; age-prune disabled when maxAgeDays<=0).
  const survivors = [];
  for (const s of auto) {
    const ageMs = s.createdAt != null ? now - s.createdAt : 0;
    const unused = s.timesLoaded < cfg.minUsesToKeep;
    const stale = cfg.maxAgeDays > 0 && ageMs > cfg.maxAgeDays * DAY_MS;
    if (unused && stale) {
      if (archiveSkill(s.name, deps)) result.pruned.push(s.name);
    } else {
      survivors.push(s);
    }
  }

  // 2. Cap eviction (LRU) among the survivors (0 = unbounded).
  if (cfg.maxAutoSkills > 0 && survivors.length > cfg.maxAutoSkills) {
    const lru = survivors
      .slice()
      // Oldest-used first. Fall back to createdAt for never-used skills so a
      // brand-new (lastUsedAt=null) skill is not treated as the stalest and
      // evicted before it is ever loaded.
      .sort((a, b) => (a.lastUsedAt ?? a.createdAt ?? 0) - (b.lastUsedAt ?? b.createdAt ?? 0));
    const overflow = survivors.length - cfg.maxAutoSkills;
    for (const s of lru.slice(0, overflow)) {
      if (archiveSkill(s.name, deps)) result.evicted.push(s.name);
    }
  }

  logRollup(deps);
  return result;
}

/**
 * Move an auto skill into the dated archive + drop its stat row. Returns `true`
 * only if the directory was moved. Provenance is re-verified against the on-disk
 * file, not the (possibly stale) stat row: anything that is not a real directory
 * holding an `origin: auto`, unpinned SKILL.md stays put — a user who "adopts" an
 * auto skill (flips `origin` or sets `pinned: true`) keeps it, and a symlink or a
 * directory without SKILL.md is never moved; its stat row is dropped so it stops
 * being tracked as auto. A failed move keeps the row so the next sweep retries.
 */
function archiveSkill(name: string, deps: CuratorDeps): boolean {
  const skillsDir = path.join(deps.workspaceDir, 'skills');
  const skillDir = path.join(skillsDir, name);
  // A stat-row name is not a trusted path segment: never follow one out of skills/.
  if (path.basename(name) !== name || name.startsWith('.') || !isOwnedAutoSkillDir(skillDir)) {
    deps.db.deleteSkillStat(name);
    return false;
  }
  const archiveDir = path.join(skillsDir, ARCHIVE_DIRNAME);
  if (!archiveDirUsable(archiveDir)) {
    warn(deps, `archive of ${name} skipped: ${archiveDir} is not a real directory`);
    return false;
  }
  const dayDir = path.join(archiveDir, new Date(deps.now).toISOString().slice(0, 10));
  let dest = path.join(dayDir, name);
  if (fs.existsSync(dest)) dest = `${dest}-${deps.now}`;
  try {
    fs.mkdirSync(dayDir, { recursive: true });
    fs.renameSync(skillDir, dest);
  } catch (err) {
    warn(deps, `archive of ${name} failed: ${(err as Error).message}`);
    return false;
  }
  deps.db.deleteSkillStat(name);
  deps.logger?.info(`[skill-learning:${deps.agentId}] archived ${name} → ${dest} (restore: move it back to ${skillDir})`);
  return true;
}

/** A failed archive stalls cap/age enforcement, so it must reach the operator. */
function warn(deps: CuratorDeps, msg: string): void {
  const line = `[skill-learning:${deps.agentId}] ${msg}`;
  if (deps.logger?.warn) deps.logger.warn(line);
  else deps.logger?.info(line);
}

/** True if the archive dir is absent or a real directory (never a symlink out of skills/). */
function archiveDirUsable(archiveDir: string): boolean {
  try {
    return fs.lstatSync(archiveDir).isDirectory();
  } catch {
    return true;
  }
}

/** Delete archive day directories older than the retention window. Best-effort. */
function expireArchive(workspaceDir: string, now: number): void {
  const archiveDir = path.join(workspaceDir, 'skills', ARCHIVE_DIRNAME);
  let days: string[];
  try {
    if (!fs.lstatSync(archiveDir).isDirectory()) return;
    days = fs.readdirSync(archiveDir);
  } catch {
    return;
  }
  const cutoff = now - ARCHIVE_RETENTION_DAYS * DAY_MS;
  for (const day of days) {
    // Measure from the END of the UTC day so a skill archived late that day still gets the full window.
    if (!ARCHIVE_DAY_RE.test(day) || Date.parse(`${day}T00:00:00Z`) + DAY_MS > cutoff) continue;
    try {
      fs.rmSync(path.join(archiveDir, day), { recursive: true, force: true });
    } catch {
      /* best-effort — retried next sweep */
    }
  }
}

function logRollup(deps: CuratorDeps): void {
  if (!deps.logger) return;
  try {
    const r = computeRollup(deps.db, deps.agentId, deps.now);
    deps.logger.info(
      `[skill-learning:${deps.agentId}] rollup — autoSkills=${r.adoption.autoSkills} ` +
        `sticky(>=3)=${r.adoption.stickyPct.toFixed(0)}% netTokens=${r.netTokens.net} ` +
        `(saved=${r.netTokens.savedByReuse} spent=${r.netTokens.spentReviewing})`,
    );
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Start the daily curator scheduler (mirror `scheduleCleanup`). Returns a
 * canceller. Invalid `pruneTimezone` falls back to UTC (never throws at boot).
 */
export function startCurator(makeDeps: () => Omit<CuratorDeps, 'now'>, cfg: ResolvedSkillLearningCfg): () => void {
  const tz = isValidTimezone(cfg.pruneTimezone) ? cfg.pruneTimezone : 'UTC';
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (): void => {
    const delay = msUntilNextHour(cfg.pruneHour, tz);
    timer = setTimeout(() => {
      try {
        curateOnce({ ...makeDeps(), now: Date.now() });
      } catch {
        /* best-effort */
      }
      schedule();
    }, delay);
    if (typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref();
  };
  schedule();
  return () => clearTimeout(timer);
}
