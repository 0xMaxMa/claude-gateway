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
   * Start a turn and, if `partial` is given, stream that text out of it. The
   * turn is left in flight — no timeout has fired yet.
   */
  async function startTurn(callbacks: {
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
  }

  /**
   * Start a turn, stream `partial` out of it, then let the soft timeout pass.
   * Leaves the turn parked in the soft→hard grace window.
   */
  async function startHangingTurn(callbacks: {
    onChunk: jest.Mock; onDone: jest.Mock; onError: jest.Mock;
  }, partial?: string): Promise<void> {
    await startTurn(callbacks, partial);
    jest.advanceTimersByTime(SOFT_TIMEOUT_MS + 50);
    await drain();
  }

  /** Assistant rows persisted for `id`, in insertion order. */
  function assistantRows(id: string): Array<{ role: string; content: string; sessionId: string }> {
    return insertMessage.mock.calls
      .map((c) => c[0] as { role: string; content: string; sessionId: string })
      .filter((m) => m.role === 'assistant' && m.sessionId === id);
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

    const rows = assistantRows(sessionId);

    // Exactly one terminal row — never a failure row *and* a reply row.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('Here is the first half of the answer');
    expect(rows[0]!.content).toContain('Agent response timed out.');
  });

  /**
   * The crash path is the case partialText exists for — the client watched the
   * deltas arrive and no `result` line is ever coming — yet it was the one path
   * that called fail() without it, so the row that replaced the half-written
   * reply erased it. Same defect shape as the hard cap above, different trigger.
   */
  it('a mid-turn crash keeps the text the client already saw (streaming path)', async () => {
    const callbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
    await startTurn(callbacks, 'Half of an answer the client already rendered');

    lastProcess!.emit('exit', null, 'SIGKILL');
    await drain();

    const rows = assistantRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('Half of an answer the client already rendered');
    expect(rows[0]!.content).toContain('Session process exited unexpectedly');
  });

  it('a mid-turn crash keeps the text already streamed (sync path)', async () => {
    const syncSession = 'sess-sync-crash-1';
    const settled = runner
      .sendApiMessage(syncSession, chatId, 'a question that crashes', { timeoutMs: 60_000 })
      .catch((e: Error) => e);

    for (let i = 0; i < 20 && !lastProcess; i++) {
      jest.advanceTimersByTime(10);
      await drain(3);
    }
    expect(lastProcess).not.toBeNull();

    // Under the 2s quiet timer, so the turn is still open when the crash lands.
    emitLine({ type: 'text', text: 'Half of an answer' });
    await drain();
    lastProcess!.emit('exit', null, 'SIGKILL');
    await drain();

    expect((await settled as Error & { code?: string }).code).toBe('PROCESS_EXITED');
    const rows = assistantRows(syncSession);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('Half of an answer');
    expect(rows[0]!.content).toContain('Session process exited unexpectedly');
  });

  /**
   * The hard cap on the SYNC path. Every test above drives sendApiMessageStream;
   * sendApiMessage has its own copy of the soft→hard escalation, and nothing
   * covered it — so a regression there (interrupting after clearing the
   * processing flag, or never interrupting at all) would leave a hung
   * subprocess and a stuck pendingApiSessions entry with the suite still green.
   */
  async function startHangingSyncTurn(id: string): Promise<{ caught: Promise<Error> }> {
    // Returned wrapped in an object: an async function AWAITS a bare promise it
    // returns, and this one cannot settle until the test advances the clock.
    const caught = runner
      .sendApiMessage(id, chatId, 'a question that hangs', { timeoutMs: SOFT_TIMEOUT_MS })
      .then(() => new Error('expected the sync turn to reject'), (e: Error) => e);

    for (let i = 0; i < 20 && !lastProcess; i++) {
      jest.advanceTimersByTime(10);
      await drain(3);
    }
    expect(lastProcess).not.toBeNull();
    return { caught };
  }

  it('AC-2/AC-4 (sync path): the soft timeout unblocks the caller, the hard cap stops the turn', async () => {
    const syncSession = 'sess-sync-hardcap-1';
    const { caught } = await startHangingSyncTurn(syncSession);

    // Soft timeout: the caller is freed with TIMEOUT_SOFT, but the turn is
    // untouched — nothing killed, the session still pending.
    jest.advanceTimersByTime(SOFT_TIMEOUT_MS + 50);
    await drain();
    expect((await caught as Error & { code?: string }).code).toBe('TIMEOUT_SOFT');
    expect(lastProcess!.kill).not.toHaveBeenCalled();
    expect(runner.hasActiveApiSession(syncSession)).toBe(true);
    expect(assistantRows(syncSession)).toHaveLength(0);

    // Hard cap: SIGINT, and exactly one terminal row so history never ends on a
    // dangling user message.
    jest.advanceTimersByTime(HARD_CAP_EXTRA_MS + 50);
    await drain();

    expect(lastProcess!.kill.mock.calls.map((c) => c[0])).toContain('SIGINT');
    expect(runner.hasActiveApiSession(syncSession)).toBe(false);
    const rows = assistantRows(syncSession);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('Agent response timed out.');
  });

  it('the sync path never reaches the hard cap with text in hand — the quiet timer answers first', async () => {
    // Why the sync hard-cap row above carries no partial text, unlike the
    // streaming one: on this path any text arms a 2s quiet timer that resolves
    // the turn, and text is the only thing that fills the buffer. So a
    // non-empty buffer and a hard cap are mutually exclusive here. Pinned
    // because `fail(..., buffer.join(''))` at the cap reads as though partial
    // text were expected there. (A production timeout budget is minutes, well
    // clear of the 2s quiet window — hence the realistic timeoutMs.)
    const syncSession = 'sess-sync-quiet-1';
    const resolved = runner
      .sendApiMessage(syncSession, chatId, 'a question that answers', { timeoutMs: 60_000 })
      .then((r) => r.text);

    for (let i = 0; i < 20 && !lastProcess; i++) {
      jest.advanceTimersByTime(10);
      await drain(3);
    }
    emitLine({ type: 'text', text: 'a complete answer with no result line' });
    await drain();

    jest.advanceTimersByTime(2_000 + 50);
    await drain();

    expect(await resolved).toBe('a complete answer with no result line');
    expect(lastProcess!.kill).not.toHaveBeenCalled();
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

  /**
   * The cross-channel live view (sendMessageToSession) has no hard cap and no
   * resume endpoint, so its soft timeout is terminal *for the caller*: it stops
   * waiting on a turn that is still running (whose answer still reaches history
   * by another route — see the suite below). That is the opposite of what the
   * API hard cap means, and
   * before this both carried `code: 'TIMEOUT'` — so the discriminator #421 added
   * to replace message-matching could not tell "still running, we stopped
   * listening" from "interrupted, definitely dead".
   */
  it('AC-4: the cross-channel soft timeout is TIMEOUT_SOFT, distinct from the hard cap\'s TIMEOUT', async () => {
    const softCallbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
    const started = runner.sendMessageToSession(
      'web-chat-1', 'telegram', 'sess-crosschannel-1', 'a question that hangs', 'tester',
      softCallbacks, { timeoutMs: SOFT_TIMEOUT_MS, requestId: 'req-crosschannel' },
    );
    for (let i = 0; i < 20 && !lastProcess; i++) {
      jest.advanceTimersByTime(10);
      await drain(3);
    }
    await started;

    jest.advanceTimersByTime(SOFT_TIMEOUT_MS + 50);
    await drain();

    expect(softCallbacks.onError).toHaveBeenCalledTimes(1);
    const softErr = softCallbacks.onError.mock.calls[0]![0] as Error & { code?: string };
    expect(softErr.code).toBe('TIMEOUT_SOFT');

    // The subprocess is untouched — this path abandons the turn, it does not
    // stop it. That difference is exactly what the two codes now express.
    expect(lastProcess!.kill).not.toHaveBeenCalled();
  });
});

