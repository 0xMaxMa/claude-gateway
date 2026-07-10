/**
 * Orphan-wake adoption gate (Bug 3 — planning: autonomous wake loses output).
 *
 * Claude can start a turn on its own: a background Task's completion
 * notification re-invokes it with no user message, so the wrapper has no
 * ActiveTurn. Without a turn, tick() skips ALL end-of-turn and menu-bridge
 * handling — streamed text is never forwarded to the channel, and an
 * interactive overlay the wake ends on (plan approval / AskUserQuestion)
 * blocks the session silently forever.
 *
 * The fix adopts such a wake as a synthetic turn, but only when it is safe:
 * the screen must actually be working (busy, or the idle input prompt is
 * gone). A straggler assistant record flushed just after finishTurn() — with
 * the idle prompt back on screen — must NOT fabricate a turn, or stale text
 * would be re-forwarded. Kept as a pure function so the gate is unit-testable
 * without spawning a PTY.
 */

export interface OrphanWakeObs {
  /** An ActiveTurn already exists — normal flow, nothing to adopt. */
  hasTurn: boolean;
  /** Wrapper is shutting down. */
  exiting: boolean;
  /** ESC interrupt in flight (/stop) — the wake is being cancelled, not started. */
  interrupting: boolean;
  /** Menu-cancel settle in flight — screen state is mid-transition. */
  menuCancelActive: boolean;
  /** A bridged menu is already awaiting the user's button answer. */
  pendingMenu: boolean;
  /** screen.isBusy() — the "esc to interrupt" busy marker is visible. */
  screenBusy: boolean;
  /** screen.hasPrompt() — the idle input caret is parked on screen. */
  screenHasPrompt: boolean;
}

/** True when an assistant record with no ActiveTurn should be adopted as an
 *  autonomous-wake turn (see module doc for the safety reasoning). */
export function shouldAdoptOrphanWake(obs: OrphanWakeObs): boolean {
  if (obs.hasTurn || obs.exiting || obs.interrupting || obs.menuCancelActive || obs.pendingMenu) {
    return false;
  }
  return obs.screenBusy || !obs.screenHasPrompt;
}
