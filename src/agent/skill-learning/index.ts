/**
 * SkillLearningManager — the only export the runner/index wire to.
 *
 * Owns the closed loop: cheap per-turn telemetry capture (always-on), a
 * debounced session-idle review trigger, the print-only reviewer, the
 * provenance-guarded writer, and the daily curator. All turn-lifecycle methods
 * are best-effort and MUST never throw into the runner's hot path.
 */

import { createHash } from 'crypto';
import { loadSkills, skillFileRefs, skillsAtPaths, type SkillCatalogUsage, type SkillRegistry } from '../../skills/loader';
import { extractFrontmatter } from '../../skills/parser';
import { HistoryDB } from '../../history/db';
import { resolveSkillLearningConfig } from './config';
import { intentHash, startOfDayMs } from './telemetry';
import { shouldReview } from './trigger';
import { runReviewer, type ClaudeSpawnFn } from './reviewer';
import { applyProposal, readSkillOrigin, type ExistingSkill } from './writer';
import { startCurator, curateOnce, archiveDirUsable, type CuratorResult } from './curator';
import { computeRollup } from './metrics';
import { SkillNotifier, type SkillNotifierOpts, type ChannelTokens } from './notifier';
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
  active: boolean;
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
  /** Exact reviewed content only: never infer equivalence from an intent or topic. */
  reviewedTranscriptHash?: string;
}

/**
 * Per-skill usage for the skills menu (hide-until-used). With `cap`, a curator that cannot
 * archive (unusable skills/.archive) hands its `maxAutoSkills` cap to the menu.
 */
export function skillCatalogUsage(
  db: HistoryDB,
  now = Date.now(),
  cap?: { workspaceDir: string; cfg: ResolvedSkillLearningCfg },
): SkillCatalogUsage {
  const stats = new Map(db.listSkillStats().map((s) => [s.name, { timesLoaded: s.timesLoaded, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt }]));
  const menuCap = cap && cap.cfg.enabled && cap.cfg.maxAutoSkills > 0 && !archiveDirUsable(cap.workspaceDir);
  return menuCap ? { now, stats, maxListedAutoSkills: cap.cfg.maxAutoSkills } : { now, stats };
}

/** Read-only skill descriptions are trimmed for the reviewer prompt (plugins can add ~100 of them). */
const READ_ONLY_DESC_MAX = 120;

/**
 * Skills a managed (orchestration) turn loaded: the task's skill command, Skill-tool
 * calls, and SKILL.md files the turn read itself (`skillFiles`, see `skillFileRefs`).
 * Plugin skills outside the registry are not tracked in skill_stats.
 */
export function managedTurnSkills(invoked: string[] | undefined, used: string[] | undefined, registry: SkillRegistry, skillFiles: string[] = []): string[] {
  // A task's skill runs as a task-specific plugin skill named orchestration-task:<name>.
  const names = [...(invoked ?? []), ...(used ?? [])].map((name) => name.replace(/^orchestration-task:/, ''));
  return [...new Set([...names.filter((name) => registry.skills.has(name)), ...skillsAtPaths(skillFiles, registry)])];
}

/**
 * The registry skills a direct-turn tool call loaded: a Skill-tool call by name, or a
 * read of the skill's SKILL.md (Read or shell — how an agent follows a menu entry on its own).
 */
export function toolUseSkills(block: { name?: string; input?: Record<string, unknown> }, registry: SkillRegistry): string[] {
  const skill = block.input?.['skill'];
  if (block.name === 'Skill') return typeof skill === 'string' && registry.skills.has(skill) ? [skill] : [];
  return skillsAtPaths(skillFileRefs(block), registry);
}

/** A skill installed outside the workspace (e.g. a Claude Code plugin skill). */
export interface InstalledSkill {
  name: string;
  description: string;
  filePath?: string;
}

export interface SkillLearningManagerOpts {
  db: HistoryDB;
  agentId: string;
  workspaceDir: string;
  mcpToolsDir?: string;
  sharedSkillsDir?: string;
  /** Plugin skills the agent's CLI loads; the reviewer must not re-learn them as auto skills. */
  installedSkills?: () => Promise<InstalledSkill[]>;
  globalCfg?: SkillLearningConfig;
  agentCfg?: SkillLearningConfig;
  /** `gateway.timezone` — the shared default when neither `globalCfg`/`agentCfg` sets `pruneTimezone`. */
  gatewayTimezone?: string;
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void };
  /** Injectable reviewer spawn — tests script the model; production uses the real claude -p. */
  reviewSpawn?: ClaudeSpawnFn;
  /** Injectable clock (tests). */
  now?: () => number;
  /** @deprecated Credentials alone never authorize notification fan-out. Use sendNotification. */
  channels?: ChannelTokens;
  /** Exact origin-session delivery. No allowlist broadcast fallback. */
  sendNotification?: SkillNotifierOpts['send'];
  /** Injectable notifier (tests). Production uses the origin-session sender. */
  notifier?: SkillNotifier;
  /** Skills a finished turn loaded (after their counts were bumped). */
  onSkillsLoaded?: (names: string[]) => void;
}

