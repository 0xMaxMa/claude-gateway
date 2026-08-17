/**
 * Curator — the anti-rot half of the loop. Daily, per agent:
 *   - prune origin:auto skills that are BOTH unused (`times_loaded < minUsesToKeep`)
 *     AND stale (`age > maxAgeDays`) and not pinned;
 *   - enforce the `maxAutoSkills` cap by evicting least-recently-used auto skills;
 *   - NEVER touch hand-authored (non-auto) or pinned skills;
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
import { readSkillOrigin } from './writer';
import { computeRollup } from './metrics';
import type { HistoryDB } from '../../history/db';
import type { ResolvedSkillLearningCfg } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Telemetry retention window — keep this many days of turn_metrics/review rows. */
export const TELEMETRY_RETENTION_DAYS = 90;

export interface CuratorDeps {
  db: HistoryDB;
  workspaceDir: string;
  agentId: string;
  cfg: ResolvedSkillLearningCfg;
  now: number;
  logger?: { info: (msg: string) => void };
  /** Injectable skill-dir remover (defaults to fs rm) — for tests. */
  removeSkillDir?: (dir: string) => void;
}

export interface CuratorResult {
  pruned: string[];
  evicted: string[];
  telemetryRowsRemoved: number;
}

function defaultRemove(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run one curation sweep. Always runs telemetry retention; skips skill pruning
 * when disabled. Pure w.r.t. time (`now` injected) and fs (remover injectable).
 */
export function curateOnce(deps: CuratorDeps): CuratorResult {
  const { db, workspaceDir, cfg, now } = deps;
  const remove = deps.removeSkillDir ?? defaultRemove;
  const result: CuratorResult = { pruned: [], evicted: [], telemetryRowsRemoved: 0 };

  // Telemetry retention ALWAYS runs (even when disabled) so the tables are bounded.
  result.telemetryRowsRemoved = db.pruneTelemetry(now - TELEMETRY_RETENTION_DAYS * DAY_MS);

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
      if (pruneSkill(s.name, deps, remove)) result.pruned.push(s.name);
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
      if (pruneSkill(s.name, deps, remove)) result.evicted.push(s.name);
    }
  }

  logRollup(deps);
  return result;
}

/**
 * Remove a skill dir + drop its stat row. Returns `true` if the directory was
 * actually removed, `false` if it was preserved (adopted by the user). Re-verify
 * provenance against the on-disk file, not the (possibly stale) stat row: a user
 * who "adopts" an auto skill — editing SKILL.md and flipping `origin` away from
 * `auto` — must never have it deleted, even though the skill_stats row still says
 * origin:auto. Drop the stale row either way so it stops being tracked as auto.
 */
function pruneSkill(name: string, deps: CuratorDeps, remove: (dir: string) => void): boolean {
  const skillDir = path.join(deps.workspaceDir, 'skills', name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillFile) && readSkillOrigin(skillFile) !== 'auto') {
    deps.db.deleteSkillStat(name);
    return false;
  }
  try {
    remove(skillDir);
  } catch {
    /* best-effort — still drop the stat row */
  }
  deps.db.deleteSkillStat(name);
  return true;
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
