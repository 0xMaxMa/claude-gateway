#!/usr/bin/env node
/**
 * Fake Claude Code TUI for integration-testing the behavioral interactive-
 * prompt probe (planning-61). Simulates scripted scenarios, selected by the
 * submitted turn text, covering the cases from planning-61 Task 2 and the
 * PR #181 review rounds:
 *
 *   MENU_FIRST          — a live menu appears; caret starts on the FIRST
 *                          option (Down alone should move it — no Up fallback
 *                          needed).
 *   MENU_LAST           — a live menu appears; caret starts on the LAST
 *                          option (no wraparound — Down is a no-op, Up
 *                          fallback must detect the reaction).
 *   BUSY_RACE           — the screen goes quiet, then the moment a probe
 *                          keystroke lands, real work resumes (busy marker
 *                          reappears) instead of any menu — the probe must
 *                          NOT mistake this for a live overlay.
 *   RECALL_NONMENU      — the screen goes quiet with a genuinely idle (no
 *                          menu) input box. Down is a no-op; Up recalls
 *                          unrelated text into the input line (simulating
 *                          input-history recall) that doesn't parse as a
 *                          menu — the wrapper must clear it with Ctrl+U and
 *                          never bridge anything.
 *   RECALL_FAKEMENU     — like RECALL_NONMENU, but the quiet screen also
 *                          shows STATIC menu-shaped text with a real ❯ caret
 *                          row (a quoted earlier menu in scrollback). Up
 *                          recalls text (screen changes) while the static
 *                          rows stay put — the highlight did NOT move, so no
 *                          bridge (PR #181 review, F1).
 *   RECALL_FAKEMENU_NUM — the F1 hole from review round 2 (finding 2): same
 *                          static quoted menu, but the recalled history entry
 *                          BEGINS WITH "2." so the input line itself renders
 *                          as a caret-bearing option row ("❯ 2. …"). The
 *                          highlight must be read from the run's own rows —
 *                          never the input line — so still no bridge.
 *   RECALL_TURNEND      — Up recalls text and the turn completes at that
 *                          same moment (transcript turn_duration lands
 *                          mid-round). The abandoned round must STILL clear
 *                          the recalled text (review round 2, finding 3 —
 *                          every abandon path restores).
 *   NO_REACT            — the screen goes quiet and NEVER reacts to any
 *                          arrow key; the probe must exhaust its round budget
 *                          and give up cleanly, the turn completing normally
 *                          via the transcript.
 *   …SWALLOW_ONCE…      — (substring anywhere in the text) the first Enter
 *                          is swallowed: the draft stays in the input line
 *                          ("❯ <text>"), never busy, no transcript. The
 *                          wrapper's Enter-retry must fire — even when the
 *                          text starts with "N." so the draft renders
 *                          exactly like a caret option row (review round 2,
 *                          findings 1+4: no retry suppression, no probing of
 *                          an unsubmitted draft).
 *   (anything else)     — baseline: normal turn, no menu, completes as usual.
 *
 * Same protocol as mock-claude-tui.js (shared via mock-tui-core.js): reads
 * bracketed-paste + Enter from the wrapper, logs submitted text to
 * FAKE_TUI_INPUT_LOG, arrow/Ctrl+U events to FAKE_TUI_EVENT_LOG, and writes
 * the Claude Code transcript JSONL to trigger TranscriptTailer events.
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
const logEvent = makeFileLogger('FAKE_TUI_EVENT_LOG');

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
let pendingDraft = null; // SWALLOW_ONCE: the draft awaiting the retry Enter
let swallowedOnce = false;
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

// Static menu-shaped scrollback for the RECALL_FAKEMENU* scenarios: a real ❯
// caret row that parses as a menu but belongs to dead text — it can never
// move in response to an arrow key. Only the input line below it varies.
function renderFakeMenu(inputLine) {
  render([
    'Earlier the assistant quoted a menu verbatim:',
    '❯ 1. First choice',
    '  2. Second choice',
    '',
    inputLine,
  ].join('\r\n'));
}

function finishScenario(text) {
  writeTranscript(text);
  idle();
  scenario = null;
}

function submit(text) {
  const trimmed = text.trim();
  if (!trimmed) { idle(); return; }

  if (trimmed.includes('SWALLOW_ONCE') && !swallowedOnce) {
    // Swallow this Enter: keep the draft visible in the input line (first
    // line only — enough for the wrapper's hasPrompt/caret matchers), never
    // go busy, write nothing. The wrapper's Enter-retry resubmits it.
    swallowedOnce = true;
    scenario = 'SWALLOW';
    pendingDraft = trimmed;
    render('❯ ' + trimmed.split('\n')[0]);
    return;
  }

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
  if (['BUSY_RACE', 'RECALL_NONMENU', 'RECALL_FAKEMENU', 'RECALL_FAKEMENU_NUM', 'RECALL_TURNEND', 'NO_REACT'].includes(trimmed)) {
    scenario = trimmed;
    recallUpSent = false;
    render('esc to interrupt\r\n❯ ');
    // Go quiet (idle-looking, but the turn is NOT finished — no transcript
    // yet) long enough to clear the busy marker and cross the probe's outer
    // quiet gate (MENU_STABLE_QUIET_MS).
    const isFake = trimmed === 'RECALL_FAKEMENU' || trimmed === 'RECALL_FAKEMENU_NUM';
    setTimeout(isFake ? () => renderFakeMenu('❯ ') : idle, 300);
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

function paintRecallScreen(inputLine) {
  if (scenario === 'RECALL_FAKEMENU' || scenario === 'RECALL_FAKEMENU_NUM') {
    renderFakeMenu(inputLine);
  } else {
    render(inputLine);
  }
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
  if (scenario === 'RECALL_NONMENU' || scenario === 'RECALL_FAKEMENU'
      || scenario === 'RECALL_FAKEMENU_NUM' || scenario === 'RECALL_TURNEND') {
    if (dir === 'up') {
      recallUpSent = true;
      // The recalled history entry: for the _NUM variant it begins with "2."
      // so the input line renders as a caret-bearing option row.
      paintRecallScreen(scenario === 'RECALL_FAKEMENU_NUM'
        ? '❯ 2. remove the old files'
        : '❯ some-recalled-history-text');
      if (scenario === 'RECALL_TURNEND') {
        // The turn completes at this very moment — turn_duration lands while
        // the probe round is still settling its Up keystroke.
        writeTranscript('turnend-result');
      }
    } else {
      // Down before the Up fallback (the initial no-op probe): repaint as-is.
      paintRecallScreen('❯ ');
    }
    return;
  }
  // NO_REACT / SWALLOW (or no active scenario): arrows are a harmless no-op.
}

function handleCtrlU() {
  logEvent(`ctrlu:scenario=${scenario}:recall=${recallUpSent}`);
  if ((scenario === 'RECALL_NONMENU' || scenario === 'RECALL_FAKEMENU'
       || scenario === 'RECALL_FAKEMENU_NUM' || scenario === 'RECALL_TURNEND')
      && recallUpSent) {
    // The wrapper cleared the recalled text — input line is empty again.
    paintRecallScreen('❯ ');
    if (scenario !== 'RECALL_TURNEND') {
      // The round is done; complete the turn shortly after, as a real turn
      // eventually would regardless of our probe keystrokes.
      // (RECALL_TURNEND already wrote its transcript at Up time.)
      const done = scenario;
      scenario = null;
      setTimeout(() => finishScenario(`${done.toLowerCase()}-result`), 300);
    } else {
      scenario = null;
    }
  }
}

idle();

startStdinMachine({
  onEnter: (text) => {
    if (pendingDraft !== null && !text.trim()) {
      // The wrapper's Enter-retry after the swallowed submit — accept it now.
      const draft = pendingDraft;
      pendingDraft = null;
      scenario = null;
      submit(draft);
      return;
    }
    submit(text);
  },
  onArrow: handleArrow,
  onCtrlU: handleCtrlU,
});
