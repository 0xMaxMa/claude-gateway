/**
 * Resolve the effective dreaming config for one agent.
 *
 * Precedence mirrors `resolveSkillLearningConfig`: a per-agent override wins over
 * the global gateway default, which wins over the built-in default. The timezone
 * is normalized once here (invalid → UTC, lesson #310) so the scheduler never
 * re-guards.
 */

import { isValidTimezone } from '../skill-learning/config';
import { numOr } from '../../utils/config-num';
import type { DreamingConfig, ResolvedDreamingCfg, ResolvedStalenessCfg, StalenessConfig } from './types';

/** Built-in staleness-GC defaults (planning-66). */
export const STALENESS_DEFAULTS: ResolvedStalenessCfg = {
  enabled: true,
  staleTtlDays: 90,
  keepImportance: 7,
  minRetrievalKeep: 1,
  supersession: true,
  recordRetrievals: true,
  maxInvalidationsPerRun: 50,
};

export const DREAMING_DEFAULTS: ResolvedDreamingCfg = {
  enabled: true,
  mode: 'auto', // apply consolidation to memory; gated by the K4 applier (#330). Set 'propose' for dry-run.
  dreamHour: 3,
  dreamMinute: 0,
  dreamTimezone: 'UTC',
  quietMinutes: 30,
  lookbackDays: 3,
  maxChangesPerRun: 3,
  reviewModel: 'claude-haiku-4-5-20251001',
  promotionThreshold: 0.6,
  minRecallCount: 2,
  autoRouteOut: true,
  staggerWindowMinutes: 30,
  staleness: STALENESS_DEFAULTS,
};

/** Pick the first defined value in precedence order, else the default. */
function pick<T>(agent: T | undefined, global: T | undefined, fallback: T): T {
  if (agent !== undefined) return agent;
  if (global !== undefined) return global;
  return fallback;
}

/**
 * Numeric config sanitation lives in {@link numOr} (`src/utils/config-num.ts`).
 * Critical for `dreamHour`, which feeds the scheduler delay — a NaN there would
 * make `setTimeout` fire immediately and the async reviewer fan out in a tight
 * reschedule loop.
 */

/**
 * Resolve the staleness-GC sub-config (planning-66). Booleans fall back to the
 * default when absent/non-boolean; numerics are sanitized like the parent config.
 */
export function resolveStalenessConfig(
  agentCfg?: StalenessConfig,
  globalCfg?: StalenessConfig,
): ResolvedStalenessCfg {
  const d = STALENESS_DEFAULTS;
  const bool = (a?: boolean, g?: boolean, fb = false): boolean => {
    const v = pick(a, g, fb);
    return typeof v === 'boolean' ? v : fb;
  };
  return {
    enabled: bool(agentCfg?.enabled, globalCfg?.enabled, d.enabled),
    staleTtlDays: numOr(pick(agentCfg?.staleTtlDays, globalCfg?.staleTtlDays, d.staleTtlDays), d.staleTtlDays, 0, Infinity),
    keepImportance: numOr(pick(agentCfg?.keepImportance, globalCfg?.keepImportance, d.keepImportance), d.keepImportance, 0, 10),
    minRetrievalKeep: numOr(pick(agentCfg?.minRetrievalKeep, globalCfg?.minRetrievalKeep, d.minRetrievalKeep), d.minRetrievalKeep, 0, Infinity),
    supersession: bool(agentCfg?.supersession, globalCfg?.supersession, d.supersession),
    recordRetrievals: bool(agentCfg?.recordRetrievals, globalCfg?.recordRetrievals, d.recordRetrievals),
    maxInvalidationsPerRun: numOr(
      pick(agentCfg?.maxInvalidationsPerRun, globalCfg?.maxInvalidationsPerRun, d.maxInvalidationsPerRun),
      d.maxInvalidationsPerRun,
      0,
      Infinity,
    ),
  };
}

export function resolveDreamingConfig(
  agentCfg?: DreamingConfig,
  globalCfg?: DreamingConfig,
  /** `gateway.timezone` — the shared default when neither override sets `dreamTimezone`. */
  gatewayTimezone?: string,
): ResolvedDreamingCfg {
  const d = DREAMING_DEFAULTS;
  // Each precedence level is validated in turn — an invalid-but-present agent/global
  // override does not count as "set" and falls through to the next level, same as
  // resolveSkillLearningConfig and AppInstaller's cleanupTimezone (issue #462 review).
  const dreamTimezone = isValidTimezone(agentCfg?.dreamTimezone)
    ? agentCfg.dreamTimezone
    : isValidTimezone(globalCfg?.dreamTimezone)
      ? globalCfg.dreamTimezone
      : isValidTimezone(gatewayTimezone)
        ? gatewayTimezone
        : d.dreamTimezone;
  const mode = pick(agentCfg?.mode, globalCfg?.mode, d.mode);
  return {
    enabled: pick(agentCfg?.enabled, globalCfg?.enabled, d.enabled),
    mode: mode === 'auto' ? 'auto' : 'propose', // anything but 'auto' is 'propose'
    // dreamHour feeds the scheduler delay — must be a finite hour 0..23.
    dreamHour: numOr(pick(agentCfg?.dreamHour, globalCfg?.dreamHour, d.dreamHour), d.dreamHour, 0, 23),
    // dreamMinute pairs with dreamHour for minute-level scheduling — clamp 0..59.
    dreamMinute: numOr(pick(agentCfg?.dreamMinute, globalCfg?.dreamMinute, d.dreamMinute), d.dreamMinute, 0, 59),
    dreamTimezone,
    quietMinutes: numOr(pick(agentCfg?.quietMinutes, globalCfg?.quietMinutes, d.quietMinutes), d.quietMinutes, 0, Infinity),
    lookbackDays: numOr(pick(agentCfg?.lookbackDays, globalCfg?.lookbackDays, d.lookbackDays), d.lookbackDays, 0, Infinity),
    maxChangesPerRun: numOr(pick(agentCfg?.maxChangesPerRun, globalCfg?.maxChangesPerRun, d.maxChangesPerRun), d.maxChangesPerRun, 0, Infinity),
    reviewModel: pick(agentCfg?.reviewModel, globalCfg?.reviewModel, d.reviewModel),
    promotionThreshold: numOr(pick(agentCfg?.promotionThreshold, globalCfg?.promotionThreshold, d.promotionThreshold), d.promotionThreshold, 0, 1),
    minRecallCount: numOr(pick(agentCfg?.minRecallCount, globalCfg?.minRecallCount, d.minRecallCount), d.minRecallCount, 0, Infinity),
    // planning-67: boolean-safe (ignore non-boolean JSON), default true.
    autoRouteOut:
      [agentCfg?.autoRouteOut, globalCfg?.autoRouteOut].find((v) => typeof v === 'boolean') ??
      d.autoRouteOut,
    // planning-68: clamp to [0,55] so the jitter never crosses into the next hour.
    staggerWindowMinutes: numOr(
      pick(agentCfg?.staggerWindowMinutes, globalCfg?.staggerWindowMinutes, d.staggerWindowMinutes),
      d.staggerWindowMinutes,
      0,
      55,
    ),
    staleness: resolveStalenessConfig(agentCfg?.staleness, globalCfg?.staleness),
  };
}
