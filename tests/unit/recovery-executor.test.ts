/**
 * Unit tests for src/agent/recovery-executor.ts — the Phase 3b orchestration
 * core. Every side effect is injected, so these drive the full decision path
 * (gate → triage → policy → budget → execute → guarded resend) without touching
 * a real session, CLI, or clock.
 */

import { runRecovery, toRecoveryOutcome, type RecoveryEffects, type RecoveryRequest } from '../../src/agent/recovery-executor'
import { initialBudget, DEFAULT_BUDGET, type BudgetState } from '../../src/agent/recovery-policy'

const T0 = 1_000_000_000_000

function makeBudget() {
  const store = new Map<string, BudgetState>()
  return {
    store,
    get: (turnKey: string) => store.get(turnKey) ?? initialBudget(turnKey),
    set: (s: BudgetState) => {
      store.set(s.turnKey, s)
    },
  }
}

function baseReq(over: Partial<RecoveryRequest> = {}): RecoveryRequest {
  return {
    incidentId: 'inc1',
    agentId: 'agent1',
    chatId: 'chat1',
    sessionId: 'sess1',
    stage: 'progress',
    failureClass: 'tui-overlay',
    turnKey: 'chat1:1000',
    ...over,
  }
}

/** A verdict-returning triage spawn (returns the given action as JSON). */
function spawnReturning(action: string, option?: number) {
  return async () => ({
    stdout: JSON.stringify({ state: 'error_overlay', action, ...(option !== undefined ? { option } : {}) }),
  })
}

describe('runRecovery — master gate', () => {
  test('U-RX-01: autoRecover off → skipped, no effect invoked', async () => {
    const calls: string[] = []
    const effects: RecoveryEffects = { escEsc: () => { calls.push('escEsc') } }
    const r = await runRecovery(baseReq(), {
      autoRecover: false,
      effects,
      now: () => T0,
      budget: makeBudget(),
    })
    expect(r.executed).toBe(false)
    expect(r.action).toBe('notify-only')
    expect(r.reason).toMatch(/disabled/)
    expect(calls).toEqual([])
  })
})

describe('runRecovery — deterministic (no triage)', () => {
  test('U-RX-02: progress with no triage → notify-only (never blindly presses keys), no budget spent', async () => {
    const budget = makeBudget()
    const calls: string[] = []
    const effects: RecoveryEffects = { esc: () => { calls.push('esc') } }
    const r = await runRecovery(baseReq({ stage: 'progress' }), {
      autoRecover: true,
      effects,
      now: () => T0,
      budget,
    })
    expect(r.action).toBe('notify-only')
    expect(r.executed).toBe(false)
    expect(calls).toEqual([])
    // notify-only consumes no budget.
    expect(budget.store.size).toBe(0)
  })

  test('U-RX-03: startup with no triage → restart-session default action executes', async () => {
    const calls: string[] = []
    const effects: RecoveryEffects = { restartSession: () => { calls.push('restart') } }
    const r = await runRecovery(baseReq({ stage: 'startup', failureClass: 'session-process' }), {
      autoRecover: true,
      effects,
      now: () => T0,
      budget: makeBudget(),
    })
    expect(r.action).toBe('restart-session')
    expect(r.executed).toBe(true)
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['restart'])
  })
})

describe('runRecovery — triage-driven execution', () => {
  test('U-RX-04: triage esc-esc on a progress overlay → escEsc effect runs', async () => {
    const calls: string[] = []
    const effects: RecoveryEffects = { escEsc: () => { calls.push('escEsc') } }
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects,
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('esc-esc'),
      gatherEvidence: async () => ({ screenText: 'overlay text' }),
    })
    expect(r.action).toBe('esc-esc')
    expect(r.executed).toBe(true)
    expect(calls).toEqual(['escEsc'])
  })

  test('U-RX-05: triage select-option passes the option index to the effect', async () => {
    let got: number | undefined
    const effects: RecoveryEffects = { selectOption: (n: number) => { got = n } }
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects,
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('select-option', 2),
    })
    expect(r.action).toBe('select-option')
    expect(r.option).toBe(2)
    expect(got).toBe(2)
  })

  test('U-RX-06: triage proposing an action the stage forbids is clamped to notify-only', async () => {
    const calls: string[] = []
    const effects: RecoveryEffects = { restartReceiver: () => { calls.push('rr') } }
    // restart-receiver is NOT in the progress whitelist → clamp.
    const r = await runRecovery(baseReq({ stage: 'progress' }), {
      autoRecover: true,
      effects,
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('restart-receiver'),
    })
    expect(r.action).toBe('notify-only')
    expect(r.executed).toBe(false)
    expect(calls).toEqual([])
  })

  test('U-RX-07: malformed triage reply → notify-only fallback (no guess)', async () => {
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects: { escEsc: () => {} },
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: async () => ({ stdout: 'not json at all' }),
    })
    expect(r.action).toBe('notify-only')
    expect(r.executed).toBe(false)
  })
})

