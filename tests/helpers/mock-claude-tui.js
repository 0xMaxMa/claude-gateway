#!/usr/bin/env node
/**
 * Fake Claude Code TUI for E2E testing of PTY-shell stuck-input bug.
 *
 * Invocation modes:
 *   node mock-claude-tui.js auth status   → prints {"loggedIn":true} and exits
 *   node mock-claude-tui.js [...]         → runs the fake TUI
 *
 * What it simulates:
 *   1. Shows "❯ " → Driver.hasPrompt() = true, TUI marked ready
 *   2. On bracketed-paste + Enter: logs submitted text to FAKE_TUI_INPUT_LOG,
 *      shows "esc to interrupt" briefly (isBusy=true), then clears screen
 *      and shows "❯ " (isBusy=false) to signal processing is complete.
 *   3. Writes a minimal Claude Code transcript JSONL (assistant record +
 *      turn_duration) so TranscriptTailer triggers sawAssistant + finishTurn().
 *   4. Handles ESC (clear buffer) and Ctrl+U (clear buffer).
 *
 * Auth shim, transcript writing, logging, and the bracketed-paste stdin state
 * machine live in mock-tui-core.js (shared with mock-claude-tui-menu.js).
 *
 * Env:
 *   FAKE_TUI_INPUT_LOG  path to append each submitted text (one per line)
 */

const {
  handleAuthShim,
  parseSessionId,
  makeTranscriptWriter,
  makeFileLogger,
  startStdinMachine,
} = require('./mock-tui-core');

const args = process.argv.slice(2);
handleAuthShim(args);

const writeTranscript = makeTranscriptWriter(parseSessionId(args));
const logInput = makeFileLogger('FAKE_TUI_INPUT_LOG');

function idle() {
  // Clear screen so "esc to interrupt" is gone; then show only idle prompt.
  // This mirrors Ink's full re-render and ensures isBusy()=false.
  process.stdout.write('\x1b[2J\x1b[H❯ ');
}

// Show initial ready prompt
idle();

let busy = false;

function submit(text) {
  const trimmed = text.trim();
  if (!trimmed) { idle(); return; }
  busy = true;
  logInput(trimmed);
  // Show busy state
  process.stdout.write('\x1b[2J\x1b[Hesc to interrupt\r\n❯ ');
  setTimeout(() => {
    busy = false;
    // Write transcript so TranscriptTailer fires sawAssistant + onTurnEnd
    writeTranscript(trimmed);
    // Return to idle so Driver's fallback can detect turn end
    idle();
  }, 300);
}

startStdinMachine({
  onEnter: (text) => {
    if (!busy) submit(text);
    else idle();
  },
});
