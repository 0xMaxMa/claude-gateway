/**
 * Skill-learning types — the closed Do → Learn → Improve loop.
 *
 * See planning-62-skill-learning.md. All durable rows live in the per-agent
 * history.db (no second database). Provenance keys (`origin`, `pinned`,
 * `createdFromSession`, `createdAt`) are ordinary extra frontmatter the skill
 * parser already ignores, so a learned skill is a plain SKILL.md.
 */

/** Reviewer/curator mode. `propose` = write to a review queue (no live inject); `auto` = write live. */
export type SkillLearningMode = 'propose' | 'auto';

/** Provenance origin of a skill. Only `auto` skills are ever edited/pruned by this subsystem. */
export type SkillOrigin = 'auto' | 'user';

/**
 * Resolved (defaults-applied) skill-learning config for one agent.
 * The gateway does not central-default; defaults are applied at the consumption
 * site (mirror of history retention / appBackup resolution).
 */
export interface ResolvedSkillLearningCfg {
  enabled: boolean;
  mode: SkillLearningMode;
  minToolCalls: number;
  reviewModel: string;
  maxAutoSkills: number;
  maxAgeDays: number;
  minUsesToKeep: number;
  pruneHour: number;
  pruneTimezone: string;
  /** Max reviewer spawns per agent per day (cost cap). */
  maxReviewsPerDay: number;
}

/** Optional per-agent override + global default, shape stored in config. */
export interface SkillLearningConfig {
  enabled?: boolean;
  mode?: SkillLearningMode;
  minToolCalls?: number;
  reviewModel?: string;
  maxAutoSkills?: number;
  maxAgeDays?: number;
  minUsesToKeep?: number;
  pruneHour?: number;
  pruneTimezone?: string;
  maxReviewsPerDay?: number;
}

/** One durable per-turn telemetry row (table `turn_metrics`). */
export interface TurnMetrics {
  sessionId: string;
  turnIdx: number;
  ts: number;
  toolCalls: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** 1 if recovery-triage fired this turn, else 0. */
  recoveryFired: number;
  /** JSON array (as string) of skill names referenced this turn. */
  skillsLoaded: string;
  /** Lightweight task-cluster key (normalized keyword/command signature). */
  intentHash: string;
  /** Cohort tag: was skillLearning.enabled at capture (1/0). */
  enabled: number;
}

/** One row of `skill_stats` — per-skill provenance + usage. */
export interface SkillStat {
  name: string;
  origin: SkillOrigin;
  createdAt: number;
  createdFromSession: string | null;
  timesLoaded: number;
  lastUsedAt: number | null;
  pinned: number;
}

/**
 * Aggregate signals for one finished session, fed to the trigger gate.
 * Derived from the session's turn_metrics rows.
 */
export interface SessionSignals {
  /** Max tool-calls across the session's turns (peak effort). */
  toolCalls: number;
  /** Any turn fired recovery-triage. */
  recoveryFired: boolean;
  /** A user-correction heuristic matched (e.g. user negation right after an agent action). */
  userCorrection: boolean;
}

/** Remaining daily review budget for an agent. */
export interface DailyBudget {
  /** Reviews already spawned today. */
  spent: number;
  /** Cap (maxReviewsPerDay); <= 0 disables reviewing entirely. */
  cap: number;
}

/** Trigger decision. */
export interface TriggerDecision {
  review: boolean;
  reason: 'tool-calls' | 'recovery' | 'user-correction' | null;
}

/** The reviewer's strict JSON output. Any parse failure ⇒ treated as `none`. */
export interface ReviewProposal {
  action: 'none' | 'create' | 'edit';
  name?: string;
  desc?: string;
  body?: string;
  /** For `edit`: the existing skill name to update. */
  targetSkill?: string;
  rationale?: string;
}

/** Result of applying a proposal through the writer. */
export interface WriteOutcome {
  written: boolean;
  action: 'none' | 'create' | 'edit';
  /** Skill name written (or attempted). */
  name?: string;
  /** Why a write was refused/skipped (provenance guard, validation, dedup, propose-queue). */
  reason?: string;
  /** True when the proposal was routed to the propose review queue rather than live. */
  queued?: boolean;
}

/** The read-side effectiveness rollup surfaced via REST/MCP. */
export interface SkillMetricsRollup {
  agentId: string;
  generatedAt: number;
  /** Measure 1 — adoption funnel. */
  adoption: {
    autoSkills: number;
    loadedAtLeast1: number;
    loadedAtLeast3: number;
    stickyPct: number; // % of auto-skills reaching >= 3 uses
  };
  /** Measure 2 — cost-to-complete delta per intent cluster (directional). */
  costDelta: {
    clusters: number;
    medianToolCallsBefore: number;
    medianToolCallsAfter: number;
    medianTokensBefore: number;
    medianTokensAfter: number;
  };
  /** Measure 3 — recovery-rate trend. */
  recovery: {
    ratePctRecent: number;
    ratePctEarlier: number;
  };
  /** Measure 4 — cohort A/B by the `enabled` column. */
  cohort: {
    enabledTurns: number;
    disabledTurns: number;
    enabledMedianToolCalls: number;
    disabledMedianToolCalls: number;
  };
  /** Measure 5 — net token economics (the bottom line). */
  netTokens: {
    savedByReuse: number;
    spentReviewing: number;
    net: number; // saved - spent
  };
}
