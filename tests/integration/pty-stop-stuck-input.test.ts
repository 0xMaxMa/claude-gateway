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
  waitMs,
} from '../helpers/pty-harness';

const MOCK_TUI_BIN = path.resolve(__dirname, '../helpers/mock-claude-tui.js');

function spawnWrapper(inputLog: string): ChildProcess {
  return spawnHarnessWrapper(MOCK_TUI_BIN, { FAKE_TUI_INPUT_LOG: inputLog });
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

    // Wait for wrapper to start (TUI ready takes ~2s)
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('FIRST_MESSAGE'));
    // Wait for fake TUI to log FIRST_MESSAGE
    await waitForLogEntries(inputLog, 1, 4000);

    // fake TUI shows esc-to-interrupt (300ms) then ❯ (idle)
    // Driver's FALLBACK_IDLE_QUIET_MS=2000ms must elapse before turn ends
    // Total: 300ms (fake busy) + 2000ms (quiet) + margin = 3000ms
    await waitMs(3000);

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
    await waitMs(2000); // wait for TUI ready

    // Send M1 — wrapper will paste it into PTY then wait SUBMIT_ENTER_DELAY_MS (300ms)
    wrapper.stdin!.write(makeTurnJson('STUCK_MESSAGE'));
    // Immediately send SIGINT (simulating /stop) before the 300ms delay elapses
    await waitMs(50);
    process.kill(wrapper.pid!, 'SIGINT');

    // Wait for interrupt to settle (interrupting flag clears after turn ends)
    await waitMs(3500);

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
    await waitMs(2500);

    // Send M1 and fire SIGINT during its paste window
    wrapper.stdin!.write(makeTurnJson('INTERRUPTED_MESSAGE'));
    await waitMs(80);
    process.kill(wrapper.pid!, 'SIGINT');

    // Wait for interrupt to fully settle (Ctrl+U fired, turn ended, queue cleared)
    await waitMs(4000);

    // Send a fresh message AFTER interrupt settled
    wrapper.stdin!.write(makeTurnJson('POST_STOP_MESSAGE'));
    const lines = await waitForLogEntries(inputLog, 1, 5000);

    // INTERRUPTED_MESSAGE must not appear (cleared by Ctrl+U)
    expect(lines.some((l) => l.includes('INTERRUPTED_MESSAGE'))).toBe(false);
    // POST_STOP_MESSAGE must arrive clean, not prefixed with stuck text
    expect(lines.some((l) => l === 'POST_STOP_MESSAGE')).toBe(true);
    expect(lines.some((l) => l.includes('INTERRUPTED') && l.includes('POST_STOP'))).toBe(false);
  }, 25000);
});
