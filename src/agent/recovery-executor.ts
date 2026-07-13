/**
 * Recovery executor (Epic #195, Phase 3b).
 *
 * This is the orchestration core that turns a watchdog-detected stall into an
 * actual recovery attempt. It runs in the AGENT RUNNER process — the only place
 * that owns the live control surfaces (session stdin, restart, safe-mode) — but
 * it is written as a PURE function with every side effect injected, so tests
 * drive the full decision path without touching a real session or CLI.
 *
 * Trust + safety model (why the pieces are split the way they are):
 *   - The classify step (triage.ts) treats screen text as UNTRUSTED data and
 *     validates the model reply against a CLOSED schema.
 *   - The decide step (recovery-policy.ts) clamps the proposed action to a
 *     per-stage whitelist and enforces a per-turn budget + cooldown.
 *   - This execute step maps the *already-validated, already-whitelisted* action
 *     to an injected effect. A missing effect is a no-op failure, never a guess.
 *
 * Everything is gated by `autoRecover`: when it is off the executor does nothing
 * but report that it was skipped, so the whole feature ships dark. Safe-mode
 * auto-fallback is deliberately NOT routed through here — it is a reversible
 * backend flip the runner applies on hard PTY failure regardless of this flag.
 */

import { runTriage, type TriageSpawn, type TriageBundle, type TriageVerdict } from './triage'
import {
  selectRecoveryAction,
  checkBudget,
  DEFAULT_BUDGET,
  type RecoveryAction,
  type BudgetState,
  type BudgetConfig,
} from './recovery-policy'
import type { RecoveryOutcome } from './incident'

/**
 * The concrete side effects the executor may invoke. Every method is optional:
 * an action whose effect is not provided is reported as unsupported rather than
 * silently succeeding. Keystroke effects (esc/enter/…) are delivered to the PTY
 * wrapper via the control channel; the restart/backend effects act on the
 * session/receiver. All may be async.
 */
export interface RecoveryEffects {
  esc?(): Promise<void> | void
  escEsc?(): Promise<void> | void
  enter?(): Promise<void> | void
  up?(): Promise<void> | void
  down?(): Promise<void> | void
  selectOption?(option: number): Promise<void> | void
  bridgeMenu?(): Promise<void> | void
  redeliverForward?(): Promise<void> | void
  restartSession?(): Promise<void> | void
  restartReceiver?(): Promise<void> | void
  fallbackHeadless?(): Promise<void> | void
  /**
   * C1: re-inject the last user message so the user does not have to retype it
   * after a recovery. The implementation MUST guard against duplicates — resend
   * only when the stalled turn produced no output — and returns whether it
   * actually resent. The executor never forces a resend; it only asks.
   */
  resendLast?(): Promise<boolean> | boolean
}

/** Which action each stage-whitelisted verb maps to on the effects object. */
type EffectKey = keyof RecoveryEffects

const ACTION_EFFECT: Record<Exclude<RecoveryAction, 'notify-only' | 'none'>, EffectKey> = {
  esc: 'esc',
  'esc-esc': 'escEsc',
  enter: 'enter',
  'select-option': 'selectOption',
  'bridge-menu': 'bridgeMenu',
  'redeliver-forward': 'redeliverForward',
  'restart-session': 'restartSession',
  'restart-receiver': 'restartReceiver',
  'fallback-headless': 'fallbackHeadless',
}

/**
 * Actions after which a guarded resend of the last user message makes sense: the
 * ones that unblock a claude turn which was still waiting for input. Delivery/
 * transport actions (redeliver-forward, restart-receiver) already move the
 * pending output themselves, so a resend there would double-submit.
 */
const RESEND_ELIGIBLE: ReadonlySet<RecoveryAction> = new Set<RecoveryAction>([
  'esc',
  'esc-esc',
  'enter',
  'select-option',
  'bridge-menu',
  'restart-session',
  'fallback-headless',
])

/** What the watchdog hands the executor for one stalled turn. */
export interface RecoveryRequest {
  /** Incident id the outcome is recorded against (opaque to the executor). */
  incidentId: string
  agentId: string
  chatId: string
  sessionId: string
  /** Pipeline stage that stalled (drives the action whitelist). */
  stage: string
  failureClass: string | null
  /** Identifies the turn for budget accounting (resets budget when it changes). */
  turnKey: string
}

