/**
 * Regression for the hard-cap gaps found reviewing #421 (issue comment
 * "Additional findings from a downstream-client investigation").
 *
 * Before this change the hard cap only *stopped listening*: cleanup() did
 * `session.off('output')` and nothing else, so past the cap the CLI subprocess
 * kept running and kept burning tokens while its eventual `result` line was
 * parsed by nobody — and history still gained a permanent
 * `⚠️ Agent response timed out.` row that could contradict a turn which was
 * demonstrably still alive. Any text the turn had already streamed was dropped
 * from that row entirely.
 *
 * The three behaviours pinned here:
 *   AC-2  the cap genuinely interrupts the turn (SIGINT), and does so BEFORE
 *         clearing the processing flag — SessionProcess.interrupt() gates on
 *         `_processing` and silently no-ops once it is false.
 *   AC-1  partial streamed text is persisted alongside the notice in ONE row,
 *         instead of being replaced by it.
 *   AC-4  the terminal error carries its `code` ('TIMEOUT'), so a client can
 *         tell the cap from a crash without matching `message` strings.
 *
 * HistoryDB and knowledge are mocked for the same node:sqlite/fts5 reason as
 * api-stream-crash-recovery.test.ts — unrelated to the change under test.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── HistoryDB mock — one shared spy so the persisted row can be asserted ─────
const insertMessage = jest.fn();
jest.mock('../../src/history/db', () => ({
  HistoryDB: {
    forDir: jest.fn(() => ({ insertMessage })),
    forAgent: jest.fn(() => ({ insertMessage })),
  },
}));

jest.mock('../../src/agent/knowledge', () => ({
  resolveSharedConfig: jest.fn(() => ({ enabled: false })),
  sharedVaultDir: jest.fn(() => '/tmp'),
  spawnArchiveReindex: jest.fn(),
}));

// ── child_process mock ───────────────────────────────────────────────────────
interface MockStdin { writable: boolean; write: jest.Mock }
interface MockChildProcess extends EventEmitter {
  stdin: MockStdin | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

let lastProcess: MockChildProcess | null = null;

function makeMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdin = { writable: true, write: jest.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 90000) + 10000;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = true;
    process.nextTick(() => proc.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  });
  return proc;
}

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    lastProcess = makeMockProcess();
    return lastProcess;
  }),
  spawnSync: jest.fn(() => ({ status: 0, stdout: '', stderr: '', error: undefined })),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { AgentRunner } from '../../src/agent/runner';
import { SessionProcess } from '../../src/session/process';
import { AgentConfig, GatewayConfig, StreamEvent } from '../../src/types';
import type { TurnSink, SeqEvent } from '../../src/agent/turn-stream';

/** Mirrors API_TIMEOUT_HARD_CAP_EXTRA_MS in src/agent/runner.ts. */
const HARD_CAP_EXTRA_MS = 600_000;
const SOFT_TIMEOUT_MS = 1_000;

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace,
    env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

function makeGatewayConfig(): GatewayConfig {
  return { gateway: { logDir: '/tmp/test-api-hardcap-logs', timezone: 'UTC' }, agents: [] };
}

/**
 * Let real async work (filesystem I/O in ensureApiSession, promise chains)
 * settle while the clock stays under the test's control. `setImmediate` and
 * `nextTick` are deliberately left unfaked so this actually drains.
 */