/** What `skillLearningHostHooks` needs from the running agent (src/index.ts). */
export interface SkillLearningHost {
  /** The runner's live registry (its CLI skill list and hidden set). */
  registry: () => SkillRegistry;
  /** A fresh installed-skill scan, for when the runner has no CLI skill list. */
  discoverInstalled: () => Promise<InstalledSkill[]>;
  /** Recompose CLAUDE.md (the skills menu) from the current skill_stats. */
  refreshMenu: () => Promise<void>;
  logger?: SkillLearningManagerOpts['logger'];
}

/**
 * The manager's hooks into the running agent. The reviewer sees the CLI skill list the
 * runner already discovered. A hidden auto skill that gets used rejoins the orchestration
 * catalog at once, and the menu is recomposed for future spawns — once per skill that
 * flips to visible, never per turn.
 */
export function skillLearningHostHooks(host: SkillLearningHost): Required<Pick<SkillLearningManagerOpts, 'installedSkills' | 'onSkillsLoaded'>> {
  let refresh = Promise.resolve();
  return {
    installedSkills: async () => {
      const registry = host.registry();
      return registry.cliSkills && !registry.cliDiscoveryError ? registry.cliSkills : host.discoverInstalled();
    },
    onSkillsLoaded: (names) => {
      const hidden = host.registry().hiddenUntilUsed;
      if (!hidden || !names.filter((name) => hidden.delete(name)).length) return;
      refresh = refresh
        .then(host.refreshMenu)
        .catch((err) => host.logger?.warn?.(`skills menu refresh failed: ${(err as Error).message}`));
    },
  };
}

export class SkillLearningManager {
  cfg: ResolvedSkillLearningCfg;
  private readonly db: HistoryDB;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly mcpToolsDir?: string;
  private readonly sharedSkillsDir?: string;
  private readonly installedSkills?: () => Promise<InstalledSkill[]>;
  private readonly logger?: SkillLearningManagerOpts['logger'];
  private readonly reviewSpawn?: ClaudeSpawnFn;
  private readonly now: () => number;
  private readonly notifier: SkillNotifier;
  private readonly onSkillsLoaded?: (names: string[]) => void;

