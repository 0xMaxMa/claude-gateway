#!/usr/bin/env node
/**
 * Fake Claude Code TUI for testing the wrapper's pre-paste input clearing
 * (issue #296). Unlike mock-claude-tui.js (whose stdin machine clears the whole
 * buffer on Ctrl+U and REPLACES it on paste), this mock models the real TUI's
 * line-aware input so the concatenation bug can be reproduced faithfully:
 *
 *   - Ctrl+U (\x15)         removes only the LAST line of the input buffer
 *                           (a single Ctrl+U cannot clear a multi-line draft).
 *   - bracketed paste       APPENDS to whatever is already in the buffer
 *                           (so a leftover draft concatenates with the paste).
 *   - Enter (\r)            submits the buffer: logs it to FAKE_TUI_INPUT_LOG,
 *                           writes a transcript turn_duration to end the turn,
 *                           then clears the buffer and returns to idle.
 *
 * FAKE_TUI_STALE_DRAFT pre-seeds the input buffer with a stuck draft (use a
 * literal "\n" to separate lines) — simulating a prior paste whose Enter was
 * swallowed. The buffer is rendered as "❯ <line1>\n<line2>…" so the wrapper's
 * ScreenModel.inputDraft() sees it exactly as the real TUI would.
 */

const {
  handleAuthShim,
  parseSessionId,
  makeTranscriptWriter,
  makeFileLogger,
} = require('./mock-tui-core');

const args = process.argv.slice(2);
handleAuthShim(args);

const writeTranscript = makeTranscriptWriter(parseSessionId(args));
const logInput = makeFileLogger('FAKE_TUI_INPUT_LOG');

// Pre-seeded stale draft (literal "\n" → real newlines), else empty.
let buffer = (process.env.FAKE_TUI_STALE_DRAFT || '').replace(/\\n/g, '\n');
let busy = false;

function render() {
  const body = busy
    ? 'esc to interrupt\r\n❯ ' + buffer.split('\n').join('\r\n')
    : '❯ ' + buffer.split('\n').join('\r\n');
  process.stdout.write('\x1b[2J\x1b[H' + body);
}

// ── stdin state machine: line-aware Ctrl+U + append-on-paste ────────────────
const State = { NORMAL: 0, CSI: 1, PASTE: 2, PASTE_CSI: 3 };
let state = State.NORMAL;
let pasteContent = '';

if (process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();

function onEnter() {
  const text = buffer;
  if (!text.trim()) { render(); return; }
  logInput(text);
  buffer = '';
  busy = true;
  render();
  // Brief busy, then end the turn via the transcript (turn_duration).
  setTimeout(() => {
    busy = false;
    writeTranscript(text);
    render();
  }, 250);
}

function ctrlU() {
  // Remove only the last line — a single Ctrl+U cannot clear a multi-line draft.
  buffer = buffer.includes('\n') ? buffer.slice(0, buffer.lastIndexOf('\n')) : '';
  render();
}

function appendPaste(content) {
  buffer += content; // APPEND — a leftover draft concatenates with the paste.
  render();
}

process.stdin.on('data', (chunk) => {
  const bytes = chunk.toString('binary');
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    switch (state) {
      case State.NORMAL:
        if (ch === '\x1b') {
          const rest = bytes.slice(i + 1);
          if (rest.startsWith('[A') || rest.startsWith('[B')) { i += 2; break; }
          state = State.CSI;
        } else if (ch === '\x15') {
          ctrlU();
        } else if (ch === '\r') {
          onEnter();
        }
        // printable chars outside a paste are ignored (wrapper only pastes)
        break;
      case State.CSI:
        if (ch === '[') {
          const rest = bytes.slice(i + 1);
          if (rest.startsWith('200~')) { state = State.PASTE; pasteContent = ''; i += 4; }
          else if (rest.startsWith('201~')) { state = State.NORMAL; i += 4; }
          else {
            let j = i + 1;
            while (j < bytes.length && !/[A-Za-z~]/.test(bytes[j])) j++;
            i = j; state = State.NORMAL;
          }
        } else { state = State.NORMAL; }
        break;
      case State.PASTE:
        if (ch === '\x1b') state = State.PASTE_CSI;
        else pasteContent += ch;
        break;
      case State.PASTE_CSI:
        if (ch === '[') {
          const rest = bytes.slice(i + 1);
          if (rest.startsWith('201~')) { appendPaste(pasteContent); pasteContent = ''; state = State.NORMAL; i += 4; }
          else { pasteContent += '\x1b['; state = State.PASTE; }
        } else { pasteContent += '\x1b' + ch; state = State.PASTE; }
        break;
    }
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

render();