async function drain(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

function emitLine(obj: Record<string, unknown>): void {
  lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
}

describe('AgentRunner — the API hard cap ends the turn instead of abandoning it', () => {
  let tmpDir: string;
  let runner: AgentRunner;
  const chatId = 'web-1';
  const sessionId = 'sess-hardcap-1';

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    insertMessage.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-hardcap-test-'));
    const workspaceDir = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    runner = new AgentRunner(makeAgentConfig(workspaceDir), makeGatewayConfig());
    lastProcess = null;
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Start a turn, stream `partial` out of it, then let the soft timeout pass.
   * Leaves the turn parked in the soft→hard grace window.
   */
  async function startHangingTurn(callbacks: {
    onChunk: jest.Mock; onDone: jest.Mock; onError: jest.Mock;
  }, partial?: string): Promise<void> {
    const started = runner.sendApiMessageStream(
      sessionId, chatId, 'a question that hangs', callbacks,
      { timeoutMs: SOFT_TIMEOUT_MS, requestId: 'req-hardcap' },
    );
    // The spawn path does real fs work; give it room, advancing the clock only
    // in small steps so neither timeout fires early.
    for (let i = 0; i < 20 && !lastProcess; i++) {
      jest.advanceTimersByTime(10);
      await drain(3);
    }
    await started;
    expect(lastProcess).not.toBeNull();

    if (partial) {
      emitLine({ type: 'text', text: partial });
      await drain();
    }

    jest.advanceTimersByTime(SOFT_TIMEOUT_MS + 50);
    await drain();
  }

  it('AC-2: the hard cap SIGINTs the subprocess — a live turn is never silently abandoned', async () => {
    const callbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
    await startHangingTurn(callbacks);

    // Soft timeout only: non-terminal, nothing killed, turn still in flight.
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(lastProcess!.kill).not.toHaveBeenCalled();
    expect(runner.hasActiveApiSession(sessionId)).toBe(true);

    jest.advanceTimersByTime(HARD_CAP_EXTRA_MS + 50);
    await drain();

    const signals = lastProcess!.kill.mock.calls.map((c) => c[0]);
    expect(signals).toContain('SIGINT');
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(runner.hasActiveApiSession(sessionId)).toBe(false);
  });

  it('AC-2: interrupt() runs while the session still reports processing — order matters', async () => {
    // interrupt() returns false and sends no signal when `_processing` is
    // already false, so an implementation that clears the flag first looks
    // correct but silently does nothing. Pin the observed return value.
    const interruptResults: boolean[] = [];
    const original = SessionProcess.prototype.interrupt;
    const spy = jest
      .spyOn(SessionProcess.prototype, 'interrupt')
      .mockImplementation(function (this: SessionProcess) {
        const result = original.call(this);
        interruptResults.push(result);
        return result;
      });

    try {
      await startHangingTurn({ onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() });
      jest.advanceTimersByTime(HARD_CAP_EXTRA_MS + 50);
      await drain();

      expect(interruptResults).toContain(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('AC-1: the hard-cap row keeps the text the turn already streamed', async () => {
    const callbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
    await startHangingTurn(callbacks, 'Here is the first half of the answer');

    jest.advanceTimersByTime(HARD_CAP_EXTRA_MS + 50);
    await drain();

    const assistantRows = insertMessage.mock.calls
      .map((c) => c[0] as { role: string; content: string; sessionId: string })
      .filter((m) => m.role === 'assistant' && m.sessionId === sessionId);

    // Exactly one terminal row — never a failure row *and* a reply row.
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toContain('Here is the first half of the answer');
    expect(assistantRows[0]!.content).toContain('Agent response timed out.');
  });

  it('AC-4: the terminal error carries code TIMEOUT, not just a message', async () => {
    const callbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
    await startHangingTurn(callbacks);

    jest.advanceTimersByTime(HARD_CAP_EXTRA_MS + 50);
    await drain();

    // The live connection always had the real Error; what was missing is the
    // code on the buffered FRAME, which is all a resumed client ever sees.
    const err = callbacks.onError.mock.calls[0]![0] as Error & { code?: string };
    expect(err.code).toBe('TIMEOUT');

    const replayed: SeqEvent[] = [];
    let terminal: SeqEvent | null = null;
    runner.attachTurnStream(sessionId, {
      write: (e) => { replayed.push(e); },
      finish: (e) => { terminal = e; },
    }, { afterSeq: 0 });
    expect((terminal as unknown as SeqEvent).event).toMatchObject({ type: 'error', code: 'TIMEOUT' });
  });

  it('AC-3 + AC-4: a client that re-attached after the soft timeout receives the coded hard-cap error', async () => {
    const callbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
    await startHangingTurn(callbacks, 'partial');

    // The original connection dropped at the soft timeout; a new one resumes.
    const replayed: StreamEvent[] = [];
    let terminal: SeqEvent | null = null;
    const sink: TurnSink = {
      write: (e) => { replayed.push(e.event); },
      finish: (e) => { terminal = e; },
    };
    const attached = runner.attachTurnStream(sessionId, sink, { afterSeq: 0 });
    expect(attached.ok).toBe(true);
    // Replay starts at the beginning of the turn: the soft-timed-out client had
    // nothing persisted, so it needs everything, not just what it missed.
    expect(replayed.some((e) => e.type === 'text_delta')).toBe(true);
    expect(terminal).toBeNull();

    jest.advanceTimersByTime(HARD_CAP_EXTRA_MS + 50);
    await drain();

    expect(terminal).not.toBeNull();
    const frame = (terminal as unknown as SeqEvent).event;
    expect(frame.type).toBe('error');
    expect(frame).toMatchObject({ type: 'error', code: 'TIMEOUT' });
    // And the Error handed to an in-process sink carries it too.
    expect((terminal as unknown as SeqEvent).error).toMatchObject({ code: 'TIMEOUT' });
  });
});
