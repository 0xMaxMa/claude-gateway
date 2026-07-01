import { Terminal } from '@xterm/headless';

export type DialogKind = 'bypass-permissions';

/** One selectable row in an interactive TUI menu (AskUserQuestion / plan approval). */
export interface MenuOption {
  /** 1-based number as shown in the TUI. */
  index: number;
  /** Human-readable label (first line only; sub-descriptions are ignored). */
  label: string;
}

/** The TUI renders spaces as U+00A0 (non-breaking) — normalize before matching. */
function normalize(text: string): string {
  return text.replace(/ /g, ' ');
}

/**
 * TUI string constants — verified against Claude Code v2.1.x.
 * When upgrading Claude Code, re-check each constant against the new TUI output.
 * All matchers live here so a UI change requires touching exactly one file.
 *
 *   BUSY_MARKER   status bar text during an active turn
 *   PROMPT_RE     idle input caret pattern
 *   BYPASS_PERMS  "Bypass Permissions" dialog markers
 */
export const TUI_BUSY_MARKER = 'esc to interrupt';
export const TUI_PROMPT_RE = /^❯ /m;
export const TUI_BYPASS_PERMS = ['Bypass Permissions mode', 'Yes, I accept'] as const;

/**
 * Rows from the bottom of the screen that detectDialog() scans. A modal dialog is
 * anchored to the bottom; this window comfortably covers a tall dialog box while
 * excluding the upper ~60% of the buffer where conversation/scrollback lives.
 *
 * Conservative on purpose: if a future dialog renders taller than this and the
 * markers fall outside the window, the only effect is the auto-accept doesn't
 * fire — the operator simply sees the dialog (fail-safe), it never mis-accepts.
 * Bump this if Claude Code's dialog grows.
 */
const DIALOG_REGION_ROWS = 20;

/**
 * The recoverable "Request too large (max 32MB)" TUI error overlay. The request
 * payload (conversation history + attachments) exceeded Anthropic's 32MB API
 * limit — distinct from the token context window, since it counts raw bytes
 * (images/files), so it can fire well below 100% context.
 *
 * Detection requires BOTH the error prefix AND the dismiss-footer marker. The
 * prefix alone appears in ordinary text too (e.g. the agent explaining this very
 * error in a reply), and matching it on the live screen would auto-fire the
 * double-ESC + restart on innocuous prose. The footer "Double press esc to go
 * back" only renders on the actual dismissable overlay — and is exactly the
 * affordance our double-ESC relies on, so gating on it keeps detection and the
 * recovery action consistent: we only auto-dismiss when the dismiss hint is real.
 */
export const TUI_REQUEST_TOO_LARGE = 'Request too large (max';
export const TUI_REQUEST_TOO_LARGE_DISMISS = 'esc to go back';

/**
 * Model id Claude Code stamps on the assistant record it injects into the
 * transcript when an API call fails (e.g. the 32MB "Request too large" error).
 * This is the AUTHORITATIVE signal: a genuine error produces a `<synthetic>`
 * assistant record, whereas re-injected history / quoted prose are `user`-type
 * records or carry a real model id — so keying detection on this never
 * false-positives on text that merely mentions the error. See TranscriptTailer.
 */
export const TUI_SYNTHETIC_MODEL = '<synthetic>';

/**
 * Defang the two substrings {@link detectRequestTooLarge} scans for, so text we
 * re-inject into the TUI (the reloaded conversation history) can never reproduce
 * the verbatim 32MB overlay on screen and trip a false restart.
 *
 * Why this is needed: Claude Code's real overlay reads
 *   "Request too large (max 32MB). Double press esc to go back ..."
 * and the gateway once captured that whole sentence into a stored assistant
 * message. buildInitialPrompt() reloads the last N messages verbatim and the PTY
 * types them back into the TUI — re-rendering BOTH trigger fragments on screen
 * every spawn, so detectRequestTooLarge() fires on a fresh, healthy session (even
 * on a bare greeting) → ESC + restart → re-inject the same poison → infinite loop.
 * The detector's "require the dismiss footer too" guard does not help here because
 * the captured copy is verbatim and carries the footer.
 *
 * We insert a single ASCII space inside each fragment. It is invisible enough in
 * re-injected prose, and survives {@link normalize} — which only folds NBSP→space
 * and never collapses runs of spaces, so the broken fragment stays broken after a
 * round-trip through the screen buffer. Only the re-injected copy is altered;
 * live detection of a genuine overlay is untouched.
 */
