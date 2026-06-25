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
 * Env:
 *   FAKE_TUI_INPUT_LOG  path to append each submitted text (one per line)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);

// ── auth status ─────────────────────────────────────────────────────────────
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'test' }) + '\n');
  process.exit(0);
}

// ── transcript helpers ───────────────────────────────────────────────────────
// Parse --session-id <uuid> from args (passed by claude-pty-shell.ts)
let sessionId = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id' && args[i + 1]) sessionId = args[i + 1];
}

function cwd2slug(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

function getTranscriptPath() {
  if (!sessionId) return null;
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd2slug(process.cwd()));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

function writeTranscript(text) {
  const txPath = getTranscriptPath();
  if (!txPath) return;
  // assistant record: sets sawAssistant=true in Driver
  const assistant = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: text || '(processed)' }] },
  });
  // turn_duration: triggers onTurnEnd() → finishTurn() in Driver
  const duration = JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    duration_ms: 100,
  });
  fs.appendFileSync(txPath, assistant + '\n' + duration + '\n');
}

// ── TUI simulation ───────────────────────────────────────────────────────────
const INPUT_LOG = process.env.FAKE_TUI_INPUT_LOG || '';

function logInput(text) {
  if (INPUT_LOG) fs.appendFileSync(INPUT_LOG, text + '\n');
}

function idle() {
  // Clear screen so "esc to interrupt" is gone; then show only idle prompt.
  // This mirrors Ink's full re-render and ensures isBusy()=false.
  process.stdout.write('\x1b[2J\x1b[H❯ ');
}

// Show initial ready prompt
idle();

// Input state machine (proper bracketed paste handling)
const State = { NORMAL: 0, CSI: 1, PASTE: 2, PASTE_CSI: 3 };
let state = State.NORMAL;
let pasteContent = '';
let normalBuf = '';
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

if (process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();

process.stdin.on('data', (chunk) => {
  const bytes = chunk.toString('binary');

  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];

    switch (state) {
      case State.NORMAL:
        if (ch === '\x1b') {
          state = State.CSI;
          normalBuf = '';
        } else if (ch === '\x15') {
          normalBuf = '';
        } else if (ch === '\r') {
          const text = normalBuf;
          normalBuf = '';
          if (!busy) submit(text);
          else idle();
        } else if (ch.charCodeAt(0) >= 0x20 || ch === '\n' || ch === '\t') {
          normalBuf += ch;
        }
        break;

      case State.CSI:
        if (ch === '[') {
          const rest = bytes.slice(i + 1);
          if (rest.startsWith('200~')) {
            state = State.PASTE;
            pasteContent = '';
            i += 4;
          } else if (rest.startsWith('201~')) {
            state = State.NORMAL;
            i += 4;
          } else {
            // Skip CSI sequence (cursor moves, etc.)
            let j = i + 1;
            while (j < bytes.length && !/[A-Za-z~]/.test(bytes[j])) j++;
            i = j;
            state = State.NORMAL;
          }
        } else if (ch === '\x1b') {
          normalBuf = '';
        } else {
          state = State.NORMAL;
        }
        break;

      case State.PASTE:
        if (ch === '\x1b') {
          state = State.PASTE_CSI;
        } else {
          pasteContent += ch;
        }
        break;

      case State.PASTE_CSI:
        if (ch === '[') {
          const rest = bytes.slice(i + 1);
          if (rest.startsWith('201~')) {
            normalBuf = pasteContent;
            pasteContent = '';
            state = State.NORMAL;
            i += 4;
          } else {
            pasteContent += '\x1b[';
            state = State.PASTE;
          }
        } else {
          pasteContent += '\x1b' + ch;
          state = State.PASTE;
        }
        break;
    }
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
