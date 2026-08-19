/**
 * DreamingManager — nightly memory consolidation, propose (dry-run) slice.
 *
 * Orchestrates: gather lookback transcript → print-only reviewer proposes memory
 * ops → write DREAMS.md diary + JSONL audit. In propose mode (the only mode
 * implemented here) NO memory file is mutated. The `auto` applier is a P3
 * follow-up; until it lands, `auto` behaves like `propose` (logs proposals only).
 */

import * as fs from 'fs';
import * as path from 'path';

import { msUntilNextTime } from '../../history/cleanup';
import { isValidTimezone } from '../skill-learning/config';
import type { ClaudeSpawnFn } from '../skill-learning/reviewer';
import { resolveDreamingConfig } from './config';
import { gatherTranscript, type DreamHistoryDb } from './gather';
import { runDreamReviewer } from './reviewer';
import { writeDreamAudit } from './audit';
import { applyDreamProposals } from './applier';
import { compactCompletedEntries } from './compactor';
import { runStalenessGc } from './staleness';
import { migrateMemory } from './migrate';
import type {
  DreamingConfig,
  DreamOutcome,
  DreamProposal,
  DreamRunResult,
  ResolvedDreamingCfg,
} from './types';

export interface DreamingManagerDeps {
  db: DreamHistoryDb;
  agentId: string;
  workspaceDir: string;
  globalCfg?: DreamingConfig;
  agentCfg?: DreamingConfig;
  logger?: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warn?: (msg: string, data?: Record<string, unknown>) => void;
  };
  /** Injectable reviewer spawn for tests (defaults to a real print-only claude -p). */
  spawnFn?: ClaudeSpawnFn;
  /** Soft memory budgets for the K4 auto-applier's net-negative gate (defaults 8000/3000). */
  memoryBudgetChars?: number;
  userBudgetChars?: number;
  /**
   * planning-65 write routing. When true, the reviewer is told the two-tier
   * contract and may emit episodic ops; `episodicArchiveDir` is where those
   * `memory/<topic>.md` notes are written. When false/absent, durable-only
   * (exact prior behavior).
   */
  writeRouting?: boolean;
  episodicArchiveDir?: string;
  /**
   * planning-67: injected route-out classifier for the embedded auto-migrate
   * stage. Given the current MEMORY.md, returns episodic-move proposals. The
   * gateway wires it (reviewer-backed spawn) only when write routing is on;
   * tests inject a stub. Absent ⇒ the stage is skipped (durable-only behavior).
   */
  routeOutFn?: (memory: string) => Promise<DreamProposal[]> | DreamProposal[];
  /**
   * Optional per-agent→shared promotion hook (K3↔K4). When provided (the gateway
   * wires it only when the shared KB is enabled AND `shared.mode:auto`), each
   * durable `add` the dream promotes is also contributed to the shared vault.
   * Injected as a callback so the manager stays decoupled from shared-config
   * resolution and is easy to test. Best-effort; must not throw.
   */
  sharedPromote?: (proposal: DreamProposal) => void;
}

const MS_PER_MINUTE = 60 * 1000;
// Cap the current-memory context fed to the reviewer so a large MEMORY.md (which
// is exactly what dreaming exists to shrink) can't blow up the prompt.
const REVIEWER_CONTEXT_CAP = 12_000;
// Hard ceiling on shrink ops per run so a runaway over-budget reviewer can't thrash.
const MAX_SHRINK_OPS_PER_RUN = 30;

/** A proposal that reduces (or does not grow) MEMORY.md length. */
function isShrinkOp(p: DreamProposal): boolean {
  if (p.op === 'remove') return true;
  if (p.op === 'replace') return (p.content ?? '').trim().length <= (p.target ?? '').length;
  return false;
}

/**
 * Select which proposals to apply this run (#337). Under budget: the classic
 * first-N cap. Over budget (overageFactor > 1): keep the non-shrink (add/grow)
 * cap at `maxChanges`, but allow proportionally MORE shrink ops (remove /
 * length-reducing replace) so an over-budget file converges instead of trickling
 * at `maxChanges`/night. Capped at MAX_SHRINK_OPS_PER_RUN.
 */
