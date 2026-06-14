import { Terminal } from '@xterm/headless';
import { serializeScreen } from '../../src/shell/pty-serialize';

const COLS = 200;
const ROWS = 50;

/** Write data into a headless terminal and resolve once xterm has parsed it. */
function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

function makeTerm(): Terminal {
  return new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
}

/** Visible screen as plain text (one string per row), for state comparison. */
function screenText(term: Terminal): string[] {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

/** Feed source bytes, serialize, replay into a fresh term, and return both screens. */
async function roundTrip(source: string): Promise<{ before: string[]; after: string[]; frame: string }> {
  const a = makeTerm();
  await write(a, source);
  const frame = serializeScreen(a);

  const b = makeTerm();
  await write(b, frame);
  return { before: screenText(a), after: screenText(b), frame };
}

describe('serializeScreen', () => {
  it('reproduces plain positioned text', async () => {
    const { before, after } = await roundTrip('\x1b[2J\x1b[H' + 'Hello, world!');
    expect(after).toEqual(before);
    expect(after[0]).toContain('Hello, world!');
  });

  it('reproduces an alt-screen frame with content at the bottom row (the bug case)', async () => {
    // Enter alt-screen, paint a top line and a bottom status bar — the bottom
    // bar is exactly what used to vanish on reconnect.
    const src =
      '\x1b[?1049h\x1b[2J' +
      '\x1b[1;1HClaude is working...' +
      `\x1b[${ROWS};1H` + '\x1b[7m $0.42 · 143k tokens \x1b[0m';
    const { before, after, frame } = await roundTrip(src);
    expect(after).toEqual(before);
    // Bottom row must survive the round-trip.
    expect(after[ROWS - 1]).toContain('$0.42');
    expect(after[ROWS - 1]).toContain('143k tokens');
    // Frame must re-enter alt-screen so the client buffer mode matches.
    expect(frame).toContain('\x1b[?1049h');
  });

  it('survives output that far exceeds any byte ring-buffer (root-cause regression)', async () => {
    // Emit ~1 MB of noisy redraws — well past the old 256 KB cap — then a final
    // full repaint. Serialization reflects the live grid, not a truncated tail,
    // so the whole screen (including the bottom bar) must reconstruct intact.
    let src = '\x1b[?1049h\x1b[2J';
    for (let i = 0; i < 20000; i++) {
      src += `\x1b[1;1HStreaming token chunk number ${i} ............................`;
    }
    src += '\x1b[1;1H\x1b[2J';
    src += '\x1b[1;1HFinal first line';
    src += `\x1b[${ROWS};1H\x1b[7m bottom status bar intact \x1b[0m`;
    const { before, after } = await roundTrip(src);
    expect(after).toEqual(before);
    expect(after[0]).toContain('Final first line');
    expect(after[ROWS - 1]).toContain('bottom status bar intact');
  });

  it('preserves multi-byte UTF-8 content (Thai) without mojibake', async () => {
    const thai = 'แก้ issues จาก code review PR #159';
    const { before, after } = await roundTrip('\x1b[2J\x1b[1;1H' + thai);
    expect(after).toEqual(before);
    expect(after[0]).toContain(thai);
  });

  it('preserves Thai fed via the socket pipeline (latin1 byte-string → bytes)', async () => {
    // Reproduce the EXACT production path that broke the live viewer:
    // the unix socket reads with setEncoding('latin1'), so the registry sees a
    // byte-string where each UTF-8 byte is one latin1 char. Feeding that string
    // straight into xterm stores mojibake; feeding the reconstructed bytes
    // (Uint8Array) makes xterm UTF-8-decode correctly. This test feeds via the
    // bytes path and asserts no mojibake survives into the serialized frame.
    const thai = 'แก้ issues จาก code review PR #159';
    const source = '\x1b[2J\x1b[1;1H' + thai;
    const latin1ByteString = Buffer.from(source, 'utf8').toString('latin1'); // what the socket hands us

    const a = makeTerm();
    await new Promise<void>((r) => a.write(Buffer.from(latin1ByteString, 'latin1'), () => r()));
    const frame = serializeScreen(a);

    const b = makeTerm();
    await write(b, frame);
    expect(screenText(b)[0]).toContain(thai);
    // The mojibake signature (UTF-8 bytes seen as latin1) must NOT appear.
    expect(frame).not.toContain('à¸');
  });

  it('reproduces SGR colors and attributes', async () => {
    const src =
      '\x1b[2J\x1b[1;1H' +
      '\x1b[1;31mBOLD RED\x1b[0m ' + // bold + palette red
      '\x1b[38;2;100;200;050mTRUECOLOR\x1b[0m ' + // RGB fg
      '\x1b[4;32mUNDER GREEN\x1b[0m'; // underline + green
    const { before, after, frame } = await roundTrip(src);
    expect(after).toEqual(before);
    expect(after[0]).toContain('BOLD RED');
    expect(after[0]).toContain('TRUECOLOR');
    // RGB foreground must be serialized in truecolor form.
    expect(frame).toContain('38;2;100;200;50');
  });

  it('restores the cursor position', async () => {
    const a = makeTerm();
    await write(a, '\x1b[2J\x1b[10;25HX');
    const frame = serializeScreen(a);
    const b = makeTerm();
    await write(b, frame);
    // Cursor should be back where the source left it (row 10, col 26 after 'X').
    expect(b.buffer.active.cursorY).toBe(a.buffer.active.cursorY);
    expect(b.buffer.active.cursorX).toBe(a.buffer.active.cursorX);
  });
});
