import { Terminal } from '@xterm/headless';

export type DialogKind = 'bypass-permissions' | 'trust-folder' | 'unknown-select';

/** The TUI renders spaces as U+00A0 (non-breaking) — normalize before matching. */
function normalize(text: string): string {
  return text.replace(/ /g, ' ');
}

/**
 * TUI string constants — verified against Claude Code v2.1.x.
 * When upgrading Claude Code, re-check each constant against the new TUI output.
 * All matchers live here so a UI change requires touching exactly one file.
 *
 *   BUSY_MARKER        status bar text during an active turn
 *   PROMPT_RE          idle input caret pattern
 *   BYPASS_PERMS       "Bypass Permissions" dialog markers
 *   TRUST_FOLDER       workspace trust dialog marker
 *   NUMBERED_SELECT_RE generic numbered select — combined with CONFIRM_MARKER
 */
export const TUI_BUSY_MARKER = 'esc to interrupt';
export const TUI_PROMPT_RE = /^❯ /m;
export const TUI_BYPASS_PERMS = ['Bypass Permissions mode', 'Yes, I accept'] as const;
export const TUI_TRUST_FOLDER = 'Do you trust the files in this folder';
export const TUI_NUMBERED_SELECT_RE = /❯ 1\./;
export const TUI_CONFIRM_MARKER = 'Enter to confirm';

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

  detectDialog(): DialogKind | null {
    const text = this.text();
    if (TUI_BYPASS_PERMS.every((s) => text.includes(s))) {
      return 'bypass-permissions';
    }
    if (text.includes(TUI_TRUST_FOLDER)) {
      return 'trust-folder';
    }
    // Generic numbered select dialog while no turn output is flowing.
    if (!text.includes(TUI_BUSY_MARKER) && TUI_NUMBERED_SELECT_RE.test(text) && text.includes(TUI_CONFIRM_MARKER)) {
      return 'unknown-select';
    }
    return null;
  }
}