export function selectProposals(
  proposals: DreamProposal[],
  maxChanges: number,
  overageFactor: number,
): DreamProposal[] {
  if (overageFactor <= 1 || maxChanges <= 0) return proposals.slice(0, maxChanges);
  const shrinkCap = Math.min(maxChanges * Math.ceil(overageFactor), MAX_SHRINK_OPS_PER_RUN);
  const out: DreamProposal[] = [];
  let nonShrink = 0;
  let shrink = 0;
  for (const p of proposals) {
    if (isShrinkOp(p)) {
      if (shrink >= shrinkCap) continue;
      shrink++;
    } else {
      if (nonShrink >= maxChanges) continue;
      nonShrink++;
    }
    out.push(p);
  }
  return out;
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * planning-68 — deterministic per-agent jitter (ms) added to the nightly delay so
 * agents don't all fire at `dreamHour:00` together (thundering herd → concurrent
 * `claude -p` spawns). A stable string hash of `agentId` mapped into
 * `[0, windowMinutes*60_000)`; NOT `Math.random`, so the offset is the same across
 * reschedules and is unit-testable. Non-finite or `<= 0` window ⇒ 0 (feature off).
 */
export function agentJitterMs(agentId: string, windowMinutes: number): number {
  if (!Number.isFinite(windowMinutes)) return 0;
  const windowMs = Math.max(0, Math.floor(windowMinutes)) * 60_000;
  if (windowMs <= 0) return 0;
  let h = 0;
  for (let i = 0; i < agentId.length; i++) {
    h = (Math.imul(h, 31) + agentId.charCodeAt(i)) >>> 0;
  }
  return h % windowMs;
}

