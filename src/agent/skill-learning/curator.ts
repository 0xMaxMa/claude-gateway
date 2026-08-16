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
      pruneSkill(s.name, deps, remove);
      result.pruned.push(s.name);
    } else {
      survivors.push(s);
    }
  }

  // 2. Cap eviction (LRU) among the survivors (0 = unbounded).
  if (cfg.maxAutoSkills > 0 && survivors.length > cfg.maxAutoSkills) {
    const lru = survivors
      .slice()
      .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0)); // oldest-used first
    const overflow = survivors.length - cfg.maxAutoSkills;
    for (const s of lru.slice(0, overflow)) {
      pruneSkill(s.name, deps, remove);
      result.evicted.push(s.name);
    }
  }

  logRollup(deps);
  return result;
}

function pruneSkill(name: string, deps: CuratorDeps, remove: (dir: string) => void): void {
  try {
    remove(path.join(deps.workspaceDir, 'skills', name));
  } catch {
    /* best-effort — still drop the stat row */
  }
  deps.db.deleteSkillStat(name);
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
