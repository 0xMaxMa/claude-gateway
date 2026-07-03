/**
 * I-PTY-MENU-PROBE: behavioral interactive-prompt probe integration tests
 * (planning-61).
 *
 * Verifies the behavioral probe (send an arrow keystroke, check whether the
 * screen reacts) that replaced the old screen-regex menu/permission
 * detectors + transcript menuToolSeen gate. Spawns the real
 * claude-pty-shell.js wrapper with CLAUDE_REAL_BIN pointing at
 * mock-claude-tui-menu.js, a scripted fake TUI that simulates each scenario
 * on cue (see that file's header for the full scenario list).
 *
 * The wrapper's own stdout carries the stream-json protocol events
 * (ProtocolEmitter) — a confirmed bridge shows up as a
 * {type:'system', subtype:'menu_prompt', ...} line, and a normal completion
 * as {type:'result', ...}. Tests assert on those events rather than reading
 * PTY screen state directly.
 */

import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EventCollector,
  ProtocolEvent,
  makeTurnJson,
  readLogLines,
  spawnWrapper,
  waitFor,
  waitMs,
} from '../helpers/pty-harness';

const MOCK_TUI_BIN = path.resolve(__dirname, '../helpers/mock-claude-tui-menu.js');

describe('I-PTY-MENU-PROBE: behavioral probe confirms/rejects a live overlay', () => {
  let wrapper: ChildProcess;
  let inputLog: string;
  let eventLog: string;
  let collector: EventCollector;

  beforeEach(() => {
    const stamp = Date.now();
    inputLog = path.join(os.tmpdir(), `pty-menu-probe-input-${stamp}.log`);
    eventLog = path.join(os.tmpdir(), `pty-menu-probe-events-${stamp}.log`);
    collector = new EventCollector();
  });

  afterEach(() => {
    wrapper?.kill('SIGTERM');
    if (fs.existsSync(inputLog)) fs.unlinkSync(inputLog);
    if (fs.existsSync(eventLog)) fs.unlinkSync(eventLog);
  });

  function start(extraEnv: Record<string, string> = {}): void {
    wrapper = spawnWrapper(MOCK_TUI_BIN, {
      FAKE_TUI_INPUT_LOG: inputLog,
      FAKE_TUI_EVENT_LOG: eventLog,
      ...extraEnv,
    });
    collector.attach(wrapper);
  }

  /** Arrow/Ctrl+U events the fake TUI observed, as 'down' | 'up' | 'ctrlu'. */
  function keyEvents(): string[] {
    return readLogLines(eventLog).map((l) => l.split(':')[0] === 'ctrlu' ? 'ctrlu' : l.split(':')[1]);
  }

  /** Asserts the restore shape: down (no-op) → up (recall) → Ctrl+U (clear). */
  function expectRecallRestored(): void {
    const keys = keyEvents();
    const upIdx = keys.indexOf('up');
    expect(upIdx).toBeGreaterThan(-1);
    expect(keys[upIdx - 1]).toBe('down');
    expect(keys.slice(upIdx + 1)).toContain('ctrlu');
  }

  /**
   * I-PTY-MENU-01: Down alone moves the caret (caret starts on the first
   * option) — the probe should confirm and bridge on its very first attempt,
   * no Up fallback needed.
   */
  it('I-PTY-MENU-01: bridges a menu when Down alone reveals it', async () => {
    start();
    await waitMs(2500); // wrapper + fake TUI ready

    wrapper.stdin!.write(makeTurnJson('MENU_FIRST'));

    const bridged = await waitFor(
      () => !!collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt'),
      6000,
    );
    expect(bridged).toBe(true);
    const menuEvent = collector.find((e) => e.subtype === 'menu_prompt') as ProtocolEvent & { options: unknown[] };
    expect(menuEvent.options).toHaveLength(3);
  }, 20000);

  /**
   * I-PTY-MENU-02: caret starts on the LAST option (no wraparound) — Down is
   * a no-op, so the probe must retry with Up before concluding there's no
   * menu (the specific boundary case the user raised).
   */
  it('I-PTY-MENU-02: bridges a menu via the Up fallback at the last option', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('MENU_LAST'));

    const bridged = await waitFor(
      () => !!collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt'),
      6000,
    );
    expect(bridged).toBe(true);

    await waitFor(() => readLogLines(eventLog).length > 0, 1000);
    const arrows = keyEvents().filter((k) => k === 'up' || k === 'down');
    // Down was tried first (no-op at the last option), then Up moved the caret.
    expect(arrows[0]).toBe('down');
    expect(arrows).toContain('up');
  }, 20000);

  /**
   * I-PTY-MENU-03: the screen changes because real work resumed (busy marker
   * reappears), not because a menu reacted — the probe must not mis-bridge a
   * phantom menu, and the turn must still complete normally afterward.
   */
  it('I-PTY-MENU-03: does not bridge on a busy-race look-alike change', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('BUSY_RACE'));

    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      8000,
    );
    expect(completed).toBe(true);
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();
    const result = collector.find((e) => e.type === 'result') as ProtocolEvent & { subtype: string };
    expect(result.subtype).toBe('success');
  }, 20000);

  /**
   * I-PTY-MENU-04: no menu is present. Down is a no-op; the Up fallback
   * recalls unrelated text into the input line (simulating history recall)
   * that doesn't parse as a menu — the wrapper must clear the recalled text
   * with Ctrl+U (never a compensating Down: recalled entries can be
   * multi-line, where Down only moves the cursor) and never bridge anything.
   */
  it('I-PTY-MENU-04: clears the input after an Up-recall that is not a menu, without bridging', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('RECALL_NONMENU'));

    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      8000,
    );
    expect(completed).toBe(true);
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();
    expectRecallRestored();
  }, 20000);

  /**
   * I-PTY-MENU-07: the fake-menu regression from the PR #181 review (F1).
   * The quiet screen shows STATIC menu-shaped text with a real ❯ caret row
   * (a quoted earlier menu in scrollback) above a genuinely idle input box.
   * Down no-ops; Up recalls text — the screen CHANGES, and the static rows
   * still parse as a menu, but the highlight did not move. The wrapper must
   * refuse to bridge (highlight-move confirmation), clear the recalled text,
   * and let the turn complete normally. Before the hardening this exact
   * sequence bridged a fabricated menu to chat.
   */
  it('I-PTY-MENU-07: never bridges static menu-shaped text whose highlight cannot move', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('RECALL_FAKEMENU'));

    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      8000,
    );
    expect(completed).toBe(true);
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();
    expectRecallRestored();
  }, 20000);

  /**
   * I-PTY-MENU-08: the F1 hole from review round 2 (finding 2). Same static
   * quoted menu, but the recalled history entry BEGINS WITH "2." — the input
   * line itself renders as a caret-bearing option row ("❯ 2. …"), so a
   * whole-screen caret scan would read the highlight as "moved" from the
   * static row to the input line and bridge a fabricated menu. The highlight
   * must be read from the option run's own rows only: no bridge, recalled
   * text cleared, turn completes normally.
   */
  it('I-PTY-MENU-08: a recalled entry starting with "N." cannot forge a highlight move', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('RECALL_FAKEMENU_NUM'));

    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      8000,
    );
    expect(completed).toBe(true);
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();
    expectRecallRestored();
  }, 20000);

  /**
   * I-PTY-MENU-09: the turn ends (transcript turn_duration lands) at the
   * same moment the Up fallback recalls text — the round is abandoned
   * mid-flight. Every abandon path must still clear the recalled text
   * (review round 2, finding 3): without the restore, the stale recalled
   * entry would be prepended to the next submitted message.
   */
  it('I-PTY-MENU-09: an abandoned round (turn ended mid-probe) still clears the Up-recall', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('RECALL_TURNEND'));

    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      8000,
    );
    expect(completed).toBe(true);
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();

    // The Ctrl+U restore must arrive even though the turn ended mid-round.
    const restored = await waitFor(() => keyEvents().includes('ctrlu'), 3000);
    expect(restored).toBe(true);
  }, 20000);

  /**
   * I-PTY-MENU-10: swallowed-Enter recovery for a draft that renders exactly
   * like a menu option row (review round 2, findings 1+4). The submitted text
   * starts with "1." and its Enter is swallowed, so the draft sits in the
   * input line as "❯ 1. …" — indistinguishable by text from a highlighted
   * menu row. The wrapper must (a) NOT probe it with arrows (no busy or
   * transcript output yet → a menu is impossible), and (b) NOT let the
   * caret-shaped draft suppress the Enter-retry — the retry resubmits and
   * the turn completes. Before the fix this state wedged into the 30-min
   * watchdog and killed the session.
   */
  it('I-PTY-MENU-10: a numbered draft with a swallowed Enter is retried, not probed or wedged', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('1. SWALLOW_ONCE fix the login bug'));

    // The Enter-retry fires SUBMIT_RETRY_AFTER_MS (4s) after the paste.
    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      12000,
    );
    expect(completed).toBe(true);
    const result = collector.find((e) => e.type === 'result') as ProtocolEvent & { subtype: string };
    expect(result.subtype).toBe('success');
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();
    // The probe must never have fired into the unsubmitted draft.
    expect(keyEvents().filter((k) => k === 'up' || k === 'down')).toHaveLength(0);
  }, 25000);

  /**
   * I-PTY-MENU-05: no interactive overlay ever appears and nothing reacts to
   * either arrow key. The probe must exhaust its round budget and give up
   * cleanly — the turn still completes normally via the transcript, exactly
   * as a plain non-menu stall does today (no new hang mode introduced).
   */
  it('I-PTY-MENU-05: gives up cleanly when nothing reacts, turn still completes', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('NO_REACT'));

    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      8000,
    );
    expect(completed).toBe(true);
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();
  }, 20000);

  /**
   * I-PTY-MENU-06: an ordinary turn with no menu at any point completes
   * normally with no visible probe side-effects reaching the fake TUI's
   * submitted-text log (baseline — the probe never fires because the turn
   * never stalls quietly for MENU_STABLE_QUIET_MS).
   */
  it('I-PTY-MENU-06: an ordinary turn with no stall completes with no probe side-effects', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('ORDINARY_MESSAGE'));

    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      6000,
    );
    expect(completed).toBe(true);
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();
    expect(keyEvents().filter((k) => k === 'up' || k === 'down')).toHaveLength(0); // no arrow keys were ever sent
  }, 20000);

  /**
   * I-PTY-MENU-11: a Task-tool sub-agent run. A non-sidechain tool_use lands,
   * then the screen goes idle-looking (no busy marker, ❯ prompt visible) for
   * longer than FALLBACK_IDLE_QUIET_MS (2000ms) while the sub-agent works
   * invisibly (its own transcript records would be sidechain — never written
   * here, since the fix must not depend on seeing them). Before the fix, the
   * fallback idle-detection heuristic ended the turn at ~2s of screen quiet,
   * orphaning the real final answer that arrives once the matching
   * tool_result lands.
   */
  it('I-PTY-MENU-11: a pending Task tool_use blocks the fallback idle finish until its tool_result lands', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('TASK_WAIT'));

    // The sub-agent is still "running" (screen quiet, no busy marker, no
    // tool_result yet) — the pre-fix fallback would already have ended the
    // turn by ~2s. It must still be open.
    await waitMs(2600);
    expect(collector.find((e) => e.type === 'result')).toBeUndefined();

    // Once the tool_result + final answer land, the turn completes with the
    // real text — not an early, truncated one.
    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      5000,
    );
    expect(completed).toBe(true);
    const result = collector.find((e) => e.type === 'result') as ProtocolEvent & { subtype: string; result?: string };
    expect(result.subtype).toBe('success');
    expect(result.result).toContain('task-wait-final-result');
  }, 20000);

  /**
   * I-PTY-MENU-12: a SIDECHAIN tool_result must NOT clear the pending gate.
   * During a Task wait, a sub-agent's own internal tool_result (sidechain) for
   * the same id lands first; the tailer filters it, so the turn stays open. It
   * completes only when the real, main-chain tool_result arrives. Guards the
   * core correctness property of the fix — that the gate keys off main-chain
   * results only — which the unit test proves at the tailer boundary but which
   * had no end-to-end coverage through the Driver.
   */
  it('I-PTY-MENU-12: a sidechain tool_result does not end the turn; only the main-chain one does', async () => {
    start();
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('TASK_WAIT_SIDECHAIN'));

    // Sidechain result lands at ~2600ms and the screen is quiet — if it wrongly
    // cleared the gate, the fallback would end the turn here. It must not.
    await waitMs(3200);
    expect(collector.find((e) => e.type === 'result')).toBeUndefined();

    // The real main-chain result (~4500ms) completes the turn with real text.
    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      4000,
    );
    expect(completed).toBe(true);
    const result = collector.find((e) => e.type === 'result') as ProtocolEvent & { subtype: string; result?: string };
    expect(result.subtype).toBe('success');
    expect(result.result).toContain('task-sidechain-final-result');
  }, 20000);

  /**
   * I-PTY-MENU-13: an orphaned Task tool_use (no tool_result, no turn_duration
   * ever) must NOT hang forever or kill the session. With a shortened watchdog,
   * the turn ends with an error and the wrapper stays alive to take the next
   * turn — the fix's "session preserved" branch of the watchdog.
   */
  it('I-PTY-MENU-13: an orphaned Task tool_use ends via the watchdog with an error, session survives', async () => {
    start({ PTY_SHELL_WATCHDOG_MS: '1500' });
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('TASK_ORPHAN'));

    // No tool_result ever comes; the shortened watchdog (1500ms after the last
    // progress) must end the turn with an error rather than hang.
    const ended = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      6000,
    );
    expect(ended).toBe(true);
    const result = collector.find((e) => e.type === 'result') as ProtocolEvent & { subtype: string; is_error?: boolean };
    expect(result.is_error).toBe(true);

    // Session must still be alive (watchdog did NOT shutdown) — a fresh turn
    // still completes, producing a second result event.
    expect(wrapper.exitCode).toBeNull();
    wrapper.stdin!.write(makeTurnJson('hello again'));
    const second = await waitFor(
      () => collector.events.filter((e) => e.type === 'result').length >= 2,
      6000,
    );
    expect(second).toBe(true);
  }, 25000);
});