export class DreamingManager {
  readonly cfg: ResolvedDreamingCfg;
  private readonly deps: DreamingManagerDeps;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: DreamingManagerDeps) {
    this.deps = deps;
    this.cfg = resolveDreamingConfig(deps.agentCfg, deps.globalCfg);
  }

  private log(msg: string, data?: Record<string, unknown>): void {
    this.deps.logger?.info(msg, data);
  }

  /**
   * Run one dream cycle. Never throws. In propose mode it writes only the diary
   * + audit and mutates no memory file.
   */
  async dreamOnce(now: number = Date.now()): Promise<DreamRunResult> {
    const cfg = this.cfg;
    const base = { proposalCount: 0, tokensSpent: 0, mode: cfg.mode };

    if (!cfg.enabled || cfg.maxChangesPerRun <= 0) {
      return { outcome: 'skipped-disabled', ...base };
    }

    const gathered = gatherTranscript(this.deps.db, cfg, now);

    // Quiet window: if the agent was active within quietMinutes, defer.
    if (gathered.lastActivityMs > 0 && now - gathered.lastActivityMs < cfg.quietMinutes * MS_PER_MINUTE) {
      return { outcome: 'skipped-quiet', ...base };
    }

    const memoryPath = path.join(this.deps.workspaceDir, 'MEMORY.md');
    const memoryBudget = this.deps.memoryBudgetChars ?? 8_000;

    // DETERMINISTIC COMPACTION (#337): before the LLM reviewer, archive terminal
    // (MERGED/CLOSED) log entries out to a searchable memory/archive/ file, leaving
    // a pointer. This is the primary shrink lever for append-only PR/issue logs and
    // needs no transcript — so it runs (auto mode only) even on empty-transcript
    // nights. Best-effort; never blocks the dream.
    let compactedCount = 0;
    if (cfg.mode === 'auto') {
      try {
        compactedCount = compactCompletedEntries(this.deps.workspaceDir, now).archivedCount;
      } catch {
        compactedCount = 0;
      }
    }

    // ARCHIVE STALENESS GC (planning-66): after the compactor, keep the Lane-2
    // archive's SEARCH quality high — soft-invalidate superseded / aged-out /
    // low-recall entries (move to memory/archive/stale.md, never delete) and
    // promote back anything retrieved after invalidation. Deterministic, memory-
    // only (no session restart), best-effort. Auto mode only; injectable clock.
    if (cfg.mode === 'auto' && cfg.staleness.enabled) {
      try {
        runStalenessGc(this.deps.workspaceDir, cfg.staleness, { now });
      } catch {
        /* best-effort — never blocks the dream */
      }
    }

    // EMBEDDED ROUTE-OUT (planning-67): when MEMORY.md is over budget, drain its
    // episodic task-log to memory/<topic>.md automatically — archive-first, so
    // every moved block stays searchable (no manual `dreaming:migrate` per agent).
    // Runs auto-mode + routing-on + over-budget only; transcript-independent (like
    // the compactor) so a quiet agent still self-drains; idempotent (skips once
    // under budget); pinned sections excluded inside migrateMemory. Best-effort.
    let routedOut = 0;
    if (
      cfg.mode === 'auto' &&
      this.deps.writeRouting &&
      cfg.autoRouteOut &&
      this.deps.routeOutFn
    ) {
      const chars = readFileSafe(memoryPath).length;
      if (chars > memoryBudget) {
        try {
          const res = await migrateMemory(this.deps.workspaceDir, {
            mode: 'apply',
            skipTerminalSweep: true, // the compactor already ran this tick
            episodicArchiveDir: this.deps.episodicArchiveDir || 'memory',
            routeOut: this.deps.routeOutFn,
            now,
          });
          routedOut = res.episodicMoved;
        } catch {
          /* best-effort — never blocks the dream */
        }
      }
    }
    if (routedOut > 0) {
      this.log('dream: embedded route-out drained episodic task-log', { routedOut });
    }

    if (!gathered.transcript.trim()) {
      this.audit(now, 'skipped-empty', '', [], 0, 0, cfg.mode === 'auto' ? 0 : undefined, compactedCount);
      return { outcome: 'skipped-empty', ...base, compactedCount };
    }

    // Read the TRUE on-disk MEMORY.md size for the budget signal (the reviewer
    // context below is truncated, so it can't be used to measure the file).
    const memoryChars = readFileSafe(memoryPath).length;
    const currentMemory = readFileSafe(memoryPath).slice(0, REVIEWER_CONTEXT_CAP);
    const currentUser = readFileSafe(path.join(this.deps.workspaceDir, 'USER.md')).slice(0, REVIEWER_CONTEXT_CAP);

    let review;
    try {
      review = await runDreamReviewer(
        {
          transcript: gathered.transcript,
          currentMemory,
          currentUser,
          memoryChars,
          memoryBudget,
          writeRouting: this.deps.writeRouting,
        },
        cfg,
        this.deps.spawnFn,
      );
    } catch (err) {
      // runDreamReviewer is not supposed to throw, but if it does, surface the
      // cause instead of swallowing it silently — an outcome=error run with no
      // diagnostics is undebuggable. Compaction + route-out already committed
      // this tick, so note that they succeeded even though the reviewer failed.
      this.log('dream: reviewer failed; keeping compaction/route-out results', {
        error: err instanceof Error ? err.message : String(err),
        compacted: compactedCount,
      });
      this.audit(now, 'error', '', [], 0, gathered.sessionCount, undefined, compactedCount);
      return { outcome: 'error', ...base, compactedCount };
    }

    // Over budget ⇒ allow proportionally more shrink ops so the file converges (#337).
    const overageFactor = memoryBudget > 0 ? memoryChars / memoryBudget : 1;
    const proposals = selectProposals(review.proposals, cfg.maxChangesPerRun, overageFactor);
    const outcome: DreamOutcome = review.timedOut
      ? 'error'
      : proposals.length > 0
        ? 'proposed'
        : 'no-changes';

    // AUTO MODE (K4): apply the ops to memory through the safe applier (backup +
    // ordered anchor re-resolution + bounded-loss + net-negative + append-only
    // fallback). Writing MEMORY.md/USER.md is memory-only ⇒ no session restart
    // (Part A). PROPOSE MODE mutates nothing — diary + audit only.
    let appliedCount = 0;
    if (cfg.mode === 'auto' && outcome === 'proposed') {
      let appliedProposals: DreamProposal[] = [];
      try {
        const applied = applyDreamProposals(this.deps.workspaceDir, proposals, {
          memoryBudgetChars: memoryBudget,
          userBudgetChars: this.deps.userBudgetChars ?? 3_000,
          // planning-65: route episodic ops to memory/<topic>.md only when routing is on.
          episodicArchiveDir: this.deps.writeRouting
            ? this.deps.episodicArchiveDir || 'memory'
            : undefined,
          // planning-67: relocate net-shrink `remove`s to a searchable archive
          // (never silently delete) when routing is on.
          archivePrunedRemovals: this.deps.writeRouting === true,
        }, now);
        appliedCount = applied.totalApplied;
        appliedProposals = applied.appliedProposals;
      } catch {
        appliedCount = 0; // applier never throws, but stay a safe no-op regardless
      }

      // Per-agent→shared promotion (K3↔K4): contribute ONLY the `add`s the applier
      // actually wrote to local memory — never a proposal that was skipped locally
      // (net-negative / bounded-loss), so the shared vault can't gain content the
      // agent's own memory refused. Gated + wired by the gateway (shared enabled +
      // mode auto); best-effort — a promotion failure never affects the local dream.
      if (this.deps.sharedPromote) {
        for (const p of appliedProposals) {
          // Only durable `add`s promote to shared; episodic task-log stays local.
          if (p.op !== 'add' || !p.content || p.tier === 'episodic') continue;
          try {
            this.deps.sharedPromote(p);
          } catch {
            /* best-effort */
          }
        }
      }
    }

    this.audit(now, outcome, review.summary, proposals, review.tokensSpent, gathered.sessionCount, cfg.mode === 'auto' ? appliedCount : undefined, compactedCount);
    this.log('Dream run complete', {
      agentId: this.deps.agentId,
      outcome,
      mode: cfg.mode,
      proposals: proposals.length,
      applied: appliedCount,
      compacted: compactedCount,
      tokens: review.tokensSpent,
    });

    return {
      outcome,
      proposalCount: proposals.length,
      tokensSpent: review.tokensSpent,
      mode: cfg.mode,
      appliedCount,
      compactedCount,
    };
  }

  private audit(
    ts: number,
    outcome: DreamOutcome,
    summary: string,
    proposals: DreamProposal[],
    tokensSpent: number,
    sessionCount: number,
    appliedCount?: number,
    compactedCount?: number,
  ): void {
    writeDreamAudit(this.deps.workspaceDir, {
      ts,
      outcome,
      mode: this.cfg.mode,
      summary,
      proposals,
      tokensSpent,
      sessionCount,
      appliedCount,
      compactedCount,
    });
  }

  /**
   * Start the nightly dream scheduler (mirror `startCurator`): a self-rescheduling
   * unref'd timer at `dreamHour` in `dreamTimezone`. Best-effort; never throws at
   * boot (invalid tz already normalized to UTC in resolveDreamingConfig).
   */
  startDreaming(): void {
    if (!this.cfg.enabled || this.cfg.maxChangesPerRun <= 0) return;
    const tz = isValidTimezone(this.cfg.dreamTimezone) ? this.cfg.dreamTimezone : 'UTC';
    const schedule = (): void => {
      // planning-68: spread agents across a window so they don't all fire at
      // dreamHour:00 together (deterministic per-agent offset, stable per reschedule).
      const delay =
        msUntilNextTime(this.cfg.dreamHour, this.cfg.dreamMinute, tz) +
        agentJitterMs(this.deps.agentId, this.cfg.staggerWindowMinutes);
      this.timer = setTimeout(() => {
        void this.dreamOnce(Date.now()).catch(() => {
          /* best-effort */
        });
        schedule();
      }, delay);
      if (typeof (this.timer as NodeJS.Timeout).unref === 'function') {
        (this.timer as NodeJS.Timeout).unref();
      }
    };
    schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
