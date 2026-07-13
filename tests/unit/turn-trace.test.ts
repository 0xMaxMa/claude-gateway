/**
 * Unit tests for src/agent/turn-trace.ts — the pure turn-trace watchdog core.
 * No filesystem, no clock: every case feeds a plain TurnObservation and asserts
 * the classified stage / stall / failure-class. The three delivery bugs fixed
 * in #193/#194 are exercised as explicit observations (see U-TT-10/11/08).
 */

import {
  classifyTurn,
  formatTurnIncident,
  TURN_STAGE_BUDGETS_MS,
  type TurnObservation,
  type TurnIncident,
} from '../../src/agent/turn-trace'

const T0 = 1_000_000_000_000 // fixed base epoch — no Date.now() in these tests

/** A neutral, idle observation; override fields per case. */
function baseObs(overrides: Partial<TurnObservation> = {}): TurnObservation {
  return {
    now: T0,
    signalAt: null,
    statusLabel: null,
    heartbeatAt: null,
    processingAt: null,
    forwardAt: null,
    menuAt: null,
    repliedPresent: false,
    errorPresent: false,
    ...overrides,
  }
}

describe('classifyTurn', () => {
  test('U-TT-01: idle when no signal and no delivery artifact', () => {
    const t = classifyTurn(baseObs())
    expect(t.stage).toBe('idle')
    expect(t.stalled).toBe(false)
    expect(t.failureClass).toBeNull()
  })

  test('U-TT-02: inject stage below budget is not stalled', () => {
    // Signal written, nothing downstream reacted yet, within budget.
    const t = classifyTurn(baseObs({ signalAt: T0 - 10_000, now: T0 }))
    expect(t.stage).toBe('inject')
    expect(t.stalled).toBe(false)
    expect(t.failureClass).toBe('runner')
  })

  test('U-TT-03: inject stage past budget stalls → runner', () => {
    const t = classifyTurn(baseObs({ signalAt: T0 - 31_000, now: T0 }))
    expect(t.stage).toBe('inject')
    expect(t.stalled).toBe(true)
    expect(t.failureClass).toBe('runner')
  })

  test('U-TT-04: startup stage (status set, no heartbeat) below budget is not stalled', () => {
    const t = classifyTurn(baseObs({
      signalAt: T0 - 60_000,
      statusLabel: 'queued',
      now: T0,
    }))
    expect(t.stage).toBe('startup')
    expect(t.stalled).toBe(false)
    expect(t.failureClass).toBe('session-process')
  })

  test('U-TT-05: startup stage past budget stalls → session-process', () => {
    const t = classifyTurn(baseObs({
      signalAt: T0 - 121_000,
      statusLabel: 'thinking',
      now: T0,
    }))
    expect(t.stage).toBe('startup')
    expect(t.stalled).toBe(true)
    expect(t.failureClass).toBe('session-process')
  })

  test('U-TT-06: progress stage with fresh heartbeat is not stalled', () => {
    const t = classifyTurn(baseObs({
      signalAt: T0 - 200_000,
      statusLabel: 'tool',
      heartbeatAt: T0 - 5_000,
      now: T0,
    }))
    expect(t.stage).toBe('progress')
    expect(t.stalled).toBe(false)
    expect(t.failureClass).toBe('claude-cli')
  })

  test('U-TT-07: progress stall (headless) → claude-cli', () => {
    const t = classifyTurn(baseObs({
      signalAt: T0 - 400_000,
      statusLabel: 'tool',
      heartbeatAt: T0 - 301_000,
      backend: 'headless',
      now: T0,
    }))
    expect(t.stage).toBe('progress')
    expect(t.stalled).toBe(true)
    expect(t.failureClass).toBe('claude-cli')
  })

  test('U-TT-08: progress stall (PTY) → tui-overlay (#193 TUI wedge mid-turn)', () => {
    const t = classifyTurn(baseObs({
      signalAt: T0 - 400_000,
      statusLabel: 'tool',
      heartbeatAt: T0 - 301_000,
      backend: 'pty',
      now: T0,
    }))
    expect(t.stage).toBe('progress')
    expect(t.stalled).toBe(true)
    expect(t.failureClass).toBe('tui-overlay')
  })

  test('U-TT-09: progress liveness uses the freshest of heartbeat/processing', () => {
    // Heartbeat is stale, but a fresh .processing sentinel proves progress.
    const t = classifyTurn(baseObs({
      signalAt: T0 - 400_000,
      statusLabel: 'tool',
      heartbeatAt: T0 - 301_000,
      processingAt: T0 - 2_000,
      now: T0,
    }))
    expect(t.stage).toBe('progress')
    expect(t.stalled).toBe(false)
  })

  test('U-TT-10: orphaned .forward past budget → dispatch / receiver-out (#193 bug 3)', () => {
    // No signal (autonomous wake, no typing loop) but a .forward sitting unsent.
    const t = classifyTurn(baseObs({ forwardAt: T0 - 20_000, now: T0 }))
    expect(t.stage).toBe('dispatch')
    expect(t.stalled).toBe(true)
    expect(t.failureClass).toBe('receiver-out')
  })

  test('U-TT-11: lingering .menu past budget → dispatch / receiver-out (#193 bug 2)', () => {
    const t = classifyTurn(baseObs({ menuAt: T0 - 20_000, now: T0 }))
    expect(t.stage).toBe('dispatch')
    expect(t.stalled).toBe(true)
    expect(t.failureClass).toBe('receiver-out')
  })

  test('U-TT-12: freshly-written delivery artifact is not yet stalled', () => {
    const t = classifyTurn(baseObs({ forwardAt: T0 - 3_000, now: T0 }))
    expect(t.stage).toBe('dispatch')
    expect(t.stalled).toBe(false)
  })

  test('U-TT-13: a delivery artifact takes priority over an in-flight signal', () => {
    // Both a live signal and a forward present → the artifact (checkpoint 7) wins.
    const t = classifyTurn(baseObs({
      signalAt: T0 - 5_000,
      heartbeatAt: T0 - 1_000,
      forwardAt: T0 - 20_000,
      now: T0,
    }))
    expect(t.stage).toBe('dispatch')
    expect(t.failureClass).toBe('receiver-out')
  })

  test('U-TT-14: a flagged .error is a handled terminal, never a stall', () => {
    const t = classifyTurn(baseObs({
      signalAt: T0 - 999_000, // very stale, would otherwise stall
      heartbeatAt: T0 - 999_000,
      errorPresent: true,
      now: T0,
    }))
    expect(t.stage).toBe('done')
    expect(t.stalled).toBe(false)
    expect(t.failureClass).toBeNull()
  })

  test('U-TT-15: budget boundary — exactly at budget stalls, one ms under does not', () => {
    const atBudget = classifyTurn(baseObs({
      signalAt: T0 - TURN_STAGE_BUDGETS_MS.inject,
      now: T0,
    }))
    expect(atBudget.stalled).toBe(true)

    const underBudget = classifyTurn(baseObs({
      signalAt: T0 - (TURN_STAGE_BUDGETS_MS.inject - 1),
      now: T0,
    }))
    expect(underBudget.stalled).toBe(false)
  })

  test('U-TT-16: a clock skew (future signal) clamps sinceMs to 0, never stalls', () => {
    const t = classifyTurn(baseObs({ signalAt: T0 + 5_000, now: T0 }))
    expect(t.sinceMs).toBe(0)
    expect(t.stalled).toBe(false)
  })

  test('U-TT-17: progress budget matches the established 5-minute no-output bound', () => {
    expect(TURN_STAGE_BUDGETS_MS.progress).toBe(300_000)
  })
})

describe('formatTurnIncident', () => {
  const incident: TurnIncident = {
    chatId: '12345',
    stage: 'dispatch',
    failureClass: 'receiver-out',
    sinceMs: 20_000,
    budgetMs: 15_000,
    midTurn: false,
    at: T0,
  }

  test('U-TT-18: renders a one-line, log-friendly summary', () => {
    const line = formatTurnIncident(incident)
    expect(line).toContain('chat=12345')
    expect(line).toContain('stage=dispatch')
    expect(line).toContain('class=receiver-out')
    expect(line).toContain('stuck=20s')
    expect(line).toContain('budget=15s')
  })

  test('U-TT-19: marks mid-turn stalls and tolerates a null failure class', () => {
    const line = formatTurnIncident({
      ...incident,
      failureClass: null,
      midTurn: true,
    })
    expect(line).toContain('class=none')
    expect(line).toContain('mid-turn')
  })
})
