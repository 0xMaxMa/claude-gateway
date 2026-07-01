#!/usr/bin/env node
/**
 * Fake Claude Code TUI for integration-testing the behavioral interactive-
 * prompt probe (planning-61). Simulates scripted scenarios, selected by the
 * submitted turn text, covering the cases from planning-61 Task 2:
 *
 *   MENU_FIRST      — a live menu appears; caret starts on the FIRST option
 *                      (Down alone should move it — no Up fallback needed).
 *   MENU_LAST       — a live menu appears; caret starts on the LAST option
 *                      (no wraparound — Down is a no-op, Up fallback must
 *                      detect the reaction).
 *   BUSY_RACE       — the screen goes quiet, then the moment a probe
 *                      keystroke lands, real work resumes (busy marker
 *                      reappears) instead of any menu — the probe must NOT
 *                      mistake this for a live overlay.
 *   RECALL_NONMENU  — the screen goes quiet with a genuinely idle (no menu)
 *                      input box. Down is a no-op; Up recalls unrelated text
 *                      into the input line (simulating input-history recall)
 *                      that doesn't parse as a menu — the wrapper must send a
 *                      restorative Down so the line ends up empty again, and
 *                      must never bridge anything.
 *   NO_REACT        — the screen goes quiet and NEVER reacts to any arrow key
 *                      (genuinely non-interactive scrollback); the probe must
 *                      exhaust its round budget and give up cleanly, and the
 *                      turn still completes normally via the transcript.
 *   (anything else) — baseline: normal turn, no menu, completes as usual.
 *
 * Same protocol as mock-claude-tui.js: reads bracketed-paste + Enter from the
 * wrapper, logs submitted text to FAKE_TUI_INPUT_LOG, and writes the Claude
 * Code transcript JSONL to trigger TranscriptTailer events.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'test' }) + '\n');
  process.exit(0);
}

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
  const assistant = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: text || '(processed)' }] },
  });
  const duration = JSON.stringify({ type: 'system', subtype: 'turn_duration', duration_ms: 100 });
  fs.appendFileSync(txPath, assistant + '\n' + duration + '\n');
}

const INPUT_LOG = process.env.FAKE_TUI_INPUT_LOG || '';
function logInput(text) {
  if (INPUT_LOG) fs.appendFileSync(INPUT_LOG, text + '\n');
}

const EVENT_LOG = process.env.FAKE_TUI_EVENT_LOG || '';
function logEvent(text) {
  if (EVENT_LOG) fs.appendFileSync(EVENT_LOG, text + '\n');
}

function render(screenText) {
  process.stdout.write('\x1b[2J\x1b[H' + screenText);
}

function idle() {
  render('❯ ');
}

// ── scripted scenario state ─────────────────────────────────────────────────
let scenario = null;
let menuCaret = 0;
let recallUpSent = false;
const MENU_OPTIONS = ['First choice', 'Second choice', 'Third choice'];
const MENU_FOOTER = 'Enter to select · ↑/↓ to navigate · Esc to cancel';

function renderMenu() {
  const lines = ['Which option do you want?', ''];
  MENU_OPTIONS.forEach((label, i) => {
    lines.push(`${i === menuCaret ? '❯' : ' '} ${i + 1}. ${label}`);
  });
  lines.push('', MENU_FOOTER);
  render(lines.join('\r\n'));
}

function finishScenario(text) {
  writeTranscript(text);
  idle();
  scenario = null;
}

function submit(text) {
  const trimmed = text.trim();
  if (!trimmed) { idle(); return; }
  logInput(trimmed);

  if (trimmed === 'MENU_FIRST' || trimmed === 'MENU_LAST') {
    scenario = trimmed;
    menuCaret = trimmed === 'MENU_FIRST' ? 0 : MENU_OPTIONS.length - 1;
    render('esc to interrupt\r\n❯ ');
    // Brief busy, then the menu appears and STAYS (no transcript write — an
    // AskUserQuestion tool_use never returns until the human answers).
    setTimeout(renderMenu, 300);
    return;
  }
  if (trimmed === 'BUSY_RACE' || trimmed === 'RECALL_NONMENU' || trimmed === 'NO_REACT') {
    scenario = trimmed;
    recallUpSent = false;
    render('esc to interrupt\r\n❯ ');
    // Go quiet (idle-looking, but the turn is NOT finished — no transcript
    // yet) long enough to clear the busy marker and cross the probe's outer
    // quiet gate (MENU_STABLE_QUIET_MS).
    setTimeout(idle, 300);
    if (trimmed === 'NO_REACT') {
      // Never reacts to a probe keystroke; complete normally after the probe
      // would have exhausted its round budget, so the turn still ends.
      setTimeout(() => finishScenario('no-react-result'), 4000);
    }
    return;
  }

  // Baseline: ordinary turn, no menu.
  render('esc to interrupt\r\n❯ ');
  setTimeout(() => finishScenario(trimmed), 300);
}

function handleArrow(dir) {
  logEvent(`arrow:${dir}:scenario=${scenario}:caret=${menuCaret}`);
  if (scenario === 'MENU_FIRST' || scenario === 'MENU_LAST') {
    if (dir === 'down' && menuCaret < MENU_OPTIONS.length - 1) {
      menuCaret++;
      renderMenu();
    } else if (dir === 'up' && menuCaret > 0) {
      menuCaret--;
      renderMenu();
    }
    // else: at a boundary — no-op, matches a real TUI with no wraparound.
    return;
  }
  if (scenario === 'BUSY_RACE') {
    // Real work "resumes" the instant a probe keystroke lands — only once.
    scenario = null;
    render('esc to interrupt\r\n❯ ');
    setTimeout(() => finishScenario('busy-race-result'), 300);
    return;
  }
  if (scenario === 'RECALL_NONMENU') {
    if (dir === 'up') {
      recallUpSent = true;
      render('❯ some-recalled-history-text');
    } else {
      // Down: either the initial no-op probe, or the wrapper's restorative
      // Down after Up recalled text — either way, empty input is correct.
      idle();
      if (recallUpSent) {
        // This was the restorative Down after Up recalled text — the round
        // is done; complete the turn shortly after, as a real turn
        // eventually would regardless of our probe keystrokes.
        scenario = null;
        setTimeout(() => finishScenario('recall-nonmenu-result'), 300);
      }
    }
    return;
  }
  // NO_REACT (or no active scenario): arrows are a harmless no-op.
}

if (process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();
idle();

const State = { NORMAL: 0, CSI: 1, PASTE: 2, PASTE_CSI: 3 };
let state = State.NORMAL;
let pasteContent = '';
let normalBuf = '';

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
            handleArrow('up');
            break;
          }
          if (rest.startsWith('[B')) {
            i += 2;
            handleArrow('down');
            break;
          }
          state = State.CSI;
          normalBuf = '';
        } else if (ch === '\x15') {
          normalBuf = '';
        } else if (ch === '\r') {
          const text = normalBuf;
          normalBuf = '';
          submit(text);
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
