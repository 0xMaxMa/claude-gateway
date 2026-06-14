import type { Terminal } from '@xterm/headless';
import type { IBufferCell } from '@xterm/headless';

/**
 * Serialize a headless terminal's CURRENT visible screen into a self-contained
 * sequence of escape codes that, written into a fresh xterm, reproduces the same
 * screen exactly.
 *
 * Why this exists: the PTY stream registry used to replay the last N KB of RAW
 * bytes on every (re)connect. An alt-screen TUI (Claude Code runs in the
 * alternate buffer) cannot be reconstructed from a truncated byte tail — the
 * visible screen is the *cumulative* result of every byte since session start.
 * Once output exceeds the ring-buffer cap (which happens fast during an active
 * turn), the front is trimmed mid-sequence: the alt-screen-enter, scroll-region
 * setup, cursor moves, and even multi-byte UTF-8 codepoints get cut in half, so
 * xterm desyncs and renders a blank or garbled screen (notably the infrequently
 * repainted bottom status/cost bar). Serializing the live screen grid instead
 * guarantees the viewer always receives one complete, coherent frame regardless
 * of how much history has scrolled past.
 *
 * The output is a Unicode string (cell chars are decoded) — callers MUST encode
 * it as UTF-8 on the wire, not latin1.
 */
export function serializeScreen(term: Terminal): string {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;

  let out = '\x1b[0m';
  // Match the server's buffer mode so a later '?1049l' (session exit) behaves
  // correctly on the client; alt-screen also clears its own scrollback.
  if (buf.type === 'alternate') out += '\x1b[?1049h';
  out += '\x1b[2J';

  let cell: IBufferCell | undefined;
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    out += `\x1b[${y + 1};1H`;
    if (!line) continue;

    // Find the last column that paints something visible. The screen was already
    // cleared by '\x1b[2J', so trailing blanks need not be emitted — this keeps
    // null cells null (faithful reconstruction) and shrinks the frame a lot.
    let last = -1;
    for (let x = cols - 1; x >= 0; x--) {
      cell = line.getCell(x, cell);
      if (cell && isVisible(cell)) { last = x; break; }
    }
    if (last < 0) continue;

    let curSgr = '';
    for (let x = 0; x <= last; x++) {
      cell = line.getCell(x, cell);
      if (!cell) {
        out += ' ';
        continue;
      }
      // Width 0 = the spacer cell that follows a wide (CJK/emoji) glyph; the
      // glyph itself already emitted its full width, so skip the spacer.
      if (cell.getWidth() === 0) continue;

      const sgr = sgrFor(cell);
      if (sgr !== curSgr) {
        // Reset first so attributes never leak from the previous cell.
        out += '\x1b[0m' + sgr;
        curSgr = sgr;
      }
      const chars = cell.getChars();
      out += chars === '' ? ' ' : chars;
    }
    out += '\x1b[0m';
  }

  // Restore the cursor to where the live screen has it (1-based, viewport-relative).
  out += `\x1b[${buf.cursorY + 1};${buf.cursorX + 1}H`;
  return out;
}

/**
 * Whether a cell paints anything the eye can see. A space with default colors is
 * invisible (so it can be trimmed from a cleared screen), but a space with a
 * background color, or under inverse video (which swaps fg/bg), is visible.
 */
function isVisible(cell: IBufferCell): boolean {
  const ch = cell.getChars();
  if (ch !== '' && ch !== ' ') return true;
  if (!cell.isBgDefault()) return true;
  if (cell.isInverse()) return true;
  return false;
}

/** Build the SGR (Select Graphic Rendition) escape for a single cell's attributes. */
function sgrFor(cell: IBufferCell): string {
  const codes: number[] = [];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);
  if (cell.isOverline()) codes.push(53);

  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    codes.push(38, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  } else if (cell.isFgPalette()) {
    codes.push(38, 5, cell.getFgColor());
  }

  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    codes.push(48, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  } else if (cell.isBgPalette()) {
    codes.push(48, 5, cell.getBgColor());
  }

  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}
