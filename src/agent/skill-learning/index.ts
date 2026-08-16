/**
 * SkillLearningManager — the only export the runner/index wire to.
 *
 * Owns the closed loop: cheap per-turn telemetry capture (always-on), a
 * debounced session-idle review trigger, the print-only reviewer, the
 * provenance-guarded writer, and the daily curator. All turn-lifecycle methods
 * are best-effort and MUST never throw into the runner's hot path.
 */

import { loadSkills } from '../../skills/loader';
import { extractFrontmatter } from '../../skills/parser';
import { HistoryDB } from '../../history/db';
import { resolveSkillLearningConfig } from './config';
import { intentHash, startOfDayMs } from './telemetry';
import { shouldReview } from './trigger';
import { runReviewer, type ClaudeSpawnFn } from './reviewer';
import { applyProposal, readSkillOrigin, type ExistingSkill } from './writer';
import { startCurator, curateOnce, type CuratorResult } from './curator';
import { computeRollup } from './metrics';
import type { SessionSignals, SkillLearningConfig, ResolvedSkillLearningCfg, SkillMetricsRollup } from './types';

/** Debounce: fire the review this long after the last turn ends (session-idle proxy). */
export const REVIEW_IDLE_DEBOUNCE_MS = 20_000;

/** Heuristic: a user message that reads like a correction of the agent's last action. */
const CORRECTION_RE = /^\s*(no\b|not\b|wrong\b|that'?s not|nope\b|ไม่ใช่|ผิด|บ่ใช่)/i;

interface Accum {
  sessionId: string;
  turnIdx: number;
  // per-turn (reset each onTurnStart)
  startedAt: number;
  toolUseIds: Set<string>;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  recoveryFired: boolean;
  skillsLoaded: Set<string>;
  firstUserMsg: string;
  // session-level signals (persist across turns until a review consumes them)
  sigMaxToolCalls: number;
  sigRecovery: boolean;
  sigCorrection: boolean;
}

export interface SkillLearningManagerOpts {
  db: HistoryDB;
  agentId: string;
  workspaceDir: string;
  mcpToolsDir?: string;
  sharedSkillsDir?: string;
  globalCfg?: SkillLearningConfig;
  agentCfg?: SkillLearningConfig;
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void };
  /** Injectable reviewer spawn — tests script the model; production uses the real claude -p. */
  reviewSpawn?: ClaudeSpawnFn;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class SkillLearningManager {
  readonly cfg: ResolvedSkillLearningCfg;
  private readonly db: HistoryDB;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly mcpToolsDir?: string;
  private readonly sharedSkillsDir?: string;
  private readonly logger?: SkillLearningManagerOpts['logger'];
  private readonly reviewSpawn?: ClaudeSpawnFn;
  private readonly now: () => number;

  private readonly accum = new Map<string, Accum>();
  private readonly reviewInFlight = new Set<string>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: SkillLearningManagerOpts) {
    this.db = opts.db;
    this.agentId = opts.agentId;
    this.workspaceDir = opts.workspaceDir;
    this.mcpToolsDir = opts.mcpToolsDir;
    this.sharedSkillsDir = opts.sharedSkillsDir;
    this.logger = opts.logger;
    this.reviewSpawn = opts.reviewSpawn;
    this.now = opts.now ?? Date.now;
    this.cfg = resolveSkillLearningConfig(opts.agentCfg, opts.globalCfg);
  }

  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  // ---- Turn lifecycle (called by the runner; all best-effort) ----------------

  /** A user turn begins. `invokedSkills` = skills detected in the incoming message. */
  onTurnStart(mapKey: string, sessionId: string, firstUserMessage: string, invokedSkills: string[] = []): void {
    try {
      let a = this.accum.get(mapKey);
      if (!a || a.sessionId !== sessionId) {
        a = this.freshAccum(sessionId);
      } else {
        a.turnIdx += 1;
      }
      a.startedAt = this.now();
      a.toolUseIds.clear();
      a.toolCalls = 0;
      a.tokensIn = 0;
      a.tokensOut = 0;
      a.recoveryFired = false;
      a.skillsLoaded = new Set(invokedSkills.filter(Boolean));
      a.firstUserMsg = firstUserMessage ?? '';
      if (CORRECTION_RE.test(a.firstUserMsg)) a.sigCorrection = true;
      this.accum.set(mapKey, a);
    } catch {
      /* never break the turn */
    }
  }

  /** A tool_use block streamed by. Deduped by block id (cumulative snapshots). */
  onToolUse(mapKey: string, toolUseId?: string): void {
    const a = this.accum.get(mapKey);
    if (!a) return;
    if (toolUseId) {
      if (a.toolUseIds.has(toolUseId)) return;
      a.toolUseIds.add(toolUseId);
    }
    a.toolCalls += 1;
  }

  onTokenUsage(mapKey: string, inputTokens: number, totalTokens: number): void {
    const a = this.accum.get(mapKey);
    if (!a) return;
    if (inputTokens > a.tokensIn) a.tokensIn = inputTokens; // peak context
    a.tokensOut += Math.max(0, totalTokens); // accumulated work
  }

  onRecoveryFired(mapKey: string): void {
    const a = this.accum.get(mapKey);
    if (!a) return;
    a.recoveryFired = true;
    a.sigRecovery = true;
  }

  /** A user turn ended. Persist the metric row + arm the idle-review debounce. */
  onTurnEnd(mapKey: string, sessionId: string): void {
    try {
      const a = this.accum.get(mapKey);
      if (!a || a.sessionId !== sessionId) return;
      const ts = this.now();
      const skills = [...a.skillsLoaded];
      this.db.insertTurnMetric({
        sessionId,
        turnIdx: a.turnIdx,
        ts,
        toolCalls: a.toolCalls,
        durationMs: Math.max(0, ts - a.startedAt),
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        recoveryFired: a.recoveryFired ? 1 : 0,
        skillsLoaded: skills.length ? JSON.stringify(skills) : null,
        intentHash: intentHash(a.firstUserMsg),
        enabled: this.cfg.enabled ? 1 : 0,
      });
      for (const name of skills) this.db.bumpSkillLoaded(name, ts);
      a.sigMaxToolCalls = Math.max(a.sigMaxToolCalls, a.toolCalls);
      this.scheduleIdleReview(mapKey, sessionId);
    } catch {
      /* best-effort */
    }
  }

  // ---- Review path -----------------------------------------------------------

  private scheduleIdleReview(mapKey: string, sessionId: string): void {
    if (!this.cfg.enabled) return; // capture still ran above; review is the gated part
    const existing = this.idleTimers.get(mapKey);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.idleTimers.delete(mapKey);
      void this.runReviewNow(mapKey, sessionId);
    }, REVIEW_IDLE_DEBOUNCE_MS);
    if (typeof (t as NodeJS.Timeout).unref === 'function') (t as NodeJS.Timeout).unref();
    this.idleTimers.set(mapKey, t);
  }

  /**
   * The gated review entry (also the direct test seam). Reads session signals,
   * checks the daily budget, and — if the gate passes — runs the reviewer and
   * applies the proposal. Never throws.
   */
  async runReviewNow(mapKey: string, sessionId: string): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.reviewInFlight.has(sessionId)) return;
    const a = this.accum.get(mapKey);
    if (!a || a.sessionId !== sessionId) return;

    const signals: SessionSignals = {
      toolCalls: a.sigMaxToolCalls,
      recoveryFired: a.sigRecovery,
      userCorrection: a.sigCorrection,
    };
    const dayStart = startOfDayMs(this.now(), this.cfg.pruneTimezone);
    const spent = this.db.countReviewRunsSince(dayStart);
    const decision = shouldReview(signals, this.cfg, { spent, cap: this.cfg.maxReviewsPerDay });
    if (!decision.review) return;

    this.reviewInFlight.add(sessionId);
    try {
      const transcript = this.gatherTranscript(sessionId);
      if (!transcript.trim()) return;
      const existing = this.loadExistingSkills();

      const { proposal, tokensSpent } = await runReviewer(
        { transcript, existingSkills: existing.map((s) => ({ name: s.name, description: s.description })) },
        this.cfg,
        this.reviewSpawn,
      );

      const outcome = applyProposal(proposal, {
        workspaceDir: this.workspaceDir,
        sessionId,
        now: this.now(),
        mode: this.cfg.mode,
        existing,
      });

      // Record provenance only on a genuine create — an edit's skill_stats row
      // already exists (from the original create), so re-recording would reset
      // its created_at (age clock) and usage counters.
      if (outcome.written && !outcome.queued && outcome.action === 'create' && outcome.name) {
        this.db.recordSkillCreated({
          name: outcome.name,
          origin: 'auto',
          createdAt: this.now(),
          createdFromSession: sessionId,
          pinned: 0,
        });
      }

      this.db.insertReviewRun({
        sessionId,
        ts: this.now(),
        triggerReason: decision.reason,
        outcome: outcome.written ? outcome.action : proposal.action === 'none' ? 'none' : 'error',
        tokensSpent,
      });

      this.logger?.info(
        `[skill-learning:${this.agentId}] review (${decision.reason}) → ${
          outcome.written ? `${outcome.action}:${outcome.name}${outcome.queued ? ' (queued)' : ''}` : `no-write (${outcome.reason ?? proposal.action})`
        } tokens=${tokensSpent}`,
      );
    } catch (err) {
      this.logger?.warn?.(`[skill-learning:${this.agentId}] review failed: ${(err as Error).message}`);
    } finally {
      this.reviewInFlight.delete(sessionId);
      // Reset session signals so the next batch of turns re-qualifies from scratch.
      a.sigMaxToolCalls = 0;
      a.sigRecovery = false;
      a.sigCorrection = false;
    }
  }

  // ---- Curator ---------------------------------------------------------------

  /** Start the daily curator scheduler. Returns a canceller. */
  startCurator(): () => void {
    return startCurator(
      () => ({
        db: this.db,
        workspaceDir: this.workspaceDir,
        agentId: this.agentId,
        cfg: this.cfg,
        logger: this.logger,
      }),
      this.cfg,
    );
  }

  /** Run one curation sweep immediately (test/ops seam). */
  curateNow(): CuratorResult {
    return curateOnce({
      db: this.db,
      workspaceDir: this.workspaceDir,
      agentId: this.agentId,
      cfg: this.cfg,
      now: this.now(),
      logger: this.logger,
    });
  }

  /** The effectiveness rollup (REST/MCP read side). */
  rollup(): SkillMetricsRollup {
    return computeRollup(this.db, this.agentId, this.now());
  }

  // ---- Internals -------------------------------------------------------------

  private freshAccum(sessionId: string): Accum {
    return {
      sessionId,
      turnIdx: 0,
      startedAt: this.now(),
      toolUseIds: new Set(),
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      recoveryFired: false,
      skillsLoaded: new Set(),
      firstUserMsg: '',
      sigMaxToolCalls: 0,
      sigRecovery: false,
      sigCorrection: false,
    };
  }

  private gatherTranscript(sessionId: string): string {
    const rows = this.db.getSessionTranscript(sessionId, 200);
    return rows
      .map((r) => `${r.role === 'assistant' ? 'assistant' : 'user'}: ${r.content}`)
      .join('\n')
      .slice(-20_000); // bound the reviewer prompt
  }

  /** All loaded skills with resolved provenance + path (for dedup + guards). */
  private loadExistingSkills(): ExistingSkill[] {
    try {
      const registry = loadSkills({
        workspaceDir: this.workspaceDir,
        mcpToolsDir: this.mcpToolsDir,
        sharedSkillsDir: this.sharedSkillsDir,
      });
      const out: ExistingSkill[] = [];
      for (const skill of registry.skills.values()) {
        let origin: 'auto' | 'user' = 'user';
        // Only workspace skills can ever be origin:auto; trust the on-disk FM.
        if (skill.source === 'workspace') {
          const fm = extractFrontmatter(skill.content)?.frontmatter;
          origin = fm && fm['origin'] === 'auto' ? 'auto' : readSkillOrigin(skill.filePath);
        }
        out.push({ name: skill.name, description: skill.description, origin, filePath: skill.filePath });
      }
      return out;
    } catch {
      return [];
    }
  }
}