export function neutralizeTuiTriggers(text: string): string {
  if (!text) return text;
  return text
    .split(TUI_REQUEST_TOO_LARGE).join('Request too large ( max')
    .split(TUI_REQUEST_TOO_LARGE_DISMISS).join('esc to go  back');
}

/** A numbered option row, with an optional leading ❯/> highlight marker. */
export const TUI_MENU_OPTION_RE = /^\s*[❯>]?\s*(\d+)\.\s+(.+?)\s*$/;

/**
 * The universal question line Claude Code's tool-permission prompt (e.g. the
 * dangerous-rm circuit breaker that fires even under
 * --dangerously-skip-permissions) always renders. Used only as a cosmetic
 * classifier in readInteractivePrompt() — never a gate: liveness itself is
 * established behaviorally (see Driver.runProbe() in claude-pty-shell.ts)
 * before this is ever consulted.
 */
const PERMISSION_QUESTION = 'Do you want to proceed?';

/** A live select prompt always highlights one option with a leading ❯/> caret
 *  (kept even inside a box border) — used by readInteractivePrompt() to tell
 *  a real option row apart from a numbered list in ordinary prose. */
const CARET_OPTION_RE = /^\s*│?\s*[❯>]\s*\d+\./;

/** A blocking interactive prompt parsed off the screen: the selectable options,
 *  any context text shown above a permission question (warning + command), and
 *  whether it's a permission-style prompt (vs a plain AskUserQuestion menu). */
export interface InteractivePrompt {
  options: MenuOption[];
  /** Human-readable lines above the question (e.g. the dangerous command) — '' if none. */
  context: string;
  /** Cosmetic only — chooses warning-style vs plain-menu-style chat formatting. */
  isPermission: boolean;
}

/**
 * Parse the numbered option rows out of a block of screen lines and return the
 * live run as 1..N options. Scrollback above a prompt can contain stale numbered
 * lines (a prior chat message rendered as "1. … 2. …"), so we take the LAST run
 * that starts at "1." and increments by one — that is the live prompt, not
 * history. Returns null for fewer than two options.
 *
 * `stripBorder` strips a left box border ("│ ") before matching, for prompts that
 * render inside a rounded dialog box (the permission prompt).
 */
function parseLiveOptionRun(lines: string[], stripBorder = false): MenuOption[] | null {
  const matches: MenuOption[] = [];
  for (const raw of lines) {
    const line = stripBorder ? raw.replace(/^\s*│\s?/, '') : raw;
    const m = TUI_MENU_OPTION_RE.exec(line);
    if (m) matches.push({ index: Number(m[1]), label: m[2].trim() });
  }
  if (matches.length < 2) return null;
  let start = -1;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].index === 1) start = i;
  }
  if (start === -1) return null;
  const run: MenuOption[] = [];
  let expected = 1;
  for (let i = start; i < matches.length && matches[i].index === expected; i++) {
    run.push(matches[i]);
    expected++;
  }
  return run.length >= 2 ? run : null;
}

/**
 * Parse a user's menu reply (typed number or a button's choice payload) into a
 * 1-based option index. Returns null for anything that isn't a leading integer
 * within [1, count] — never trust chat input to be a valid selection.
 */
export function parseMenuChoice(text: string, count: number): number | null {
  const m = /^\s*(\d+)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= count ? n : null;
}

/**
 * Channel turns reach the wrapper wrapped in a <channel …>…</channel> envelope
 * (see AgentRunner.buildChannelXml) — even a one-character menu reply like "1"
 * arrives as `<channel source="telegram" …>1</channel>`. To interpret a menu
 * selection we need the user's actual text, not the envelope, so pull out the
 * inner content and drop any nested <replied> block. Returns the input
 * unchanged when it is not a channel envelope (e.g. a raw API/typed reply).
 */
export function extractChannelContent(text: string): string {
  const m = /<channel\b[^>]*>([\s\S]*)<\/channel>/.exec(text);
  if (!m) return text;
  return m[1].replace(/<replied\b[^>]*>[\s\S]*?<\/replied>/g, '').trim();
}

/** Build the chat-facing menu prompt (also the API/number fallback text). */
export function formatMenuPrompt(options: MenuOption[]): string {
  const lines = options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
  return `🔢 Choose an option — tap a button below, or reply with the number:\n\n${lines}`;
}

/**
 * Build the chat-facing prompt for a tool-permission request. Leads with a clear
 * warning (this is a guarded/destructive operation Claude Code refused to run
 * unattended), echoes the context lines (e.g. the exact command) so the human can
 * judge, and lists the options 1..N — the same numbering selectMenuOption() types
 * back into the TUI. Also the API/no-button fallback text.
 */