describe('runRecovery — budget + cooldown', () => {
  test('U-RX-08: exhausted per-turn budget clamps a wanted action to notify-only', async () => {
    const budget = makeBudget()
    // Pre-fill the budget to the cap for this turn.
    budget.set({ turnKey: 'chat1:1000', attempts: DEFAULT_BUDGET.maxPerTurn, lastAt: T0 - 1 })
    const calls: string[] = []
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects: { escEsc: () => { calls.push('escEsc') } },
      now: () => T0,
      budget,
      triageSpawn: spawnReturning('esc-esc'),
    })
    expect(r.action).toBe('notify-only')
    expect(r.reason).toMatch(/budget|clamped/)
    expect(calls).toEqual([])
  })

  test('U-RX-09: a new turnKey resets the budget so recovery can act again', async () => {
    const budget = makeBudget()
    budget.set({ turnKey: 'chat1:1000', attempts: DEFAULT_BUDGET.maxPerTurn, lastAt: T0 - 1 })
    const calls: string[] = []
    const r = await runRecovery(baseReq({ turnKey: 'chat1:2000' }), {
      autoRecover: true,
      effects: { escEsc: () => { calls.push('escEsc') } },
      now: () => T0 + 60_000,
      budget,
      triageSpawn: spawnReturning('esc-esc'),
    })
    expect(r.executed).toBe(true)
    expect(calls).toEqual(['escEsc'])
  })
})

describe('runRecovery — execution failures', () => {
  test('U-RX-10: a missing effect for a whitelisted action → unsupported, not a guess', async () => {
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects: {}, // no escEsc provided
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('esc-esc'),
    })
    expect(r.executed).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/unsupported/)
  })

  test('U-RX-11: an effect that throws is reported ok:false, executed:true', async () => {
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects: { escEsc: () => { throw new Error('pty gone') } },
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('esc-esc'),
    })
    expect(r.executed).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/pty gone/)
  })
})

describe('runRecovery — C1 guarded resend', () => {
  test('U-RX-12: resends after a successful unblocking action when the guard allows', async () => {
    let resendCalled = 0
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects: { escEsc: () => {}, resendLast: () => { resendCalled++; return true } },
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('esc-esc'),
      resendAfterRecover: true,
    })
    expect(r.resent).toBe(true)
    expect(resendCalled).toBe(1)
  })

  test('U-RX-13: does not resend when the effect guard declines (turn already produced output)', async () => {
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects: { escEsc: () => {}, resendLast: () => false },
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('esc-esc'),
      resendAfterRecover: true,
    })
    expect(r.resent).toBe(false)
  })

  test('U-RX-14: does not resend after a delivery/transport action (would double-submit)', async () => {
    let resendCalled = 0
    const r = await runRecovery(baseReq({ stage: 'delivery', failureClass: 'delivery-file' }), {
      autoRecover: true,
      effects: { redeliverForward: () => {}, resendLast: () => { resendCalled++; return true } },
      now: () => T0,
      budget: makeBudget(),
      // deterministic default for delivery is redeliver-forward
      resendAfterRecover: true,
    })
    expect(r.action).toBe('redeliver-forward')
    expect(r.resent).toBe(false)
    expect(resendCalled).toBe(0)
  })

  test('U-RX-15: resend is skipped entirely when resendAfterRecover is off', async () => {
    let resendCalled = 0
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects: { escEsc: () => {}, resendLast: () => { resendCalled++; return true } },
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('esc-esc'),
      resendAfterRecover: false,
    })
    expect(r.resent).toBe(false)
    expect(resendCalled).toBe(0)
  })
})

describe('toRecoveryOutcome — persisted schema', () => {
  test('U-RX-16: encodes option and resend into the compact outcome', async () => {
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects: { selectOption: () => {}, resendLast: () => true },
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('select-option', 4),
      resendAfterRecover: true,
    })
    const outcome = toRecoveryOutcome(r)
    expect(outcome.action).toBe('select-option:4')
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toMatch(/resent/)
    expect(outcome.at).toBe(T0)
  })

  test('U-RX-17: a failed effect maps to ok:false in the outcome', async () => {
    const r = await runRecovery(baseReq(), {
      autoRecover: true,
      effects: { escEsc: () => { throw new Error('boom') } },
      now: () => T0,
      budget: makeBudget(),
      triageSpawn: spawnReturning('esc-esc'),
    })
    expect(toRecoveryOutcome(r).ok).toBe(false)
  })
})
