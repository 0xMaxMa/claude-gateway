/**
 * Safe-mode manager (Epic #195, Phase 3).
 *
 * When the PTY (interactive TUI) backend repeatedly fails for an agent, the
 * gateway temporarily flips that agent to the headless backend so it keeps
 * serving turns while the wedge is investigated — without restarting the
 * gateway. Safe mode is reversible: it is cleared on an explicit restore
 * (user command / fix release) or when a healthy PTY turn is later observed.
 *
 * This manager owns only the in-memory decision + audit state. The actual
 * backend flip is applied by the runner, which reads `isActive(agentId)` when
 * spawning a session (setting `SessionProcess.forceHeadless`). Keeping the
 * state here — not in config on disk — means the override never persists past a
 * gateway restart, which is the desired failsafe: a restart re-reads the user's
 * real config and starts fresh.
 */

import { shouldEnterSafeMode, DEFAULT_SAFE_MODE_THRESHOLD } from './recovery-policy'

/** A safe-mode transition, emitted to the audit sink. */
export interface SafeModeEvent {
  agentId: string
  action: 'enter' | 'exit' | 'pty-failure' | 'pty-success'
  reason: string
  at: number
  /** Consecutive PTY failures at the time of the event. */
  failures: number
}

export type SafeModeAuditSink = (event: SafeModeEvent) => void

export interface SafeModeManagerDeps {
  /** Consecutive-failure threshold to auto-enter safe mode. */
  threshold?: number
  /** Clock injection (epoch ms). */
  now?: () => number
  /** Optional audit sink — every transition is reported here. */
  audit?: SafeModeAuditSink
}

interface AgentState {
  active: boolean
  consecutivePtyFailures: number
}

export class SafeModeManager {
  private readonly threshold: number
  private readonly now: () => number
  private readonly audit?: SafeModeAuditSink
  private readonly agents = new Map<string, AgentState>()

  constructor(deps: SafeModeManagerDeps = {}) {
    this.threshold = deps.threshold ?? DEFAULT_SAFE_MODE_THRESHOLD
    this.now = deps.now ?? (() => Date.now())
    this.audit = deps.audit
  }

  private state(agentId: string): AgentState {
    let s = this.agents.get(agentId)
    if (!s) {
      s = { active: false, consecutivePtyFailures: 0 }
      this.agents.set(agentId, s)
    }
    return s
  }

  private emit(agentId: string, action: SafeModeEvent['action'], reason: string): void {
    if (!this.audit) return
    const s = this.state(agentId)
    this.audit({
      agentId,
      action,
      reason,
      at: this.now(),
      failures: s.consecutivePtyFailures,
    })
  }

  /** Whether the agent is currently forced to the headless backend. */
  isActive(agentId: string): boolean {
    return this.state(agentId).active
  }

  /**
   * Record a hard PTY-backend failure. Returns true if this failure just
   * crossed the threshold and the agent should be (and now is) in safe mode.
   * Idempotent once active — repeated failures while active return false.
   */
  recordPtyFailure(agentId: string): boolean {
    const s = this.state(agentId)
    s.consecutivePtyFailures += 1
    this.emit(agentId, 'pty-failure', 'pty backend failure')
    if (!s.active && shouldEnterSafeMode(s.consecutivePtyFailures, this.threshold)) {
      s.active = true
      this.emit(
        agentId,
        'enter',
        `auto: ${s.consecutivePtyFailures} consecutive PTY failures`,
      )
      return true
    }
    return false
  }

  /**
   * Record a healthy turn. Clears the failure counter; if safe mode was active
   * it is lifted (the backend recovered). Returns true if safe mode was exited.
   */
  recordSuccess(agentId: string): boolean {
    const s = this.state(agentId)
    s.consecutivePtyFailures = 0
    this.emit(agentId, 'pty-success', 'healthy turn')
    if (s.active) {
      s.active = false
      this.emit(agentId, 'exit', 'healthy turn observed')
      return true
    }
    return false
  }

  /** Force safe mode on (e.g. explicit operator action). */
  enter(agentId: string, reason = 'manual'): void {
    const s = this.state(agentId)
    if (s.active) return
    s.active = true
    this.emit(agentId, 'enter', reason)
  }

  /** Restore the configured backend (user command / fix release). */
  exit(agentId: string, reason = 'manual'): void {
    const s = this.state(agentId)
    s.consecutivePtyFailures = 0
    if (!s.active) return
    s.active = false
    this.emit(agentId, 'exit', reason)
  }
}
