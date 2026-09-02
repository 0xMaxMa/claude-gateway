/**
 * Decision logic for accepting Claude Code's "Bypass Permissions mode" dialog.
 *
 * The wrapper always injects --dangerously-skip-permissions, so the resulting
 * confirmation modal is accepted on the operator's behalf. How to accept it
 * depends on the Claude Code build, because the dialog's rendering changed:
 *
 *   Claude Code <= 2.1.247          Claude Code >= 2.1.248
 *     ❯ 1. No, exit                   ❯ No, exit
 *       2. Yes, I accept                Yes, I accept
 *
 * The old shape is a numbered select — typing the digit picks *and* confirms
 * the row in one keystroke. The new shape has no indexes, so a digit selects
 * nothing at all: the dialog stays up, gets re-detected every
 * DIALOG_ACTION_COOLDOWN_MS, and the session wedges until the watchdog kills
 * it (issue #431). Both shapes start with the caret on "No, exit".
 *
 * Both renderings are still in the wild, so this decides per screen rather
 * than per version — there is no version string to read from inside the PTY
 * anyway, and the screen is the thing that actually has to be driven.
 *
 * SAFETY: choosing "No, exit" terminates Claude Code, which is not
 * recoverable, while leaving the dialog up merely means an operator sees it.
 * So Enter is only ever sent once the caret is *observed* on the accept row,
 * the digit is read off the accept row instead of hard-coded (a future
 * reordering must not send us to "No, exit"), and anything unparseable or
 * ambiguous produces no keystroke at all.
 *
 * This module is the pure decision — kept free of node-pty / screen imports so
 * it is cheap to unit-test in isolation, same pattern as menu-probe.ts's
 * decideProbeAttempt and menu-cancel.ts's decideMenuCancel. See
 * Driver.maybeHandleDialog() in claude-pty-shell.ts for where it is wired in.
 */

/**
 * The dialog's two option labels. BYPASS_ACCEPT_LABEL is the same string
 * screen.ts lists in TUI_BYPASS_PERMS as a detection marker; it is repeated
 * here rather than imported to keep this module dependency-free, and a unit
 * test asserts the two never drift apart (screen.ts: "all matchers live here
 * so a UI change requires touching exactly one file").
 */
export const BYPASS_ACCEPT_LABEL = 'Yes, I accept';
export const BYPASS_DECLINE_LABEL = 'No, exit';

/** Arrow keystrokes used to walk the caret onto the accept row. */
export const BYPASS_KEY_DOWN = '\x1b[B';
export const BYPASS_KEY_UP = '\x1b[A';
/** Confirms the highlighted row ("Enter to confirm" per the dialog's own footer). */
export const BYPASS_KEY_ENTER = '\r';

/**
 * Ceiling on keystrokes sent per dialog — arrow moves plus the accepting key
 * itself. A healthy dialog needs at most two (one move, one Enter); the
 * ceiling exists so a dialog that renders but never responds cannot draw
 * *unbounded* key traffic, because those keys are not discarded by an
 * unresponsive TUI — they queue and land in the prompt once it opens.
 *
 * Sized to the startup window rather than to the happy path. maybeHandleDialog()
 * only runs while the shell is not ready, so the caller can make at most
 * STARTUP_TIMEOUT_MS / DIALOG_ACTION_COOLDOWN_MS = 120000/2000 = 60 attempts
 * before the startup timeout ends the process anyway; a test pins that
 * arithmetic against the driver's own constants. A tighter ceiling would go
 * silent partway through that window, so a dialog that merely swallowed its
 * first keystrokes (still rendering, key handler not yet attached) would never
 * be retried and would die at the startup timeout into a respawn loop — the
 * exact #431 symptom. Overspending is cheap by comparison: an unresponsive TUI
 * only ever collects arrows and digits here (Enter is sent solely after the
 * caret is *observed* to have moved, which an unresponsive TUI never does), so
 * the worst case is junk characters in an input draft the driver already
 * clears, never a submitted line.
 *
 * Exhausting the ceiling falls back to 'wait' — the fail-safe visible dialog.
 */
export const BYPASS_MAX_KEYS = 60;

/**
 * Consecutive rounds with no dialog on screen before the keystroke ceiling is
 * considered spent on a dialog that is gone.
 *
 * Not 1: detection needs both TUI_BYPASS_PERMS markers inside the same bottom
 * region (screen.ts DIALOG_REGION_ROWS), so a repaint that shifts the box by a
 * row drops the header out of that window for a single read. Resetting on one
 * miss would zero the counter mid-dialog — precisely the case the ceiling
 * exists for. Requiring sustained absence costs the next dialog one extra
 * cooldown round at most.
 */
export const BYPASS_RESET_AFTER_MISSES = 2;

export type BypassDialogAction =
  /** Numbered rendering: type this digit, which selects and confirms in one key. */
  | { kind: 'digit'; key: string }
  /**
   * Un-numbered rendering: the caret is on the decline row, so step it onto
   * the accept row. Exactly one step — see decideBypassDialogAction(); a caret
   * anywhere other than the decline row is ambiguous and yields 'wait'.
   */
  | { kind: 'move'; key: string }
  /** Caret is on the accept row — safe to confirm. */
  | { kind: 'confirm'; key: string }
  /** Nothing safe to do this round; `reason` is for the log. */
  | { kind: 'wait'; reason: string };

/** Per-dialog bookkeeping. Reset once the dialog has left the screen. */
export interface BypassDialogState {
  /** Keystrokes already sent for the current dialog. */
  keys: number;
  /** Consecutive rounds the dialog was not detected — see noteDialogAbsent(). */
  misses: number;
}

