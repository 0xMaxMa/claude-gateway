/**
 * Resolve the effective dreaming config for one agent.
 *
 * Precedence mirrors `resolveSkillLearningConfig`: a per-agent override wins over
 * the global gateway default, which wins over the built-in default. The timezone
 * is normalized once here (invalid → UTC, lesson #310) so the scheduler never
 * re-guards.
 */

import { isValidTimezone } from '../skill-learning/config';
import type { DreamingConfig, ResolvedDreamingCfg } from './types';

export const DREAMING_DEFAULTS: ResolvedDreamingCfg = {
  enabled: true,
  mode: 'propose', // SAFE default: diary-only dry-run (auto mutates memory — P3)
  dreamHour: 3,
  dreamTimezone: 'UTC',
  quietMinutes: 30,
  lookbackDays: 3,
  maxChangesPerRun: 3,
  reviewModel: 'claude-haiku-4-5-20251001',
  promotionThreshold: 0.6,
  minRecallCount: 2,
};

/** Pick the first defined value in precedence order, else the default. */
function pick<T>(agent: T | undefined, global: T | undefined, fallback: T): T {
  if (agent !== undefined) return agent;
  if (global !== undefined) return global;
  return fallback;
}

export function resolveDreamingConfig(
  agentCfg?: DreamingConfig,
  globalCfg?: DreamingConfig,
): ResolvedDreamingCfg {
  const d = DREAMING_DEFAULTS;
  const rawTz = pick(agentCfg?.dreamTimezone, globalCfg?.dreamTimezone, d.dreamTimezone);
  const mode = pick(agentCfg?.mode, globalCfg?.mode, d.mode);
  return {
    enabled: pick(agentCfg?.enabled, globalCfg?.enabled, d.enabled),
    mode: mode === 'auto' ? 'auto' : 'propose', // anything but 'auto' is 'propose'
    dreamHour: pick(agentCfg?.dreamHour, globalCfg?.dreamHour, d.dreamHour),
    dreamTimezone: isValidTimezone(rawTz) ? rawTz : 'UTC',
    quietMinutes: pick(agentCfg?.quietMinutes, globalCfg?.quietMinutes, d.quietMinutes),
    lookbackDays: pick(agentCfg?.lookbackDays, globalCfg?.lookbackDays, d.lookbackDays),
    maxChangesPerRun: pick(agentCfg?.maxChangesPerRun, globalCfg?.maxChangesPerRun, d.maxChangesPerRun),
    reviewModel: pick(agentCfg?.reviewModel, globalCfg?.reviewModel, d.reviewModel),
    promotionThreshold: pick(agentCfg?.promotionThreshold, globalCfg?.promotionThreshold, d.promotionThreshold),
    minRecallCount: pick(agentCfg?.minRecallCount, globalCfg?.minRecallCount, d.minRecallCount),
  };
}
