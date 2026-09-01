/**
 * Regression for #421: a streamed turn was bound to exactly one HTTP request.
 *
 * Two symptoms, one cause — the gateway kept no re-attachable state for an
 * in-flight turn:
 *
 *  1. `onClientDisconnect` set `clientGone`, and every emission was guarded by
 *     `if (!clientGone)`. Nothing was buffered, so a browser reload mid-turn
 *     lost the rest of the turn permanently even though it kept running and
 *     landed in history.
 *  2. The soft timeout called `notifyError(...)`, which reached the client as a
 *     terminal `{"type":"error"}` SSE event, while the turn kept running for up
 *     to a further `API_TIMEOUT_HARD_CAP_EXTRA_MS`. The reply frequently did
 *     arrive and was persisted — to a client that had already been told the
 *     request failed.
 *
 * These drive the runner directly through a mocked child_process, the same way
 * tests/unit/api-stream-crash-recovery.test.ts does; the mock setup below is
 * lifted from it (including the node:sqlite/fts5 workaround documented there).
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── HistoryDB mock (sidesteps the local node:sqlite/fts5 gap) ────────────────
jest.mock('../../src/history/db', () => ({
  HistoryDB: {
    forDir: jest.fn(() => ({ insertMessage: jest.fn() })),
    forAgent: jest.fn(() => ({ insertMessage: jest.fn() })),
  },
}));

jest.mock('../../src/agent/knowledge', () => ({
  resolveSharedConfig: jest.fn(() => ({ enabled: false })),
  sharedVaultDir: jest.fn(() => '/tmp'),
  spawnArchiveReindex: jest.fn(),
}));

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

import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig, GatewayConfig, StreamEvent } from '../../src/types';
import type { SeqEvent } from '../../src/agent/turn-stream';

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
  return { gateway: { logDir: '/tmp/test-api-reattach-logs', timezone: 'UTC' }, agents: [] };
}

/** A second SSE connection, standing in for the client that reconnected. */
function recordingSink() {
  const rec = {
    writes: [] as SeqEvent[],
    finished: null as SeqEvent | null,
    sink: {
      write(e: SeqEvent) { rec.writes.push(e); },
      finish(e: SeqEvent) { rec.finished = e; },
    },
  };
  return rec;
}

function emitLine(proc: MockChildProcess, obj: Record<string, unknown>): void {
  proc.stdout!.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
}

const settle = () => new Promise((r) => setImmediate(r));

