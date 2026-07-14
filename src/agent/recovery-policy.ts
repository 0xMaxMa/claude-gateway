/**
 * Recovery policy (Epic #195, Phase 3).
 *
 * Turns a (schema-validated) triage verdict into an actual recovery action —
 * but only after enforcing three independent guards, so a compromised or
 * mistaken triage step can never drive an unsafe intervention:
 *
 *   1. Per-stage whitelist. Each pipeline stage permits only a small set of
 *      actions (a `dispatch` stall may redeliver or restart the receiver; a
 *      `progress` PTY wedge may press esc or restart the session). An action
 *      the stage does not permit is clamped to `notify-only`, regardless of
 *      what triage proposed.
 *   2. Budget + cooldown. Interventions are capped per turn and spaced by a
 *      cooldown, so a flapping stall cannot trigger an unbounded action loop.
 *   3. Safe-mode escalation. Repeated PTY-stage failures recommend flipping the
 *      agent to the headless backend instead of retrying the same wedge.
 *
 * All functions are pure — no IO, no clock reads (the caller passes `now`).
 * The executor that actually presses keys / restarts / flips backend lives in
 * the runner; this module decides, it never acts.
 */

import type { TriageVerdict, TriageAction } from './triage'

/** A recovery action the executor understands (same closed vocabulary as triage). */
export type RecoveryAction = TriageAction

/** A selected recovery, ready for the executor. */
export interface RecoveryPlan {
  action: RecoveryAction
  /** Present only for `select-option`. */
  option?: number
  /** Why this action (audit/logging). */
  reason: string
}

/** The safe no-op plan. */
export const NOTIFY_ONLY_PLAN: RecoveryPlan = {
  action: 'notify-only',
  reason: 'no permitted action',
}

/**
 * Actions permitted per stalled stage. Deliberately conservative: destructive
 * or cross-cutting actions (restart-receiver, fallback-headless) are only
 * allowed where they make sense. `notify-only` is always implicitly allowed.
 */
export const STAGE_ALLOWED_ACTIONS: Record<string, ReadonlyArray<RecoveryAction>> = {
  // Receiver/channel ingress — nothing to press; escalate the transport.
  inbound: ['restart-receiver', 'notify-only'],
  // Runner failed to inject — restart the session.
  inject: ['restart-session', 'notify-only'],
  // Session/CLI startup wedged — restart, or fall back to headless.
  startup: ['restart-session', 'fallback-headless', 'notify-only'],
  // Claude producing no output — a TUI overlay is the usual cause: dismiss it,
  // pick a menu option, or restart; repeated failures escalate to headless.
  progress: [
    'esc',
    'esc-esc',
    'enter',
    'select-option',
    'bridge-menu',
    'restart-session',
    'fallback-headless',
    'notify-only',
  ],
  // Turn ended, no artifact — redeliver or restart the session.
  delivery: ['redeliver-forward', 'restart-session', 'notify-only'],
  // Artifact written, not sent — redeliver, or restart the receiver.
  dispatch: ['redeliver-forward', 'restart-receiver', 'notify-only'],
}

/**
 * Decide the recovery plan for a stalled stage given an optional triage verdict.
 * If a verdict is supplied, its action is honoured ONLY if the stage permits it;
 * otherwise the plan clamps to notify-only. With no verdict, a conservative
 * default action for the stage is used (still whitelist-checked).
 */
export function selectRecoveryAction(input: {
  stage: string
  failureClass: string | null
  verdict?: TriageVerdict | null
}): RecoveryPlan {
  const allowed = STAGE_ALLOWED_ACTIONS[input.stage] ?? ['notify-only']

  if (input.verdict) {
    const a = input.verdict.action
    if (a === 'notify-only' || a === 'none') {
      return { action: 'notify-only', reason: `triage:${a}` }
    }
    if (allowed.includes(a)) {
      const plan: RecoveryPlan = { action: a, reason: `triage:${input.verdict.state}` }
      if (a === 'select-option' && typeof input.verdict.option === 'number') {
        plan.option = input.verdict.option
      }
      // select-option with no option index is not actionable → clamp.
      if (a === 'select-option' && plan.option === undefined) {
        return { action: 'notify-only', reason: 'select-option missing option index' }
      }
      return plan
    }
    // Triage proposed an action this stage does not permit → refuse it.
    return { action: 'notify-only', reason: `clamped: ${a} not allowed at ${input.stage}` }
  }

  // No triage available → deterministic default per stage.
  const fallback = defaultActionForStage(input.stage)
  if (allowed.includes(fallback)) {
    return { action: fallback, reason: `default:${input.stage}` }
  }
  return NOTIFY_ONLY_PLAN
}