export interface RecoveryDeps {
  /** Master gate. When false the executor does nothing but report `skipped`. */
  autoRecover: boolean
  effects: RecoveryEffects
  now: () => number
  /** Per-turn budget accounting, injected so it can persist across calls. */
  budget: {
    get(turnKey: string): BudgetState
    set(state: BudgetState): void
    config?: BudgetConfig
  }
  /**
   * Optional local `claude -p` triage. When omitted, the executor falls back to
   * the deterministic per-stage default action (still whitelist-checked).
   */
  triageSpawn?: TriageSpawn
  /**
   * Collect scrubbed evidence for triage (screen snapshot / status text). The
   * caller is responsible for scrubbing; the executor passes it through as data.
   */
  gatherEvidence?: () => Promise<{ screenText?: string; statusText?: string } | null>
  /** C1 gate: attempt a guarded resend after a successful unblocking action. */
  resendAfterRecover?: boolean
  /** Optional structured logger. */
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

/** Full result of one recovery attempt (richer than the persisted schema). */
export interface RecoveryResult {
  incidentId: string
  stage: string
  /** The action actually taken (may be clamped to notify-only). */
  action: RecoveryAction
  option?: number
  /** True if an effect was invoked (notify-only / skip / clamp are false). */
  executed: boolean
  /** True if the invoked effect completed without throwing. */
  ok: boolean
  reason: string
  /** True if the last user message was resent (C1). */
  resent: boolean
  at: number
}

/**
 * Run one recovery attempt. ALWAYS resolves (never throws): any failure degrades
 * to a safe, recorded outcome. The returned RecoveryResult is what the caller
 * persists to the incident bundle and may surface to the user.
 */
export async function runRecovery(
  req: RecoveryRequest,
  deps: RecoveryDeps,
): Promise<RecoveryResult> {
  const at = deps.now()
  const base = { incidentId: req.incidentId, stage: req.stage, at }

  // Master gate: feature ships dark. Detection/incident/notify already ran in
  // the caller; here we simply do nothing and say so.
  if (!deps.autoRecover) {
    return { ...base, action: 'notify-only', executed: false, ok: true, reason: 'skipped: autoRecover disabled', resent: false }
  }

  // 1) Evidence → 2) triage (classify) → 3) policy (decide). None of these act.
  let verdict: TriageVerdict | null = null
  if (deps.triageSpawn) {
    let bundle: TriageBundle = { stage: req.stage, failureClass: req.failureClass }
    try {
      const ev = deps.gatherEvidence ? await deps.gatherEvidence() : null
      if (ev) bundle = { ...bundle, screenText: ev.screenText, statusText: ev.statusText }
    } catch {
      // Evidence gathering is best-effort; triage can still classify from stage.
    }
    verdict = await runTriage({ spawn: deps.triageSpawn, bundle })
  }

  const plan = selectRecoveryAction({ stage: req.stage, failureClass: req.failureClass, verdict })

  // notify-only never consumes budget and invokes no effect — the caller owns
  // the user-facing notice, so the executor just records the decision.
  if (plan.action === 'notify-only' || plan.action === 'none') {
    return { ...base, action: 'notify-only', executed: false, ok: true, reason: plan.reason, resent: false }
  }

  // 4) Budget + cooldown. An actionable plan blocked by budget clamps to
  // notify-only (recorded with the action it wanted) and consumes nothing more.
  const cfg = deps.budget.config ?? DEFAULT_BUDGET
  const verdictBudget = checkBudget(deps.budget.get(req.turnKey), req.turnKey, at, cfg)
  if (!verdictBudget.allowed) {
    deps.budget.set(verdictBudget.next)
    return {
      ...base,
      action: 'notify-only',
      executed: false,
      ok: true,
      reason: `clamped: ${verdictBudget.reason} (wanted ${plan.action})`,
      resent: false,
    }
  }
  deps.budget.set(verdictBudget.next)

  // 5) Execute the whitelisted action via its injected effect.
  const effectKey = ACTION_EFFECT[plan.action as Exclude<RecoveryAction, 'notify-only' | 'none'>]
  const effect = effectKey ? (deps.effects[effectKey] as ((arg?: number) => Promise<void> | void) | undefined) : undefined
  const result: RecoveryResult = {
    ...base,
    action: plan.action,
    option: plan.option,
    executed: false,
    ok: false,
    reason: plan.reason,
    resent: false,
  }

  if (!effect) {
    result.reason = `unsupported: no effect for ${plan.action}`
    deps.log?.('recovery: unsupported action', { action: plan.action, stage: req.stage })
    return result
  }

  try {
    if (plan.action === 'select-option' && typeof plan.option === 'number') {
      await effect(plan.option)
    } else {
      await effect()
    }
    result.executed = true
    result.ok = true
    deps.log?.('recovery: executed', { action: plan.action, stage: req.stage, incidentId: req.incidentId })
  } catch (err) {
    result.executed = true
    result.ok = false
    result.reason = `effect threw: ${(err as Error).message}`
    deps.log?.('recovery: effect failed', { action: plan.action, error: (err as Error).message })
    return result
  }

  // 6) C1 guarded resend. Only after a successful unblocking action, and only if
  // the effect implementation confirms the turn produced no output.
  if (deps.resendAfterRecover && RESEND_ELIGIBLE.has(plan.action) && deps.effects.resendLast) {
    try {
      result.resent = Boolean(await deps.effects.resendLast())
    } catch {
      result.resent = false
    }
  }

  return result
}

/** Map a full result to the compact schema persisted in the incident bundle. */
export function toRecoveryOutcome(r: RecoveryResult): RecoveryOutcome {
  const bits = [r.reason]
  if (r.resent) bits.push('resent')
  return {
    action: r.option !== undefined ? `${r.action}:${r.option}` : r.action,
    at: r.at,
    ok: r.ok && r.executed,
    detail: bits.join('; '),
  }
}