describe('sendApiMessageStream — resumable turn stream (#421)', () => {
  let tmpDir: string;
  let runner: AgentRunner;
  const chatId = 'web-1';
  const sessionId = 'sess-reattach-1';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-reattach-test-'));
    const workspaceDir = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    runner = new AgentRunner(makeAgentConfig(workspaceDir), makeGatewayConfig());
    lastProcess = null;
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Symptom 1: disconnect mid-turn ────────────────────────────────────────

  it('a client that disconnects mid-turn re-attaches and gets the WHOLE rest of the turn, result included', async () => {
    // Before the fix this was unrecoverable: `clientGone` silenced the producer
    // and nothing was retained, so everything after the disconnect existed only
    // in history — no partial text, no tool events, no result, for any client.
    const seen: Array<{ event: StreamEvent; seq?: number }> = [];
    const onDone = jest.fn();
    const onError = jest.fn();

    const disconnect = await runner.sendApiMessageStream(
      sessionId, chatId, 'draw me something',
      { onChunk: (event, seq) => seen.push({ event, seq }), onDone, onError },
      { timeoutMs: 60_000, requestId: 'req-1' },
    );

    emitLine(lastProcess!, { type: 'text', text: 'before ' });
    await settle();
    expect(seen).toEqual([{ event: { type: 'text_delta', text: 'before ' }, seq: 1 }]);

    // The browser reloads. The turn keeps running server-side.
    disconnect();

    emitLine(lastProcess!, { type: 'text', text: 'after ' });
    emitLine(lastProcess!, { type: 'thinking', text: 'hmm' });
    await settle();

    // The dead connection is not written to any more...
    expect(seen).toHaveLength(1);
    expect(onDone).not.toHaveBeenCalled();

    // ...but the turn kept recording, so the reconnecting client picks up from
    // its cursor with no gap.
    const reattached = recordingSink();
    const attach = runner.attachTurnStream(sessionId, reattached.sink, { afterSeq: 1, requestId: 'req-1' });
    expect(attach.ok).toBe(true);
    expect(reattached.writes.map((e) => e.seq)).toEqual([2, 3]);
    expect(reattached.writes.map((e) => e.event)).toEqual([
      { type: 'text_delta', text: 'after ' },
      { type: 'thinking', text: 'hmm' },
    ]);

    // And it is live from here: the terminating result lands on the NEW
    // connection exactly as it would have on the original one.
    emitLine(lastProcess!, { type: 'result', result: 'before after' });
    await settle();

    expect(reattached.finished).toMatchObject({
      seq: 4,
      event: { type: 'result', text: 'before after' },
    });
    expect(onDone).not.toHaveBeenCalled(); // never re-sent to the abandoned socket
  });

  it('a turn that finished while nobody was attached is still replayable in full, from the start', async () => {
    const disconnect = await runner.sendApiMessageStream(
      sessionId, chatId, 'hi',
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
      { timeoutMs: 60_000, requestId: 'req-1' },
    );

    emitLine(lastProcess!, { type: 'text', text: 'partial' });
    await settle();
    disconnect();
    emitLine(lastProcess!, { type: 'result', result: 'partial reply' });
    await settle();

    // No cursor → replay from the turn's first event.
    const late = recordingSink();
    expect(runner.attachTurnStream(sessionId, late.sink).ok).toBe(true);
    expect(late.writes.map((e) => e.event)).toEqual([{ type: 'text_delta', text: 'partial' }]);
    expect(late.finished?.event).toEqual({ type: 'result', text: 'partial reply' });
  });

  it('resuming a turn is not a conflict — 409 still means "a second turn", never "the first one again"', async () => {
    await runner.sendApiMessageStream(
      sessionId, chatId, 'hi',
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
      { timeoutMs: 60_000, requestId: 'req-1' },
    );

    // Starting a second turn on the same session is still a conflict...
    expect(runner.hasActiveApiSession(sessionId)).toBe(true);
    // ...while attaching to the one in flight succeeds.
    expect(runner.attachTurnStream(sessionId, recordingSink().sink).ok).toBe(true);
  });

  it('refuses to attach to a turn that is gone, or to a request_id that is not the current turn', async () => {
    expect(runner.attachTurnStream('never-ran', recordingSink().sink)).toEqual({ ok: false, reason: 'gone' });

    await runner.sendApiMessageStream(
      sessionId, chatId, 'hi',
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
      { timeoutMs: 60_000, requestId: 'req-1' },
    );
    expect(
      runner.attachTurnStream(sessionId, recordingSink().sink, { requestId: 'req-stale' }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  // ── Symptom 2: the soft timeout ───────────────────────────────────────────

  it('the soft timeout is a NON-terminal `timeout` event, not a terminal error, and the turn keeps streaming', async () => {
    // Before the fix: onError fired with 'Agent response timeout' — the client
    // rendered a hard failure — and `clientGone` was set, so every event the
    // still-running turn produced afterwards was discarded.
    const seen: StreamEvent[] = [];
    const onDone = jest.fn();
    const onError = jest.fn();

    await runner.sendApiMessageStream(
      sessionId, chatId, 'something slow',
      { onChunk: (event) => seen.push(event), onDone, onError },
      { timeoutMs: 40, requestId: 'req-1' },
    );

    await new Promise((r) => setTimeout(r, 90));

    expect(onError).not.toHaveBeenCalled();
    expect(seen).toContainEqual({ type: 'timeout', message: 'Agent response timeout', resumable: true });

    // The turn is not cancelled: output after the budget still reaches the
    // client that stayed, and the reply still terminates the stream normally.
    emitLine(lastProcess!, { type: 'text', text: 'late but real' });
    emitLine(lastProcess!, { type: 'result', result: 'late but real' });
    await settle();

    expect(seen).toContainEqual({ type: 'text_delta', text: 'late but real' });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toBe('late but real');
    expect(onError).not.toHaveBeenCalled();
  });

  it('a turn that soft-timed-out is still resumable on a new connection', async () => {
    const disconnect = await runner.sendApiMessageStream(
      sessionId, chatId, 'something slow',
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
      { timeoutMs: 40, requestId: 'req-1' },
    );

    await new Promise((r) => setTimeout(r, 90));
    disconnect(); // the client gave up on the original socket

    emitLine(lastProcess!, { type: 'result', result: 'arrived late' });
    await settle();

    const resumed = recordingSink();
    expect(runner.attachTurnStream(sessionId, resumed.sink).ok).toBe(true);
    expect(resumed.writes.map((e) => e.event)).toEqual([
      { type: 'timeout', message: 'Agent response timeout', resumable: true },
    ]);
    expect(resumed.finished?.event).toEqual({ type: 'result', text: 'arrived late' });
  });

  it('a genuine failure AFTER a soft timeout is still reported as a real error', async () => {
    // The old code set `errorNotified` at the soft timeout so the later
    // terminal failure could not double-notify. Now that the soft timeout is
    // not an error at all, the real one must still get through — otherwise a
    // turn that dies after its budget would end in silence.
    const onError = jest.fn();

    await runner.sendApiMessageStream(
      sessionId, chatId, 'something slow',
      { onChunk: jest.fn(), onDone: jest.fn(), onError },
      { timeoutMs: 40, requestId: 'req-1' },
    );

    await new Promise((r) => setTimeout(r, 90));
    expect(onError).not.toHaveBeenCalled();

    lastProcess!.emit('exit', null, 'SIGKILL'); // the subprocess dies for real
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'PROCESS_EXITED' });
    expect(runner.hasActiveApiSession(sessionId)).toBe(false);
  });
});