/** Conservative default action when no triage verdict is available. */
export function defaultActionForStage(stage: string): RecoveryAction {
  switch (stage) {
    case 'dispatch':
      return 'redeliver-forward'
    case 'delivery':
      return 'redeliver-forward'
    case 'inject':
    case 'startup':
      return 'restart-session'
    case 'inbound':
      return 'restart-receiver'
    case 'progress':
      // A progress wedge is ambiguous without triage; do not blindly press keys.
      return 'notify-only'
    default:
      return 'notify-only'
  }
}

// ─── Budget + cooldown ──────────────────────────────────────────────────────

export const DEFAULT_MAX_INTERVENTIONS_PER_TURN = 3
export const DEFAULT_COOLDOWN_MS = 30_000

export interface BudgetConfig {
  maxPerTurn: number
  cooldownMs: number
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxPerTurn: DEFAULT_MAX_INTERVENTIONS_PER_TURN,
  cooldownMs: DEFAULT_COOLDOWN_MS,
}

/**
 * Immutable budget state for one turn. A turn is identified by `turnKey`
 * (e.g. chatId + signal timestamp); when the key changes the budget resets.
 */
export interface BudgetState {
  turnKey: string
  attempts: number
  lastAt: number
}

export function initialBudget(turnKey: string): BudgetState {
  return { turnKey, attempts: 0, lastAt: 0 }
}

export interface BudgetVerdict {
  allowed: boolean
  reason: string
  /** The state to persist for the next check (reset if the turn changed). */
  next: BudgetState
}

/**
 * Decide whether an intervention is allowed now, and return the state to keep.
 * Resets the counter when the turn changes; enforces the per-turn cap and the
 * cooldown between attempts. Pure — the caller supplies `now`.
 */
export function checkBudget(
  state: BudgetState,
  turnKey: string,
  now: number,
  cfg: BudgetConfig = DEFAULT_BUDGET,
): BudgetVerdict {
  // New turn → fresh budget.
  const base: BudgetState =
    state.turnKey === turnKey ? state : initialBudget(turnKey)

  if (base.attempts >= cfg.maxPerTurn) {
    return { allowed: false, reason: 'budget exhausted for this turn', next: base }
  }
  if (base.attempts > 0 && now - base.lastAt < cfg.cooldownMs) {
    return { allowed: false, reason: 'cooldown active', next: base }
  }
  return {
    allowed: true,
    reason: 'ok',
    next: { turnKey, attempts: base.attempts + 1, lastAt: now },
  }
}

// ─── Safe-mode escalation ─────────────────────────────────────────────────

export const DEFAULT_SAFE_MODE_THRESHOLD = 3

/**
 * Whether repeated PTY-stage failures should escalate to safe mode (flip the
 * agent to the headless backend). Pure.
 */
export function shouldEnterSafeMode(
  consecutivePtyFailures: number,
  threshold: number = DEFAULT_SAFE_MODE_THRESHOLD,
): boolean {
  return consecutivePtyFailures >= threshold
}

/**
 * Whether safe mode should be lifted. Safe mode is a reactive fallback; it is
 * cleared explicitly — on a successful PTY turn after a fix, or on user command.
 */
export function shouldExitSafeMode(input: {
  manualRestore?: boolean
  healthyPtyTurnObserved?: boolean
}): boolean {
  return Boolean(input.manualRestore || input.healthyPtyTurnObserved)
}
