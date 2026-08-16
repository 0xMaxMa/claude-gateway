/**
 * Metrics (read side) — the 5 effectiveness measures, all derived from
 * turn_metrics + skill_stats + skill_review_runs. This is the concrete
 * "measurable effectiveness" surface (planning-62 §Measurement).
 *
 * All measures are directional/heuristic by design; the causal signal is the
 * `enabled` on/off cohort (measure 4) and the net-token ledger (measure 5).
 */

import type { HistoryDB, TurnMetricRow } from '../../history/db';
import type { SkillMetricsRollup } from './types';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function turnTokens(r: TurnMetricRow): number {
  return r.tokensIn + r.tokensOut;
}

function hasSkill(r: TurnMetricRow): boolean {
  if (!r.skillsLoaded) return false;
  try {
    const arr = JSON.parse(r.skillsLoaded) as unknown[];
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

/** Compute the full effectiveness rollup for an agent. */
export function computeRollup(db: HistoryDB, agentId: string, now: number): SkillMetricsRollup {
  const stats = db.listSkillStats();
  const autoStats = stats.filter((s) => s.origin === 'auto');
  const turns = db.listTurnMetrics(0);
  const reviews = db.listReviewRuns(0);

  // ---- Measure 1: adoption funnel ----
  const autoSkills = autoStats.length;
  const loadedAtLeast1 = autoStats.filter((s) => s.timesLoaded >= 1).length;
  const loadedAtLeast3 = autoStats.filter((s) => s.timesLoaded >= 3).length;
  const stickyPct = autoSkills > 0 ? (loadedAtLeast3 / autoSkills) * 100 : 0;

  // ---- Measure 2: cost-to-complete delta (skill-loaded turns vs not) ----
  const before = turns.filter((t) => !hasSkill(t));
  const after = turns.filter((t) => hasSkill(t));
  const clusters = new Set(turns.map((t) => t.intentHash ?? 'misc')).size;

  // ---- Measure 3: recovery-rate trend (earlier half vs recent half by ts) ----
  const byTs = turns.slice().sort((a, b) => a.ts - b.ts);
  const half = Math.floor(byTs.length / 2);
  const earlier = byTs.slice(0, half);
  const recent = byTs.slice(half);
  const rate = (rows: TurnMetricRow[]): number =>
    rows.length ? (rows.filter((r) => r.recoveryFired).length / rows.length) * 100 : 0;

  // ---- Measure 4: cohort A/B by the `enabled` column ----
  const enabledTurns = turns.filter((t) => t.enabled === 1);
  const disabledTurns = turns.filter((t) => t.enabled === 0);

  // ---- Measure 5: net token economics ----
  const spentReviewing = reviews.reduce((n, r) => n + r.tokensSpent, 0);
  const savedByReuse = estimateSaved(turns);

  return {
    agentId,
    generatedAt: now,
    adoption: { autoSkills, loadedAtLeast1, loadedAtLeast3, stickyPct },
    costDelta: {
      clusters,
      medianToolCallsBefore: median(before.map((t) => t.toolCalls)),
      medianToolCallsAfter: median(after.map((t) => t.toolCalls)),
      medianTokensBefore: median(before.map(turnTokens)),
      medianTokensAfter: median(after.map(turnTokens)),
    },
    recovery: { ratePctRecent: rate(recent), ratePctEarlier: rate(earlier) },
    cohort: {
      enabledTurns: enabledTurns.length,
      disabledTurns: disabledTurns.length,
      enabledMedianToolCalls: median(enabledTurns.map((t) => t.toolCalls)),
      disabledMedianToolCalls: median(disabledTurns.map((t) => t.toolCalls)),
    },
    netTokens: { savedByReuse, spentReviewing, net: savedByReuse - spentReviewing },
  };
}

/**
 * Estimate tokens saved by reuse: per intent cluster, take the median token cost
 * of "before" (no-skill) turns as the counterfactual, and credit each "after"
 * (skill-loaded) turn the positive difference. Sum across clusters.
 */
function estimateSaved(turns: TurnMetricRow[]): number {
  const byCluster = new Map<string, TurnMetricRow[]>();
  for (const t of turns) {
    const k = t.intentHash ?? 'misc';
    (byCluster.get(k) ?? byCluster.set(k, []).get(k)!).push(t);
  }
  let saved = 0;
  for (const rows of byCluster.values()) {
    const before = rows.filter((r) => !hasSkill(r));
    const after = rows.filter((r) => hasSkill(r));
    if (!before.length || !after.length) continue;
    const baseline = median(before.map(turnTokens));
    for (const a of after) {
      saved += Math.max(0, baseline - turnTokens(a));
    }
  }
  return saved;
}
