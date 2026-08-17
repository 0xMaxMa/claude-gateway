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

import { msUntilNextHour } from '../../history/cleanup';
import { isValidTimezone } from '../skill-learning/config';
import type { ClaudeSpawnFn } from '../skill-learning/reviewer';
import { resolveDreamingConfig } from './config';
import { gatherTranscript, type DreamHistoryDb } from './gather';
import { runDreamReviewer } from './reviewer';
import { writeDreamAudit } from './audit';
import { applyDreamProposals } from './applier';
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

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
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

    if (!gathered.transcript.trim()) {
      this.audit(now, 'skipped-empty', '', [], 0, 0);
      return { outcome: 'skipped-empty', ...base };
    }

    const currentMemory = readFileSafe(path.join(this.deps.workspaceDir, 'MEMORY.md')).slice(0, REVIEWER_CONTEXT_CAP);
    const currentUser = readFileSafe(path.join(this.deps.workspaceDir, 'USER.md')).slice(0, REVIEWER_CONTEXT_CAP);

    let review;
    try {
      review = await runDreamReviewer(
        { transcript: gathered.transcript, currentMemory, currentUser },
        cfg,
        this.deps.spawnFn,
      );
    } catch {
      // runDreamReviewer never throws, but belt-and-suspenders: a failed review
      // is a safe no-op.
      this.audit(now, 'error', '', [], 0, gathered.sessionCount);
      return { outcome: 'error', ...base };
    }

    const proposals = review.proposals.slice(0, cfg.maxChangesPerRun);
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
          memoryBudgetChars: this.deps.memoryBudgetChars ?? 8_000,
          userBudgetChars: this.deps.userBudgetChars ?? 3_000,
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
          if (p.op !== 'add' || !p.content) continue;
          try {
            this.deps.sharedPromote(p);
          } catch {
            /* best-effort */
          }
        }
      }
    }

    this.audit(now, outcome, review.summary, proposals, review.tokensSpent, gathered.sessionCount, cfg.mode === 'auto' ? appliedCount : undefined);
    this.log('Dream run complete', {
      agentId: this.deps.agentId,
      outcome,
      mode: cfg.mode,
      proposals: proposals.length,
      applied: appliedCount,
      tokens: review.tokensSpent,
    });

    return {
      outcome,
      proposalCount: proposals.length,
      tokensSpent: review.tokensSpent,
      mode: cfg.mode,
      appliedCount,
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
      const delay = msUntilNextHour(this.cfg.dreamHour, tz);
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
