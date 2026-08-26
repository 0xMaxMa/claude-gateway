/**
 * I-PTY-STOP: PTY-shell /stop stuck-input regression tests
 *
 * Verifies that after /stop (SIGINT) the PTY input line is cleared so the
 * user's next message is submitted clean — not prepended with stale text.
 *
 * Architecture: spawns the real claude-pty-shell.js wrapper with
 * CLAUDE_REAL_BIN pointing at mock-claude-tui.js (a fake Ink TUI).
 * The wrapper reads JSON turns from stdin (same as SessionProcess sends it)
 * and the fake TUI logs every submitted line to FAKE_TUI_INPUT_LOG so the
 * test can assert exactly what text reached the TUI input.
 *
 * SIGINT is sent to the WRAPPER process (not the fake TUI), exactly as the
 * gateway does when /stop arrives: the wrapper translates SIGINT → ESC to
 * the PTY + sets this.interrupting, then clears the PTY input via Ctrl+U.
 */

import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  makeTurnJson,
  spawnWrapper as spawnHarnessWrapper,
  waitForLogEntries,
  waitForResults,
  waitForWrapperReady,
  waitMs,
} from '../helpers/pty-harness';

const MOCK_TUI_BIN = path.resolve(__dirname, '../helpers/mock-claude-tui.js');

function spawnWrapper(inputLog: string): ChildProcess {
  return spawnHarnessWrapper(MOCK_TUI_BIN, { FAKE_TUI_INPUT_LOG: inputLog });
}

