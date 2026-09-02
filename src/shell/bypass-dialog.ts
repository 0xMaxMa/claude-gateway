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
 * This module is the pure detection + decision — kept free of node-pty / screen
 * imports so it is cheap to unit-test in isolation, same pattern as
 * menu-probe.ts's decideProbeAttempt and menu-cancel.ts's decideMenuCancel.
 * ScreenModel.detectDialog() calls isBypassDialogOnScreen() below; see
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

/**
 * The dialog's own confirm affordance, rendered a line or two below the option
 * rows ("Enter to confirm · Esc to cancel"). Only the stable prefix is matched.
 *
 * Required by {@link isBypassDialogOnScreen} for the same reason
 * TUI_REQUEST_TOO_LARGE_DISMISS is required by detectRequestTooLarge(): the
 * labels alone appear in ordinary prose (this very dialog's warning text, a
 * chat reply explaining it, re-injected history quoting it), whereas the
 * footer is the affordance the live overlay renders — and it is exactly the
 * affordance the accepting keystroke relies on, so gating on it keeps
 * detection and the action consistent.
 */
export const BYPASS_CONFIRM_FOOTER = 'Enter to confirm';

/**
 * The dialog's heading — the same string screen.ts lists first in
 * TUI_BYPASS_PERMS, repeated here for the dependency-free reason above, with a
 * unit test asserting the two never drift apart.
 *
 * Required by {@link isBypassDialogOnScreen} so that predicate is the COMPLETE
 * rule rather than half of one split across two files. See the note there.
 */
export const BYPASS_HEADING = 'Bypass Permissions mode';

/**
 * How far apart the dialog's own rows may sit before they stop being one block.
 *
 * The real capture has the two options on adjacent rows and the footer two rows
 * below them (one blank row between). These bounds allow a little repaint slack
 * while still requiring the elements to be visually together: without them the
 * "structure" was only an ordering, so an option row, a second option row 15
 * lines further down and any sentence containing "Enter to confirm" below that
 * satisfied it — on a screen of ordinary conversation (review round 2, M3).
 */
