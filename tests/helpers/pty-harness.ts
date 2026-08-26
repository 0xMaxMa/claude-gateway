/**
 * Shared harness for PTY-shell integration tests: spawns the real
 * claude-pty-shell.js wrapper with CLAUDE_REAL_BIN pointing at a fake TUI
 * from tests/helpers, feeds it stdin turns, and collects its stream-json
 * protocol events / fake-TUI log files. Used by pty-stop-stuck-input.test.ts
 * and pty-menu-probe.test.ts — wrapper CLI args and the turn-JSON shape live
 * here exactly once.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WAIT_TIMEOUT_MS, waitMs } from './wait-for';

// Re-exported rather than reimplemented: this harness carried its own copies of
// both, and its `waitFor` copy made the timeout a REQUIRED argument — which is
// how every call site here ended up hand-picking a wall-clock budget.
export { waitFor, waitMs, WAIT_TIMEOUT_MS } from './wait-for';

export const PTY_SHELL_BIN = path.resolve(__dirname, '../../dist/shell/claude-pty-shell.js');

export interface ProtocolEvent {
  type: string;
  subtype?: string;
  [k: string]: unknown;
}

export function makeTurnJson(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n'
  );
}



/** Collects parsed stream-json events from the wrapper's stdout as they arrive. */
export class EventCollector {
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

/**
 * Readiness promise per spawned wrapper, resolved when the wrapper emits its
 * `system/init` event — which it does at exactly the moment it decides the TUI
 * is ready (claude-pty-shell.ts: `this.ready = true` → `emitInit`). Registered
 * here rather than exposed as a spawn option so the stdout listener is always
 * attached in the same tick as the spawn: a listener added even a little later
 * can miss the event and then wait out its whole deadline.
 */
const readyPromises = new WeakMap<ChildProcess, Promise<void>>();

/** Every protocol event a spawned wrapper has emitted, in order. */
const emittedEvents = new WeakMap<ChildProcess, ProtocolEvent[]>();

/**
 * Spawn the wrapper against a fake TUI. `env` adds/overrides wrapper env vars
 * (e.g. FAKE_TUI_INPUT_LOG / FAKE_TUI_EVENT_LOG paths).
 */
export function spawnWrapper(mockTuiBin: string, env: Record<string, string>): ChildProcess {
  const child = spawn('node', [PTY_SHELL_BIN, '--model', 'claude-test', '--dangerously-skip-permissions'], {
    env: {
      ...process.env,
      // Use path directly (not "node path") so checkAuthStatus(realBinParts[0]) works
      CLAUDE_REAL_BIN: mockTuiBin,
      PTY_SHELL_DEBUG: '0',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let resolveReady!: () => void;
  readyPromises.set(child, new Promise<void>((resolve) => { resolveReady = resolve; }));
  const events: ProtocolEvent[] = [];
  emittedEvents.set(child, events);
  let buf = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ProtocolEvent;
        events.push(e);
        if (e.type === 'system' && e.subtype === 'init') resolveReady();
      } catch {
        // non-JSON debug output — ignore
      }
    }
  });

  return child;
}

/**
 * Wait until the wrapper has finished starting the fake TUI.
 *
 * Replaces the fixed `waitMs(2500)` these tests used to open with. A sleep
 * that guesses process-startup time is wrong in both directions: it wastes two
 * seconds on an idle machine, and under a loaded parallel run it can expire
 * *before* the TUI is ready, so the turn written next races the wrapper's own
 * startup. The wrapper already announces readiness — wait for that instead.
 */
export async function waitForWrapperReady(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  const ready = readyPromises.get(child);
  if (!ready) throw new Error('waitForWrapperReady: child was not created by spawnWrapper()');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for the wrapper to report the TUI ready`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([ready, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read the lines a fake TUI appended to a log file (one per entry). */
export function readLogLines(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Wait until the log has at least `n` entries, or timeout. */
export async function waitForLogEntries(
  logPath: string,
  n: number,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = readLogLines(logPath);
    if (lines.length >= n) return lines;
    await waitMs(100);
  }
  return readLogLines(logPath);
}

/** Protocol events the wrapper has emitted so far (empty before its first line). */
export function wrapperEvents(child: ChildProcess): ProtocolEvent[] {
  return emittedEvents.get(child) ?? [];
}

/**
 * Wait until the wrapper has ended at least `n` turns.
 *
 * The wrapper emits one `result` event per finished turn, which is the signal
 * these tests were approximating with a fixed multi-second sleep sized just
 * above FALLBACK_IDLE_QUIET_MS. Sleeping for a production constant plus a
 * guessed margin makes the test a measurement of the machine; waiting for the
 * event the wrapper already emits measures the wrapper.
 */
export async function waitForResults(
  child: ChildProcess,
  n: number,
  timeoutMs = 15_000,
): Promise<ProtocolEvent[]> {
  const events = emittedEvents.get(child);
  if (!events) throw new Error('waitForResults: child was not created by spawnWrapper()');
  const results = () => events.filter((e) => e.type === 'result');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (results().length >= n) return results();
    await waitMs(50);
  }
  throw new Error(
    `Timed out after ${Date.now() - startedAt}ms waiting for ${n} finished turn(s); saw ${results().length}`,
  );
}