function spawnWrapperNoMarker(inputLog: string): ChildProcess {
  return spawnHarnessWrapper(MOCK_TUI_BIN, {
    FAKE_TUI_INPUT_LOG: inputLog,
    FAKE_TUI_NO_BUSY_MARKER: '1',
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('I-PTY-STOP: /stop does not leave stuck text in PTY input', () => {
  let wrapper: ChildProcess;
  let inputLog: string;

  beforeEach(() => {
    inputLog = path.join(os.tmpdir(), `pty-stop-test-${Date.now()}.log`);
  });

  afterEach(() => {
    wrapper?.kill('SIGTERM');
    if (fs.existsSync(inputLog)) fs.unlinkSync(inputLog);
  });

  /**
   * I-PTY-STOP-01: Normal flow (no /stop) — M1 then M2 are submitted separately.
   * Baseline: verifies the test harness works end-to-end.
   */
  it('I-PTY-STOP-01: baseline — two sequential messages each submitted clean', async () => {
    wrapper = spawnWrapper(inputLog);

    await waitForWrapperReady(wrapper);

    wrapper.stdin!.write(makeTurnJson('FIRST_MESSAGE'));
    // Wait for fake TUI to log FIRST_MESSAGE
    await waitForLogEntries(inputLog, 1, 4000);

    // The wrapper emits one `result` per finished turn — wait for that rather
    // than for 300ms of fake-busy + FALLBACK_IDLE_QUIET_MS + a guessed margin.
    await waitForResults(wrapper, 1);

    wrapper.stdin!.write(makeTurnJson('SECOND_MESSAGE'));
    const lines = await waitForLogEntries(inputLog, 2, 5000);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('FIRST_MESSAGE');
    expect(lines[1]).toBe('SECOND_MESSAGE');
    expect(lines[1]).not.toContain('FIRST_MESSAGE');
  }, 25000);

  /**
   * I-PTY-STOP-02: /stop during typeAndSubmit wait
   * Send M1 → immediately send SIGINT (before Enter) → send M2.
   * M2 must be submitted clean, M1 must not appear in the log.
   */
  it('I-PTY-STOP-02: /stop during paste → M2 submitted without M1 stuck text', async () => {
    wrapper = spawnWrapper(inputLog);
    await waitForWrapperReady(wrapper);

    // Send M1 — wrapper will paste it into PTY then wait SUBMIT_ENTER_DELAY_MS (300ms)
    wrapper.stdin!.write(makeTurnJson('STUCK_MESSAGE'));
    // Immediately send SIGINT (simulating /stop) before the 300ms delay elapses
    await waitMs(50);
    process.kill(wrapper.pid!, 'SIGINT');

    // The interrupted turn still ends with a `result` — that event, not a
    // fixed 3.5s, is when the interrupting flag has cleared.
    await waitForResults(wrapper, 1);

    // Send M2
    wrapper.stdin!.write(makeTurnJson('CLEAN_MESSAGE'));
    const lines = await waitForLogEntries(inputLog, 1, 5000);

    // STUCK_MESSAGE should never have been submitted (Ctrl+U cleared it)
    expect(lines.some((l) => l.includes('STUCK_MESSAGE'))).toBe(false);
    // CLEAN_MESSAGE should be submitted clean
    expect(lines.some((l) => l === 'CLEAN_MESSAGE')).toBe(true);
    // CLEAN_MESSAGE must not be prefixed with stuck text
    expect(lines.some((l) => l.includes('STUCK') && l.includes('CLEAN'))).toBe(false);
  }, 20000);

  /**
   * I-PTY-STOP-03: /stop drops queue — message sent AFTER interrupt settles is clean.
   * When /stop fires during a paste, Ctrl+U clears PTY input AND queue.
   * A new message sent after the interrupt settles is submitted without contamination.
   */
  it('I-PTY-STOP-03: message after /stop settles is submitted without stuck text', async () => {
    wrapper = spawnWrapper(inputLog);
    await waitForWrapperReady(wrapper);

    // Send M1 and fire SIGINT during its paste window
    wrapper.stdin!.write(makeTurnJson('INTERRUPTED_MESSAGE'));
    await waitMs(80);
    process.kill(wrapper.pid!, 'SIGINT');

    // Interrupt fully settled = the turn ended (Ctrl+U fired, queue cleared).
    await waitForResults(wrapper, 1);

    // Send a fresh message AFTER interrupt settled
    wrapper.stdin!.write(makeTurnJson('POST_STOP_MESSAGE'));
    const lines = await waitForLogEntries(inputLog, 1, 5000);

    // INTERRUPTED_MESSAGE must not appear (cleared by Ctrl+U)
    expect(lines.some((l) => l.includes('INTERRUPTED_MESSAGE'))).toBe(false);
    // POST_STOP_MESSAGE must arrive clean, not prefixed with stuck text
    expect(lines.some((l) => l === 'POST_STOP_MESSAGE')).toBe(true);
    expect(lines.some((l) => l.includes('INTERRUPTED') && l.includes('POST_STOP'))).toBe(false);
  }, 25000);

  /**
   * I-PTY-STOP-04 (Issue #290): the turn still ends when the TUI never renders the
   * "esc to interrupt" busy marker (v2.1.227+). With no marker, sawBusy used to
   * stay false forever, so the fallback end-of-turn (sawBusy && sawAssistant) never
   * fired and the SECOND message hung behind an unended turn. sawBusy is now set
   * from the transcript assistant record, so the fallback fires and M2 submits.
   *
   * Proven-red: revert the onAssistant sawBusy assignment in claude-pty-shell.ts and
   * only FIRST_NO_MARKER reaches the log (M1's turn never ends → M2 stays queued).
   */
  it('I-PTY-STOP-04: turn ends via fallback with no busy marker, so the next message submits', async () => {
    wrapper = spawnWrapperNoMarker(inputLog);
    await waitForWrapperReady(wrapper);

    wrapper.stdin!.write(makeTurnJson('FIRST_NO_MARKER'));
    await waitForLogEntries(inputLog, 1, 5000);

    // The fallback must end the turn for M2 to submit at all. Waiting for the
    // `result` asserts exactly that — and on the pre-fix code it never arrives,
    // which is the proven-red behaviour described above.
    await waitForResults(wrapper, 1);

    wrapper.stdin!.write(makeTurnJson('SECOND_NO_MARKER'));
    const lines = await waitForLogEntries(inputLog, 2, 6000);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('FIRST_NO_MARKER');
    expect(lines[1]).toBe('SECOND_NO_MARKER');
  }, 30000);
});
