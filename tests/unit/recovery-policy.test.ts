/**
 * Unit tests for src/agent/recovery-policy.ts — whitelist enforcement, budget +
 * cooldown, and safe-mode escalation decisions. All pure.
 */

import {
  selectRecoveryAction,
  defaultActionForStage,
  checkBudget,
  initialBudget,
  shouldEnterSafeMode,
  shouldExitSafeMode,
  DEFAULT_BUDGET,
  STAGE_ALLOWED_ACTIONS,
} from '../../src/agent/recovery-policy'
import type { TriageVerdict } from '../../src/agent/triage'

const T0 = 1_000_000_000_000

describe('selectRecoveryAction — whitelist enforcement', () => {
  test('U-RP-01: honours a triage action that the stage permits', () => {
    const verdict: TriageVerdict = { state: 'error_overlay', action: 'esc-esc' }
    const plan = selectRecoveryAction({ stage: 'progress', failureClass: 'tui-overlay', verdict })
    expect(plan.action).toBe('esc-esc')
  })

  test('U-RP-02: clamps a triage action the stage does NOT permit → notify-only', () => {
    // restart-receiver is not permitted at the progress stage.
    const verdict: TriageVerdict = { state: 'idle', action: 'restart-receiver' }
    const plan = selectRecoveryAction({ stage: 'progress', failureClass: 'tui-overlay', verdict })
    expect(plan.action).toBe('notify-only')
    expect(plan.reason).toContain('clamped')
  })

  test('U-RP-03: select-option carries the option index through', () => {
    const verdict: TriageVerdict = { state: 'menu', action: 'select-option', option: 3 }
    const plan = selectRecoveryAction({ stage: 'progress', failureClass: 'tui-overlay', verdict })
    expect(plan).toMatchObject({ action: 'select-option', option: 3 })
  })

  test('U-RP-04: select-option without an index is not actionable → notify-only', () => {
    // A verdict that somehow reaches selection without an option (defensive).
    const verdict = { state: 'menu', action: 'select-option' } as TriageVerdict
    const plan = selectRecoveryAction({ stage: 'progress', failureClass: 'tui-overlay', verdict })
    expect(plan.action).toBe('notify-only')
  })

  test('U-RP-05: triage "none"/"notify-only" → notify-only', () => {
    expect(
      selectRecoveryAction({ stage: 'progress', failureClass: null, verdict: { state: 'busy', action: 'none' } }).action,
    ).toBe('notify-only')
    expect(
      selectRecoveryAction({ stage: 'progress', failureClass: null, verdict: { state: 'unknown', action: 'notify-only' } }).action,
    ).toBe('notify-only')
  })

  test('U-RP-06: no verdict → conservative per-stage default (still whitelist-checked)', () => {
    expect(selectRecoveryAction({ stage: 'dispatch', failureClass: 'receiver-out' }).action).toBe(
      'redeliver-forward',
    )
    expect(selectRecoveryAction({ stage: 'startup', failureClass: 'session-process' }).action).toBe(
      'restart-session',
    )
    // A progress wedge without triage must NOT blindly press keys.
    expect(selectRecoveryAction({ stage: 'progress', failureClass: 'tui-overlay' }).action).toBe(
      'notify-only',
    )
  })

  test('U-RP-07: unknown stage → notify-only', () => {
    expect(selectRecoveryAction({ stage: 'bogus', failureClass: null }).action).toBe('notify-only')
  })

  test('U-RP-08: every default action is within its stage whitelist (or notify-only)', () => {
    for (const stage of Object.keys(STAGE_ALLOWED_ACTIONS)) {
      const def = defaultActionForStage(stage)
      const allowed = STAGE_ALLOWED_ACTIONS[stage]
      expect(def === 'notify-only' || allowed.includes(def)).toBe(true)
    }
  })
})

describe('checkBudget — per-turn cap + cooldown', () => {
  test('U-RP-09: first intervention allowed; increments attempts', () => {
    const s = initialBudget('turn-1')
    const v = checkBudget(s, 'turn-1', T0)
    expect(v.allowed).toBe(true)
    expect(v.next.attempts).toBe(1)
  })

  test('U-RP-10: cooldown blocks a too-soon second intervention', () => {
    let s = initialBudget('turn-1')
    s = checkBudget(s, 'turn-1', T0).next
    const v = checkBudget(s, 'turn-1', T0 + 1000) // within cooldown
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain('cooldown')
  })

  test('U-RP-11: after cooldown, a second intervention is allowed', () => {
    let s = initialBudget('turn-1')
    s = checkBudget(s, 'turn-1', T0).next
    const v = checkBudget(s, 'turn-1', T0 + DEFAULT_BUDGET.cooldownMs)
    expect(v.allowed).toBe(true)
    expect(v.next.attempts).toBe(2)
  })

  test('U-RP-12: per-turn cap exhausts the budget', () => {
    let s = initialBudget('turn-1')
    let t = T0
    for (let i = 0; i < DEFAULT_BUDGET.maxPerTurn; i++) {
      const v = checkBudget(s, 'turn-1', t)
      expect(v.allowed).toBe(true)
      s = v.next
      t += DEFAULT_BUDGET.cooldownMs
    }
    const blocked = checkBudget(s, 'turn-1', t)
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toContain('exhausted')
  })

  test('U-RP-13: a new turn resets the budget', () => {
    let s = initialBudget('turn-1')
    let t = T0
    for (let i = 0; i < DEFAULT_BUDGET.maxPerTurn; i++) {
      s = checkBudget(s, 'turn-1', t).next
      t += DEFAULT_BUDGET.cooldownMs
    }
    // Same state, but a different turn key → fresh budget, allowed again.
    const v = checkBudget(s, 'turn-2', t)
    expect(v.allowed).toBe(true)
    expect(v.next.turnKey).toBe('turn-2')
    expect(v.next.attempts).toBe(1)
  })
})

describe('safe-mode escalation decisions', () => {
  test('U-RP-14: enter only at/after the threshold', () => {
    expect(shouldEnterSafeMode(1)).toBe(false)
    expect(shouldEnterSafeMode(2)).toBe(false)
    expect(shouldEnterSafeMode(3)).toBe(true)
    expect(shouldEnterSafeMode(2, 2)).toBe(true)
  })

  test('U-RP-15: exit only on manual restore or a healthy PTY turn', () => {
    expect(shouldExitSafeMode({})).toBe(false)
    expect(shouldExitSafeMode({ manualRestore: true })).toBe(true)
    expect(shouldExitSafeMode({ healthyPtyTurnObserved: true })).toBe(true)
  })
})