export function formatPermissionPrompt(context: string, options: MenuOption[]): string {
  const opts = options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
  const ctx = context.trim() ? `\n\n${context.trim()}` : '';
  return `⚠️ Claude Code is asking permission for a guarded operation — a human must decide:${ctx}\n\nTap a button below, or reply with the number:\n\n${opts}`;
}

/**
 * Virtual terminal fed with raw PTY bytes. Used ONLY for liveness signals
 * (busy / idle / dialog detection) — assistant text is never parsed from
 * the screen; the transcript JSONL is the text source of truth.
 */
export class ScreenModel {
  private term: Terminal;
  private lastDataTs = Date.now();
  /** Set when a busy marker is seen in a raw chunk; survives fast busy→idle flips between polls. */
  private busySeenInRaw = false;

  constructor(public readonly cols = 200, public readonly rows = 50) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true });
  }

  write(data: string): void {
    this.lastDataTs = Date.now();
    if (normalize(data).includes(TUI_BUSY_MARKER)) this.busySeenInRaw = true;
    this.term.write(data);
  }

  /** Milliseconds since the PTY last produced output. */
  quietMs(): number {
    return Date.now() - this.lastDataTs;
  }

  text(): string {
    return this.rowsText(0, this.term.rows);
  }

  /**
   * The bottom `rows` lines of the visible screen. Active modal UI — permission
   * dialogs, error overlays, the input box — renders anchored to the bottom,
   * whereas conversation/scrollback flows in the upper area. Matching a marker
   * against this region instead of the full buffer keeps a reply (or re-injected
   * history) that merely quotes a marker from tripping a detector, since that
   * text sits above the active zone. Reduces false positives sharply but is not
   * absolute (text can briefly be the bottom-most line), so prefer an
   * authoritative transcript signal where one exists.
   */
  bottomText(rows: number): string {
    const start = Math.max(0, this.term.rows - rows);
    return this.rowsText(start, this.term.rows);
  }

  private rowsText(startRow: number, endRow: number): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = startRow; i < endRow; i++) {
      const line = buf.getLine(buf.viewportY + i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return normalize(lines.join('\n'));
  }

  /** Claude is processing a turn (spinner area shows "esc to interrupt"). */
  isBusy(): boolean {
    return this.text().includes(TUI_BUSY_MARKER);
  }

  /** Consume the raw-chunk busy flag (catches turns faster than the poll interval). */
  consumeBusySeen(): boolean {
    const seen = this.busySeenInRaw;
    this.busySeenInRaw = false;
    return seen;
  }

  /** Idle input prompt is on screen. */
  hasPrompt(): boolean {
    return TUI_PROMPT_RE.test(this.text());
  }

  detectDialog(): DialogKind | null {
    // Scan only the bottom region: a real modal dialog renders there, while a
    // reply/history quoting "Bypass Permissions mode … Yes, I accept" sits in the
    // scrollback above and must not trigger the auto-accept keystroke. The dialog
    // has no transcript signal, so this region guard (plus requiring BOTH markers)
    // is the available defense.
    const text = this.bottomText(DIALOG_REGION_ROWS);
    if (TUI_BYPASS_PERMS.every((s) => text.includes(s))) {
      return 'bypass-permissions';
    }
    return null;
  }

  /**
   * Extract the option labels (and, for a permission prompt, the warning/command
   * context) from a live interactive overlay — an AskUserQuestion-style menu or
   * a tool-permission Yes/No prompt (e.g. the dangerous-rm circuit breaker that
   * fires even under --dangerously-skip-permissions). This is a PURE READER: it
   * never decides whether a prompt exists. Callers must already have proven
   * liveness behaviorally — see Driver.runProbe() in claude-pty-shell.ts, which
   * sends an arrow-key probe and only calls this once the screen visibly reacted.
   *
   * Returns null when the region doesn't parse into a clean 1..N option run
   * (fail-safe: no bridge rather than a garbled one) even though the probe
   * proved something reacted — e.g. some other arrow-responsive UI with no
   * formatter here.
   *
   * isPermission is decided by whether "Do you want to proceed?" appears in the
   * bottom region — a COSMETIC classification (chooses warning-style vs
   * plain-menu-style chat formatting) that defaults to a plain menu when
   * ambiguous; it never gates whether to bridge.
   */
  readInteractivePrompt(): InteractivePrompt | null {
    const bottom = this.bottomText(DIALOG_REGION_ROWS);
    const isPermission = bottom.includes(PERMISSION_QUESTION);

    if (!isPermission) {
      // A tall AskUserQuestion menu can render more options than fit in the
      // bottom-region window, so scan the whole buffer. parseLiveOptionRun()
      // already isolates the live 1..N run nearest the end of the buffer, so
      // stale numbered scrollback above it can't inflate or shift the list.
      // A live select prompt always highlights one option with the ❯/> caret;
      // plain prose that merely happens to look like a numbered list never
      // carries one, so requiring it keeps this reader from hallucinating an
      // options list out of unrelated text.
      const lines = this.text().split('\n');
      if (!lines.some((l) => CARET_OPTION_RE.test(l))) return null;
      const options = parseLiveOptionRun(lines);
      return options ? { options, context: '', isPermission: false } : null;
    }

    const lines = bottom.split('\n');
    // Use the LAST occurrence of the question — the live prompt sits nearest
    // the bottom, so a reply/history that quotes the question higher in the
    // bottom region can't capture the question index and empty the context.
    let qIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(PERMISSION_QUESTION)) { qIdx = i; break; }
    }
    const optionRegion = lines.slice(qIdx + 1);
    if (!optionRegion.some((l) => CARET_OPTION_RE.test(l))) return null;
    const options = parseLiveOptionRun(optionRegion, true);
    if (!options) return null;

    // Context = the warning + command shown above the question. Bound it to the
    // dialog box (scan up for the rounded top border ╭) so conversation lines
    // that merely share the bottom region aren't swept in; fall back to the
    // few lines immediately above the question when the prompt isn't boxed.
    const isBorderOnly = (l: string) => /^[\s│╭╮╰╯─]*$/.test(l);
    const stripBorder = (l: string) => l.replace(/^[\s│]+/, '').replace(/[\s│]+$/, '');
    const aboveQ = lines.slice(0, qIdx);
    let boxTop = -1;
    for (let i = aboveQ.length - 1; i >= 0; i--) {
      if (/[╭╮]/.test(aboveQ[i])) { boxTop = i; break; }
    }
    const contextLines = boxTop >= 0 ? aboveQ.slice(boxTop + 1) : aboveQ.slice(-4);
    const context = contextLines
      .filter((l) => !isBorderOnly(l))
      .map(stripBorder)
      .filter((l) => l.length > 0)
      .join('\n');

    return { options, context, isPermission: true };
  }

  /**
   * True if a selectable prompt (menu row or permission Yes/No) still visibly
   * occupies the bottom of the screen — a live caret (❯/>) beside a numbered
   * option. This is a NARROW, POST-confirmation liveness check only: whether a
   * prompt is still blocking right now, used to decide if the confirming Enter
   * after a typed selection is still needed, or to exclude a live wizard step
   * from the Enter-swallowed retry heuristic. It is never used to decide
   * whether a prompt exists in the first place — that's the behavioral probe's
   * job (Driver.runProbe()) — so it carries none of the detection gate's
   * false-positive risk: callers only ever invoke it when they already know
   * they're mid-selection or a probe just confirmed a live overlay.
   */
  interactivePromptBlocking(): boolean {
    return /^\s*│?\s*[❯>]\s*\d+\./m.test(this.bottomText(DIALOG_REGION_ROWS));
  }
}

