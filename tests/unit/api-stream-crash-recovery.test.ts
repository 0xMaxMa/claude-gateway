/**
 * Regression for the pendingApiSessions stuck-forever bug: a session's CLI
 * subprocess dying mid-turn (crash, or a Stop whose SIGINT handler didn't get
 * a chance to flush a final `result` line) previously left
 * AgentRunner.sendApiMessageStream's promise unsettled until the up-to-15-
 * minute opts.timeoutMs + API_TIMEOUT_HARD_CAP_EXTRA_MS safety net — during
 * which `hasActiveApiSession` stayed true and every retry on the same
 * session_id got a 409 CONFLICT ("Session already has a pending request"),
 * with the web's UI stuck on "typing..." indefinitely.
 *
 * Reproduced live against a real deployment before this fix (see commit
 * message) — this test drives the same subprocess-exit-without-a-result
 * scenario through a mocked child_process so it's exercised on every run.
 *
 * HistoryDB is mocked because this Node build's node:sqlite lacks the fts5
 * extension HistoryDB._initSchema() requires — unrelated to the change under
 * test; every AgentRunner-constructing test in this repo hits the same wall
 * in this environment.
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

// ── child_process mock (capture the spawned mock process for output/exit) ────
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

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AgentRunner } from '../../src/agent/runner';
import { SessionProcess } from '../../src/session/process';
import { AgentConfig, GatewayConfig } from '../../src/types';

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
  return { gateway: { logDir: '/tmp/test-api-crash-logs', timezone: 'UTC' }, agents: [] };
}

describe('AgentRunner.sendApiMessageStream — subprocess exit mid-turn', () => {
  let tmpDir: string;
  let runner: AgentRunner;
  const chatId = 'web-1';
  const sessionId = 'sess-crash-1';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-crash-test-'));
    const workspaceDir = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    runner = new AgentRunner(makeAgentConfig(workspaceDir), makeGatewayConfig());
    lastProcess = null;
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a subprocess exit with NO prior result line fails the turn immediately (not after the timeout chain)', async () => {
    const onDone = jest.fn();
    const onError = jest.fn();

    await runner.sendApiMessageStream(
      sessionId,
      chatId,
      'hello',
      { onChunk: jest.fn(), onDone, onError },
      { timeoutMs: 60_000 }, // deliberately long — must NOT be what unblocks this
    );

    expect(runner.hasActiveApiSession(sessionId)).toBe(true);
    expect(lastProcess).not.toBeNull();

    // The subprocess dies (crash, or a Stop whose SIGINT handler didn't flush
    // a final result) WITHOUT ever emitting a `result` stdout line.
    lastProcess!.emit('exit', null, 'SIGINT');
    // Let the 'exit' handler's microtask/listener chain settle.
    await new Promise((r) => setImmediate(r));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'PROCESS_EXITED' });
    expect(onDone).not.toHaveBeenCalled();
    // The whole point of the fix: cleared immediately, not stuck until the
    // 60s timeoutMs (let alone the 10-minute hard-cap extra) elapses.
    expect(runner.hasActiveApiSession(sessionId)).toBe(false);
  });

  it('a subprocess exit AFTER a result line is a no-op (the graceful-stop / normal-completion path is unaffected)', async () => {
    const onDone = jest.fn();
    const onError = jest.fn();

    await runner.sendApiMessageStream(
      sessionId,
      chatId,
      'hello',
      { onChunk: jest.fn(), onDone, onError },
      { timeoutMs: 60_000 },
    );

    expect(lastProcess).not.toBeNull();

    // Normal completion: the CLI emits its terminal `result` line before exiting
    // (this is also what a graceful /stop looks like when the CLI's own SIGINT
    // handler gets a chance to flush one).
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: 'hi there' }) + '\n'));
    lastProcess!.emit('exit', 0, null);
    await new Promise((r) => setImmediate(r));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toBe('hi there');
    // The exit-triggered fail() must be a no-op once done() already settled —
    // no spurious error surfaced alongside a real, successful reply.
    expect(onError).not.toHaveBeenCalled();
    expect(runner.hasActiveApiSession(sessionId)).toBe(false);
  });

  it('a send during the ~5s auto-restart window waits for the respawn instead of silently no-op-ing (getOrSpawnSession)', async () => {
    // Real timers throughout (accepts the real ~5s AUTO_RESTART_DELAY_MS
    // cost) — deliberately NOT jest.useFakeTimers(). An earlier version tried
    // controlling this with fake timers + counted microtask drains and it
    // passed identically with the fix present AND reverted: this call chain
    // also does real, unmocked SessionStore filesystem I/O (ensureApiSession)
    // ahead of getOrSpawnSession, whose completion isn't ordered by fake
    // timers or by counting Promise.resolve() ticks — only genuine wall-clock
    // waiting reproduces the actual race deterministically. Verified this
    // version DOES discriminate: reverting the runner.ts/process.ts fix while
    // keeping this test makes it fail exactly as expected below.
    //
    // Also spies on SessionProcess.prototype.sendMessage to record
    // isRunning() at the INSTANT each call happens, rather than inferring
    // correctness from stdin content after the fact — content-based checks
    // were fooled by a stale onOutput listener surviving the restart (see the
    // git history of this test for that dead end too).
    const sendMessageRunningStates: boolean[] = [];
    const originalSendMessage = SessionProcess.prototype.sendMessage;
    const sendMessageSpy = jest
      .spyOn(SessionProcess.prototype, 'sendMessage')
      .mockImplementation(function (this: SessionProcess, text: string) {
        sendMessageRunningStates.push(this.isRunning());
        return originalSendMessage.call(this, text);
      });

    try {
      // Turn 1: gets a process, then crashes with no result line (same shape
      // as the first test above — this also exercises the onExit fix,
      // confirming turn 1 fails promptly rather than hanging).
      const turn1Error = jest.fn();
      await runner.sendApiMessageStream(
        sessionId, chatId, 'turn 1',
        { onChunk: jest.fn(), onDone: jest.fn(), onError: turn1Error },
        { timeoutMs: 60_000 },
      );
      const proc1 = lastProcess!;
      expect(proc1).not.toBeNull();

      proc1.emit('exit', null, 'SIGKILL'); // crash — no result line, triggers scheduleRestart
      await Promise.resolve();
      expect(turn1Error).toHaveBeenCalledTimes(1);
      expect(runner.hasActiveApiSession(sessionId)).toBe(false); // the earlier fix already covers this

      // Turn 2 fires IMMEDIATELY — well inside the real ~5s auto-restart
      // window, since sendApiMessageStream's own pre-getOrSpawnSession work
      // (ensureApiSession etc.) takes milliseconds, not seconds.
      const turn2Done = jest.fn();
      const turn2Error = jest.fn();
      await runner.sendApiMessageStream(
        sessionId, chatId, 'turn 2',
        { onChunk: jest.fn(), onDone: turn2Done, onError: turn2Error },
        { timeoutMs: 60_000 },
      );

      // The whole point: sendMessage is NEVER called while the process is
      // down. Turn 1's own call (index 0) was on a live process too — the
      // second entry is turn 2's, and it must be true, not false.
      expect(sendMessageSpy).toHaveBeenCalledTimes(2);
      expect(sendMessageRunningStates).toEqual([true, true]);

      const proc2 = lastProcess!;
      expect(proc2).not.toBe(proc1);

      // Let turn 2 complete normally to confirm the session is fully healthy again.
      proc2.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: 'turn 2 reply' }) + '\n'));
      proc2.emit('exit', 0, null);
      await new Promise((r) => setImmediate(r));

      expect(turn2Done).toHaveBeenCalledTimes(1);
      expect(turn2Done.mock.calls[0][0]).toBe('turn 2 reply');
      expect(turn2Error).not.toHaveBeenCalled();
    } finally {
      sendMessageSpy.mockRestore();
    }
  }, 15_000);
});
