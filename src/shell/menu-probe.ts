/**
 * Decision logic for the behavioral interactive-prompt probe.
 *
 * Replaces the old text-pattern gate (screen-regex menu/permission detectors
 * gated behind a transcript tool_use signal — see planning-61) with a
 * behavioral test: while a turn looks stalled, send an arrow keystroke into
 * the PTY and check whether the screen actually reacts. A live, arrow-
 * navigable overlay (AskUserQuestion menu, plan approval, or a permission
 * Yes/No prompt) visibly moves its highlighted row; idle scrollback that
 * merely *contains* menu-shaped text cannot react to a keypress, because it
 * isn't a live UI element. See Driver.maybeProbeAndBridge()/advanceProbe() in
 * claude-pty-shell.ts for where this is wired in.
 *
 * This module is the pure per-round bookkeeping decision only (round budget +
 * cooldown), kept free of node-pty / screen imports so it is cheap to
 * unit-test in isolation — same pattern as menu-cancel.ts's decideMenuCancel.
 */

/** Down-arrow keystroke — the probe's primary attempt. */
export const PROBE_KEY_DOWN = '\x1b[B';
/** Up-arrow keystroke — fallback when Down produces no change (e.g. the
 *  highlighted option is already the last one, with no wraparound). */
export const PROBE_KEY_UP = '\x1b[A';

// How long to wait after a probe keystroke before reading the screen again.
// Picked to be comfortably above PTY round-trip latency while staying well
// under the 700ms outer quiet gate (MENU_STABLE_QUIET_MS in
// claude-pty-shell.ts) — tune after live testing (planning-61 Task 5) if the
// probe fires too eagerly/too late.
export const PROBE_SETTLE_MS = 200;
// Minimum gap between probe rounds within the same stall. Must be at least
// 2x PROBE_SETTLE_MS so a failed round (Down + Up fallback, each settled)
// fully completes before another can start; a little headroom on top avoids
// hammering keys into the PTY back-to-back when nothing is listening.
export const PROBE_RETRY_COOLDOWN_MS = 500;
// Cap on probe rounds per stall. After this many rounds with no confirmed
// reaction, give up — the turn falls through to the existing Enter-retry /
// fallback-idle-detection / watchdog path, exactly as a plain non-menu stall
// does today. First-pass number (planning-61); tune after Task 5.
export const PROBE_MAX_ROUNDS = 3;

export type ProbeAttemptAction = 'send' | 'wait' | 'give-up';

/** Per-turn probe bookkeeping — replaces the old ActiveTurn.menuToolSeen gate. */
export interface ProbeState {
  /** Timestamp (ms) of the most recent probe attempt (0 = none yet). */
  lastAttemptAt: number;
  /** How many rounds have been attempted so far this stall. */
  rounds: number;
}

export interface ProbeAttemptObs {
  now: number;
}

/**
 * Decide whether to start a new probe round right now.
 *
 * - `send`     — cooldown has elapsed and the round budget isn't spent; go.
 * - `wait`     — still within the cooldown window since the last attempt.
 * - `give-up`  — PROBE_MAX_ROUNDS already spent this stall; stop probing
 *                until real activity resumes and resets the budget (see
 *                Driver.tick()'s busy-resume handling in claude-pty-shell.ts).
 */
export function decideProbeAttempt(state: ProbeState, obs: ProbeAttemptObs): ProbeAttemptAction {
  if (state.rounds >= PROBE_MAX_ROUNDS) return 'give-up';
  if (obs.now - state.lastAttemptAt < PROBE_RETRY_COOLDOWN_MS) return 'wait';
  return 'send';
}

/** The slice of a parsed InteractivePrompt (screen.ts) the confirmation
 *  compares — structural, so this module stays free of screen imports. */
export interface ProbeReadout {
  options: readonly unknown[];
  /** 1-based option index the ❯ caret highlights. */
  highlighted: number;
}

/**
 * Decide whether a probe keystroke genuinely moved a live overlay's
 * highlight — the plan's "before/after comparison of the highlighted row"
 * (planning-61, Agreed Direction point 2; post-review hardening F1).
 *
 * Confirmed only when BOTH snapshots parse as the same-shaped prompt (equal
 * option count) and the ❯-highlighted index CHANGED. This is what static
 * menu-shaped text (a markdown "> 1." blockquote, a quoted earlier menu)
 * can never satisfy: surrounding text may change (e.g. Up recalled input
 * history), but a caret row in dead scrollback cannot move — and since
 * parseLiveOptionRun() reads the highlight from the run's OWN rows, a
 * caret-bearing line elsewhere on screen (the input line after a recall)
 * can't supply the "moved" index either (review round 2, finding 2).
 *
 * Rejecting when `before` is null is deliberate: the probe only fires after
 * the screen has been quiet for MENU_STABLE_QUIET_MS, so a real overlay was
 * already fully rendered in the before snapshot. An overlay that only
 * parses AFTER the keystroke means the screen changed for some other reason
 * (work resuming, a fresh render mid-settle) — the next probe round will
 * confirm it cleanly if it is real (fail-safe: a missed bridge is
 * recoverable, a false bridge is not).
 */
export function confirmProbeReaction(
  before: ProbeReadout | null,
  after: ProbeReadout | null,
): boolean {
  if (!before || !after) return false;
  if (before.options.length !== after.options.length) return false;
  return before.highlighted !== after.highlighted;
}
