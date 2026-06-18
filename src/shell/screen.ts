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
 * Interactive select-menu footer markers (e.g. AskUserQuestion). The footer reads
 * "Enter to select · ↑/↓ to navigate · Esc to cancel"; we match on the two stable
 * fragments so spacing/middle-dot variations across TUI versions don't break it.
 */
export const TUI_MENU_FOOTER = ['to navigate', 'to cancel'] as const;
/** A numbered option row, with an optional leading ❯/> highlight marker. */
export const TUI_MENU_OPTION_RE = /^\s*[❯>]?\s*(\d+)\.\s+(.+?)\s*$/;

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
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) {
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

  /**
   * The TUI is showing the recoverable "Request too large (max 32MB)" error.
   * Requires both the error prefix and the dismiss-footer marker so ordinary
   * text mentioning the phrase (e.g. an agent reply) never trips the auto-ESC.
   */
  detectRequestTooLarge(): boolean {
    const text = this.text();
    return text.includes(TUI_REQUEST_TOO_LARGE) && text.includes(TUI_REQUEST_TOO_LARGE_DISMISS);
  }

  detectDialog(): DialogKind | null {
    const text = this.text();
    if (TUI_BYPASS_PERMS.every((s) => text.includes(s))) {
      return 'bypass-permissions';
    }
    return null;
  }

  /**
   * Detect an interactive select menu blocking on keyboard input (e.g. the
   * AskUserQuestion / plan-approval prompt) and parse its numbered options.
   * Returns the options in display order, or null when no menu is on screen.
   *
   * Requires the select-menu footer AND at least two numbered rows — ordinary
   * numbered lists in assistant output never carry the footer, so this won't
   * false-positive on them. The bypass-permissions dialog also matches the
   * footer; callers must check detectDialog() first and let it auto-accept.
   */
  detectMenu(): MenuOption[] | null {
    const text = this.text();
    if (!TUI_MENU_FOOTER.every((s) => text.includes(s))) return null;
    // Scan only the region ABOVE the footer — the live menu's options always
    // sit between the question and the "to navigate · to cancel" footer.
    const lines = text.split('\n');
    const footerIdx = lines.findIndex((l) => TUI_MENU_FOOTER.some((s) => l.includes(s)));
    const region = footerIdx >= 0 ? lines.slice(0, footerIdx) : lines;

    const matches: MenuOption[] = [];
    for (const line of region) {
      const m = TUI_MENU_OPTION_RE.exec(line);
      if (m) matches.push({ index: Number(m[1]), label: m[2].trim() });
    }
    if (matches.length < 2) return null;

    // Scrollback above the menu can contain stale numbered lines (e.g. a prior
    // chat message rendered as "1. … 2. …"). The real select menu always numbers
    // its options 1..N in order, so take the LAST run that starts at "1." and
    // increments by one — that is the live menu nearest the footer, not history.
    // This run's position is what selectMenuOption() types into the TUI, so it
    // MUST mirror the on-screen numbering exactly.
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
}

/**
 * Heartbeat liveness predicate (pure). The PTY session counts as actively working
 * — so the receiver's 5-min stalled detector should be held off — when EITHER the
 * busy spinner is on screen (`isBusy`) OR the PTY produced output more recently than
 * `livenessQuietMs` while not parked at an idle prompt (`!hasPrompt`).
 *
 * The recent-output arm is the robust signal: the exact "esc to interrupt" busy
 * marker can drop off screen for minutes during context compaction, large request
 * assembly, or a long sub-agent run (so `isBusy` reads false), yet those states keep
 * animating a spinner and therefore keep emitting PTY bytes, keeping `quietMs` low.
 * A genuinely hung or idle TUI emits nothing → `quietMs` grows past the window → not
 * alive → the stalled detector fires correctly.
 */
export function isPtyActivelyWorking(
  obs: { isBusy: boolean; hasPrompt: boolean; quietMs: number },
  livenessQuietMs: number,
): boolean {
  return obs.isBusy || (!obs.hasPrompt && obs.quietMs < livenessQuietMs);
}
