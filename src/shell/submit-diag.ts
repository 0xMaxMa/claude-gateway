/**
 * Diagnostics for the swallowed-Enter submit-retry path (#370).
 *
 * A turn intermittently fails with "failed to submit turn to the TUI input" for
 * two indistinguishable reasons in today's logs:
 *   (1) the Enter was genuinely swallowed — the draft is still sitting in the
 *       input box at give-up (`draftLen > 0`), or
 *   (2) a busy-marker-drift false-positive — newer Claude Code renders a random
 *       gerund spinner instead of the "esc to interrupt" marker, so the
 *       give-up branch trips even though Claude is working (draft empty, records
 *       appear right after — surfaced by the paired `recovered` event).
 *
 * These pure helpers build one prod-safe structured snapshot per retry/give-up/
 * recovery. Extracted from claude-pty-shell.ts so they are unit-testable without
 * importing that module (which starts the driver on load).
 */

/** Stable 32-bit FNV-1a hash of a string, hex. Used only to correlate the input
 *  draft across submit-retry snapshots (an unchanged hash ⇒ a genuinely stuck,
 *  unsubmitted draft) WITHOUT ever logging the raw user text. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Decision inputs for one submit-retry diagnostic snapshot. */
export interface SubmitDiagInputs {
  event: 'retry' | 'giveup' | 'recovered';
  enterRetries: number;
  sawBusy: boolean;
  /** True if the literal "esc to interrupt" marker was ever seen this turn —
   *  distinct from `sawBusy` (which also flips from echo-immune assistant
   *  records). Its absence, with records still arriving, is the cause-2 tell. */
  sawBusyMarker: boolean;
  sawAssistant: boolean;
  recordsDelta: number;
  /** Raw input draft — redacted to length + hash by buildSubmitDiag; never emitted. */
  draft: string;
  quietMs: number;
  msSinceSubmit: number | null;
  msSinceStart: number;
  msSinceFirstRecord: number | null;
  hasPrompt: boolean;
  dialog: string | null;
  fromMenuSelection: boolean;
  probeRounds: number | null;
}

/** Classification of a submit-retry snapshot into the two known failure modes,
 *  or `unknown` when the evidence fits neither. This is a *label to aid reading*
 *  — the raw fields (`draftLen`, `recordsDelta`, `sawBusyMarker`, …) remain the
 *  source of truth and are always emitted, so a novel case is never lost to a
 *  wrong bucket.
 *
 *  - `cause1-swallowed`: a non-empty draft is still sitting in the input box
 *    (`draftLen > 0`) ⇒ the Enter was genuinely swallowed.
 *  - `cause2-marker-drift`: the draft is empty and records arrived
 *    (`draftLen === 0 && recordsDelta > 0`) ⇒ the Enter went through; the
 *    give-up was a busy-marker-drift false positive.
 *  - `unknown`: empty draft and no records (`draftLen === 0 && recordsDelta === 0`)
 *    ⇒ Enter cleared but nothing followed — fits neither known cause. */
export type LikelyCause = 'cause1-swallowed' | 'cause2-marker-drift' | 'unknown';

export function classifyLikelyCause(draftLen: number, recordsDelta: number): LikelyCause {
  if (draftLen > 0) return 'cause1-swallowed';
  if (recordsDelta > 0) return 'cause2-marker-drift';
  return 'unknown';
}

/** Build the prod-safe, structured diagnostic snapshot for the swallowed-Enter
 *  submit-retry path. Pure: the raw draft is reduced to `draftLen` + `draftHash`
 *  here and NEVER passed through verbatim, so no user text, token, or secret can
 *  reach the logs. `event` distinguishes an Enter-retry, the final give-up
 *  (cause 1 proof: non-empty draft still on screen), and a later successful
 *  completion (`recovered` — cause 2 proof: the Enter was not actually
 *  swallowed). `likelyCause` is a reading aid derived from the raw fields; those
 *  fields remain the source of truth. */
export function buildSubmitDiag(i: SubmitDiagInputs): Record<string, unknown> {
  return {
    event: i.event,
    likelyCause: classifyLikelyCause(i.draft.length, i.recordsDelta),
    enterRetries: i.enterRetries,
    sawBusy: i.sawBusy,
    sawBusyMarker: i.sawBusyMarker,
    sawAssistant: i.sawAssistant,
    recordsDelta: i.recordsDelta,
    draftLen: i.draft.length,
    draftHash: i.draft.length > 0 ? shortHash(i.draft) : null,
    quietMs: i.quietMs,
    msSinceSubmit: i.msSinceSubmit,
    msSinceStart: i.msSinceStart,
    msSinceFirstRecord: i.msSinceFirstRecord,
    hasPrompt: i.hasPrompt,
    dialog: i.dialog,
    fromMenuSelection: i.fromMenuSelection,
    probeRounds: i.probeRounds,
  };
}
