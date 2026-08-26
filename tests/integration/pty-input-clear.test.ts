/**
 * I-PTY-INPUT-CLEAR: the wrapper clears the TUI input COMPLETELY before pasting
 * a new turn (issue #296).
 *
 * A single Ctrl+U clears only one input line, so a stale MULTI-line draft left by
 * a prior swallowed Enter would keep its earlier line(s) and the next paste would
 * land after them — merging two messages into one garbled turn (proven from a live
 * transcript: a message's first line survived and the next message concatenated
 * onto it).
 *
 * Spawns the real claude-pty-shell.js wrapper with CLAUDE_REAL_BIN pointing at
 * mock-claude-tui-input.js, a fake TUI that models line-aware input: Ctrl+U removes
 * only the last line, a bracketed paste APPENDS to the buffer, and Enter logs the
 * submitted buffer to FAKE_TUI_INPUT_LOG. FAKE_TUI_STALE_DRAFT pre-seeds a stuck
 * draft. We assert on the submitted text.
 */

import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  makeTurnJson,
  readLogLines,
  spawnWrapper,
  waitForLogEntries,
  waitForWrapperReady,
} from '../helpers/pty-harness';

const MOCK_TUI_BIN = path.resolve(__dirname, '../helpers/mock-claude-tui-input.js');

describe('I-PTY-INPUT-CLEAR: input is cleared fully before a paste', () => {
  let wrapper: ChildProcess;
  let inputLog: string;

  beforeEach(() => {
    inputLog = path.join(os.tmpdir(), `pty-input-clear-${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}.log`);
  });

  afterEach(() => {
    wrapper?.kill('SIGTERM');
    if (fs.existsSync(inputLog)) fs.unlinkSync(inputLog);
  });

  function start(extraEnv: Record<string, string> = {}): void {
    wrapper = spawnWrapper(MOCK_TUI_BIN, { FAKE_TUI_INPUT_LOG: inputLog, ...extraEnv });
  }

  /**
   * I-PTY-INPUT-01 (proven-red centerpiece): a stale 2-line draft is left in the
   * input; the next message must submit ON ITS OWN — never concatenated onto the
   * leftover. On the pre-fix wrapper the single Ctrl+U clears only line 2, the
   * paste appends after line 1, and the submitted text is "STALEONE<msg>".
   */
  it('I-PTY-INPUT-01: does not concatenate a stale multi-line draft with the next message', async () => {
    start({ FAKE_TUI_STALE_DRAFT: 'STALEONE\\nSTALETWO' });
    // Ready = the stale draft is sitting in the input, waiting to contaminate.
    await waitForWrapperReady(wrapper);

    wrapper.stdin!.write(makeTurnJson('FRESHMESSAGE'));

    const lines = await waitForLogEntries(inputLog, 1, 8000);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const submitted = lines[0];
    // The submitted turn is exactly the new message — no leftover draft prepended.
    expect(submitted).toBe('FRESHMESSAGE');
    expect(submitted).not.toContain('STALEONE');
    expect(submitted).not.toContain('STALETWO');
  }, 20000);

  /**
   * I-PTY-INPUT-02: the clear is a no-op on the normal path — an empty prompt with
   * no stale draft submits the message unchanged (clearInput() must not corrupt or
   * drop a clean submission).
   */
  it('I-PTY-INPUT-02: submits a clean message unchanged when the input starts empty', async () => {
    start();
    await waitForWrapperReady(wrapper);

    wrapper.stdin!.write(makeTurnJson('HELLO_WORLD'));

    const lines = await waitForLogEntries(inputLog, 1, 8000);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toBe('HELLO_WORLD');
  }, 20000);
});
