/**
 * Resolve the effective skill-learning config for one agent.
 *
 * Precedence mirrors `resolveRetentionDays` (history/cleanup.ts): a per-agent
 * override wins over the global gateway default, which wins over the built-in
 * default. The gateway does not central-default — defaults are applied here at
 * the consumption site.
 */

import type { SkillLearningConfig, ResolvedSkillLearningCfg } from './types';

export const SKILL_LEARNING_DEFAULTS: ResolvedSkillLearningCfg = {
  enabled: true,
  mode: 'auto',
  minToolCalls: 5,
  reviewModel: 'claude-haiku-4-5-20251001',
  maxAutoSkills: 50,
  maxAgeDays: 30,
  minUsesToKeep: 2,
  pruneHour: 3,
  pruneTimezone: 'UTC',
  maxReviewsPerDay: 20,
  notify: true,
};

/** Pick the first defined value in precedence order, else the default. */
function pick<T>(agent: T | undefined, global: T | undefined, fallback: T): T {
  if (agent !== undefined) return agent;
  if (global !== undefined) return global;
  return fallback;
}

/**
 * Merge a per-agent override and the global gateway config into a fully
 * resolved config. Either side may be undefined/partial.
 */
export function resolveSkillLearningConfig(
  agentCfg?: SkillLearningConfig,
  globalCfg?: SkillLearningConfig,
  /** `gateway.timezone` — the shared default when neither override sets `pruneTimezone`. */
  gatewayTimezone?: string,
): ResolvedSkillLearningCfg {
  const d = SKILL_LEARNING_DEFAULTS;
  // Normalize the timezone once, here, so every consumer (curator scheduler,
  // telemetry day-window) receives a value Intl accepts — an invalid tz falls
  // back to UTC rather than each consumer re-guarding (or crashing) on its own.
  const rawTz = agentCfg?.pruneTimezone ?? globalCfg?.pruneTimezone ?? gatewayTimezone ?? d.pruneTimezone;
  return {
    enabled: pick(agentCfg?.enabled, globalCfg?.enabled, d.enabled),
    mode: pick(agentCfg?.mode, globalCfg?.mode, d.mode),
    minToolCalls: pick(agentCfg?.minToolCalls, globalCfg?.minToolCalls, d.minToolCalls),
    reviewModel: pick(agentCfg?.reviewModel, globalCfg?.reviewModel, d.reviewModel),
    maxAutoSkills: pick(agentCfg?.maxAutoSkills, globalCfg?.maxAutoSkills, d.maxAutoSkills),
    maxAgeDays: pick(agentCfg?.maxAgeDays, globalCfg?.maxAgeDays, d.maxAgeDays),
    minUsesToKeep: pick(agentCfg?.minUsesToKeep, globalCfg?.minUsesToKeep, d.minUsesToKeep),
    pruneHour: pick(agentCfg?.pruneHour, globalCfg?.pruneHour, d.pruneHour),
    pruneTimezone: isValidTimezone(rawTz) ? rawTz : 'UTC',
    maxReviewsPerDay: pick(agentCfg?.maxReviewsPerDay, globalCfg?.maxReviewsPerDay, d.maxReviewsPerDay),
    notify: pick(agentCfg?.notify, globalCfg?.notify, d.notify),
  };
}

/** Validate a timezone string; fall back to UTC on anything Intl rejects (boot-safety, lesson #310). */
export function isValidTimezone(tz: string | undefined): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
