/**
 * Shared plumbing for the fake Claude Code TUIs used by the PTY-shell tests
 * (mock-claude-tui.js, mock-claude-tui-menu.js): the `auth status` shim, the
 * transcript writers TranscriptTailer reads, the env-var file loggers, and
 * the bracketed-paste stdin state machine. Each mock supplies only its
 * scenario behavior via handlers — protocol fixes land here exactly once.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** `claude auth status` shim — prints a logged-in status and exits. */
function handleAuthShim(args) {
  if (args[0] === 'auth' && args[1] === 'status') {
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'test' }) + '\n');
    process.exit(0);
  }
}

/** Parse --session-id <uuid> from argv (passed by claude-pty-shell.ts). */
function parseSessionId(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id' && args[i + 1]) return args[i + 1];
  }
  return '';
}

function cwd2slug(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

function getTranscriptPath(sessionId) {
  if (!sessionId) return null;
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd2slug(process.cwd()));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

/**
 * Returns a writeTranscript(text) that appends an assistant record (sets
 * sawAssistant in the Driver) plus a turn_duration record (triggers
 * onTurnEnd() → finishTurn()) to the Claude Code transcript JSONL.
 */
function makeTranscriptWriter(sessionId) {
  return function writeTranscript(text) {
    const txPath = getTranscriptPath(sessionId);
    if (!txPath) return;
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: text || '(processed)' }] },
    });
    const duration = JSON.stringify({ type: 'system', subtype: 'turn_duration', duration_ms: 100 });
    fs.appendFileSync(txPath, assistant + '\n' + duration + '\n');
  };
}

/** Returns an append-line logger for the file named by the env var ('' = off). */
function makeFileLogger(envVar) {
  const logPath = process.env[envVar] || '';
  return function logLine(text) {
    if (logPath) fs.appendFileSync(logPath, text + '\n');
  };
}

/**
 * Bracketed-paste stdin state machine. Consumes the wrapper's writes and
 * dispatches:
 *   onEnter(bufferText)  — '\r' outside a paste (bufferText may be '')
 *   onArrow('up'|'down') — bare ESC [A / ESC [B (optional; ignored if absent)
 *   onCtrlU()            — after the buffer was cleared by \x15 (optional)
 * Buffer handling (accumulate printable/paste bytes, clear on ESC/Ctrl+U,
 * hand off on Enter) lives here; the mocks never touch the raw bytes.
 */
function startStdinMachine(handlers) {
  const State = { NORMAL: 0, CSI: 1, PASTE: 2, PASTE_CSI: 3 };
  let state = State.NORMAL;
  let pasteContent = '';
  let normalBuf = '';

  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on('data', (chunk) => {
    const bytes = chunk.toString('binary');

    for (let i = 0; i < bytes.length; i++) {
      const ch = bytes[i];

      switch (state) {
        case State.NORMAL:
          if (ch === '\x1b') {
            const rest = bytes.slice(i + 1);
            if (rest.startsWith('[A')) {
              i += 2;
              if (handlers.onArrow) handlers.onArrow('up');
              break;
            }
            if (rest.startsWith('[B')) {
              i += 2;
              if (handlers.onArrow) handlers.onArrow('down');
              break;
            }
            state = State.CSI;
            normalBuf = '';
          } else if (ch === '\x15') {
            normalBuf = '';
            if (handlers.onCtrlU) handlers.onCtrlU();
          } else if (ch === '\r') {
            const text = normalBuf;
            normalBuf = '';
            handlers.onEnter(text);
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
}

/**
 * Returns an appendRecord(obj) that writes one raw JSONL line to the Claude
 * Code transcript — for scenarios that need fine-grained control over
 * individual record shapes/timing (tool_use, tool_result, sidechain) instead
 * of the combined assistant+turn_duration writeTranscript() helper.
 */
function makeRawTranscriptAppender(sessionId) {
  return function appendRecord(obj) {
    const txPath = getTranscriptPath(sessionId);
    if (!txPath) return;
    fs.appendFileSync(txPath, JSON.stringify(obj) + '\n');
  };
}

module.exports = {
  handleAuthShim,
  parseSessionId,
  makeTranscriptWriter,
  makeRawTranscriptAppender,
  makeFileLogger,
  startStdinMachine,
};
