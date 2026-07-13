/**
 * Unit tests for src/agent/safe-mode.ts — SafeModeManager toggling, threshold
 * escalation, reversibility, and audit emission.
 */

import { SafeModeManager, type SafeModeEvent } from '../../src/agent/safe-mode'

const AGENT = 'claude-founder'

describe('SafeModeManager', () => {
  test('U-SM-01: inactive by default', () => {
    const m = new SafeModeManager()
    expect(m.isActive(AGENT)).toBe(false)
  })

  test('U-SM-02: auto-enters after threshold consecutive PTY failures', () => {
    const m = new SafeModeManager({ threshold: 3 })
    expect(m.recordPtyFailure(AGENT)).toBe(false)
    expect(m.recordPtyFailure(AGENT)).toBe(false)
    expect(m.recordPtyFailure(AGENT)).toBe(true) // crossed threshold
    expect(m.isActive(AGENT)).toBe(true)
  })

  test('U-SM-03: recordPtyFailure returns true only on the crossing failure', () => {
    const m = new SafeModeManager({ threshold: 2 })
    m.recordPtyFailure(AGENT)
    expect(m.recordPtyFailure(AGENT)).toBe(true)
    // Already active → subsequent failures return false (idempotent).
    expect(m.recordPtyFailure(AGENT)).toBe(false)
    expect(m.isActive(AGENT)).toBe(true)
  })

  test('U-SM-04: a healthy PTY turn resets the counter before the threshold', () => {
    const m = new SafeModeManager({ threshold: 3 })
    m.recordPtyFailure(AGENT)
    m.recordPtyFailure(AGENT)
    m.recordSuccess(AGENT) // resets consecutive failures
    expect(m.recordPtyFailure(AGENT)).toBe(false) // count restarts from 1
    expect(m.isActive(AGENT)).toBe(false)
  })

  test('U-SM-05: recordSuccess lifts an active safe mode (reversible)', () => {
    const m = new SafeModeManager({ threshold: 2 })
    m.recordPtyFailure(AGENT)
    m.recordPtyFailure(AGENT)
    expect(m.isActive(AGENT)).toBe(true)
    expect(m.recordSuccess(AGENT)).toBe(true) // exited
    expect(m.isActive(AGENT)).toBe(false)
  })

  test('U-SM-06: manual enter / exit', () => {
    const m = new SafeModeManager()
    m.enter(AGENT, 'operator')
    expect(m.isActive(AGENT)).toBe(true)
    m.exit(AGENT, 'fix released')
    expect(m.isActive(AGENT)).toBe(false)
  })

  test('U-SM-07: per-agent isolation', () => {
    const m = new SafeModeManager({ threshold: 1 })
    m.recordPtyFailure('agent-a')
    expect(m.isActive('agent-a')).toBe(true)
    expect(m.isActive('agent-b')).toBe(false)
  })

  test('U-SM-08: audit sink receives every transition', () => {
    const events: SafeModeEvent[] = []
    const m = new SafeModeManager({ threshold: 2, audit: (e) => events.push(e) })
    m.recordPtyFailure(AGENT)
    m.recordPtyFailure(AGENT) // enters
    m.recordSuccess(AGENT) // exits
    const actions = events.map((e) => e.action)
    expect(actions).toContain('pty-failure')
    expect(actions).toContain('enter')
    expect(actions).toContain('exit')
    // enter event carries the failure count that triggered it.
    const enter = events.find((e) => e.action === 'enter')
    expect(enter!.failures).toBe(2)
  })

  test('U-SM-09: injected clock stamps event timestamps', () => {
    const events: SafeModeEvent[] = []
    const m = new SafeModeManager({ threshold: 1, now: () => 123456, audit: (e) => events.push(e) })
    m.recordPtyFailure(AGENT)
    expect(events.every((e) => e.at === 123456)).toBe(true)
  })
})