/**
 * Heartbeat liveness predicate (pure). The PTY session counts as actively working
 * — so the receiver's 5-min stalled detector should be held off — when EITHER the
 * busy spinner is on screen (`isBusy`) OR the PTY produced output more recently than
 * `livenessQuietMs` (`quietMs < livenessQuietMs`).
 *
 * The recent-output arm is the robust signal: the exact "esc to interrupt" busy
 * marker can drop off screen for minutes during context compaction, large request
 * assembly, or a long sub-agent run (so `isBusy` reads false), yet those states keep
 * animating a spinner and therefore keep emitting PTY bytes, keeping `quietMs` low.
 *
 * We deliberately do NOT also gate on "not at an idle prompt": recent Claude Code
 * keeps the `❯` input caret on screen while a turn is in flight (so the next message
 * can be queued), so a `hasPrompt` guard would neutralise this arm exactly when it's
 * needed. The idle prompt is already covered by `quietMs` — a settled idle TUI emits
 * nothing, so `quietMs` grows past the window and the session reads not-alive. The
 * only cost is a short tail of beats for up to `livenessQuietMs` after a turn ends,
 * which is harmless: the turn's result/idle teardown has already stopped typing.
 */
export function isPtyActivelyWorking(
  obs: { isBusy: boolean; quietMs: number },
  livenessQuietMs: number,
): boolean {
  return obs.isBusy || obs.quietMs < livenessQuietMs;
}