/**
 * What the cross-channel soft timeout does and does not cost (#421).
 *
 * TIMEOUT_SOFT tells the client the turn is still running and its result still
 * lands in history — and the timeout then runs cleanup(), detaching this turn's
 * output listener, which is the only route to done(). That reads like the answer
 * is lost, but it is not: the reply reaches history through writers that are not
 * bound to the turn at all — the session's own long-lived output handler inserts
 * the plain-text result into the history DB, and SessionProcess appends it to the
 * session JSON. done()'s own writes are a *duplicate* of those, so keeping the
 * listener alive past the timeout would add a second row rather than rescue a
 * lost one. Pinned here because the promise in API.md rests on it.
 */
describe('AgentRunner — a cross-channel turn answers late without the caller', () => {
  let tmpDir: string;
  let runner: AgentRunner;
  const rawChatId = 'web-chat-1';
  const channel = 'telegram' as const;
  const channelSession = 'sess-crosschannel-late';

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    insertMessage.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-latechannel-test-'));
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

  async function startChannelTurn(
    callbacks: { onChunk: jest.Mock; onDone: jest.Mock; onError: jest.Mock },
    requestId: string,
    sessionId: string = channelSession,
  ): Promise<void> {
    const started = runner.sendMessageToSession(
      rawChatId, channel, sessionId, 'a question that hangs', 'tester',
      callbacks, { timeoutMs: SOFT_TIMEOUT_MS, requestId },
    );
    for (let i = 0; i < 20 && !lastProcess; i++) {
      jest.advanceTimersByTime(10);
      await drain(3);
    }
    await started;
    expect(lastProcess).not.toBeNull();
  }

  function assistantContents(sessionId: string): string[] {
    return insertMessage.mock.calls
      .map((c) => c[0] as { role: string; content: string; sessionId: string })
      .filter((m) => m.role === 'assistant' && m.sessionId === sessionId)
      .map((m) => m.content);
  }

  it('a result that lands after the soft timeout still reaches history', async () => {
    const callbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
    await startChannelTurn(callbacks, 'req-late-1');

    jest.advanceTimersByTime(SOFT_TIMEOUT_MS + 50);
    await drain();
    // The caller has been answered and told the turn is still running…
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onError.mock.calls[0]![0]).toMatchObject({ code: 'TIMEOUT_SOFT' });
    expect(assistantContents(channelSession)).toEqual([]);

    // …and the turn then finishes. The turn's own listener is gone, so this row
    // is written by the session handler alone — which is why exactly one lands
    // here, where a punctual turn (both writers live) still writes two.
    emitLine({ type: 'result', result: 'the answer, a moment late' });
    await drain();

    expect(assistantContents(channelSession)).toEqual(['the answer, a moment late']);
    // The caller was already answered; the late result must not re-terminate it.
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
  });

  it('an API turn and a channel turn on one session id no longer displace each other', async () => {
    // Both producers share one registry. Keyed by the bare session id, whichever
    // started second released the other's record — and with it the resume
    // endpoint's only way back to a live API turn.
    const apiCallbacks = { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() };
    const startedApi = runner.sendApiMessageStream(
      'api-chat-1', 'api-chat-1', 'an api question', apiCallbacks,
      { timeoutMs: 60_000, requestId: 'req-api-side' },
    );
    for (let i = 0; i < 20 && !lastProcess; i++) {
      jest.advanceTimersByTime(10);
      await drain(3);
    }
    await startedApi;
    emitLine({ type: 'text', text: 'from the api turn' });
    await drain();

    // Same session id, other producer.
    await startChannelTurn(
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
      'req-channel-side',
      'api-chat-1',
    );

    const replayed: StreamEvent[] = [];
    const attached = runner.attachTurnStream('api-chat-1', {
      write: (e) => { replayed.push(e.event); },
      finish: () => {},
    }, { afterSeq: 0, requestId: 'req-api-side' });

    expect(attached.ok).toBe(true);
    expect(replayed).toContainEqual({ type: 'text_delta', text: 'from the api turn' });
  });
});
