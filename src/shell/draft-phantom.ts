/**
 * Telling a real, unsubmitted input draft apart from screen furniture the draft
 * reader mistakes for one (#370).
 *
 * `ScreenModel.inputDraft()` locates the last `❯ ` caret on the visible screen and
 * returns the text after it. An interactive overlay — an AskUserQuestion menu, a
 * tool-permission prompt — renders its highlighted row with that exact caret and
 * hides the input box, so while one is up the reader hands back the overlay's rows
 * as if the user had typed them. Static text cannot settle the ambiguity (a genuine
 * draft that begins "1. …" is menu-shaped too, which is why gating on a screen-text
 * menu check regressed #296), so this module settles it *behaviorally* instead,
 * using a keystroke the driver already sends.
 *
 * Ctrl+U edits the input line. A real draft therefore always changes under a burst
 * of them; text that survives the entire pre-paste budget byte-for-byte is not in
 * the input box at all. That surviving text is the "phantom", and the submit-retry
 * path must not read it as proof that this turn's Enter was swallowed.
 *
 * Pure helpers, kept out of claude-pty-shell.ts so they are unit-testable without
 * importing that module (which starts the driver on load) — same reason
 * `submit-diag.ts` exists.
 */

/**
 * The phantom draft, or null if the reported text is (or may be) a real draft.
 *
 * @param before draft reported immediately before the Ctrl+U burst
 * @param after  draft reported after the burst exhausted its budget
 *
 * Null when the input cleared (`after === ''`) or when any Ctrl+U moved the text —
 * a partially-cleared real draft still counts as real, so nothing is discounted on
 * the strength of a maybe.
 */
export function classifyPhantomDraft(before: string, after: string): string | null {
  if (after === '') return null;
  return after === before ? after : null;
}

/**
 * The draft to treat as evidence that a turn's paste is still unsubmitted.
 *
 * Returns '' when the current read is byte-identical to a known phantom — the same
 * furniture, not this turn's text. Any other draft passes through unchanged, so a
 * real draft that merely looks menu-shaped still triggers the swallowed-Enter retry
 * exactly as #296 requires.
 */
export function unsubmittedDraft(draft: string, phantom: string | null): string {
  return phantom !== null && draft === phantom ? '' : draft;
}