  private readonly accum = new Map<string, Accum>();
  private readonly reviewInFlight = new Set<string>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: SkillLearningManagerOpts) {
    this.db = opts.db;
    this.agentId = opts.agentId;
    this.workspaceDir = opts.workspaceDir;
    this.mcpToolsDir = opts.mcpToolsDir;
    this.sharedSkillsDir = opts.sharedSkillsDir;
    this.installedSkills = opts.installedSkills;
    this.logger = opts.logger;
    this.reviewSpawn = opts.reviewSpawn;
    this.now = opts.now ?? Date.now;
    this.onSkillsLoaded = opts.onSkillsLoaded;
    this.cfg = resolveSkillLearningConfig(opts.agentCfg, opts.globalCfg, opts.gatewayTimezone);
    this.notifier =
      opts.notifier ??
      new SkillNotifier({
        workspaceDir: this.workspaceDir,
        notify: this.cfg.notify,
        send: opts.sendNotification,
        logger: opts.logger,
      });
  }

  private cancelCurator?: () => void;
  private pendingConfig?: Pick<SkillLearningManagerOpts,'agentCfg'|'globalCfg'|'gatewayTimezone'>;
  reconfigure(opts: Pick<SkillLearningManagerOpts,'agentCfg'|'globalCfg'|'gatewayTimezone'>): void {
    if(this.reviewInFlight.size){this.pendingConfig=opts;return;}
    this.pendingConfig=undefined;
    this.cfg=resolveSkillLearningConfig(opts.agentCfg,opts.globalCfg,opts.gatewayTimezone);
    this.notifier.setEnabled(this.cfg.notify);
    this.startCurator();
  }
  stop(): void {
    this.cancelCurator?.();this.cancelCurator=undefined;
    for(const timer of this.idleTimers.values())clearTimeout(timer);
    this.idleTimers.clear();this.pendingConfig=undefined;
  }

  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  // ---- Turn lifecycle (called by the runner; all best-effort) ----------------

  /** A user turn begins. `invokedSkills` = skills detected in the incoming message. */
  onTurnStart(mapKey: string, sessionId: string, firstUserMessage: string, invokedSkills: string[] = [], startedAt?: number): void {
    try {
      const pending = this.idleTimers.get(mapKey);
      if (pending) clearTimeout(pending);
      this.idleTimers.delete(mapKey);
      let a = this.accum.get(mapKey);
      if (!a || a.sessionId !== sessionId) {
        a = this.freshAccum(sessionId);
      } else {
        a.turnIdx += 1;
      }
      a.startedAt = startedAt ?? this.now();
      a.active = true;
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

  /** The agent loaded a skill mid-turn (Skill tool, or a Read of its SKILL.md). */
  onSkillUsed(mapKey: string, name: string): void {
    this.accum.get(mapKey)?.skillsLoaded.add(name);
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
      a.active = false;
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
      try {
        if (skills.length) this.onSkillsLoaded?.(skills);
      } catch (err) {
        this.logger?.warn?.(`[skill-learning:${this.agentId}] onSkillsLoaded failed: ${(err as Error).message}`);
      }
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
    if (!a || a.sessionId !== sessionId || a.active) return;

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
    // Consume only this batch before awaiting: a newer turn may accumulate while
    // the reviewer runs and must not have its evidence erased in finally.
    a.sigMaxToolCalls = 0;
    a.sigRecovery = false;
    a.sigCorrection = false;
    try {
      const transcript = this.gatherTranscript(sessionId);
      if (!transcript.trim()) return;
      const transcriptHash = createHash('sha256').update(transcript).digest('hex');
      if (a.reviewedTranscriptHash === transcriptHash && !signals.recoveryFired && !signals.userCorrection) return;
      const existing = await this.loadExistingSkills();

      const { proposal, tokensSpent, reviewed } = await runReviewer(
        {
          transcript: transcript.slice(-20_000),
          // Only auto skills are editable; the rest are listed read-only so the reviewer neither edits nor re-learns them.
          existingSkills: existing.filter((s) => s.origin === 'auto').map((s) => ({ name: s.name, description: s.description })),
          readOnlySkills: existing.filter((s) => s.origin !== 'auto').map((s) => ({ name: s.name, description: s.description.slice(0, READ_ONLY_DESC_MAX) })),
        },
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

      // Malformed/rejected write proposals must not suppress a later retry.
      if (reviewed && (proposal.action === 'none' || outcome.written)) a.reviewedTranscriptHash = transcriptHash;

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

      // Tell the operator a skill changed — diary (always) + throttled channel
      // push. Only for a genuine live write (not the propose review queue).
      if (outcome.written && !outcome.queued && outcome.name &&
          (outcome.action === 'create' || outcome.action === 'edit')) {
        this.notifier.onSkillWritten({
          name: outcome.name,
          action: outcome.action,
          sessionId,
          now: this.now(),
        });
      }

      this.logger?.info(
        `[skill-learning:${this.agentId}] review (${decision.reason}) → ${
          outcome.written ? `${outcome.action}:${outcome.name}${outcome.queued ? ' (queued)' : ''}` : `no-write (${outcome.reason ?? proposal.action})`
        } tokens=${tokensSpent}`,
      );
    } catch (err) {
      this.logger?.warn?.(`[skill-learning:${this.agentId}] review failed: ${(err as Error).message}`);
    } finally {
      this.reviewInFlight.delete(sessionId);
      if(this.pendingConfig&&!this.reviewInFlight.size)this.reconfigure(this.pendingConfig);
      // The newer batch's timer may have fired while this review was in flight.
      if (!a.active && (a.sigMaxToolCalls > 0 || a.sigRecovery || a.sigCorrection) &&
          this.accum.get(mapKey) === a && !this.idleTimers.has(mapKey)) {
        this.scheduleIdleReview(mapKey, sessionId);
      }
    }
  }

  // ---- Curator ---------------------------------------------------------------

  /** Start the daily curator scheduler. Returns a canceller. */
  startCurator(): () => void {
    this.cancelCurator?.();
    this.cancelCurator = startCurator(
      () => ({
        db: this.db,
        workspaceDir: this.workspaceDir,
        agentId: this.agentId,
        cfg: this.cfg,
        logger: this.logger,
      }),
      this.cfg,
    );
    return this.cancelCurator;
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
      active: false,
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
      .join('\n');
  }

  /**
   * All loaded skills with resolved provenance + path (for dedup + guards). Registry
   * skills come first and win a name clash: a same-named installed copy (e.g. a shared
   * skill synced to ~/.claude/skills) must neither shadow an auto skill nor be listed twice.
   */
  private async loadExistingSkills(): Promise<ExistingSkill[]> {
    const out: ExistingSkill[] = [];
    try {
      const registry = loadSkills({
        workspaceDir: this.workspaceDir,
        mcpToolsDir: this.mcpToolsDir,
        sharedSkillsDir: this.sharedSkillsDir,
      });
      for (const skill of registry.skills.values()) {
        let origin: 'auto' | 'user' = 'user';
        // Only workspace skills can ever be origin:auto; trust the on-disk FM.
        if (skill.source === 'workspace') {
          const fm = extractFrontmatter(skill.content)?.frontmatter;
          origin = fm && fm['origin'] === 'auto' ? 'auto' : readSkillOrigin(skill.filePath);
        }
        out.push({ name: skill.name, description: skill.description, origin, filePath: skill.filePath });
      }
    } catch {
      /* installed skills below still guard against re-learning */
    }
    try {
      const seen = new Set(out.map((s) => s.name));
      for (const s of (await this.installedSkills?.()) ?? []) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        out.push({ name: s.name, description: s.description, origin: 'user', filePath: s.filePath ?? '' });
      }
    } catch (err) {
      this.logger?.warn?.(`[skill-learning:${this.agentId}] installed-skill discovery failed: ${(err as Error).message}`);
    }
    return out;
  }
}
