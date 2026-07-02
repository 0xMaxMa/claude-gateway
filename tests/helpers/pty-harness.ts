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

export function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await waitMs(100);
  }
  return pred();
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
 * Spawn the wrapper against a fake TUI. `env` adds/overrides wrapper env vars
 * (e.g. FAKE_TUI_INPUT_LOG / FAKE_TUI_EVENT_LOG paths).
 */
export function spawnWrapper(mockTuiBin: string, env: Record<string, string>): ChildProcess {
  return spawn('node', [PTY_SHELL_BIN, '--model', 'claude-test', '--dangerously-skip-permissions'], {
    env: {
      ...process.env,
      // Use path directly (not "node path") so checkAuthStatus(realBinParts[0]) works
      CLAUDE_REAL_BIN: mockTuiBin,
      PTY_SHELL_DEBUG: '0',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
export async function waitForLogEntries(logPath: string, n: number, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = readLogLines(logPath);
    if (lines.length >= n) return lines;
    await waitMs(100);
  }
  return readLogLines(logPath);
}
