import { Terminal } from '@xterm/headless';

export type DialogKind = 'bypass-permissions' | 'trust-folder' | 'unknown-select';

/** The TUI renders spaces as U+00A0 (non-breaking) — normalize before matching. */
function normalize(text: string): string {
  return text.replace(/ /g, ' ');
}

/**
 * Virtual terminal fed with raw PTY bytes. Used ONLY for liveness signals
 * (busy / idle / dialog detection) — assistant text is never parsed from
 * the screen; the transcript JSONL is the text source of truth.
 *
 * All TUI string matchers live here so a Claude Code release that changes
 * the UI requires touching exactly one file.
 *
 * Verified against Claude Code v2.x. When upgrading Claude Code, re-check:
 *   isBusy            "esc to interrupt"         (status bar during active turn)
 *   hasPrompt         /^❯ /m                     (idle input prompt)
 *   bypass-perms      "Bypass Permissions mode" + "Yes, I accept"
 *   trust-folder      "Do you trust the files in this folder"
 *   unknown-select    /❯ 1\./ + "Enter to confirm"
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
    if (normalize(data).includes('esc to interrupt')) this.busySeenInRaw = true;
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
    return this.text().includes('esc to interrupt');
  }

  /** Consume the raw-chunk busy flag (catches turns faster than the poll interval). */
  consumeBusySeen(): boolean {
    const seen = this.busySeenInRaw;
    this.busySeenInRaw = false;
    return seen;
  }

  /** Idle input prompt is on screen. */
  hasPrompt(): boolean {
    return /^❯ /m.test(this.text());
  }

  detectDialog(): DialogKind | null {
    const text = this.text();
    if (text.includes('Bypass Permissions mode') && text.includes('Yes, I accept')) {
      return 'bypass-permissions';
    }
    if (text.includes('Do you trust the files in this folder')) {
      return 'trust-folder';
    }
    // Generic numbered select dialog while no turn output is flowing.
    if (!text.includes('esc to interrupt') && /❯ 1\./.test(text) && text.includes('Enter to confirm')) {
      return 'unknown-select';
    }
    return null;
  }
}
