/**
 * Types for nightly memory "dreaming" (issue #325, Part C).
 *
 * P2 slice = `propose` (dry-run) only: a print-only reviewer proposes memory
 * consolidation ops which are written to a DREAMS.md diary + JSONL audit — the
 * gateway mutates NO memory file. `auto` mode (applying ops) is a P3 follow-up.
 */

export type DreamMode = 'propose' | 'auto';
export type DreamOpKind = 'add' | 'replace' | 'remove';
export type DreamFile = 'MEMORY.md' | 'USER.md';
/**
 * Which memory tier an op writes to (planning-65).
 *   - `durable`  → an evergreen file (`MEMORY.md`/`USER.md`), injected every session.
 *   - `episodic` → a `memory/<topic>.md` note, searched on demand (task-log).
 * Absent ⇒ `durable` (back-compat with pre-routing proposals).
 */
export type DreamTier = 'durable' | 'episodic';

/** Raw archive-staleness-GC config under `gateway.dreaming.staleness` (planning-66). */
export interface StalenessConfig {
  enabled?: boolean;
  staleTtlDays?: number;
  keepImportance?: number;
  minRetrievalKeep?: number;
  supersession?: boolean;
  recordRetrievals?: boolean;
}

/** Fully-resolved staleness config (defaults applied, values sanitized). */
export interface ResolvedStalenessCfg {
  enabled: boolean;
  staleTtlDays: number;
  keepImportance: number;
  minRetrievalKeep: number;
  supersession: boolean;
  recordRetrievals: boolean;
}

/** Partial config as it appears under `gateway.dreaming` / a per-agent override. */
export interface DreamingConfig {
  enabled?: boolean;
  mode?: DreamMode;
  dreamHour?: number;
  dreamTimezone?: string;
  quietMinutes?: number;
  lookbackDays?: number;
  maxChangesPerRun?: number;
  reviewModel?: string;
  promotionThreshold?: number;
  minRecallCount?: number;
  /**
   * planning-67: when true (default), the nightly dream (auto mode) drains an
   * over-budget MEMORY.md by routing episodic task-log to `memory/<topic>.md`
   * automatically (archive-safe), instead of relying on manual `dreaming:migrate`.
   * A clean kill-switch: false ⇒ prior behavior (manual CLI only).
   */
  autoRouteOut?: boolean;
  staleness?: StalenessConfig;
}

/** Fully-resolved config (defaults applied, timezone normalized). */
export interface ResolvedDreamingCfg {
  enabled: boolean;
  mode: DreamMode;
  dreamHour: number;
  dreamTimezone: string;
  quietMinutes: number;
  lookbackDays: number;
  maxChangesPerRun: number;
  reviewModel: string;
  promotionThreshold: number;
  minRecallCount: number;
  autoRouteOut: boolean;
  staleness: ResolvedStalenessCfg;
}

/** One proposed memory-consolidation op (never applied in propose mode). */
export interface DreamProposal {
  op: DreamOpKind;
  /**
   * Target evergreen file for a `durable` op. Omitted for `episodic` ops, which
   * route by `topic` into `memory/<topic>.md` instead.
   */
  file?: DreamFile;
  /** Tier this op writes to; absent ⇒ 'durable' (back-compat). */
  tier?: DreamTier;
  /** For `episodic` ops: the `memory/<topic>.md` slug (`^[a-z0-9-]{1,64}$`). */
  topic?: string;
  /** Substring anchor for `replace`/`remove`. */
  target?: string;
  /** New text for `add`/`replace`. */
  content?: string;
  reason: string;
  score: number;
  recallCount: number;
}

export interface DreamReviewResult {
  summary: string;
  proposals: DreamProposal[];
  /** Tokens the reviewer spent (input+output), for the net-token ledger. 0 if unknown. */
  tokensSpent: number;
  timedOut?: boolean;
}

export type DreamOutcome =
  | 'proposed' // proposals written to the diary (propose mode)
  | 'no-changes' // reviewer found nothing worth changing (a success)
  | 'skipped-disabled' // enabled:false or maxChangesPerRun:0
  | 'skipped-quiet' // a session was active within quietMinutes
  | 'skipped-empty' // no sessions in the lookback window
  | 'error'; // reviewer failed/timed out (safe no-op)

export interface DreamRunResult {
  outcome: DreamOutcome;
  proposalCount: number;
  tokensSpent: number;
  mode: DreamMode;
  /** Ops actually applied to memory (auto mode only; 0 in propose mode). */
  appliedCount?: number;
  /** Terminal-state entries the deterministic compactor archived (auto mode; #337). */
  compactedCount?: number;
}
