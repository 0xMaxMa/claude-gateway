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

// When set, the fake TUI simulates recent Claude Code (v2.1.227+): its status bar
// never renders the "esc to interrupt" busy marker, and it writes an assistant
// record WITHOUT a turn_duration record. The turn can then only end via the
// Driver's fallback end-of-turn heuristic — which requires sawBusy, now set from
// the transcript (assistant record) rather than the dead screen marker (#290).
const NO_BUSY_MARKER = process.env.FAKE_TUI_NO_BUSY_MARKER === '1';

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
  if (NO_BUSY_MARKER) {
    // No "esc to interrupt" marker anywhere — mirrors v2.1.227. The status line is
    // a spinner + randomized gerund, which we simply omit.
    process.stdout.write('\x1b[2J\x1b[H❯ ');
    setTimeout(() => {
      busy = false;
      // assistant record only — no turn_duration, so the fallback must end the turn.
      writeTranscript(trimmed, { assistantOnly: true });
      idle();
    }, 300);
    return;
  }
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
