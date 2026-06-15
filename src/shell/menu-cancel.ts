/**
 * Decision logic for submitting a queued prompt after ESC-cancelling a bridged
 * interactive menu.
 *
 * When the user replies to a bridged menu with free text instead of a number,
 * the wrapper sends ESC to dismiss the menu and then wants to submit the text as
 * a fresh prompt. But ESC makes Claude resume (it processes the cancellation),
 * so the TUI is briefly busy/redrawing. Submitting into that transition races —
 * the paste lands in a non-prompt state, the Enter is swallowed, and the turn
 * never starts (→ 30-min watchdog hang). So submission is deferred until the TUI
 * settles back to an idle prompt.
 *
 * This module is the pure decision: given the current observations, return the
 * action the caller should take. Kept free of node-pty / screen imports so it is
 * cheap to unit-test in isolation.
 */

// Minimum delay after the ESC before we allow a submit. Gives Claude time to
// start any cancellation response so `isBusy` can catch it (and block us).
export const MENU_CANCEL_MIN_WAIT_MS = 800;
// The PTY must be quiet at least this long, once back at an idle prompt.
export const MENU_CANCEL_SETTLE_QUIET_MS = 600;
// If the menu lingers (ESC swallowed), re-send ESC no more often than this.
export const MENU_CANCEL_ESC_RETRY_MS = 1500;
// Cap on ESC re-sends before we stop retrying.
export const MENU_CANCEL_MAX_ESC = 3;
// Hard fallback: submit anyway after this long so a stuck TUI never hangs.
export const MENU_CANCEL_TIMEOUT_MS = 15_000;

export type MenuCancelAction = 'wait' | 'resend-esc' | 'submit';

export interface MenuCancelState {
  /** Timestamp (ms) of the first ESC that started this cancel. */
  since: number;
  /** Timestamp (ms) of the most recent ESC sent. */
  lastEscAt: number;
  /** How many ESCs have been sent so far (starts at 1). */
  escs: number;
}

export interface MenuCancelObs {
  now: number;
  /** Is an interactive select menu still on screen? */
  menuVisible: boolean;
  /** Is the normal input prompt box present? */
  hasPrompt: boolean;
  /** Is the TUI busy (spinner / processing)? */
  isBusy: boolean;
  /** Milliseconds since the last PTY output. */
  quietMs: number;
}

/**
 * Decide what to do while waiting for the TUI to settle after a menu-cancel.
 *
 * - `submit`    — the queued prompt is safe to type now (or the hard timeout hit).
 * - `resend-esc` — the menu is still up; ESC was likely swallowed, send it again.
 * - `wait`      — keep waiting; nothing to do this tick.
 */
export function decideMenuCancel(state: MenuCancelState, obs: MenuCancelObs): MenuCancelAction {
  const { since, lastEscAt, escs } = state;
  const { now, menuVisible, hasPrompt, isBusy, quietMs } = obs;

  // Hard timeout: never hang — submit regardless of screen state. The turn's
  // own Enter-retry logic is the last line of defence for a swallowed submit.
  if (now - since > MENU_CANCEL_TIMEOUT_MS) return 'submit';

  // Settled back to an idle prompt → safe to submit the queued text.
  if (!menuVisible
      && hasPrompt
      && !isBusy
      && now - since >= MENU_CANCEL_MIN_WAIT_MS
      && quietMs >= MENU_CANCEL_SETTLE_QUIET_MS) {
    return 'submit';
  }

  // Menu still lingering → ESC may have been swallowed; re-send periodically.
  if (menuVisible
      && now - lastEscAt > MENU_CANCEL_ESC_RETRY_MS
      && escs < MENU_CANCEL_MAX_ESC) {
    return 'resend-esc';
  }

  return 'wait';
}