/**
 * Record a round in which no dialog was detected, clearing the keystroke count
 * once the dialog has been absent for BYPASS_RESET_AFTER_MISSES consecutive
 * rounds so the next dialog starts with a full allowance. Tolerating a single
 * miss keeps a one-round detection flicker (a repaint shifting the header out
 * of the detection window) from silently refilling the allowance mid-dialog.
 */
export function noteDialogAbsent(state: BypassDialogState): void {
  state.misses++;
  if (state.misses >= BYPASS_RESET_AFTER_MISSES) state.keys = 0;
}

/** Record a round in which the dialog *was* detected, restarting the miss run. */
export function noteDialogPresent(state: BypassDialogState): void {
  state.misses = 0;
}

/** One option row of the dialog as it appears on screen. */
interface OptionRow {
  /** Line index within the scanned region — decides Down vs Up. */
  line: number;
  /** The ❯ caret is on this row. */
  caret: boolean;
  /** The row's `N.` index in the numbered rendering, or null when un-numbered. */
  digit: number | null;
}

/**
 * Match an option row: optional box border, optional ❯ caret, optional `N.`
 * index, then the label and nothing else.
 *
 * Anchored at both ends on purpose. The dialog's own warning prose mentions
 * accepting responsibility and Bypass Permissions mode, and a chat reply can
 * quote the labels outright; requiring the label to be the *whole* row keeps
 * those from being mistaken for a selectable option.
 *
 * The caret is U+276F only — never the ASCII '>' that TUI_MENU_OPTION_RE
 * tolerates for row content — because the real TUI never renders '>' as a
 * caret while prose (markdown blockquotes) renders it constantly.
 *
 * The label is escaped before interpolation. These patterns are built at module
 * load, and the labels above are meant to be edited when the TUI changes: an
 * unescaped label containing '(' would throw SyntaxError at import time and take
 * every PTY session down with it, and a '.' would silently become a wildcard
 * that widens what counts as a selectable row.
 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Exported only so a unit test can prove the escaping above. */
export function rowPattern(label: string): RegExp {
  return new RegExp(
    `^[\\s│]*(❯)?\\s*(?:(\\d+)\\.)?\\s*${escapeForRegExp(label)}[\\s│]*$`,
  );
}

const ACCEPT_ROW_RE = rowPattern(BYPASS_ACCEPT_LABEL);
const DECLINE_ROW_RE = rowPattern(BYPASS_DECLINE_LABEL);

/**
 * Find the option row nearest the bottom of the region. A live modal is the
 * bottom-most thing on screen, so scanning upward from the end means quoted
 * scrollback above it can never be the row we act on.
 */
function findRow(lines: string[], re: RegExp): OptionRow | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]);
    if (m) return { line: i, caret: m[1] === '❯', digit: m[2] ? Number(m[2]) : null };
  }
  return null;
}

/**
 * Decide the single keystroke to send at a bypass-permissions dialog, given
 * the screen region the dialog was detected in.
 *
 * Callers send at most one key per call and re-read the screen before the
 * next one (the DIALOG_ACTION_COOLDOWN_MS re-entry in maybeHandleDialog()),
 * so multi-step acceptance is a screen-driven state machine rather than a
 * blind key sequence: every keystroke is justified by what is on screen at
 * the moment it is sent.
 *
 * `state.keys` is only read here; the caller advances it for every action that
 * actually sends a key.
 */
export function decideBypassDialogAction(
  dialogText: string,
  state: BypassDialogState,
): BypassDialogAction {
  // Budget applies to every keystroke, not just the arrows: a dialog still on
  // screen after this many keys is not responding to us, and the fix for #431
  // is precisely that repeating a key at a dialog that ignores it is worse
  // than doing nothing.
  if (state.keys >= BYPASS_MAX_KEYS) {
    return { kind: 'wait', reason: `keystroke budget exhausted after ${state.keys} keys` };
  }

  const lines = dialogText.split('\n');
  const accept = findRow(lines, ACCEPT_ROW_RE);
  if (!accept) return { kind: 'wait', reason: 'accept row not parseable on screen' };

  // Numbered rendering (<= 2.1.247): the digit selects and confirms in one
  // keystroke, the same key the pre-#431 code sent — but read off the accept
  // row rather than hard-coded, so a reordered dialog cannot make us type the
  // digit that means "No, exit". A wider index is not one keystroke, and how
  // such a dialog responds to arrows has never been observed, so it stops here
  // rather than guessing its way toward Enter.
  if (accept.digit !== null) {
    if (accept.digit >= 1 && accept.digit <= 9) {
      return { kind: 'digit', key: String(accept.digit) };
    }
    return { kind: 'wait', reason: `accept row index ${accept.digit} is not a single keystroke` };
  }

  // Un-numbered rendering (>= 2.1.248): navigate, then confirm.
  const decline = findRow(lines, DECLINE_ROW_RE);
  if (accept.caret && !decline?.caret) return { kind: 'confirm', key: BYPASS_KEY_ENTER };

  // Not on the accept row. Only move when the caret is unambiguously on the
  // decline row: a screen with no caret at all is still rendering (or is not
  // the live dialog), and one with a caret on both rows is not a shape we
  // understand. Guessing either way risks confirming "No, exit".
  //
  // So this is a single step between two known rows, not a search: on a dialog
  // whose caret sits on some third row, every round yields 'wait' and the
  // operator sees the dialog. Both observed renderings have exactly these two
  // options, and stepping blindly toward a row we cannot see the caret on is
  // how Enter ends up on "No, exit".
  if (!decline?.caret || accept.caret) {
    return { kind: 'wait', reason: 'no unambiguous caret on the dialog rows' };
  }
  return {
    kind: 'move',
    key: accept.line > decline.line ? BYPASS_KEY_DOWN : BYPASS_KEY_UP,
  };
}
