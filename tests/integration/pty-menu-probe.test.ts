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

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PTY_SHELL_BIN = path.resolve(__dirname, '../../dist/shell/claude-pty-shell.js');
const MOCK_TUI_BIN = path.resolve(__dirname, '../helpers/mock-claude-tui-menu.js');

interface ProtocolEvent {
  type: string;
  subtype?: string;
  [k: string]: unknown;
}

function makeTurnJson(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Collects parsed stream-json events from the wrapper's stdout as they arrive. */
class EventCollector {
  events: ProtocolEvent[] = [];
  private buf = '';

  attach(child: ChildProcess): void {
    child.stdout!.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line) as ProtocolEvent);
        } catch {
          // non-JSON debug output — ignore
        }
      }
    });
  }

  find(pred: (e: ProtocolEvent) => boolean): ProtocolEvent | undefined {
    return this.events.find(pred);
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await waitMs(100);
  }
  return pred();
}

function spawnWrapper(inputLog: string, eventLog: string): ChildProcess {
  return spawn('node', [PTY_SHELL_BIN, '--model', 'claude-test', '--dangerously-skip-permissions'], {
    env: {
      ...process.env,
      CLAUDE_REAL_BIN: MOCK_TUI_BIN,
      FAKE_TUI_INPUT_LOG: inputLog,
      FAKE_TUI_EVENT_LOG: eventLog,
      PTY_SHELL_DEBUG: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function readLines(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
}

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

  /**
   * I-PTY-MENU-01: Down alone moves the caret (caret starts on the first
   * option) — the probe should confirm and bridge on its very first attempt,
   * no Up fallback needed.
   */
  it('I-PTY-MENU-01: bridges a menu when Down alone reveals it', async () => {
    wrapper = spawnWrapper(inputLog, eventLog);
    collector.attach(wrapper);
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
    wrapper = spawnWrapper(inputLog, eventLog);
    collector.attach(wrapper);
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('MENU_LAST'));

    const bridged = await waitFor(
      () => !!collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt'),
      6000,
    );
    expect(bridged).toBe(true);

    const events = await waitFor(() => readLines(eventLog).length > 0, 1000)
      .then(() => readLines(eventLog));
    // Down was tried first (no-op at the last option), then Up moved the caret.
    expect(events[0]).toContain('arrow:down');
    expect(events.some((l) => l.includes('arrow:up'))).toBe(true);
  }, 20000);

  /**
   * I-PTY-MENU-03: the screen changes because real work resumed (busy marker
   * reappears), not because a menu reacted — the probe must not mis-bridge a
   * phantom menu, and the turn must still complete normally afterward.
   */
  it('I-PTY-MENU-03: does not bridge on a busy-race look-alike change', async () => {
    wrapper = spawnWrapper(inputLog, eventLog);
    collector.attach(wrapper);
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
   * that doesn't parse as a menu — the wrapper must send a restorative Down
   * (never bridging anything) so the input ends up empty again.
   */
  it('I-PTY-MENU-04: restores the input after an Up-recall that is not a menu, without bridging', async () => {
    wrapper = spawnWrapper(inputLog, eventLog);
    collector.attach(wrapper);
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('RECALL_NONMENU'));

    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      8000,
    );
    expect(completed).toBe(true);
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();

    const events = readLines(eventLog);
    // down (no-op) → up (recalls text) → down (restorative) — proves the
    // wrapper's restore-on-unparseable-change path fired, not just a single
    // probe attempt.
    const dirs = events.map((l) => (l.includes('arrow:down') ? 'down' : 'up'));
    const upIdx = dirs.indexOf('up');
    expect(upIdx).toBeGreaterThan(-1);
    expect(dirs[upIdx - 1]).toBe('down');
    expect(dirs.slice(upIdx + 1)).toContain('down');
  }, 20000);

  /**
   * I-PTY-MENU-05: no interactive overlay ever appears and nothing reacts to
   * either arrow key. The probe must exhaust its round budget and give up
   * cleanly — the turn still completes normally via the transcript, exactly
   * as a plain non-menu stall does today (no new hang mode introduced).
   */
  it('I-PTY-MENU-05: gives up cleanly when nothing reacts, turn still completes', async () => {
    wrapper = spawnWrapper(inputLog, eventLog);
    collector.attach(wrapper);
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
    wrapper = spawnWrapper(inputLog, eventLog);
    collector.attach(wrapper);
    await waitMs(2500);

    wrapper.stdin!.write(makeTurnJson('ORDINARY_MESSAGE'));

    const completed = await waitFor(
      () => !!collector.find((e) => e.type === 'result'),
      6000,
    );
    expect(completed).toBe(true);
    expect(collector.find((e) => e.type === 'system' && e.subtype === 'menu_prompt')).toBeUndefined();
    expect(readLines(eventLog)).toHaveLength(0); // no arrow keys were ever sent
  }, 20000);
});