export const BYPASS_MAX_ROW_GAP = 2;
export const BYPASS_MAX_FOOTER_GAP = 3;

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
 * Not 1: detection is structural (see isBypassDialogOnScreen), so a mid-repaint
 * frame — the option rows drawn but the footer not yet, or the caret momentarily
 * on neither row — reads as "no dialog" for a single round while the dialog is
 * still very much up. Resetting on one miss would zero the counter mid-dialog —
 * precisely the case the ceiling exists for. Requiring sustained absence costs
 * the next dialog one extra cooldown round at most.
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
 * miss keeps a one-round detection flicker (a repaint catching the dialog
 * half-drawn) from silently refilling the allowance mid-dialog.
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
  /** Line index within the screen text — decides Down vs Up. */
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
 * Find the option row nearest the bottom of the screen. A live modal is the
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
 * Is a live, drivable bypass-permissions dialog on this screen?
 *
 * This replaced a positional test — "both marker substrings inside the bottom
 * 20 rows" — which assumed a modal is always anchored to the bottom. This
 * dialog is not: it renders at boot, before there is any conversation to push
 * it down, so on a clean start it sits at the TOP of the screen with the rest
 * blank. Both markers then fall outside the window, detection returns null,
 * nothing is pressed, and the session dies at the 120 s startup timeout and
 * respawns into the same dialog (issue #436). Whether a given boot emitted
 * enough output to push the dialog into the window is what made the wedge look
 * random.
 *
 * The window was never really about position, though — it was a cheap proxy for
 * "this is the live modal, not text that quotes it". Quoted text is a genuine
 * hazard: an agent explaining this dialog, or re-injected conversation history,
 * puts the same characters on the same screen, and a mis-aimed Enter can land on
 * "No, exit" and kill Claude Code unrecoverably. So the proxy is replaced with
 * the thing it was proxying for — structural properties, all position-
 * independent, all read off a verbatim capture of the real dialog:
 *
 *   1. The dialog's heading is somewhere on screen. Cheap substring reject.
 *   2. Both option labels occupy a WHOLE row (findRow's anchored patterns), so
 *      prose that mentions them mid-sentence never qualifies.
 *   3. Exactly ONE of those two rows carries the ❯ caret. Zero means the frame
 *      is still rendering (or is not a live select); two is a shape we do not
 *      understand.
 *   4. The rows and the footer form one BLOCK — the options within
 *      BYPASS_MAX_ROW_GAP rows of each other, the footer within
 *      BYPASS_MAX_FOOTER_GAP below them. Without this the three elements only
 *      had to appear in order, so an option row, an unrelated option row 15
 *      lines later and a sentence containing "Enter to confirm" further down
 *      still qualified (review round 2, finding M3).
 *   5. The dialog's own confirm footer renders BELOW the option rows.
 *   6. Nothing but blank rows renders below that footer.
 *
 * (6) is the load-bearing one, and it is what the old bottom-region test was
 * actually encoding: a live modal owns the screen. Quoted text never can — the
 * input box, its border and the status bar always render underneath it — so
 * scrollback, a pasted dialog, and re-injected history all fail (6) no matter
 * where on the screen they land.
 *
 * (6) is deliberately ZERO-tolerance: not even a box border may follow the
 * footer. A future Claude Code that draws this dialog inside a box, or paints a
 * status line beneath it, would therefore stop being detected. That is the
 * intended direction of the trade — a miss is fail-safe (the operator sees the
 * dialog, and maybeHandleDialog() now logs a warning naming this exact case),
 * whereas relaxing (6) to tolerate border rows would admit a quoted dialog
 * sitting above an EMPTY input box, whose rows are themselves nothing but
 * border characters. Given "No, exit" is unrecoverable and a visible dialog is
 * not, a miss beats a false accept (review round 2, finding M2 — accepted as
 * accurate, resolved this way rather than by relaxing the rule).
 *
 * Fail-safe in the same direction as before: anything unrecognised reads as "no
 * dialog", which means no keystroke and an operator who simply sees the dialog.
 */
export function isBypassDialogOnScreen(screenText: string): boolean {
  // The heading gate lives HERE rather than in ScreenModel.detectDialog() so
  // that this predicate is the whole rule. When detectDialog() held it, the
  // action layer re-applied only the structural half, and a screen carrying a
  // perfect dialog shape without the heading produced a live Enter if
  // decideBypassDialogAction() was ever called from anywhere else — the exact
  // drift the two-layer design claimed to prevent (review round 2, finding H1).
  if (!screenText.includes(BYPASS_HEADING)) return false;
  const lines = screenText.split('\n');
  const accept = findRow(lines, ACCEPT_ROW_RE);
  const decline = findRow(lines, DECLINE_ROW_RE);
  if (!accept || !decline) return false;
  // Exactly one caret: equal flags mean either none (still rendering) or both
  // (unrecognised shape). Same rule decideBypassDialogAction() acts on.
  if (accept.caret === decline.caret) return false;
  if (Math.abs(accept.line - decline.line) > BYPASS_MAX_ROW_GAP) return false;
  const lastOptionRow = Math.max(accept.line, decline.line);
  const footer = lines.findIndex(
    (l, i) => i > lastOptionRow && l.includes(BYPASS_CONFIRM_FOOTER),
  );
  if (footer === -1) return false;
  if (footer - lastOptionRow > BYPASS_MAX_FOOTER_GAP) return false;
  return lines.slice(footer + 1).every((l) => l.trim() === '');
}

/**
 * Decide the single keystroke to send at a bypass-permissions dialog, given
 * the screen text the dialog was detected on.
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

  // The caller only gets here after detectDialog() fired, and both now read the
  // whole screen — so "act only on what was detected" can no longer be enforced
  // by handing this function a narrow region. It is enforced by applying the
  // same structural rule here instead, which also keeps the two layers from
  // drifting apart if either is edited alone.
  if (!isBypassDialogOnScreen(dialogText)) {
    return { kind: 'wait', reason: 'no live bypass dialog on screen' };
  }

  // The checks below are reached only for a screen that already satisfies that
  // rule, so several are belt-and-braces. They are kept deliberately: each one
  // states an invariant this decision depends on, and a keystroke sent on a
  // wrong assumption here can pick "No, exit" and end the session for good.
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
