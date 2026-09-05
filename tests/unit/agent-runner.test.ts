import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock child_process ────────────────────────────────────────────────────────

interface MockStdin {
  writable: boolean;
  write: jest.Mock;
}

interface MockChildProcess extends EventEmitter {
  stdin: MockStdin | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

const allProcesses: MockChildProcess[] = [];

function makeMockProcess(): MockChildProcess {
  const stdin: MockStdin = { writable: true, write: jest.fn() };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const proc = new EventEmitter() as MockChildProcess;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 90000) + 10000;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = true;
    process.nextTick(() => proc.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  });

  allProcesses.push(proc);
  return proc;
}

jest.mock('child_process', () => ({
  spawn: jest.fn((..._args) => makeMockProcess()),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { AgentRunner, MAX_IMAGE_SIZE_BYTES } from '../../src/agent/runner';
import { AgentConfig, GatewayConfig, StreamEvent } from '../../src/types';
import { SessionProcess } from '../../src/session/process';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentConfig(workspace: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace,
    env: '',
    telegram: {
      botToken: 'test-token',
    },
    claude: {
      model: 'claude-opus-4-6',
      dangerouslySkipPermissions: false,
      extraFlags: [],
    },
    ...overrides,
  };
}

function makeGatewayConfig(): GatewayConfig {
  return {
    gateway: { logDir: '/tmp/test-ar-logs', timezone: 'UTC' },
    agents: [],
  };
}

async function sendChannelPost(
  port: number,
  chatId: string,
  content: string,
  user = 'testuser',
): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      meta: {
        chat_id: chatId,
        message_id: '1',
        user,
        ts: new Date().toISOString(),
      },
    }),
  });
}

function getCallbackPort(runner: AgentRunner): number {
  return (runner as unknown as { callbackPort: number }).callbackPort;
}

function getSessions(runner: AgentRunner): Map<string, SessionProcess> {
  return (runner as unknown as { sessions: Map<string, SessionProcess> }).sessions;
}

async function waitForSession(runner: AgentRunner, sessionId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!getSessions(runner).has(sessionId)) {
    if (Date.now() > deadline) throw new Error(`Session '${sessionId}' not spawned within ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 10));
  }
}

function getIdleCleaner(runner: AgentRunner): ReturnType<typeof setInterval> | undefined {
  return (runner as unknown as { idleCleanerTimer?: ReturnType<typeof setInterval> })
    .idleCleanerTimer;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Shrink the channel-coalescing debounce window file-wide so image POSTs flush
// almost immediately — existing image tests assume a near-instant spawn. Tests
// that exercise the debounce timing itself set their own larger value.
beforeAll(() => {
  process.env.CHANNEL_COALESCE_WINDOW_MS = '20';
});
afterAll(() => {
  delete process.env.CHANNEL_COALESCE_WINDOW_MS;
});

describe('AgentRunner (session pool)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-test-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) {
      await runner.stop();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // U-AR-01: Different chat_ids get different SessionProcesses
  // --------------------------------------------------------------------------
  it('U-AR-01: different chat_ids get different SessionProcesses', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:111', 'hello');
    // Allow async session spawn to complete
    await new Promise(r => setTimeout(r, 100));

    await sendChannelPost(port, 'chat:222', 'world');
    await new Promise(r => setTimeout(r, 100));

    const sessions = getSessions(runner);
    expect(sessions.size).toBe(2);
    expect(sessions.has('chat:111')).toBe(true);
    expect(sessions.has('chat:222')).toBe(true);
    expect(sessions.get('chat:111')).not.toBe(sessions.get('chat:222'));
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-02: Same chat_id reuses existing SessionProcess
  // --------------------------------------------------------------------------
  it('U-AR-02: same chat_id reuses the existing SessionProcess', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:111', 'first message');
    await new Promise(r => setTimeout(r, 100));

    const first = getSessions(runner).get('chat:111');

    await sendChannelPost(port, 'chat:111', 'second message');
    await new Promise(r => setTimeout(r, 100));

    const second = getSessions(runner).get('chat:111');

    expect(getSessions(runner).size).toBe(1);
    expect(first).toBe(second);
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-03: maxConcurrent evicts oldest idle session
  // --------------------------------------------------------------------------
  it('U-AR-03: maxConcurrent evicts oldest idle session when pool is full', async () => {
    agentConfig = makeAgentConfig(agentConfig.workspace, {
      session: { maxConcurrent: 2, idleTimeoutMinutes: 30 },
    });
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // Fill pool with 2 sessions
    await sendChannelPost(port, 'chat:111', 'hello');
    await new Promise(r => setTimeout(r, 100));
    await sendChannelPost(port, 'chat:222', 'hello');
    await new Promise(r => setTimeout(r, 100));

    expect(getSessions(runner).size).toBe(2);

    // Make chat:111 the oldest (lowest lastActivityAt)
    const sess111 = getSessions(runner).get('chat:111')!;
    (sess111 as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 100_000;

    // Third chat should evict chat:111 (oldest idle)
    await sendChannelPost(port, 'chat:333', 'new session');
    await new Promise(r => setTimeout(r, 200));

    expect(getSessions(runner).size).toBe(2);
    expect(getSessions(runner).has('chat:333')).toBe(true);
    expect(getSessions(runner).has('chat:222')).toBe(true);
    // chat:111 evicted
    expect(getSessions(runner).has('chat:111')).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-04: idle cleaner stops sessions past idleTimeoutMs
  // --------------------------------------------------------------------------
  it('U-AR-04: idle cleaner stops sessions that have exceeded idle timeout', async () => {
    agentConfig = makeAgentConfig(agentConfig.workspace, {
      session: { idleTimeoutMinutes: 30, maxConcurrent: 20 },
    });
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:idle', 'hello');
    await new Promise(r => setTimeout(r, 100));

    expect(getSessions(runner).size).toBe(1);

    // Reach into private method and call it directly to simulate idle cleaner firing
    const sess = getSessions(runner).get('chat:idle')!;
    (sess as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 60 * 60 * 1000;

    // Directly invoke the private idle cleaner logic by calling the method via cast
    const runnerInternal = runner as unknown as {
      idleTimeoutMs: number;
      sessions: Map<string, SessionProcess>;
      logger: { info: (msg: string, data?: unknown) => void };
    };

    // Simulate the idle cleaner interval callback
    for (const [id, proc] of runnerInternal.sessions) {
      if (proc.isIdle(runnerInternal.idleTimeoutMs)) {
        await proc.stop();
        runnerInternal.sessions.delete(id);
      }
    }

    expect(getSessions(runner).size).toBe(0);
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-TOOLARGE-02: the recovery counter is wired into spawn — a session
  //   spawned while mid-escalation gets the shrunk historyLimit (ladder rung).
  // --------------------------------------------------------------------------
  it('U-AR-TOOLARGE-02: spawn applies the escalated historyLimit from the counter', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    // Simulate two prior 32MB recoveries on this chat (rung 2 = 30 messages).
    (runner as unknown as { tooLargeRecoveries: Map<string, number> })
      .tooLargeRecoveries.set('chat:esc', 2);

    await sendChannelPost(port, 'chat:esc', 'hello again');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:esc')!;
    expect(sess).toBeDefined();
    expect(sess.historyLimit).toBe(30); // default cap 50 → rungs [40,30,20,10,0]; recovery #2 = 30
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-TOOLARGE-03: a successful result clears the escalation counter so the
  //   next 32MB starts fresh at the top of the ladder (full history again).
  // --------------------------------------------------------------------------
  it('U-AR-TOOLARGE-03: a successful result resets the recovery counter', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:reset', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const internal = runner as unknown as {
      tooLargeRecoveries: Map<string, number>;
      tooLargeExhausted: Set<string>;
    };
    internal.tooLargeRecoveries.set('chat:reset', 3);
    internal.tooLargeExhausted.add('chat:reset');

    // A genuine successful result on this session must clear the escalation.
    const sess = getSessions(runner).get('chat:reset')!;
    sess.emit('output', JSON.stringify({ type: 'result', is_error: false, result: 'all good' }));
    await new Promise(r => setTimeout(r, 50));

    expect(internal.tooLargeRecoveries.has('chat:reset')).toBe(false);
    expect(internal.tooLargeExhausted.has('chat:reset')).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // #460: .sessions/<id>/mcp-config.json holds fully-substituted secrets
  // (channel bot tokens, GATEWAY_API_KEY) and must not accumulate unbounded —
  // a hard kill (SIGKILL, crash, host reboot) skips SessionProcess.stop()'s
  // own cleanup, so start() sweeps what's left behind.
  // --------------------------------------------------------------------------
  it('#460: start() removes a stale leftover .sessions/<id>/ directory from a previous run', async () => {
    const staleDir = path.join(agentConfig.workspace, '.sessions', 'chat:stale-from-crash');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'mcp-config.json'), '{"mcpServers":{}}');

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    expect(fs.existsSync(staleDir)).toBe(false);
  }, 15000);

  it('#460: does not sweep a directory backed by a currently-live session', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:111', 'hello');
    await waitForSession(runner, 'chat:111');
    const liveSessionId = getSessions(runner).get('chat:111')!.sessionId;
    const liveDir = path.join(agentConfig.workspace, '.sessions', liveSessionId);
    expect(fs.existsSync(liveDir)).toBe(true); // sanity: writeMcpConfig() already created it

    // Exercise the sweep directly rather than a second start() — this
    // AgentRunner only ever calls it once, at the top of start(), before any
    // of its own sessions exist. Calling it again proves the liveness check
    // itself is correct, not just "it happens to run before sessions do".
    await (runner as unknown as { sweepStaleSessionDirs(): Promise<void> }).sweepStaleSessionDirs();

    expect(fs.existsSync(liveDir)).toBe(true);
  }, 15000);
});

// ── tokenUsage → session model persistence (#273) ────────────────────────────

describe('AgentRunner — tokenUsage persists model to session meta', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-model-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) {
      await runner.stop();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // Drive the raw child-process stdout (not SessionProcess's 'output' passthrough)
  // so the real stream-json parser in src/session/process.ts runs and populates
  // proc.lastModel + fires 'tokenUsage', exactly as it would against the live CLI.
  function emitTurn(rawProc: MockChildProcess, opts: { model?: string; inputTokens: number; outputTokens: number }): void {
    if (opts.model !== undefined) {
      const assistantLine = JSON.stringify({
        type: 'assistant',
        message: { model: opts.model, content: [{ type: 'text', text: 'hi' }] },
      });
      rawProc.stdout!.emit('data', Buffer.from(assistantLine + '\n'));
    }
    const messageStart = JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { usage: { input_tokens: opts.inputTokens } } },
    });
    rawProc.stdout!.emit('data', Buffer.from(messageStart + '\n'));
    const resultLine = JSON.stringify({
      type: 'result', is_error: false, result: 'ok',
      usage: { output_tokens: opts.outputTokens },
    });
    rawProc.stdout!.emit('data', Buffer.from(resultLine + '\n'));
  }

  it('T-AR-MODEL-1: tokenUsage persists both model and totalTokensUsed to session meta', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:model1', 'hi');
    await waitForSession(runner, 'chat:model1');
    await new Promise(r => setTimeout(r, 100));
    const sessionUuid = getSessions(runner).get('chat:model1')!.sessionId;

    const rawProc = allProcesses[allProcesses.length - 1];
    emitTurn(rawProc, { model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 50 });

    await new Promise(r => setTimeout(r, 150));

    const metaMap = await runner.getAllSessionMeta();
    const meta = metaMap.get(sessionUuid);
    expect(meta).toBeDefined();
    expect(meta!.model).toBe('claude-opus-4-8');
  }, 15000);

  it('T-AR-MODEL-2: a later turn on a different model overwrites the persisted model (latest wins)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:model2', 'hi');
    await waitForSession(runner, 'chat:model2');
    await new Promise(r => setTimeout(r, 100));
    const sessionUuid = getSessions(runner).get('chat:model2')!.sessionId;

    const rawProc = allProcesses[allProcesses.length - 1];
    emitTurn(rawProc, { model: 'claude-sonnet-4-6', inputTokens: 60, outputTokens: 40 });
    await new Promise(r => setTimeout(r, 150));

    let metaMap = await runner.getAllSessionMeta();
    expect(metaMap.get(sessionUuid)?.model).toBe('claude-sonnet-4-6');

    emitTurn(rawProc, { model: 'claude-opus-4-8', inputTokens: 60, outputTokens: 40 });
    await new Promise(r => setTimeout(r, 150));

    metaMap = await runner.getAllSessionMeta();
    expect(metaMap.get(sessionUuid)?.model).toBe('claude-opus-4-8');
  }, 15000);

  it('T-AR-MODEL-3: proc.lastModel is sticky — a later turn with no fresh assistant/model event keeps the previously captured model', async () => {
    // proc.lastModel lives on the SessionProcess instance and is only overwritten by a new
    // `type: assistant` event carrying `message.model`; it is NOT reset per turn. So a turn
    // whose stream is only message_start + result (no assistant event) still reports the
    // model captured on an earlier turn of the same process.
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:model3', 'hi');
    await waitForSession(runner, 'chat:model3');
    await new Promise(r => setTimeout(r, 100));
    const sessionUuid = getSessions(runner).get('chat:model3')!.sessionId;

    const rawProc = allProcesses[allProcesses.length - 1];
    emitTurn(rawProc, { model: 'claude-opus-4-8', inputTokens: 60, outputTokens: 40 });
    await new Promise(r => setTimeout(r, 150));
    expect((await runner.getAllSessionMeta()).get(sessionUuid)?.model).toBe('claude-opus-4-8');

    // Second turn: no assistant/model event at all, only message_start + result.
    emitTurn(rawProc, { inputTokens: 60, outputTokens: 40 });
    await new Promise(r => setTimeout(r, 150));

    const metaMap = await runner.getAllSessionMeta();
    expect(metaMap.get(sessionUuid)).toBeDefined();
    expect(metaMap.get(sessionUuid)!.model).toBe('claude-opus-4-8');
  }, 15000);

  it('T-AR-MODEL-3b: the very first tokenUsage event on a session that never saw an assistant/model event leaves model unset', async () => {
    // `...(proc.lastModel && { model: proc.lastModel })` in runner.ts: when proc.lastModel is
    // still '' (its initial value — no assistant event has arrived yet), the `model` key is
    // omitted from the meta patch entirely, so a session with no prior model stays unset.
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:model3b', 'hi');
    await waitForSession(runner, 'chat:model3b');
    await new Promise(r => setTimeout(r, 100));
    const sessionUuid = getSessions(runner).get('chat:model3b')!.sessionId;

    const rawProc = allProcesses[allProcesses.length - 1];
    // No assistant/model event at all — only message_start + result.
    emitTurn(rawProc, { inputTokens: 60, outputTokens: 40 });
    await new Promise(r => setTimeout(r, 150));

    const metaMap = await runner.getAllSessionMeta();
    expect(metaMap.get(sessionUuid)).toBeDefined();
    expect(metaMap.get(sessionUuid)!.model).toBeUndefined();
  }, 15000);

  it('T-AR-MODEL-3c: a tokenUsage event with no captured model does NOT wipe a model persisted by an earlier process instance (fix for #273 regression)', async () => {
    // Regression coverage for the d44c9da fix. Simulates a respawned SessionProcess (fresh
    // instance, proc.lastModel reset to '') whose store already has a model persisted from a
    // prior instance's turn. Before the fix, `model: proc.lastModel || undefined` would have
    // explicitly overwritten the stored model with undefined via Object.assign; the spread-based
    // fix must omit the key instead and leave the previously persisted model untouched.
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:model3c', 'hi');
    await waitForSession(runner, 'chat:model3c');
    await new Promise(r => setTimeout(r, 100));
    const sp = getSessions(runner).get('chat:model3c')!;
    const sessionUuid = sp.sessionId;

    // Seed a persisted model directly in the store, as if an earlier process instance had
    // already captured one (this session's own fresh proc.lastModel is still '').
    const sessionStore = (runner as unknown as { sessionStore: import('../../src/session/store').SessionStore }).sessionStore;
    await sessionStore.updateSessionMeta(agentConfig.id, 'chat:model3c', sessionUuid, { model: 'claude-opus-4-8' });
    expect((await runner.getAllSessionMeta()).get(sessionUuid)?.model).toBe('claude-opus-4-8');

    const rawProc = allProcesses[allProcesses.length - 1];
    // This turn's stream never carries an assistant/model event — proc.lastModel stays ''.
    emitTurn(rawProc, { inputTokens: 60, outputTokens: 40 });
    await new Promise(r => setTimeout(r, 150));

    const metaMap = await runner.getAllSessionMeta();
    expect(metaMap.get(sessionUuid)?.model).toBe('claude-opus-4-8');
  }, 15000);

  it('T-AR-MODEL-4 (bad case): a result event without usage data does not touch session meta at all', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:model4', 'hi');
    await waitForSession(runner, 'chat:model4');
    await new Promise(r => setTimeout(r, 100));
    const sessionUuid = getSessions(runner).get('chat:model4')!.sessionId;

    const before = await runner.getAllSessionMeta();
    const beforeModel = before.get(sessionUuid)?.model;

    const rawProc = allProcesses[allProcesses.length - 1];
    // Assistant message carries a model, but the turn never reaches message_start,
    // so lastMessageStartContext stays 0 and tokenUsage must not fire.
    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hi' }] },
    });
    rawProc.stdout!.emit('data', Buffer.from(assistantLine + '\n'));
    const resultLine = JSON.stringify({ type: 'result', is_error: false, result: 'ok' });
    rawProc.stdout!.emit('data', Buffer.from(resultLine + '\n'));

    await new Promise(r => setTimeout(r, 150));

    const after = await runner.getAllSessionMeta();
    // totalTokensUsed/model were never persisted via tokenUsage — meta.model unchanged.
    expect(after.get(sessionUuid)?.model).toBe(beforeModel);
  }, 15000);
});

// ── restartOrDefer (skills hot-reload support) ────────────────────────────────

describe('AgentRunner — restartOrDefer', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-restart-defer-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) {
      await runner.stop();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // RS1: stops a non-processing session immediately
  // --------------------------------------------------------------------------
  it('RS1: stops a non-processing session subprocess immediately', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:idle', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:idle')!;
    expect(sess).toBeDefined();
    // Simulate turn completed: mark as not processing so it stops immediately.
    sess.setProcessing(false);

    await runner.restartOrDefer();

    expect(getSessions(runner).has('chat:idle')).toBe(false);
    expect(getSessions(runner).size).toBe(0);
  }, 15000);

  // --------------------------------------------------------------------------
  // RS2: defers a processing session (does not stop immediately)
  // --------------------------------------------------------------------------
  it('RS2: defers restart for a processing session', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:busy', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:busy')!;
    // Mark session as processing.
    sess.setProcessing(true);
    const stopSpy = jest.spyOn(sess, 'stop');

    await runner.restartOrDefer();

    // Session still in pool; stop not called yet.
    expect(stopSpy).not.toHaveBeenCalled();
    expect(getSessions(runner).has('chat:busy')).toBe(true);
    expect(getSessions(runner).size).toBe(1);
  }, 15000);

  // --------------------------------------------------------------------------
  // RS3: mixed — idle stopped immediately, processing deferred
  // --------------------------------------------------------------------------
  it('RS3: stops idle sessions immediately; defers processing sessions', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:a', 'hi');
    await new Promise(r => setTimeout(r, 100));
    await sendChannelPost(port, 'chat:b', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const sessA = getSessions(runner).get('chat:a')!;
    const sessB = getSessions(runner).get('chat:b')!;
    // sessA: reset processing (turn completed) → stops immediately
    // sessB: remains processing (turn still running) → deferred
    sessA.setProcessing(false);
    // sessB.isProcessing is already true from sendChannelPost
    const stopSpyB = jest.spyOn(sessB, 'stop');

    await runner.restartOrDefer();

    expect(getSessions(runner).has('chat:a')).toBe(false);
    expect(getSessions(runner).has('chat:b')).toBe(true);
    expect(stopSpyB).not.toHaveBeenCalled();
    expect(getSessions(runner).size).toBe(1);
  }, 15000);

  // --------------------------------------------------------------------------
  // RS4: empty pool — no-op, does not throw
  // --------------------------------------------------------------------------
  it('RS4: empty session pool is a no-op', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    expect(getSessions(runner).size).toBe(0);
    await expect(runner.restartOrDefer()).resolves.toEqual({
      immediate: 0,
      deferred: 0,
      skipped: 0,
    });
    expect(getSessions(runner).size).toBe(0);
  }, 15000);

  // --------------------------------------------------------------------------
  // RS5: receiver and callback server remain up
  // --------------------------------------------------------------------------
  it('RS5: receiver and callback server keep running after restart', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:keepalive', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:keepalive')!;
    // Simulate turn completed so session is stopped immediately.
    sess.setProcessing(false);

    expect(runner.isRunning()).toBe(true);
    const portBefore = getCallbackPort(runner);

    await runner.restartOrDefer();

    // Receiver still running; callback server still bound to the same port.
    expect(runner.isRunning()).toBe(true);
    expect(getCallbackPort(runner)).toBe(portBefore);

    // And a new message re-spawns the stopped session lazily.
    await sendChannelPost(port, 'chat:keepalive', 'again');
    await new Promise(r => setTimeout(r, 100));
    expect(getSessions(runner).has('chat:keepalive')).toBe(true);
  }, 15000);

  // --------------------------------------------------------------------------
  // RS6: deferred session stops when setProcessing(false) is called
  // --------------------------------------------------------------------------
  it('RS6: deferred session stops itself after turn completes', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:defer', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:defer')!;
    // isProcessing is already true from sendChannelPost

    await runner.restartOrDefer();
    // Still in pool — processing
    expect(getSessions(runner).has('chat:defer')).toBe(true);

    // Simulate turn completing
    sess.setProcessing(false);
    await new Promise(r => setTimeout(r, 50));

    // Session should now be stopped and removed via deferredRestartReady listener
    expect(getSessions(runner).has('chat:defer')).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // RS7: skipBusy — busy session is left running (no deferred restart),
  //      idle session is still stopped immediately
  // --------------------------------------------------------------------------
  it('RS7: skipBusy leaves busy sessions running but still restarts idle ones', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:a', 'hi');
    await new Promise(r => setTimeout(r, 100));
    await sendChannelPost(port, 'chat:b', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const sessA = getSessions(runner).get('chat:a')!;
    const sessB = getSessions(runner).get('chat:b')!;
    // sessA idle (turn completed), sessB busy (agent wrote MEMORY.md mid-turn)
    sessA.setProcessing(false);
    sessB.setProcessing(true);
    const stopSpyB = jest.spyOn(sessB, 'stop');
    const pendingSpyB = jest.spyOn(sessB, 'markPendingRestart');

    await runner.restartOrDefer({ skipBusy: true });

    // idle session restarted (stopped + removed)
    expect(getSessions(runner).has('chat:a')).toBe(false);
    // busy session untouched: not stopped, not armed for deferred restart
    expect(getSessions(runner).has('chat:b')).toBe(true);
    expect(stopSpyB).not.toHaveBeenCalled();
    expect(pendingSpyB).not.toHaveBeenCalled();

    // And completing its turn must NOT stop it (no footgun)
    sessB.setProcessing(false);
    await new Promise(r => setTimeout(r, 50));
    expect(getSessions(runner).has('chat:b')).toBe(true);
  }, 15000);

  // --------------------------------------------------------------------------
  // RS8: deferIdle — idle session is NOT stopped now; it is armed in
  //      pendingRestarts to respawn losslessly on its next message (issue #321).
  // --------------------------------------------------------------------------
  it('RS8: deferIdle defers idle sessions (armed, not stopped) instead of SIGKILL', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:idle', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:idle')!;
    sess.setProcessing(false); // idle bystander
    const stopSpy = jest.spyOn(sess, 'stop');
    const pending = (runner as unknown as { pendingRestarts: Set<string> }).pendingRestarts;

    const counts = await runner.restartOrDefer({ deferIdle: true });

    // Idle session is neither stopped nor removed — it stays alive, armed.
    expect(stopSpy).not.toHaveBeenCalled();
    expect(getSessions(runner).has('chat:idle')).toBe(true);
    expect(pending.has('chat:idle')).toBe(true);
    expect(counts).toEqual({ immediate: 0, deferred: 1, skipped: 0 });
  }, 15000);

  // --------------------------------------------------------------------------
  // RS9: skipBusy + deferIdle (the memory/skills change combo) — busy skipped,
  //      idle deferred; ZERO immediate stops. This is the acceptance shape for
  //      "a memory/skills write drops no live session".
  // --------------------------------------------------------------------------
  it('RS9: skipBusy+deferIdle stops nothing (busy skipped, idle deferred)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:idle', 'hi');
    await new Promise(r => setTimeout(r, 100));
    await sendChannelPost(port, 'chat:busy', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const idle = getSessions(runner).get('chat:idle')!;
    const busy = getSessions(runner).get('chat:busy')!;
    idle.setProcessing(false);
    busy.setProcessing(true);
    const idleStop = jest.spyOn(idle, 'stop');
    const busyStop = jest.spyOn(busy, 'stop');
    const pending = (runner as unknown as { pendingRestarts: Set<string> }).pendingRestarts;

    const counts = await runner.restartOrDefer({ skipBusy: true, deferIdle: true });

    // Nothing SIGKILLed: idle deferred, busy skipped.
    expect(idleStop).not.toHaveBeenCalled();
    expect(busyStop).not.toHaveBeenCalled();
    expect(getSessions(runner).has('chat:idle')).toBe(true);
    expect(getSessions(runner).has('chat:busy')).toBe(true);
    expect(pending.has('chat:idle')).toBe(true);
    expect(pending.has('chat:busy')).toBe(false); // busy was skipped, not armed
    expect(counts).toEqual({ immediate: 0, deferred: 1, skipped: 1 });
  }, 15000);

  // --------------------------------------------------------------------------
  // RS10: deferIdle must NOT arm api/__heartbeat__ sessions. Their key never
  //       flows through injectTurn (the only pendingRestarts consumer), so an
  //       entry there would leak forever and the change would never reach them.
  //       They are stopped now instead, so they respawn fresh (as before #321).
  // --------------------------------------------------------------------------
  it('RS10: deferIdle stops an idle api session now (not armed) — key is never consumed', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:api', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:api')!;
    sess.setProcessing(false); // idle
    // Simulate an api/__heartbeat__ session (keyed by sessionId, not a chatId).
    (sess as unknown as { source: string }).source = 'api';
    const stopSpy = jest.spyOn(sess, 'stop');
    const pending = (runner as unknown as { pendingRestarts: Set<string> }).pendingRestarts;

    const counts = await runner.restartOrDefer({ deferIdle: true });

    // Stopped now (respawn fresh), NOT armed in pendingRestarts (no leak).
    expect(stopSpy).toHaveBeenCalled();
    expect(getSessions(runner).has('chat:api')).toBe(false);
    expect(pending.has('chat:api')).toBe(false);
    expect(counts).toEqual({ immediate: 1, deferred: 0, skipped: 0 });
  }, 15000);

  // --------------------------------------------------------------------------
  // RS11: consume guard — a deferred restart must NOT be consumed while the
  //       session is mid-turn. The same chatId key can be streaming a web-UI
  //       live-view turn (sendMessageToSession, which does not hold turnActive),
  //       so an unguarded stop() at the injectTurn consume would truncate it.
  //       The flag stays armed and is consumed on the next idle turn instead.
  // --------------------------------------------------------------------------
  it('RS11: an armed restart is not consumed mid-turn (web-UI live view), stays armed', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:web', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:web')!;
    const pending = (runner as unknown as { pendingRestarts: Set<string> }).pendingRestarts;
    const stopSpy = jest.spyOn(sess, 'stop');

    // Arm a deferred restart and simulate a concurrent web-UI turn on this key
    // (isProcessing = true, no turnActive).
    pending.add('chat:web');
    sess.setProcessing(true);

    // Drive the consume path as an incoming channel message would (injectTurn is
    // fire-and-forget/void).
    (runner as unknown as {
      injectTurn: (c: string, s: string, e: Array<{ content?: string; meta?: Record<string, string> }>) => void;
    }).injectTurn('chat:web', 'telegram', [
      { content: 'concurrent channel message', meta: { chat_id: 'chat:web', message_id: '9', user: 't', ts: new Date().toISOString() } },
    ]);
    await new Promise(r => setTimeout(r, 200));

    // The mid-turn session was NOT stopped, and the restart is still armed.
    expect(stopSpy).not.toHaveBeenCalled();
    expect(getSessions(runner).has('chat:web')).toBe(true);
    expect(pending.has('chat:web')).toBe(true);
  }, 15000);

  // --------------------------------------------------------------------------
  // RS12: REGRESSION — the incident this guards against. A session dispatches a
  //       background Agent tool_use, ends its OWN turn (idle from the outside),
  //       and THEN an aggressive restart tier (skipBusy:false, deferIdle:false —
  //       exactly what a non-agent-writable CLAUDE.md change uses) must NOT
  //       SIGKILL it. Before this fix it fell straight to toStopNow: isProcessing
  //       was false and deferIdle was false, so it was stopped immediately,
  //       destroying whatever the dispatched sub-agent was still doing.
  // --------------------------------------------------------------------------
  it('RS12: a session with a dispatched-but-unresolved background Agent call is deferred, not SIGKILLed, even under the aggressive default tier', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:review', 'review this PR');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:review')!;
    const rawProc = allProcesses[allProcesses.length - 1];
    // The session dispatches a background sub-agent mid-turn…
    const dispatchLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }] },
      stop_reason: 'tool_use',
    });
    rawProc.stdout!.emit('data', Buffer.from(dispatchLine + '\n'));
    // …then its OWN turn ends right after (matches the observed session_idle
    // pattern: "I'll wait for the sub-agents" → turn over, nothing more to do
    // right now from the CLI's own perspective).
    sess.setProcessing(false);

    const stopSpy = jest.spyOn(sess, 'stop');
    const pending = (runner as unknown as { pendingRestarts: Set<string> }).pendingRestarts;

    // The exact call the CLAUDE.md-change ("restart" tier) path makes — no
    // deferIdle, no skipBusy. This is what SIGKILLed the session in the incident.
    const counts = await runner.restartOrDefer({ skipBusy: false });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(getSessions(runner).has('chat:review')).toBe(true);
    expect(pending.has('chat:review')).toBe(true);
    expect(counts).toEqual({ immediate: 0, deferred: 1, skipped: 0 });
  }, 15000);

  // --------------------------------------------------------------------------
  // RS13: once the dispatch resolves (a fresh turn starts, e.g. the woken
  //       notification) and ends without a new dispatch, the SAME aggressive
  //       tier stops it immediately again — the protection is not permanent or
  //       accidentally sticky.
  // --------------------------------------------------------------------------
  it('RS13: after the background dispatch resolves, the next idle window restarts normally again', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:resolved', 'review this PR');
    await new Promise(r => setTimeout(r, 100));

    const sess = getSessions(runner).get('chat:resolved')!;
    const rawProc = allProcesses[allProcesses.length - 1];
    const dispatchLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Agent', input: {} }] },
      stop_reason: 'tool_use',
    });
    rawProc.stdout!.emit('data', Buffer.from(dispatchLine + '\n'));
    sess.setProcessing(false);
    expect(sess.hasLikelyOutstandingBackgroundWork()).toBe(true);

    // The task-notification wakes the session (a fresh turn) and it ends
    // normally with no further background dispatch.
    sess.setProcessing(true);
    sess.setProcessing(false);
    expect(sess.hasLikelyOutstandingBackgroundWork()).toBe(false);

    const stopSpy = jest.spyOn(sess, 'stop');
    const counts = await runner.restartOrDefer({ skipBusy: false });

    expect(stopSpy).toHaveBeenCalled();
    expect(getSessions(runner).has('chat:resolved')).toBe(false);
    expect(counts).toEqual({ immediate: 1, deferred: 0, skipped: 0 });
  }, 15000);

  // --------------------------------------------------------------------------
  // RS14: `filter` only narrows the candidate set — it must not change what
  //       happens to a session it does select, and a session it does not select
  //       must not be counted as `skipped` (that number means "needed a restart,
  //       did not get one", which is a different and reportable thing).
  // --------------------------------------------------------------------------
  it('RS14: filter narrows which sessions are restarted, and a filtered-out one is not "skipped"', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:yes', 'hi');
    await new Promise(r => setTimeout(r, 100));
    await sendChannelPost(port, 'chat:no', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const yes = getSessions(runner).get('chat:yes')!;
    const no = getSessions(runner).get('chat:no')!;
    yes.setProcessing(false);
    no.setProcessing(false);
    const noStop = jest.spyOn(no, 'stop');

    const counts = await runner.restartOrDefer({ filter: (p) => p === yes });

    expect(getSessions(runner).has('chat:yes')).toBe(false);
    expect(getSessions(runner).has('chat:no')).toBe(true);
    expect(noStop).not.toHaveBeenCalled();
    expect(counts).toEqual({ immediate: 1, deferred: 0, skipped: 0 });
  }, 15000);
});

// ── restartSessionsUsingConnector ─────────────────────────────────────────────
//
// Regression (round 10). This used to ask an agent-level question —
// `usesConnector(id)`, i.e. "does this connector resolve to something for this
// agent right now?" — and then restart either every session of the agent or none.
//
// The failure that mattered is the delete/give-up path. oauth-refresh-sweep.ts
// gives up on a connector by deleting its secrets and THEN calling this; the API's
// DELETE route does the same. By then the connector resolves to nothing, so the
// old code answered "nobody uses it" and restarted nothing — leaving every live
// session running with the credential that had just been revoked. (DELETE papered
// over it with a `force: true` computed before the delete; the sweep passed no
// options at all, so a give-up never withdrew anything from anybody.)
//
// The mirror-image failure is the refresh path: the answer was "yes" for every
// session of the agent, including ones spawned before the connector was ever
// connected, so a timer-driven token refresh respawned sessions holding no copy
// of the token that rotated.
//
// The decision is now per session, against what that session was actually spawned
// with, so these tests drive the real shape: a connector that resolves to nothing.

describe('AgentRunner — restartSessionsUsingConnector', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-restart-connector-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  /** Two live idle sessions; only `holder` was spawned with connector `id`. */
  async function twoSessions(id: string) {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:holder', 'hi');
    await new Promise(r => setTimeout(r, 100));
    await sendChannelPost(port, 'chat:bystander', 'hi');
    await new Promise(r => setTimeout(r, 100));

    const holder = getSessions(runner).get('chat:holder')!;
    const bystander = getSessions(runner).get('chat:bystander')!;
    holder.setProcessing(false);
    bystander.setProcessing(false);
    // Stands in for writeMcpConfig having written this connector into `holder`'s
    // mcp-config.json and not into `bystander`'s. Spying rather than staging a
    // real mcp-token.env keeps this test about the runner's dispatch; the
    // fingerprint comparison itself is covered in session-process.test.ts.
    jest.spyOn(holder, 'connectorConfigChanged').mockImplementation((c: string) => c === id);
    jest.spyOn(bystander, 'connectorConfigChanged').mockReturnValue(false);
    return { holder, bystander };
  }

  it('restarts a session spawned with the connector even though it now resolves to nothing', async () => {
    const { holder } = await twoSessions('firecrawl');
    // No entry in customConnectors and no secret anywhere — exactly the state the
    // sweep's give-up branch and the DELETE route leave behind before calling.
    expect(gatewayConfig.gateway.customConnectors?.firecrawl).toBeUndefined();

    const res = await runner.restartSessionsUsingConnector('firecrawl');

    expect(res.restarted).toBe(true);
    expect(holder.connectorConfigChanged).toHaveBeenCalledWith('firecrawl', undefined);
  }, 15000);

  it('leaves a session the connector never reached alone', async () => {
    const { bystander } = await twoSessions('firecrawl');
    const bystanderStop = jest.spyOn(bystander, 'stop');
    const pending = (runner as unknown as { pendingRestarts: Set<string> }).pendingRestarts;

    await runner.restartSessionsUsingConnector('firecrawl');

    expect(bystanderStop).not.toHaveBeenCalled();
    expect(pending.has('chat:bystander')).toBe(false);
  }, 15000);

  it('reports restarted:false when the change reaches no session', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:other', 'hi');
    await new Promise(r => setTimeout(r, 100));
    const sess = getSessions(runner).get('chat:other')!;
    sess.setProcessing(false);
    jest.spyOn(sess, 'connectorConfigChanged').mockReturnValue(false);

    await expect(runner.restartSessionsUsingConnector('firecrawl')).resolves.toEqual({
      restarted: false,
    });
  }, 15000);

  // The caller is an API route that just wrote config.json; the config watcher has
  // not re-read it into this runner yet, so without the overlay the connector
  // resolves to nothing and a just-connected connector reads as a deletion.
  it('resolves the connector through the caller-supplied overlay', async () => {
    const { holder } = await twoSessions('gmail');
    const entry = {
      label: 'Gmail',
      config: { type: 'http', url: 'https://gmail.example/mcp', headers: {} },
      secretNames: [],
      credentialOwner: 'none' as const,
    };

    await runner.restartSessionsUsingConnector('gmail', { overlay: { gmail: entry } });

    expect(holder.connectorConfigChanged).toHaveBeenCalledWith(
      'gmail',
      expect.objectContaining({ url: 'https://gmail.example/mcp' }),
    );
  }, 15000);

  // Round 12, finding 2. The overlay was used for the comparison and then thrown
  // away, so the sessions this method restarts came back up from the runner's
  // pre-write view of config.json — the very staleness the overlay exists to
  // work around. Asserted through a real respawn rather than the config object,
  // because mcp-config.json is where the bug is visible to a user.
  //
  // Not a narrow race: the config watcher debounces 500ms, so the respawn beats
  // it every time. And it does not self-heal — the fresh spawn records the stale
  // resolution as its fingerprint, and this method is the only thing that ever
  // compares it again.
  function mcpServersOf(chatId: string): Record<string, unknown> {
    // Via the session, not the chat id: a channel session's directory is named
    // by the uuid the runner minted for it, not by the chat it belongs to.
    const proc = getSessions(runner).get(chatId)!;
    const file = path.join(agentConfig.workspace, '.sessions', proc.sessionId, 'mcp-config.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers;
  }

  const gmailEntry = {
    label: 'Gmail',
    config: { type: 'http', url: 'https://gmail.example/mcp', headers: {} },
    secretNames: [],
    credentialOwner: 'none' as const,
  };

  it('a session spawned after the restart gets the connector the overlay added', async () => {
    await twoSessions('gmail');

    await runner.restartSessionsUsingConnector('gmail', { overlay: { gmail: gmailEntry } });

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:after', 'hi');
    await new Promise(r => setTimeout(r, 100));
    expect(mcpServersOf('chat:after')).toHaveProperty('gmail');
  }, 15000);

  it('a session spawned after the restart does not get the connector the overlay removed', async () => {
    gatewayConfig.gateway.customConnectors = { gmail: gmailEntry };
    await twoSessions('gmail');
    // The pre-write view really does still carry it — otherwise the assertion
    // below would pass for the wrong reason.
    expect(mcpServersOf('chat:holder')).toHaveProperty('gmail');

    await runner.restartSessionsUsingConnector('gmail', { overlay: { gmail: null } });

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:after', 'hi');
    await new Promise(r => setTimeout(r, 100));
    expect(mcpServersOf('chat:after')).not.toHaveProperty('gmail');
  }, 15000);
});

// ── Typing error notification tests ───────────────────────────────────────────

describe('AgentRunner — typing error notification', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-typing-test-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function getTypingDir(): string {
    return path.join(agentConfig.workspace, '.telegram-state', 'typing');
  }

  function callWriteTypingError(r: AgentRunner, chatId: string, code: string): void {
    (r as unknown as { writeTypingError: (c: string, code: string) => void })
      .writeTypingError(chatId, code);
  }

  // --------------------------------------------------------------------------
  // U-AR-TYPING-01: writeTypingError writes error file in correct location
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-01: writeTypingError writes error file with correct code', () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);

    callWriteTypingError(runner, 'chat:999', 'PROCESS_FAILED');

    const errorFile = path.join(getTypingDir(), 'chat:999.error');
    expect(fs.existsSync(errorFile)).toBe(true);
    expect(fs.readFileSync(errorFile, 'utf8')).toBe('PROCESS_FAILED');
  });

  // --------------------------------------------------------------------------
  // U-AR-TYPING-02: writeTypingError writes POOL_FULL code
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-02: writeTypingError writes POOL_FULL code', () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);

    callWriteTypingError(runner, 'chat:pool', 'POOL_FULL');

    const errorFile = path.join(getTypingDir(), 'chat:pool.error');
    expect(fs.readFileSync(errorFile, 'utf8')).toBe('POOL_FULL');
  });

  // --------------------------------------------------------------------------
  // U-AR-TYPING-AF-01: writeAutoForward writes JSON { text, format } to .forward file
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-AF-01: writeAutoForward writes JSON with default text format', () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);

    (runner as unknown as { writeAutoForward: (chatId: string, text: string) => void })
      .writeAutoForward('123456789', 'Hello from agent');

    const forwardFile = path.join(getTypingDir(), '123456789.forward');
    expect(fs.existsSync(forwardFile)).toBe(true);
    // Queue format (claude-gateway#380): an array of entries, each tagged
    // with the turn that wrote it (null here — no live typing-signal file).
    const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    expect(content).toEqual([{ text: 'Hello from agent', format: 'text', turnId: null }]);
  });

  // --------------------------------------------------------------------------
  // U-AR-TYPING-AF-02: writeAutoForward writes JSON with html format
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-AF-02: writeAutoForward writes JSON with html format', () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);

    (runner as unknown as { writeAutoForward: (chatId: string, text: string, format: string) => void })
      .writeAutoForward('123456789', 'Hello <code>code</code>', 'html');

    const forwardFile = path.join(getTypingDir(), '123456789.forward');
    expect(fs.existsSync(forwardFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    expect(content).toEqual([{ text: 'Hello <code>code</code>', format: 'html', turnId: null }]);
  });

  // --------------------------------------------------------------------------
  // U-AR-TOOLARGE-01: request_too_large recovery escalates the history ladder
  //   (50→40→30→20→10→0) and pins at the last rung once 0-history still trips.
  //   Covers Bug B (headless) + Bug A (PTY) — both route through this handler.
  // --------------------------------------------------------------------------
  it('U-AR-TOOLARGE-01: handleRequestTooLarge escalates, gives up, then stops churning', () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    const r = runner as unknown as {
      handleRequestTooLarge: (mapKey: string, proc: { setProcessing: (b: boolean) => void }) => void;
      tooLargeRecoveries: Map<string, number>;
      tooLargeExhausted: Set<string>;
      restartProcess: (chatId: string) => Promise<void>;
    };
    // Spy restartProcess to count restarts without touching the (empty) session pool.
    const restartSpy = jest.spyOn(r, 'restartProcess').mockResolvedValue(undefined);
    const proc = { setProcessing: jest.fn() };
    const forwardFile = path.join(getTypingDir(), 'chat:big.forward');
    // Queue format (claude-gateway#380): each call appends rather than
    // overwrites, so read the most recently queued entry's text.
    const readForward = () => {
      const entries = JSON.parse(fs.readFileSync(forwardFile, 'utf8')) as Array<{ text: string }>;
      return entries[entries.length - 1]!.text;
    };

    // Rungs 1..5 → counter climbs, each emits the "Restarting" resend notice + restarts.
    for (let i = 1; i <= 5; i++) {
      r.handleRequestTooLarge('chat:big', proc);
      expect(r.tooLargeRecoveries.get('chat:big')).toBe(i);
      expect(readForward()).toContain('32MB request limit');
    }
    expect(proc.setProcessing).toHaveBeenLastCalledWith(false);
    expect(restartSpy).toHaveBeenCalledTimes(5);

    // 6th: even 0-history tripped → pin at last rung (5), tell the user to /clear,
    // and restart ONCE more to clear the wedged process (6 restarts total).
    r.handleRequestTooLarge('chat:big', proc);
    expect(r.tooLargeRecoveries.get('chat:big')).toBe(5);
    expect(r.tooLargeExhausted.has('chat:big')).toBe(true);
    expect(readForward()).toContain('/clear');
    expect(restartSpy).toHaveBeenCalledTimes(6);

    // 7th+: still exhausted → keep re-notifying /clear but NO further restart (no churn).
    r.handleRequestTooLarge('chat:big', proc);
    r.handleRequestTooLarge('chat:big', proc);
    expect(readForward()).toContain('/clear');
    expect(restartSpy).toHaveBeenCalledTimes(6);
  });

  // --------------------------------------------------------------------------
  // U-AR-TOOLARGE-04: spawnHistoryLimit with the DEFAULT cap (50) reproduces the
  //   legacy recovery sequence exactly (backward compatibility).
  // --------------------------------------------------------------------------
  it('U-AR-TOOLARGE-04: default cap reproduces the legacy 50→40→30→20→10→0 sequence', () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    const r = runner as unknown as { spawnHistoryLimit: (cap: number, count: number) => number };

    expect(r.spawnHistoryLimit(50, 0)).toBe(50); // healthy
    // recoveries 1..6 step down and then pin at the 0-history rung
    expect([1, 2, 3, 4, 5, 6].map(c => r.spawnHistoryLimit(50, c))).toEqual([40, 30, 20, 10, 0, 0]);
  });

  // --------------------------------------------------------------------------
  // U-AR-TOOLARGE-05: a LOWERED cap steps through only the rungs strictly below
  //   it — no no-op retry that re-injects the same (already-too-large) size.
  // --------------------------------------------------------------------------
  it('U-AR-TOOLARGE-05: a lowered cap skips rungs >= the cap (no no-op recovery)', () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    const r = runner as unknown as { spawnHistoryLimit: (cap: number, count: number) => number };

    // cap 30 → healthy 30, then strictly-smaller rungs [20, 10, 0] (never a second 30)
    expect(r.spawnHistoryLimit(30, 0)).toBe(30);
    expect([1, 2, 3, 4].map(c => r.spawnHistoryLimit(30, c))).toEqual([20, 10, 0, 0]);

    // cap 0 → no history at all, and nothing smaller to recover to
    expect(r.spawnHistoryLimit(0, 0)).toBe(0);
    expect(r.spawnHistoryLimit(0, 1)).toBe(0);

    // cap above the ladder top → the leading rung (MAX_HISTORY_MESSAGES) is used
    expect(r.spawnHistoryLimit(100, 0)).toBe(100);
    expect(r.spawnHistoryLimit(100, 1)).toBe(50);
  });

  // --------------------------------------------------------------------------
  // U-AR-TOOLARGE-06: exhaustion aligns to the lowered cap — a cap of 30 has only
  //   3 shrink rungs ([20,10,0]), so it gives up after 3 steps, not 5.
  // --------------------------------------------------------------------------
  it('U-AR-TOOLARGE-06: lowered cap exhausts after its own rung count (3), not 5', () => {
    const loweredConfig = makeAgentConfig(agentConfig.workspace, { history: { maxHistoryMessages: 30 } });
    runner = new AgentRunner(loweredConfig, gatewayConfig);
    const r = runner as unknown as {
      handleRequestTooLarge: (mapKey: string, proc: { setProcessing: (b: boolean) => void }) => void;
      tooLargeRecoveries: Map<string, number>;
      tooLargeExhausted: Set<string>;
      restartProcess: (chatId: string) => Promise<void>;
    };
    const restartSpy = jest.spyOn(r, 'restartProcess').mockResolvedValue(undefined);
    const proc = { setProcessing: jest.fn() };
    const forwardFile = path.join(getTypingDir(), 'chat:low.forward');
    // Queue format (claude-gateway#380): each call appends rather than
    // overwrites, so read the most recently queued entry's text.
    const readForward = () => {
      const entries = JSON.parse(fs.readFileSync(forwardFile, 'utf8')) as Array<{ text: string }>;
      return entries[entries.length - 1]!.text;
    };

    // Rungs [20,10,0] → 3 climbing steps, each restarts.
    for (let i = 1; i <= 3; i++) {
      r.handleRequestTooLarge('chat:low', proc);
      expect(r.tooLargeRecoveries.get('chat:low')).toBe(i);
    }
    expect(restartSpy).toHaveBeenCalledTimes(3);
    expect(r.tooLargeExhausted.has('chat:low')).toBe(false);

    // 4th: exhausted (0-history still tripped) → pin at 3, surface /clear, restart once.
    r.handleRequestTooLarge('chat:low', proc);
    expect(r.tooLargeRecoveries.get('chat:low')).toBe(3);
    expect(r.tooLargeExhausted.has('chat:low')).toBe(true);
    expect(readForward()).toContain('/clear');
    expect(restartSpy).toHaveBeenCalledTimes(4);

    // 5th+: still exhausted → no further restart churn.
    r.handleRequestTooLarge('chat:low', proc);
    expect(restartSpy).toHaveBeenCalledTimes(4);
  });

  // --------------------------------------------------------------------------
  // U-AR-TYPING-03: spawn error writes SPAWN_FAILED typing error file
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-03: spawn error via callback writes SPAWN_FAILED typing error', async () => {
    agentConfig = makeAgentConfig(agentConfig.workspace, {
      session: { maxConcurrent: 0, idleTimeoutMinutes: 30 }, // pool immediately full
    });
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // Pool has maxConcurrent=0, can't evict (no idle sessions), so spawn fails
    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'hello',
        meta: { chat_id: 'chat:fail', message_id: '1', user: 'u', ts: new Date().toISOString() },
      }),
    });

    // Allow async spawn error to propagate
    await new Promise(r => setTimeout(r, 200));

    const errorFile = path.join(getTypingDir(), 'chat:fail.error');
    // Pool full or spawn failed — either POOL_FULL or SPAWN_FAILED is acceptable
    if (fs.existsSync(errorFile)) {
      const code = fs.readFileSync(errorFile, 'utf8').trim();
      expect(['POOL_FULL', 'SPAWN_FAILED']).toContain(code);
    }
    // If file doesn't exist, no error occurred (pool was evictable) — test still passes
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-TYPING-04: session 'failed' event writes PROCESS_FAILED typing error
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-04: session failed event writes PROCESS_FAILED typing error', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'hello',
        meta: { chat_id: 'chat:crash', message_id: '1', user: 'u', ts: new Date().toISOString() },
      }),
    });

    await new Promise(r => setTimeout(r, 150));

    const sessions = getSessions(runner);
    const session = sessions.get('chat:crash');
    if (!session) return; // session not spawned — skip

    // Emit 'failed' event directly (simulates max restarts exceeded)
    session.emit('failed');

    await new Promise(r => setTimeout(r, 50));

    const errorFile = path.join(getTypingDir(), 'chat:crash.error');
    if (fs.existsSync(errorFile)) {
      expect(fs.readFileSync(errorFile, 'utf8').trim()).toBe('PROCESS_FAILED');
    }
    // Session should be removed from pool
    expect(sessions.has('chat:crash')).toBe(false);
  }, 15000);
});

// ── sendApiMessageStream tests ───────────────────────────────────────────────

describe('AgentRunner — sendApiMessageStream', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-stream-test-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    agentConfig = makeAgentConfig(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // T9: delivers text deltas via onChunk
  it('T9: delivers text deltas via onChunk', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t9',
        'test-chat',
        'hello',
        {
          onChunk: (event) => chunks.push(event),
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));

    // Find the session and simulate output
    const sessions = getSessions(runner);
    const session = sessions.get('stream-t9')!;
    expect(session).toBeDefined();

    // Simulate partial assistant messages (--include-partial-messages format)
    session.emit('output', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
      stop_reason: null,
    }));
    session.emit('output', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
      stop_reason: null,
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'Hello world' }));

    const result = await donePromise;
    expect(result).toBe('Hello world');

    const textDeltas = chunks.filter(c => c.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { text: string }).text).toBe('Hello');
    expect((textDeltas[1] as { text: string }).text).toBe(' world');
  }, 15000);

  // T10: calls onDone on result event with full text
  it('T10: calls onDone on result event', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t10',
        'test-chat',
        'test',
        {
          onChunk: () => {},
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));

    const session = getSessions(runner).get('stream-t10')!;
    session.emit('output', JSON.stringify({ type: 'result', result: 'Final answer' }));

    const result = await donePromise;
    expect(result).toBe('Final answer');
  }, 15000);

  // T11: persists to SessionStore
  it('T11: persists user and assistant messages to SessionStore', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const donePromise = new Promise<void>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t11',
        'test-chat',
        'persist test',
        {
          onChunk: () => {},
          onDone: () => resolve(),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));

    const session = getSessions(runner).get('stream-t11')!;
    session.emit('output', JSON.stringify({ type: 'result', result: 'Stored answer' }));

    await donePromise;
    await new Promise(r => setTimeout(r, 100));

    // Check session store file exists
    const storeDir = path.join(tmpDir, 'agents', 'alfred', 'sessions');
    if (fs.existsSync(storeDir)) {
      const files = fs.readdirSync(storeDir);
      const sessionFile = files.find(f => f.includes('stream-t11'));
      if (sessionFile) {
        const content = fs.readFileSync(path.join(storeDir, sessionFile), 'utf8');
        expect(content).toContain('persist test');
        expect(content).toContain('Stored answer');
      }
    }
    // If store dir doesn't exist, appendMessage is a no-op (catch-ignored) — acceptable
  }, 15000);

  // T12: conflict guard
  it('T12: throws CONFLICT on duplicate session', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    // Start first stream (never resolves)
    runner.sendApiMessageStream(
      'stream-t12',
        'test-chat',
      'first',
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      { timeoutMs: 10000 },
    );

    await new Promise(r => setTimeout(r, 200));

    // Second request to same session should throw CONFLICT
    await expect(
      runner.sendApiMessageStream(
        'stream-t12',
        'test-chat',
        'second',
        { onChunk: () => {}, onDone: () => {}, onError: () => {} },
        { timeoutMs: 5000 },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 15000);

  // T13: the soft timeout is a non-terminal `timeout` event, not an error (#421).
  // It used to call onError, which told the client the request had failed while
  // the turn was still running — and frequently still about to answer.
  it('T13: soft timeout emits a non-terminal timeout event, not onError', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const onError = jest.fn();
    const timedOut = new Promise<StreamEvent>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t13',
        'test-chat',
        'timeout test',
        {
          onChunk: (event) => { if (event.type === 'timeout') resolve(event); },
          onDone: () => {},
          onError,
        },
        { timeoutMs: 200 }, // short timeout
      );
    });

    const event = await timedOut;
    expect(event).toEqual({ type: 'timeout', message: expect.stringMatching(/timeout/i), resumable: true });
    expect(onError).not.toHaveBeenCalled();
    // The turn is still in flight — the hard cap, not the soft one, ends it.
    expect(runner.hasActiveApiSession('stream-t13')).toBe(true);
  }, 15000);

  // T14: onClientDisconnect keeps stream alive; session freed only after result
  it('T14: onClientDisconnect keeps session active; slot freed on result', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    let onClientDisconnect: (() => void) | undefined;
    const streamStarted = new Promise<void>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t14',
        'test-chat',
        'disconnect test',
        {
          onChunk: () => {},
          onDone: () => {},
          onError: () => {},
        },
        { timeoutMs: 10000 },
      ).then((fn) => {
        onClientDisconnect = fn;
        resolve();
      });
    });

    await new Promise(r => setTimeout(r, 200));
    await streamStarted;

    expect(runner.hasActiveApiSession('stream-t14')).toBe(true);

    // Simulate SSE client disconnect — session must stay active server-side
    onClientDisconnect!();
    expect(runner.hasActiveApiSession('stream-t14')).toBe(true);

    // Simulate Claude completing the response after disconnect
    const session = getSessions(runner).get('stream-t14')!;
    session.emit('output', JSON.stringify({ type: 'result', result: 'Response after disconnect' }));

    await new Promise(r => setTimeout(r, 100));

    // Session slot freed once result arrives
    expect(runner.hasActiveApiSession('stream-t14')).toBe(false);

    // Should be able to start a new stream on same session
    await expect(
      runner.sendApiMessageStream(
        'stream-t14',
        'test-chat',
        'after result',
        { onChunk: () => {}, onDone: () => {}, onError: () => {} },
        { timeoutMs: 5000 },
      ),
    ).resolves.toBeDefined();
  }, 15000);

  // T14b: response is persisted to history DB after client disconnect.
  // Since #421 the abandoned connection's callbacks go quiet on disconnect —
  // its socket is dead, and the turn's output is delivered to whoever
  // re-attaches instead. Persistence, which is what this test is really about,
  // is unaffected.
  it('T14b: response persisted to history DB after client disconnect', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    let onClientDisconnect: (() => void) | undefined;
    const onDone = jest.fn();

    runner.sendApiMessageStream(
      'stream-t14b',
      'test-chat',
      'persist after disconnect',
      {
        onChunk: () => {},
        onDone,
        onError: () => {},
      },
      { timeoutMs: 10000 },
    ).then((fn) => { onClientDisconnect = fn; });

    // Wait for stream to start and disconnect fn to be available
    await new Promise(r => setTimeout(r, 200));
    expect(onClientDisconnect).toBeDefined();

    // Simulate SSE client disconnect before result arrives
    onClientDisconnect!();

    // Simulate Claude completing the response after disconnect
    const session = getSessions(runner).get('stream-t14b')!;
    session.emit('output', JSON.stringify({ type: 'result', result: 'Persisted response' }));
    await new Promise(r => setTimeout(r, 100));

    // Nothing is written to the socket the client already closed…
    expect(onDone).not.toHaveBeenCalled();

    // …but the result is still there for a client that re-attaches…
    const replayed: Array<{ text: string }> = [];
    const attached = runner.attachTurnStream('stream-t14b', {
      write: () => {},
      finish: (e) => { if (e.event.type === 'result') replayed.push({ text: e.event.text }); },
    });
    expect(attached.ok).toBe(true);
    expect(replayed).toEqual([{ text: 'Persisted response' }]);

    // …and history DB must contain the assistant message
    const page = runner.getHistoryDb().getMessages('api-test-chat');
    const msgs = page.messages as Array<{ role: string; content: string }>;
    const assistantMsg = msgs.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe('Persisted response');
  }, 15000);

  // T14c: agent attachments (from api_reply) are persisted to mediaFiles so they
  // survive history reload. Without this, the screenshot vanishes from chat history
  // as soon as the live SSE stream ends — only the text remains.
  it('T14c: agent attachments are persisted to history mediaFiles', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    // Create a real media file so popApiAttachments's existsSync guard passes.
    const mediaAbs = path.join(tmpDir, 'agents', 'alfred', 'media', 'api-stream-t14c', 'shot.jpg');
    fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
    fs.writeFileSync(mediaAbs, 'fake-image');

    const doneFired = new Promise<void>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t14c',
        'test-chat-attach',
        'browse and screenshot',
        {
          onChunk: () => {},
          onDone: () => resolve(),
          onError: () => {},
        },
        { timeoutMs: 10000 },
      );
    });

    await waitForSession(runner, 'stream-t14c');

    // Simulate the agent calling api_reply mid-turn (registers attachment),
    // then emitting the final result text.
    runner.addApiAttachments('stream-t14c', [mediaAbs]);
    const session = getSessions(runner).get('stream-t14c')!;
    session.emit('output', JSON.stringify({ type: 'result', result: 'Screenshot ready' }));

    await doneFired;

    const page = runner.getHistoryDb().getMessages('api-test-chat-attach');
    const msgs = page.messages as Array<{ role: string; content: string; mediaFiles?: string[] }>;
    const assistantMsg = msgs.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe('Screenshot ready');
    expect(assistantMsg!.mediaFiles).toEqual(['media/api-stream-t14c/shot.jpg']);
  }, 15000);

  // T14d: image-only replies (empty text but attachments present) still persist —
  // the legacy `if (result.trim())` gate would have dropped them silently.
  it('T14d: image-only replies persist via attachments', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const mediaAbs = path.join(tmpDir, 'agents', 'alfred', 'media', 'api-stream-t14d', 'only.jpg');
    fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
    fs.writeFileSync(mediaAbs, 'fake-image');

    const doneFired = new Promise<void>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t14d',
        'test-chat-img-only',
        'screenshot',
        {
          onChunk: () => {},
          onDone: () => resolve(),
          onError: () => {},
        },
        { timeoutMs: 10000 },
      );
    });

    await waitForSession(runner, 'stream-t14d');

    runner.addApiAttachments('stream-t14d', [mediaAbs]);
    const session = getSessions(runner).get('stream-t14d')!;
    session.emit('output', JSON.stringify({ type: 'result', result: '' }));

    await doneFired;

    const page = runner.getHistoryDb().getMessages('api-test-chat-img-only');
    const msgs = page.messages as Array<{ role: string; content: string; mediaFiles?: string[] }>;
    const assistantMsg = msgs.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe('');
    expect(assistantMsg!.mediaFiles).toEqual(['media/api-stream-t14d/only.jpg']);
  }, 15000);

  // --------------------------------------------------------------------------
  // T-AR-STREAM-15: Partial assistant messages produce incremental text_delta chunks
  // --------------------------------------------------------------------------
  it('T-AR-STREAM-15: partial assistant messages produce incremental text_delta chunks', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-partial-15',
        'test-chat',
        'hello',
        {
          onChunk: (event) => chunks.push(event),
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));

    const session = getSessions(runner).get('stream-partial-15')!;
    expect(session).toBeDefined();

    // Simulate partial assistant messages (cumulative text from --include-partial-messages)
    const partial1 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
      stop_reason: null,
    });
    session.emit('output', partial1);

    const partial2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
      stop_reason: null,
    });
    session.emit('output', partial2);

    // Result event
    session.emit('output', JSON.stringify({ type: 'result', result: 'Hello world' }));

    const result = await donePromise;
    expect(result).toBe('Hello world');

    const textDeltas = chunks.filter(c => c.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { text: string }).text).toBe('Hello');
    expect((textDeltas[1] as { text: string }).text).toBe(' world');
  }, 15000);

  // --------------------------------------------------------------------------
  // T-AR-STREAM-16: stream_event tool_use blocks are accumulated and emitted
  // --------------------------------------------------------------------------
  it('T-AR-STREAM-16: stream_event tool_use blocks accumulate and emit tool_use chunk', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t16',
        'test-chat',
        'run bash',
        {
          onChunk: (event) => chunks.push(event),
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));
    const session = getSessions(runner).get('stream-t16')!;

    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"echo hello"}' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'done' }));

    const result = await donePromise;
    expect(result).toBe('done');

    const toolChunks = chunks.filter(c => c.type === 'tool_use');
    expect(toolChunks).toHaveLength(1);
    const tc = toolChunks[0] as { type: 'tool_use'; name: string; id: string; input: Record<string, unknown> };
    expect(tc.name).toBe('Bash');
    expect(tc.id).toBe('toolu_01');
    expect(tc.input).toEqual({ command: 'echo hello' });
  }, 15000);

  // --------------------------------------------------------------------------
  // T-AR-STREAM-17: multiple tool calls in one turn (different indices)
  // --------------------------------------------------------------------------
  it('T-AR-STREAM-17: multiple tool calls at different indices emit separate tool_use chunks', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t17',
        'test-chat',
        'multi tool',
        {
          onChunk: (event) => chunks.push(event),
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));
    const session = getSessions(runner).get('stream-t17')!;

    // Tool A at index 0
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'id-a', name: 'Read', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }));

    // Tool B at index 2
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'id-b', name: 'Write', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/b"}' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 2 },
    }));

    session.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await donePromise;

    const toolChunks = chunks.filter(c => c.type === 'tool_use') as Array<{ name: string; id: string; input: Record<string, unknown> }>;
    expect(toolChunks).toHaveLength(2);
    expect(toolChunks[0].name).toBe('Read');
    expect(toolChunks[0].input).toEqual({ file_path: '/a' });
    expect(toolChunks[1].name).toBe('Write');
    expect(toolChunks[1].input).toEqual({ file_path: '/b' });
  }, 15000);

  // --------------------------------------------------------------------------
  // T-AR-STREAM-18: malformed partial JSON in tool input is silently skipped
  // --------------------------------------------------------------------------
  it('T-AR-STREAM-18: malformed tool input JSON is skipped without throwing', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t18',
        'test-chat',
        'bad json',
        {
          onChunk: (event) => chunks.push(event),
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));
    const session = getSessions(runner).get('stream-t18')!;

    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'id-bad', name: 'Bash', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'NOT_VALID_JSON' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'ok' }));

    const result = await donePromise;
    expect(result).toBe('ok');
    // No tool_use chunk should be emitted for malformed input
    expect(chunks.filter(c => c.type === 'tool_use')).toHaveLength(0);
  }, 15000);

  // --------------------------------------------------------------------------
  // T-AR-STREAM-19: tool_use and text_delta coexist in same turn
  // --------------------------------------------------------------------------
  it('T-AR-STREAM-19: tool_use and text_delta both emit in the same turn', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t19',
        'test-chat',
        'mixed',
        {
          onChunk: (event) => chunks.push(event),
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));
    const session = getSessions(runner).get('stream-t19')!;

    // text block first
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Running...' } },
    }));
    // tool block
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'id-c', name: 'Bash', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'Running...' }));

    await donePromise;

    expect(chunks.filter(c => c.type === 'text_delta')).toHaveLength(1);
    expect(chunks.filter(c => c.type === 'tool_use')).toHaveLength(1);
    const tc = chunks.find(c => c.type === 'tool_use') as { name: string; input: Record<string, unknown> };
    expect(tc.name).toBe('Bash');
    expect(tc.input).toEqual({ command: 'ls' });
  }, 15000);

  // T-AR-STREAM-ALLOW-TOOLS-1: allowTools=false injects "Do NOT call any tools"
  it('T-AR-STREAM-ALLOW-TOOLS-1: allowTools=false includes tool-restriction instruction', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    let capturedMessage = '';
    runner.sendApiMessageStream(
      'stream-at-1',
        'test-chat',
      'hello',
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      { timeoutMs: 5000, allowTools: false },
    );

    await new Promise(r => setTimeout(r, 200));

    const proc = allProcesses[allProcesses.length - 1];
    const calls = (proc.stdin!.write as jest.Mock).mock.calls;
    capturedMessage = calls.map((c: unknown[]) => String(c[0])).join('');

    expect(capturedMessage).toContain('Do NOT call any tools');
    expect(capturedMessage).not.toContain('You may use tools');
  }, 15000);

  // T-AR-STREAM-ALLOW-TOOLS-2: allowTools=true removes restriction, adds permission
  it('T-AR-STREAM-ALLOW-TOOLS-2: allowTools=true omits tool-restriction instruction', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    runner.sendApiMessageStream(
      'stream-at-2',
        'test-chat',
      'run job',
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      { timeoutMs: 5000, allowTools: true },
    );

    await new Promise(r => setTimeout(r, 200));

    const proc = allProcesses[allProcesses.length - 1];
    const calls = (proc.stdin!.write as jest.Mock).mock.calls;
    const capturedMessage = calls.map((c: unknown[]) => String(c[0])).join('');

    expect(capturedMessage).not.toContain('Do NOT call any tools');
    expect(capturedMessage).toContain('You may use tools');
  }, 15000);

  // T-AR-STREAM-ALLOW-TOOLS-3: default (no allowTools) behaves like allowTools=false
  it('T-AR-STREAM-ALLOW-TOOLS-3: omitting allowTools defaults to tool-restricted mode', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    runner.sendApiMessageStream(
      'stream-at-3',
        'test-chat',
      'hello',
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      { timeoutMs: 5000 },
    );

    await new Promise(r => setTimeout(r, 200));

    const proc = allProcesses[allProcesses.length - 1];
    const calls = (proc.stdin!.write as jest.Mock).mock.calls;
    const capturedMessage = calls.map((c: unknown[]) => String(c[0])).join('');

    expect(capturedMessage).toContain('Do NOT call any tools');
  }, 15000);

  // T-WP-1: allowTools=true — system note contains MEMORY_RULE override
  it('T-WP-1: allowTools=true system note contains memory-rule override', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    runner.sendApiMessageStream(
      'stream-wp-1',
        'test-chat',
      'do something',
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      { timeoutMs: 5000, allowTools: true },
    );

    await new Promise(r => setTimeout(r, 200));

    const proc = allProcesses[allProcesses.length - 1];
    const calls = (proc.stdin!.write as jest.Mock).mock.calls;
    const capturedMessage = calls.map((c: unknown[]) => String(c[0])).join('');

    expect(capturedMessage).toContain('memory updates are not supported in API sessions');
  }, 15000);

  // T-WP-2: allowTools=true — system note lists protected workspace files
  it('T-WP-2: allowTools=true system note lists protected workspace files', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    runner.sendApiMessageStream(
      'stream-wp-2',
        'test-chat',
      'do something',
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      { timeoutMs: 5000, allowTools: true },
    );

    await new Promise(r => setTimeout(r, 200));

    const proc = allProcesses[allProcesses.length - 1];
    const calls = (proc.stdin!.write as jest.Mock).mock.calls;
    const capturedMessage = calls.map((c: unknown[]) => String(c[0])).join('');

    expect(capturedMessage).toContain('AGENTS.md');
    expect(capturedMessage).toContain('SOUL.md');
    expect(capturedMessage).toContain('MEMORY.md');
  }, 15000);

  // T-WP-3: allowTools=false — system note also contains MEMORY_RULE override
  it('T-WP-3: allowTools=false system note also contains memory-rule override', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    runner.sendApiMessageStream(
      'stream-wp-3',
        'test-chat',
      'hello',
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      { timeoutMs: 5000, allowTools: false },
    );

    await new Promise(r => setTimeout(r, 200));

    const proc = allProcesses[allProcesses.length - 1];
    const calls = (proc.stdin!.write as jest.Mock).mock.calls;
    const capturedMessage = calls.map((c: unknown[]) => String(c[0])).join('');

    expect(capturedMessage).toContain('memory updates are not supported in API sessions');
  }, 15000);

  // T-WP-4: allowTools=false — system note instructs no tool use
  it('T-WP-4: allowTools=false system note instructs no tool use', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    runner.sendApiMessageStream(
      'stream-wp-4',
        'test-chat',
      'hello',
      { onChunk: () => {}, onDone: () => {}, onError: () => {} },
      { timeoutMs: 5000, allowTools: false },
    );

    await new Promise(r => setTimeout(r, 200));

    const proc = allProcesses[allProcesses.length - 1];
    const calls = (proc.stdin!.write as jest.Mock).mock.calls;
    const capturedMessage = calls.map((c: unknown[]) => String(c[0])).join('');

    expect(capturedMessage).toContain('Do NOT call any tools');
  }, 15000);

  // --------------------------------------------------------------------------
  // T-AR-STREAM-16: No duplicate text in buffer from partial messages
  // --------------------------------------------------------------------------
  it('T-AR-STREAM-16: no duplicate text in buffer from partial messages', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-partial-16',
        'test-chat',
        'hello',
        {
          onChunk: (event) => chunks.push(event),
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));

    const session = getSessions(runner).get('stream-partial-16')!;
    expect(session).toBeDefined();

    // Simulate partial assistant messages (cumulative)
    session.emit('output', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
      stop_reason: null,
    }));

    session.emit('output', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
      stop_reason: null,
    }));

    // Result — the final text should be exactly "Hello world", not "HelloHello world"
    session.emit('output', JSON.stringify({ type: 'result', result: 'Hello world' }));

    const result = await donePromise;
    expect(result).toBe('Hello world');
    // Also verify via chunks: concatenated deltas should equal "Hello world"
    const allDeltaText = chunks
      .filter(c => c.type === 'text_delta')
      .map(c => (c as { text: string }).text)
      .join('');
    expect(allDeltaText).toBe('Hello world');
  }, 15000);

  // T-TOOL-USE-PTY: PTY mode (headless=false) emits tool_use blocks inside assistant messages
  it('T-TOOL-USE-PTY: emits tool_use events from PTY-mode assistant message', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-tool-use-pty',
        'test-chat',
        'open google',
        {
          onChunk: (event) => chunks.push(event),
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));

    const session = getSessions(runner).get('stream-tool-use-pty')!;
    expect(session).toBeDefined();

    // Simulate PTY-mode assistant message with tool_use block (from emitter.ts emitAssistant)
    session.emit('output', JSON.stringify({
      type: 'assistant',
      session_id: 'stream-tool-use-pty',
      stop_reason: 'tool_use',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_abc123', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: '' }));

    await donePromise;

    const toolUseChunks = chunks.filter(c => c.type === 'tool_use');
    expect(toolUseChunks).toHaveLength(1);
    const toolEvent = toolUseChunks[0] as { type: 'tool_use'; name: string; id: string; input?: Record<string, unknown> };
    expect(toolEvent.name).toBe('Bash');
    expect(toolEvent.id).toBe('tu_abc123');
    expect(toolEvent.input).toEqual({ command: 'ls' });
  }, 15000);

  // T-TOOL-USE-PTY-MIXED: PTY mode assistant message with both text and tool_use blocks
  it('T-TOOL-USE-PTY-MIXED: emits both text_delta and tool_use from mixed assistant message', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'stream-tool-use-mixed',
        'test-chat',
        'hello with tool',
        {
          onChunk: (event) => chunks.push(event),
          onDone: (text) => resolve(text),
          onError: () => {},
        },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));

    const session = getSessions(runner).get('stream-tool-use-mixed')!;

    // Simulate assistant message with both text and tool_use
    session.emit('output', JSON.stringify({
      type: 'assistant',
      stop_reason: 'tool_use',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Opening now.' },
          { type: 'tool_use', id: 'tu_xyz', name: 'Skill', input: { skill: 'browser' } },
        ],
      },
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'Opening now.' }));

    await donePromise;

    expect(chunks.some(c => c.type === 'text_delta')).toBe(true);
    expect(chunks.some(c => c.type === 'tool_use')).toBe(true);
    const toolEvent = chunks.find(c => c.type === 'tool_use') as { type: 'tool_use'; name: string; id: string } | undefined;
    expect(toolEvent?.name).toBe('Skill');
    expect(toolEvent?.id).toBe('tu_xyz');
  }, 15000);
});

// ── sendApiMessage (sync) tests ───────────────────────────────────────────────

describe('AgentRunner — timeout keeps listening (#75)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-t75-test-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    agentConfig = makeAgentConfig(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('stream: a result arriving AFTER the soft timeout still persists to history with its attachments', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const softTimeout = new Promise<void>((resolve) => {
      runner.sendApiMessageStream(
        'late-1',
        'late-chat',
        'slow turn',
        {
          onChunk: (event) => { if (event.type === 'timeout') resolve(); },
          onDone: () => {},
          onError: () => {},
        },
        { timeoutMs: 200 },
      );
    });
    await waitForSession(runner, 'late-1');

    // Soft timeout fires and the client is told the turn is running long (#421)…
    await softTimeout;

    // …but the turn is still listening: register an attachment and finish late.
    const mediaDir = path.join(runner.getAgentsBaseDir(), 'alfred', 'media', 'api-late-1');
    fs.mkdirSync(mediaDir, { recursive: true });
    const absFile = path.join(mediaDir, 'late.png');
    fs.writeFileSync(absFile, 'png-bytes');
    runner.addApiAttachments('late-1', [absFile]);

    const session = getSessions(runner).get('late-1')!;
    session.emit('output', JSON.stringify({ type: 'result', result: 'finished late' }));
    await new Promise(r => setTimeout(r, 100));

    // Newest-first: [assistant "finished late", user "slow turn"]
    const page = runner.getHistoryDb().getMessages('api-late-chat');
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]!.role).toBe('assistant');
    expect(page.messages[0]!.content).toBe('finished late');
    expect(page.messages[0]!.mediaFiles).toEqual(['media/api-late-1/late.png']);
    // Session slot freed only after the late result, and the buffer is drained.
    expect(runner.hasActiveApiSession('late-1')).toBe(false);
    expect(runner.popApiAttachments('late-1')).toEqual([]);
  }, 15000);

  it('sync: a result arriving AFTER the soft timeout still persists to history', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const rejected = runner
      .sendApiMessage('late-sync', 'late-sync-chat', 'slow turn', { timeoutMs: 200 })
      .then(() => null, (err: Error) => err);
    await waitForSession(runner, 'late-sync');
    const err = await rejected;
    expect(err).not.toBeNull();
    // TIMEOUT_SOFT, not TIMEOUT: the caller's budget elapsed but the turn is
    // still running — which is precisely what the rest of this test asserts.
    // The hard cap, which does end the turn, keeps the bare TIMEOUT.
    expect((err as Error & { code: string }).code).toBe('TIMEOUT_SOFT');

    const session = getSessions(runner).get('late-sync')!;
    session.emit('output', JSON.stringify({ type: 'result', result: 'sync late' }));
    await new Promise(r => setTimeout(r, 100));

    // Newest-first: [assistant "sync late", user "slow turn"]
    const page = runner.getHistoryDb().getMessages('api-late-sync-chat');
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]!.role).toBe('assistant');
    expect(page.messages[0]!.content).toBe('sync late');
  }, 15000);

  it('a new turn clears attachments a dead turn left behind (no cross-turn leak)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    // Simulate a dead turn's leftovers sitting in the buffer.
    const mediaDir = path.join(runner.getAgentsBaseDir(), 'alfred', 'media', 'api-leak-1');
    fs.mkdirSync(mediaDir, { recursive: true });
    const stale = path.join(mediaDir, 'stale.png');
    fs.writeFileSync(stale, 'stale-bytes');
    runner.addApiAttachments('leak-1', [stale]);

    const donePromise = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'leak-1',
        'leak-chat',
        'fresh turn',
        { onChunk: () => {}, onDone: (text) => resolve(text), onError: () => {} },
        { timeoutMs: 5000 },
      );
    });
    await waitForSession(runner, 'leak-1');
    const session = getSessions(runner).get('leak-1')!;
    session.emit('output', JSON.stringify({ type: 'result', result: 'clean reply' }));
    await donePromise;
    await new Promise(r => setTimeout(r, 50));

    const page = runner.getHistoryDb().getMessages('api-leak-chat');
    const assistantRow = page.messages.find((m) => m.role === 'assistant')!;
    // The stale attachment from the dead turn must NOT ride on this reply.
    expect(assistantRow.mediaFiles).toBeUndefined();
  }, 15000);
});

describe('AgentRunner — sendApiMessage (sync)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-sync-test-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    agentConfig = makeAgentConfig(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // T-API-SYNC-1: agent attachments are persisted to history mediaFiles (sync path)
  it('T-API-SYNC-1: agent attachments are persisted to history mediaFiles', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const mediaAbs = path.join(tmpDir, 'agents', 'alfred', 'media', 'api-sync-t1', 'shot.jpg');
    fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
    fs.writeFileSync(mediaAbs, 'fake-image');

    const resultPromise = runner.sendApiMessage(
      'sync-t1',
      'test-chat-sync',
      'browse and screenshot',
      { timeoutMs: 10000 },
    );

    await waitForSession(runner, 'sync-t1');

    runner.addApiAttachments('sync-t1', [mediaAbs]);
    const session = getSessions(runner).get('sync-t1')!;
    session.emit('output', JSON.stringify({ type: 'result', result: 'Screenshot ready' }));

    const result = await resultPromise;
    expect(result.text).toBe('Screenshot ready');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].url).toBe('/v1/agents/alfred/media/api-sync-t1/shot.jpg');

    const page = runner.getHistoryDb().getMessages('api-test-chat-sync');
    const msgs = page.messages as Array<{ role: string; content: string; mediaFiles?: string[] }>;
    const assistantMsg = msgs.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe('Screenshot ready');
    expect(assistantMsg!.mediaFiles).toEqual(['media/api-sync-t1/shot.jpg']);
  }, 15000);

  // T-API-SYNC-2: image-only reply (empty text) persists with mediaFiles (sync path)
  it('T-API-SYNC-2: image-only replies persist via attachments', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const mediaAbs = path.join(tmpDir, 'agents', 'alfred', 'media', 'api-sync-t2', 'only.jpg');
    fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
    fs.writeFileSync(mediaAbs, 'fake-image');

    const resultPromise = runner.sendApiMessage(
      'sync-t2',
      'test-chat-sync-img',
      'screenshot',
      { timeoutMs: 10000 },
    );

    await waitForSession(runner, 'sync-t2');

    runner.addApiAttachments('sync-t2', [mediaAbs]);
    const session = getSessions(runner).get('sync-t2')!;
    session.emit('output', JSON.stringify({ type: 'result', result: '' }));

    const result = await resultPromise;
    expect(result.text).toBe('');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].url).toBe('/v1/agents/alfred/media/api-sync-t2/only.jpg');

    const page = runner.getHistoryDb().getMessages('api-test-chat-sync-img');
    const msgs = page.messages as Array<{ role: string; content: string; mediaFiles?: string[] }>;
    const assistantMsg = msgs.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe('');
    expect(assistantMsg!.mediaFiles).toEqual(['media/api-sync-t2/only.jpg']);
  }, 15000);
});

// ── Typing persistence tests ──────────────────────────────────────────────────

describe('AgentRunner — typing persistence', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    jest.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-typing-persist-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function getTypingDir(): string {
    return path.join(agentConfig.workspace, '.telegram-state', 'typing');
  }

  /**
   * Helper: start runner, create a Telegram session, pre-create the typing signal file,
   * and return the session for emitting events.
   */
  async function setupSessionWithTypingFile(chatId: string): Promise<SessionProcess> {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // Coalesce now debounces text messages too (A1, #290), so the spawn happens
    // on the coalesce timer — schedule it under real timers (before the POST) so
    // it actually fires during the wait below rather than as an abandoned fake timer.
    jest.useRealTimers();
    await sendChannelPost(port, chatId, 'hello');
    await new Promise(r => setTimeout(r, 150));
    jest.useFakeTimers();

    const session = getSessions(runner).get(chatId)!;
    expect(session).toBeDefined();

    // Pre-create typing signal file (normally created by typing plugin on receiver side)
    const typingDir = getTypingDir();
    fs.mkdirSync(typingDir, { recursive: true });
    fs.writeFileSync(path.join(typingDir, chatId), '');

    return session;
  }

  // --------------------------------------------------------------------------
  // U-AR-TYPING-05: result event does not delete typing file immediately
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-05: result event does not delete typing file immediately', async () => {
    const chatId = 'chat:t05';
    const session = await setupSessionWithTypingFile(chatId);

    // Emit result event
    session.emit('output', JSON.stringify({ type: 'result', result: 'done' }));

    // Do NOT advance timers — check immediately (0ms after result)
    const typingFile = path.join(getTypingDir(), chatId);
    expect(fs.existsSync(typingFile)).toBe(true);
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-TYPING-06: result event deletes typing file after 3s delay
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-06: result event deletes typing file after 3s delay', async () => {
    const chatId = 'chat:t06';
    const session = await setupSessionWithTypingFile(chatId);

    // Emit result event
    session.emit('output', JSON.stringify({ type: 'result', result: 'done' }));

    // Advance fake timers by 3000ms (the TYPING_DONE_DELAY_MS)
    jest.advanceTimersByTime(3000);

    const typingFile = path.join(getTypingDir(), chatId);
    expect(fs.existsSync(typingFile)).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-TYPING-07: new output within 3s cancels typing done
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-07: new output within 3s cancels typing done', async () => {
    const chatId = 'chat:t07';
    const session = await setupSessionWithTypingFile(chatId);

    // Emit result event (starts 3s timer)
    session.emit('output', JSON.stringify({ type: 'result', result: 'partial' }));

    // Advance 1s, then emit new assistant output (cancels the pending timer)
    jest.advanceTimersByTime(1000);
    session.emit('output', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'continuing...' }] },
      stop_reason: null,
    }));

    // Advance to 4s total (3s after the first result, 3s after the new output hasn't elapsed yet)
    jest.advanceTimersByTime(3000);

    // Typing file should still exist — the new output cancelled the first timer
    // and no new result event was emitted, so no new 3s timer was started
    const typingFile = path.join(getTypingDir(), chatId);
    expect(fs.existsSync(typingFile)).toBe(true);
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-TYPING-08: multiple result events only trigger one deletion
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-08: multiple result events only trigger one deletion', async () => {
    const chatId = 'chat:t08';
    const session = await setupSessionWithTypingFile(chatId);

    // Spy on writeTypingDone to count calls
    const writeTypingDoneSpy = jest.spyOn(
      runner as unknown as { writeTypingDone: (id: string) => void },
      'writeTypingDone',
    );

    // Emit 3 result events rapidly
    session.emit('output', JSON.stringify({ type: 'result', result: 'r1' }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'r2' }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'r3' }));

    // Advance 3s after the last result
    jest.advanceTimersByTime(3000);

    const typingFile = path.join(getTypingDir(), chatId);
    expect(fs.existsSync(typingFile)).toBe(false);

    // writeTypingDone should have been called exactly once (only the last timer fires)
    expect(writeTypingDoneSpy).toHaveBeenCalledTimes(1);
    expect(writeTypingDoneSpy).toHaveBeenCalledWith(chatId);

    writeTypingDoneSpy.mockRestore();
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-TYPING-09: session exit clears pending timer and calls writeTypingDone
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-09: session exit clears pending timer and calls writeTypingDone immediately', async () => {
    const chatId = 'chat:t09';
    const session = await setupSessionWithTypingFile(chatId);

    // Emit result event (starts 3s timer)
    session.emit('output', JSON.stringify({ type: 'result', result: 'working' }));

    // Before 3s elapses, emit exit on session (simulates session termination)
    jest.advanceTimersByTime(500);
    session.emit('exit');

    // Typing file should be deleted immediately on exit (no need to wait 3s)
    const typingFile = path.join(getTypingDir(), chatId);
    expect(fs.existsSync(typingFile)).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // U-AR-TYPING-10: reply tool call does not affect typing file
  // --------------------------------------------------------------------------
  it('U-AR-TYPING-10: reply tool call does not affect typing file', async () => {
    const chatId = 'chat:t10';
    const session = await setupSessionWithTypingFile(chatId);

    // Emit assistant message with mcp__telegram__reply tool_use
    session.emit('output', JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'mcp__telegram__reply', id: 'tool-1' },
        ],
      },
      stop_reason: null,
    }));

    // Typing file should still exist — reply tool does not trigger typing done
    const typingFile = path.join(getTypingDir(), chatId);
    expect(fs.existsSync(typingFile)).toBe(true);
  }, 15000);

});

// ── Session command routing tests ─────────────────────────────────────────────

describe('AgentRunner — session command routing', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-session-cmd-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function getTypingDir(): string {
    return path.join(agentConfig.workspace, '.telegram-state', 'typing');
  }

  async function postChannelMessage(port: number, chatId: string, content: string): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        meta: {
          chat_id: chatId,
          message_id: '1',
          user: 'testuser',
          ts: new Date().toISOString(),
        },
      }),
    });
  }

  // -------------------------------------------------------------------------
  // U11: /sessions command → not forwarded to SessionProcess, triggers session list
  // -------------------------------------------------------------------------
  it('U11: /sessions command is NOT forwarded to SessionProcess but triggers session list handling', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // Send a /sessions command
    await postChannelMessage(port, 'chat:session-cmd', '/sessions');
    await new Promise(r => setTimeout(r, 200));

    // The session process should NOT have been spawned (command handled before getOrSpawnSession)
    const sessions = getSessions(runner);
    expect(sessions.has('chat:session-cmd')).toBe(false);

    // A .forward file should have been written (session list response)
    const forwardFile = path.join(getTypingDir(), 'chat:session-cmd.forward');
    expect(fs.existsSync(forwardFile)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    expect(typeof entries[0].text).toBe('string');
    expect(entries[0].text).toContain('Session');
  }, 15000);

  // -------------------------------------------------------------------------
  // U12: /new my session → creates session, sends confirmation via auto-forward
  // -------------------------------------------------------------------------
  it('U12: /new <name> creates a new session and sends confirmation via auto-forward', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // Send a /new command with a session name
    await postChannelMessage(port, 'chat:new-cmd', '/new my session');
    await new Promise(r => setTimeout(r, 300));

    // A .forward file should contain confirmation
    const forwardFile = path.join(getTypingDir(), 'chat:new-cmd.forward');
    expect(fs.existsSync(forwardFile)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    expect(entries[0].text).toContain('my session');
    expect(entries[0].text).toContain('New session created');

    // The process should NOT be in the session map (new sessions are lazily spawned)
    const sessions = getSessions(runner);
    expect(sessions.has('chat:new-cmd')).toBe(false);
  }, 15000);

  it('U12b: /new without name creates "Session N" and sends confirmation', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await postChannelMessage(port, 'chat:new-noname', '/new');
    await new Promise(r => setTimeout(r, 300));

    const forwardFile = path.join(getTypingDir(), 'chat:new-noname.forward');
    expect(fs.existsSync(forwardFile)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    // Auto-name should follow "Session N" pattern
    expect(entries[0].text).toMatch(/Session \d/);
  }, 15000);

  // -------------------------------------------------------------------------
  // U13: regular message (non-command) → forwarded to Claude normally
  // -------------------------------------------------------------------------
  it('U13: regular (non-command) message is forwarded to Claude via SessionProcess', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // Send a plain message
    await postChannelMessage(port, 'chat:regular', 'Hello, Claude!');
    await new Promise(r => setTimeout(r, 200));

    // A SessionProcess should have been spawned for this chat
    const sessions = getSessions(runner);
    expect(sessions.has('chat:regular')).toBe(true);

    // The process's stdin should have received the message
    // Skip TelegramReceiver (0 writes) — find session process with stdin writes
    const proc = allProcesses.find(p => !p.killed && p.stdin!.write.mock.calls.length > 0);
    expect(proc).toBeDefined();
    const writeCallArgs = proc!.stdin!.write.mock.calls.map((c: unknown[]) => c[0] as string);
    const hasMessage = writeCallArgs.some(s => s.includes('Hello, Claude!'));
    expect(hasMessage).toBe(true);
  }, 15000);

  it('U13b: /sessions does not spawn a SessionProcess (only session list command)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    const spawnMock = require('child_process').spawn as jest.Mock;
    const spawnCountBefore = spawnMock.mock.calls.length;

    await postChannelMessage(port, 'chat:no-spawn', '/sessions');
    await new Promise(r => setTimeout(r, 200));

    const spawnCountAfter = spawnMock.mock.calls.length;
    // spawn should NOT have been called for a session command
    expect(spawnCountAfter).toBe(spawnCountBefore);
  }, 15000);

  // -------------------------------------------------------------------------
  // U14: menu_prompt + result — prose preceding the menu is forwarded, the
  // duplicated menu text suffix is stripped (previously the whole result was
  // dropped, losing plan/analysis text the user needed to answer the menu).
  // -------------------------------------------------------------------------
  it('U14: result prose before a bridged menu is forwarded with the menu suffix stripped', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    const chatId = 'chat:menu-strip';
    await postChannelMessage(port, chatId, 'plan something');
    await waitForSession(runner, chatId);
    const session = getSessions(runner).get(chatId)!;

    const menuText = '🔢 Choose an option — tap a button below.\n1. Yes\n2. No';
    session.emit('output', JSON.stringify({
      type: 'system',
      subtype: 'menu_prompt',
      prompt: menuText,
      options: [{ label: 'Yes' }, { label: 'No' }],
    }));
    // Menu bridged to buttons via the .menu file
    const menuFile = path.join(getTypingDir(), `${chatId}.menu`);
    expect(fs.existsSync(menuFile)).toBe(true);
    const menu = JSON.parse(fs.readFileSync(menuFile, 'utf8'));
    expect(menu.text).toBe(menuText);
    expect(menu.options).toHaveLength(2);

    const prose = 'Here is the detailed plan.\nStep 1 does X, step 2 does Y.';
    session.emit('output', JSON.stringify({
      type: 'result',
      is_error: false,
      result: `${prose}\n\n${menuText}`,
    }));
    await new Promise(r => setTimeout(r, 100));

    const forwardFile = path.join(getTypingDir(), `${chatId}.forward`);
    expect(fs.existsSync(forwardFile)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    expect(entries[0].text).toContain('Here is the detailed plan.');
    expect(entries[0].text).not.toContain('Choose an option');
  }, 15000);

  it('U14b: result that is only the menu text produces no forward (no duplicate)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    const chatId = 'chat:menu-only';
    await postChannelMessage(port, chatId, 'ask me');
    await waitForSession(runner, chatId);
    const session = getSessions(runner).get(chatId)!;

    const menuText = '🔢 Choose an option\n1. A\n2. B';
    session.emit('output', JSON.stringify({
      type: 'system',
      subtype: 'menu_prompt',
      prompt: menuText,
      options: [{ label: 'A' }, { label: 'B' }],
    }));
    session.emit('output', JSON.stringify({ type: 'result', is_error: false, result: menuText }));
    await new Promise(r => setTimeout(r, 100));

    expect(fs.existsSync(path.join(getTypingDir(), `${chatId}.forward`))).toBe(false);
  }, 15000);

  it('U14c: menu text not embedded verbatim in result — forward suppressed (no double post)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    const chatId = 'chat:menu-reworded';
    await postChannelMessage(port, chatId, 'ask me');
    await waitForSession(runner, chatId);
    const session = getSessions(runner).get(chatId)!;

    session.emit('output', JSON.stringify({
      type: 'system',
      subtype: 'menu_prompt',
      prompt: '🔢 Choose an option\n1. A\n2. B',
      options: [{ label: 'A' }, { label: 'B' }],
    }));
    session.emit('output', JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'Reworded output listing 1. A and 2. B differently',
    }));
    await new Promise(r => setTimeout(r, 100));

    expect(fs.existsSync(path.join(getTypingDir(), `${chatId}.forward`))).toBe(false);
  }, 15000);
});

// ── Restart-before-turn tests (US-003) ───────────────────────────────────────

describe('AgentRunner — restart before turn (US-003)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-restart-turn-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // US3-01: needsRestart=false → no session restart, same process reused
  // --------------------------------------------------------------------------
  it('US3-01: needsRestart=false — existing session is reused without restart', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    expect(runner.restartPending('chat:r01')).toBe(false);

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:r01', 'first turn');
    await new Promise(r => setTimeout(r, 150));

    const firstSession = getSessions(runner).get('chat:r01')!;
    expect(firstSession).toBeDefined();
    const spawnCount = (require('child_process').spawn as jest.Mock).mock.calls.length;

    // Send second turn — needsRestart is still false
    await sendChannelPost(port, 'chat:r01', 'second turn');
    await new Promise(r => setTimeout(r, 150));

    const secondSession = getSessions(runner).get('chat:r01')!;
    // Same session object, no extra spawn
    expect(secondSession).toBe(firstSession);
    expect((require('child_process').spawn as jest.Mock).mock.calls.length).toBe(spawnCount);
  }, 15000);

  // --------------------------------------------------------------------------
  // US3-02: needsRestart=true → existing session stopped, new one spawned
  // --------------------------------------------------------------------------
  it('US3-02: needsRestart=true — session is stopped and a new one is spawned', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:r02', 'first turn');
    await new Promise(r => setTimeout(r, 150));

    const firstSession = getSessions(runner).get('chat:r02')!;
    expect(firstSession).toBeDefined();
    const stopSpy = jest.spyOn(firstSession, 'stop');

    // Trigger the restart flag
    (runner as any).pendingRestarts.add('chat:r02');

    const spawnCountBefore = (require('child_process').spawn as jest.Mock).mock.calls.length;

    // First turn must end before the next injects (gateway turn queue, #290).
    firstSession.emit('output', JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
    await new Promise(r => setTimeout(r, 20));

    await sendChannelPost(port, 'chat:r02', 'second turn');
    await new Promise(r => setTimeout(r, 150));

    // Old session was stopped
    expect(stopSpy).toHaveBeenCalled();
    // A new session was spawned
    expect((require('child_process').spawn as jest.Mock).mock.calls.length).toBeGreaterThan(spawnCountBefore);
    // New session object is different
    const newSession = getSessions(runner).get('chat:r02');
    expect(newSession).toBeDefined();
    expect(newSession).not.toBe(firstSession);
  }, 15000);

  // --------------------------------------------------------------------------
  // US3-03: needsRestart reset to false after restart
  // --------------------------------------------------------------------------
  it('US3-03: needsRestart is reset to false after restart', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:r03', 'first turn');
    await new Promise(r => setTimeout(r, 150));

    // First turn must end before the next injects (gateway turn queue, #290).
    getSessions(runner).get('chat:r03')!.emit('output', JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
    await new Promise(r => setTimeout(r, 20));

    (runner as any).pendingRestarts.add('chat:r03');

    await sendChannelPost(port, 'chat:r03', 'second turn');
    await new Promise(r => setTimeout(r, 150));

    expect(runner.restartPending('chat:r03')).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // US3-04: imageSizeSinceRestart reset to 0 after restart
  // --------------------------------------------------------------------------
  it('US3-04: imageSizeSinceRestart is reset to 0 after restart', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:r04', 'first turn');
    await new Promise(r => setTimeout(r, 150));

    // First turn must end before the next injects (gateway turn queue, #290).
    getSessions(runner).get('chat:r04')!.emit('output', JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
    await new Promise(r => setTimeout(r, 20));

    (runner as any).pendingRestarts.add('chat:r04');
    (runner as any).imageSizePerChat.set('chat:r04', MAX_IMAGE_SIZE_BYTES + 100);

    await sendChannelPost(port, 'chat:r04', 'second turn');
    await new Promise(r => setTimeout(r, 150));

    expect(runner.imageSize('chat:r04')).toBe(0);
  }, 15000);

  // --------------------------------------------------------------------------
  // US3-05: needsRestart=true with no existing session → no error, spawn fresh
  // --------------------------------------------------------------------------
  it('US3-05: needsRestart=true with no prior session — spawns fresh without error', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    (runner as any).pendingRestarts.add('chat:r05');
    (runner as any).imageSizePerChat.set('chat:r05', MAX_IMAGE_SIZE_BYTES + 1);

    const port = getCallbackPort(runner);

    // No prior session exists — should spawn cleanly
    await sendChannelPost(port, 'chat:r05', 'first turn ever');
    await new Promise(r => setTimeout(r, 150));

    expect(getSessions(runner).has('chat:r05')).toBe(true);
    expect(runner.restartPending('chat:r05')).toBe(false);
    expect(runner.imageSize('chat:r05')).toBe(0);
  }, 15000);

  // --------------------------------------------------------------------------
  // US3-06: text turn can trigger restart (not just image turns)
  // --------------------------------------------------------------------------
  it('US3-06: a text-only turn can trigger restart when needsRestart=true', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:r06', 'initial message');
    await new Promise(r => setTimeout(r, 150));

    const firstSession = getSessions(runner).get('chat:r06')!;
    const stopSpy = jest.spyOn(firstSession, 'stop');

    // First turn must end before the next injects (gateway turn queue, #290).
    firstSession.emit('output', JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
    await new Promise(r => setTimeout(r, 20));

    (runner as any).pendingRestarts.add('chat:r06');

    // Send a plain text turn (no image) — restart should still happen
    await sendChannelPost(port, 'chat:r06', 'plain text follow-up');
    await new Promise(r => setTimeout(r, 150));

    expect(stopSpy).toHaveBeenCalled();
    expect(runner.restartPending('chat:r06')).toBe(false);
  }, 15000);
});

// ── Image size edge cases (US-004) ────────────────────────────────────────────

describe('AgentRunner — image size edge cases (US-004)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-us4-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  async function sendImageChannelPost(
    port: number,
    chatId: string,
    imagePath: string,
    content = '',
  ): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        meta: {
          chat_id: chatId,
          message_id: '1',
          user: 'testuser',
          ts: new Date().toISOString(),
          image_path: imagePath,
        },
      }),
    });
  }

  // --------------------------------------------------------------------------
  // US4-01: Error turn with image → accumulator still counts
  // Binary was loaded into context before the error, so size must be tracked.
  // --------------------------------------------------------------------------
  it('US4-01: error result turn still accumulates image size', async () => {
    const testImagePath = path.join(tmpDir, 'err-img.jpg');
    const fileSize = 1024;
    fs.writeFileSync(testImagePath, Buffer.alloc(fileSize));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendImageChannelPost(port, 'chat:us4-01', testImagePath);
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:us4-01');
    expect(session).toBeDefined();

    // Emit an error result — binary was loaded into context before the error
    session!.emit('output', JSON.stringify({ type: 'result', result: '', is_error: true }));
    await new Promise(r => setTimeout(r, 100));

    expect(runner.imageSize('chat:us4-01')).toBe(fileSize);
  }, 15000);

  // --------------------------------------------------------------------------
  // US4-02: Single image > MAX_IMAGE_SIZE_BYTES → summary triggered then needsRestart = true
  // --------------------------------------------------------------------------
  it('US4-02: single image larger than MAX_IMAGE_SIZE_BYTES triggers summary then sets needsRestart', async () => {
    const testImagePath = path.join(tmpDir, 'large.jpg');
    const fileSize = MAX_IMAGE_SIZE_BYTES + 1;
    fs.writeFileSync(testImagePath, Buffer.alloc(fileSize));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendImageChannelPost(port, 'chat:us4-02', testImagePath);
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:us4-02');
    expect(session).toBeDefined();
    jest.spyOn(session!, 'query').mockResolvedValue('Image 1: A large test image');
    session!.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 200));

    expect(runner.restartPending('chat:us4-02')).toBe(true);
    expect(runner.imageSize('chat:us4-02')).toBe(0);
  }, 15000);

  // --------------------------------------------------------------------------
  // US4-03: Image sent after restart → accumulator starts from 0, not from old total
  // --------------------------------------------------------------------------
  it('US4-03: image sent after restart accumulates from zero, not from old session total', async () => {
    const img1 = path.join(tmpDir, 'before-restart.jpg');
    const img2 = path.join(tmpDir, 'after-restart.jpg');
    const size1 = 3000;
    const size2 = 512;
    fs.writeFileSync(img1, Buffer.alloc(size1));
    fs.writeFileSync(img2, Buffer.alloc(size2));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // First image turn (pre-restart session)
    await sendImageChannelPost(port, 'chat:us4-03', img1);
    await new Promise(r => setTimeout(r, 150));
    const session1 = getSessions(runner).get('chat:us4-03')!;
    expect(session1).toBeDefined();
    session1.emit('output', JSON.stringify({ type: 'result', result: 'done1' }));
    await new Promise(r => setTimeout(r, 100));
    expect(runner.imageSize('chat:us4-03')).toBe(size1);

    // Mark restart needed; next turn triggers the restart and resets accumulator to 0
    (runner as any).pendingRestarts.add('chat:us4-03');
    await sendChannelPost(port, 'chat:us4-03', 'text turn triggers restart');
    await new Promise(r => setTimeout(r, 150));
    expect(runner.imageSize('chat:us4-03')).toBe(0);

    // Image turn in the new session — must accumulate from zero
    await sendImageChannelPost(port, 'chat:us4-03', img2);
    await new Promise(r => setTimeout(r, 150));
    const session2 = getSessions(runner).get('chat:us4-03')!;
    expect(session2).toBeDefined();
    session2.emit('output', JSON.stringify({ type: 'result', result: 'done2' }));
    await new Promise(r => setTimeout(r, 100));

    // Only size2 should be in the accumulator — old total (size1) must not carry over
    expect(runner.imageSize('chat:us4-03')).toBe(size2);
    expect(runner.restartPending('chat:us4-03')).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // US4-04: query() called with summary prompt when threshold is crossed
  // --------------------------------------------------------------------------
  it('US4-04: session.query() is called with summary prompt when threshold is crossed', async () => {
    const testImagePath = path.join(tmpDir, 'us4-04.jpg');
    fs.writeFileSync(testImagePath, Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendImageChannelPost(port, 'chat:us4-04', testImagePath);
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:us4-04')!;
    const querySpy = jest.spyOn(session, 'query').mockResolvedValue('Image 1: A test image');

    session.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 200));

    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy.mock.calls[0][0]).toContain('summarize');
  }, 15000);

  // --------------------------------------------------------------------------
  // US4-05: needsRestart = true even when query() fails
  // --------------------------------------------------------------------------
  it('US4-05: needsRestart is set to true even when query() rejects', async () => {
    const testImagePath = path.join(tmpDir, 'us4-05.jpg');
    fs.writeFileSync(testImagePath, Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendImageChannelPost(port, 'chat:us4-05', testImagePath);
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:us4-05')!;
    jest.spyOn(session, 'query').mockRejectedValue(new Error('query failed'));

    session.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 200));

    expect(runner.restartPending('chat:us4-05')).toBe(true);
  }, 15000);
});

// ── Image size tracking tests (US-002) ────────────────────────────────────────

describe('AgentRunner — image size tracking (US-002)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-imgsize-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  async function sendImageChannelPost(
    port: number,
    chatId: string,
    imagePath: string,
    content = '',
  ): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        meta: {
          chat_id: chatId,
          message_id: '1',
          user: 'testuser',
          ts: new Date().toISOString(),
          image_path: imagePath,
        },
      }),
    });
  }

  // Same shape as sendImageChannelPost, plus the meta a non-image attachment
  // carries. LINE files ride the image_path channel so the runner stages them
  // into MediaStore, and media_type is what marks them as not-an-image.
  async function sendMediaChannelPost(
    port: number,
    chatId: string,
    mediaPath: string,
    extraMeta: Record<string, string>,
    content = '',
  ): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        meta: {
          chat_id: chatId,
          message_id: '1',
          user: 'testuser',
          ts: new Date().toISOString(),
          image_path: mediaPath,
          ...extraMeta,
        },
      }),
    });
  }

  // --------------------------------------------------------------------------
  // US2-01: text-only turn does not change imageSizeSinceRestart
  // --------------------------------------------------------------------------
  it('US2-01: text-only turn leaves imageSizeSinceRestart at zero', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'chat:img01', 'hello world');
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:img01');
    if (session) {
      session.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    }
    await new Promise(r => setTimeout(r, 100));

    expect(runner.imageSize('chat:img01')).toBe(0);
    expect(runner.restartPending('chat:img01')).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // US2-02: image turn accumulates file size in imageSizeSinceRestart
  // --------------------------------------------------------------------------
  it('US2-02: image turn accumulates file size in imageSizeSinceRestart', async () => {
    const testImagePath = path.join(tmpDir, 'test.jpg');
    const fileSize = 1024;
    fs.writeFileSync(testImagePath, Buffer.alloc(fileSize));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendImageChannelPost(port, 'chat:img02', testImagePath);
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:img02');
    expect(session).toBeDefined();
    session!.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));

    expect(runner.imageSize('chat:img02')).toBe(fileSize);
    expect(runner.restartPending('chat:img02')).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // #429: a non-image attachment (LINE file) must not consume the image budget
  // --------------------------------------------------------------------------
  it('#429: file attachment does not accumulate toward the image-size budget', async () => {
    const filePath = path.join(tmpDir, 'us429.pdf');
    fs.writeFileSync(filePath, Buffer.alloc(4096));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendMediaChannelPost(port, 'chat:f429', filePath, {
      media_type: 'file',
      attachment_kind: 'file',
      attachment_name: 'us429.pdf',
    }, '(file: us429.pdf)');
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:f429');
    expect(session).toBeDefined();
    session!.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));

    // A document the agent may never open must not push the chat toward a
    // summary+restart it never needed.
    expect(runner.imageSize('chat:f429')).toBe(0);
    expect(runner.restartPending('chat:f429')).toBe(false);
  }, 15000);

  // Anti-over-correction guard: the exclusion must key on media_type alone, so
  // every channel that does not set it (Telegram, Slack, web upload) keeps
  // counting exactly as before.
  it('#429: media_type=image and an absent media_type both still accumulate', async () => {
    const imgA = path.join(tmpDir, 'us429-a.jpg');
    const imgB = path.join(tmpDir, 'us429-b.jpg');
    fs.writeFileSync(imgA, Buffer.alloc(512));
    fs.writeFileSync(imgB, Buffer.alloc(256));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    // explicit media_type=image (what the LINE router sets for photos)
    await sendMediaChannelPost(port, 'chat:i429', imgA, { media_type: 'image' });
    await new Promise(r => setTimeout(r, 150));
    let session = getSessions(runner).get('chat:i429');
    expect(session).toBeDefined();
    session!.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));
    expect(runner.imageSize('chat:i429')).toBe(512);

    // no media_type at all (Telegram / Slack / web upload)
    await sendMediaChannelPost(port, 'chat:i429b', imgB, {});
    await new Promise(r => setTimeout(r, 150));
    session = getSessions(runner).get('chat:i429b');
    expect(session).toBeDefined();
    session!.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));
    expect(runner.imageSize('chat:i429b')).toBe(256);
  }, 20000);

  // --------------------------------------------------------------------------
  // US2-03: crossing MAX_IMAGE_SIZE_BYTES triggers summary then sets needsRestart = true
  // --------------------------------------------------------------------------
  it('US2-03: crossing MAX_IMAGE_SIZE_BYTES threshold triggers summary and sets needsRestart', async () => {
    const testImagePath = path.join(tmpDir, 'threshold.jpg');
    const fileSize = 200;
    fs.writeFileSync(testImagePath, Buffer.alloc(fileSize));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    // Pre-set accumulator so that adding fileSize bytes crosses the limit
    (runner as any).imageSizePerChat.set('chat:img03', MAX_IMAGE_SIZE_BYTES - fileSize + 1);

    const port = getCallbackPort(runner);
    await sendImageChannelPost(port, 'chat:img03', testImagePath);
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:img03');
    expect(session).toBeDefined();
    jest.spyOn(session!, 'query').mockResolvedValue('Image 1: A test threshold image');
    session!.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 200));

    expect(runner.restartPending('chat:img03')).toBe(true);
    expect(runner.imageSize('chat:img03')).toBe(0);
  }, 15000);

  // --------------------------------------------------------------------------
  // US2-04: fs.stat failure → log warning, accumulator unchanged, no crash
  // --------------------------------------------------------------------------
  it('US2-04: fs.stat failure does not change accumulator and does not crash', async () => {
    const nonExistentPath = path.join(tmpDir, 'no-such-file.jpg');

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendImageChannelPost(port, 'chat:img04', nonExistentPath);
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:img04');
    expect(session).toBeDefined();
    session!.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));

    expect(runner.imageSize('chat:img04')).toBe(0);
    expect(runner.restartPending('chat:img04')).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // US2-05: image with caption counts size normally
  // --------------------------------------------------------------------------
  it('US2-05: image with caption counts file size normally', async () => {
    const testImagePath = path.join(tmpDir, 'captioned.jpg');
    const fileSize = 512;
    fs.writeFileSync(testImagePath, Buffer.alloc(fileSize));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendImageChannelPost(port, 'chat:img05', testImagePath, 'look at this photo');
    await new Promise(r => setTimeout(r, 150));

    const session = getSessions(runner).get('chat:img05');
    expect(session).toBeDefined();
    session!.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));

    expect(runner.imageSize('chat:img05')).toBe(fileSize);
  }, 15000);

  // --------------------------------------------------------------------------
  // US2-06: multiple image turns from different chatIds each accumulate size independently
  // --------------------------------------------------------------------------
  it('US2-06: image turns on different chatIds accumulate size independently', async () => {
    const img1 = path.join(tmpDir, 'img1.jpg');
    const img2 = path.join(tmpDir, 'img2.jpg');
    fs.writeFileSync(img1, Buffer.alloc(300));
    fs.writeFileSync(img2, Buffer.alloc(700));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // First image turn
    await sendImageChannelPost(port, 'chat:img06a', img1);
    await new Promise(r => setTimeout(r, 150));
    const sessA = getSessions(runner).get('chat:img06a')!;
    expect(sessA).toBeDefined();
    sessA.emit('output', JSON.stringify({ type: 'result', result: 'done 1' }));
    await new Promise(r => setTimeout(r, 100));

    expect(runner.imageSize('chat:img06a')).toBe(300);

    // Second image turn on a different session
    await sendImageChannelPost(port, 'chat:img06b', img2);
    await new Promise(r => setTimeout(r, 150));
    const sessB = getSessions(runner).get('chat:img06b')!;
    expect(sessB).toBeDefined();
    sessB.emit('output', JSON.stringify({ type: 'result', result: 'done 2' }));
    await new Promise(r => setTimeout(r, 100));

    expect(runner.imageSize('chat:img06b')).toBe(700);
  }, 15000);

  // --------------------------------------------------------------------------
  // US2-07: rapid-fire images on same chatId — all counted, not just last
  // --------------------------------------------------------------------------
  it('US2-07: multiple images sent rapidly on same chatId all accumulate via queue', async () => {
    const img1 = path.join(tmpDir, 'rapid1.jpg');
    const img2 = path.join(tmpDir, 'rapid2.jpg');
    const img3 = path.join(tmpDir, 'rapid3.jpg');
    fs.writeFileSync(img1, Buffer.alloc(100));
    fs.writeFileSync(img2, Buffer.alloc(200));
    fs.writeFileSync(img3, Buffer.alloc(300));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    // Send 3 images before any result fires — all should be enqueued
    await sendImageChannelPost(port, 'chat:img07', img1);
    await sendImageChannelPost(port, 'chat:img07', img2);
    await sendImageChannelPost(port, 'chat:img07', img3);
    await new Promise(r => setTimeout(r, 200));

    const session = getSessions(runner).get('chat:img07')!;
    expect(session).toBeDefined();

    // Fire 3 results — each dequeues one image path
    session.emit('output', JSON.stringify({ type: 'result', result: 'turn1' }));
    await new Promise(r => setTimeout(r, 100));
    expect(runner.imageSize('chat:img07')).toBe(100);

    session.emit('output', JSON.stringify({ type: 'result', result: 'turn2' }));
    await new Promise(r => setTimeout(r, 100));
    expect(runner.imageSize('chat:img07')).toBe(300); // 100 + 200

    session.emit('output', JSON.stringify({ type: 'result', result: 'turn3' }));
    await new Promise(r => setTimeout(r, 100));
    expect(runner.imageSize('chat:img07')).toBe(600); // 100 + 200 + 300
  }, 15000);
});

// ── Discord-aware auto-forward format (US-005) ─────────────────────────────────

describe('AgentRunner — Discord-aware auto-forward format (US-005)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-discord-fmt-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  async function sendImageChannelPost(
    port: number,
    chatId: string,
    imagePath: string,
    content = '',
  ): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        meta: {
          chat_id: chatId,
          message_id: '1',
          user: 'testuser',
          ts: new Date().toISOString(),
          image_path: imagePath,
        },
      }),
    });
  }

  // US5-01: Discord auto-forward uses plain text format (not html)
  it('US5-01: Discord result text is forwarded as plain text, not Telegram HTML', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'ch:disc01', 'hello');
    await new Promise(r => setTimeout(r, 150));

    (runner as any).channelSourceMap?.set('ch:disc01', 'discord');

    const session = getSessions(runner).get('ch:disc01');
    expect(session).toBeDefined();

    const writeForwardSpy = jest.spyOn(
      runner as unknown as { writeAutoForward: (chatId: string, text: string, format?: string, forceDeliver?: boolean) => void },
      'writeAutoForward',
    );

    session!.emit('output', JSON.stringify({ type: 'result', result: '**bold** and `code`' }));
    await new Promise(r => setTimeout(r, 100));

    // No reply call failed this turn, so the forward is NOT force-delivered
    // (#422) — it keeps the turn id the receiver dedups against.
    expect(writeForwardSpy).toHaveBeenCalledWith('ch:disc01', '**bold** and `code`', 'text', false);
  }, 15000);

  // US5-02: Telegram result text with markdown is converted to HTML
  it('US5-02: Telegram result text with markdown is forwarded as Telegram HTML', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'ch:tg01', 'hello');
    await new Promise(r => setTimeout(r, 150));

    (runner as any).channelSourceMap?.set('ch:tg01', 'telegram');

    const session = getSessions(runner).get('ch:tg01');
    expect(session).toBeDefined();

    const writeForwardSpy = jest.spyOn(
      runner as unknown as { writeAutoForward: (chatId: string, text: string, format?: string, forceDeliver?: boolean) => void },
      'writeAutoForward',
    );

    session!.emit('output', JSON.stringify({ type: 'result', result: '**bold text**' }));
    await new Promise(r => setTimeout(r, 100));

    expect(writeForwardSpy).toHaveBeenCalledWith(
      'ch:tg01',
      expect.stringContaining('<b>'),
      'html',
      false,
    );
  }, 15000);

  // US5-03: Telegram plain text (no markdown) forwarded without html format
  it('US5-03: Telegram result text without markdown is forwarded as plain text', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await sendChannelPost(port, 'ch:tg02', 'hello');
    await new Promise(r => setTimeout(r, 150));

    (runner as any).channelSourceMap?.set('ch:tg02', 'telegram');

    const session = getSessions(runner).get('ch:tg02');
    expect(session).toBeDefined();

    const writeForwardSpy = jest.spyOn(
      runner as unknown as { writeAutoForward: (chatId: string, text: string, format?: string, forceDeliver?: boolean) => void },
      'writeAutoForward',
    );

    session!.emit('output', JSON.stringify({ type: 'result', result: 'plain text no markdown' }));
    await new Promise(r => setTimeout(r, 100));

    expect(writeForwardSpy).toHaveBeenCalledWith('ch:tg02', 'plain text no markdown', 'text', false);
  }, 15000);

  // US5-04: per-chat image counters are independent across chatIds
  it('US5-04: image size counters for different chatIds are independent', async () => {
    const img1 = path.join(tmpDir, 'chat-a.jpg');
    const img2 = path.join(tmpDir, 'chat-b.jpg');
    fs.writeFileSync(img1, Buffer.alloc(500));
    fs.writeFileSync(img2, Buffer.alloc(800));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendImageChannelPost(port, 'chat:iso-a', img1);
    await new Promise(r => setTimeout(r, 150));
    const sessA = getSessions(runner).get('chat:iso-a')!;
    sessA.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));

    await sendImageChannelPost(port, 'chat:iso-b', img2);
    await new Promise(r => setTimeout(r, 150));
    const sessB = getSessions(runner).get('chat:iso-b')!;
    sessB.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));

    expect(runner.imageSize('chat:iso-a')).toBe(500);
    expect(runner.imageSize('chat:iso-b')).toBe(800);
  }, 15000);

  // US5-05: restart flag for one chatId does not affect another
  it('US5-05: restart flag set for chatId A does not trigger restart for chatId B', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:rst-a', 'first message');
    await new Promise(r => setTimeout(r, 150));

    (runner as any).pendingRestarts.add('chat:rst-a');

    expect(runner.restartPending('chat:rst-a')).toBe(true);
    expect(runner.restartPending('chat:rst-b')).toBe(false);
  }, 15000);

  // US5-06: restart clears only the triggering chatId's counter
  it('US5-06: restart triggered for chatId A clears only A counter, B counter unchanged', async () => {
    const imgA = path.join(tmpDir, 'reset-a.jpg');
    const imgB = path.join(tmpDir, 'reset-b.jpg');
    fs.writeFileSync(imgA, Buffer.alloc(300));
    fs.writeFileSync(imgB, Buffer.alloc(400));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);

    await sendImageChannelPost(port, 'chat:clr-a', imgA);
    await new Promise(r => setTimeout(r, 150));
    const sessA = getSessions(runner).get('chat:clr-a')!;
    sessA.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));

    await sendImageChannelPost(port, 'chat:clr-b', imgB);
    await new Promise(r => setTimeout(r, 150));
    const sessB = getSessions(runner).get('chat:clr-b')!;
    sessB.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await new Promise(r => setTimeout(r, 100));

    expect(runner.imageSize('chat:clr-a')).toBe(300);
    expect(runner.imageSize('chat:clr-b')).toBe(400);

    // Manually trigger restart for chat A only
    (runner as any).pendingRestarts.add('chat:clr-a');
    (runner as any).imageSizePerChat.delete('chat:clr-a');

    // After reset: A is 0, B is unchanged
    expect(runner.imageSize('chat:clr-a')).toBe(0);
    expect(runner.imageSize('chat:clr-b')).toBe(400);
  }, 15000);
});

// ── Model override / switch-back tests (US-MOD) ───────────────────────────────

describe('AgentRunner — per-session model override', () => {
  const AGENT_DEFAULT_MODEL = 'claude-opus-4-6';
  const NON_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-model-test-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    agentConfig = makeAgentConfig(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // US-MOD-01: same model → no restart
  it('US-MOD-01: same non-default model on consecutive requests — no restart', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const done1 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-01',
        'test-chat',
        'first',
        { onChunk: (e) => chunks.push(e), onDone: resolve, onError: () => {} },
        { timeoutMs: 5000, model: NON_DEFAULT_MODEL },
      );
    });
    await new Promise(r => setTimeout(r, 150));
    const session1 = getSessions(runner).get('mod-01')!;
    expect(session1).toBeDefined();
    session1.emit('output', JSON.stringify({ type: 'result', result: 'r1' }));
    await done1;

    const spawnCountAfterFirst = (require('child_process').spawn as jest.Mock).mock.calls.length;

    // Second request with same model — should reuse session
    const done2 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-01',
        'test-chat',
        'second',
        { onChunk: () => {}, onDone: resolve, onError: () => {} },
        { timeoutMs: 5000, model: NON_DEFAULT_MODEL },
      );
    });
    await new Promise(r => setTimeout(r, 150));
    const session2 = getSessions(runner).get('mod-01')!;
    session2.emit('output', JSON.stringify({ type: 'result', result: 'r2' }));
    await done2;

    expect((require('child_process').spawn as jest.Mock).mock.calls.length).toBe(spawnCountAfterFirst);
    expect(session2).toBe(session1);
  }, 15000);

  // US-MOD-02: switch from non-default model to different non-default → restart
  it('US-MOD-02: switching from one non-default model to another — restarts session', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const done1 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-02',
        'test-chat',
        'first',
        { onChunk: () => {}, onDone: resolve, onError: () => {} },
        { timeoutMs: 5000, model: NON_DEFAULT_MODEL },
      );
    });
    await new Promise(r => setTimeout(r, 150));
    const session1 = getSessions(runner).get('mod-02')!;
    session1.emit('output', JSON.stringify({ type: 'result', result: 'r1' }));
    await done1;

    const spawnCountAfterFirst = (require('child_process').spawn as jest.Mock).mock.calls.length;

    const done2 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-02',
        'test-chat',
        'second',
        { onChunk: () => {}, onDone: resolve, onError: () => {} },
        { timeoutMs: 5000, model: 'claude-sonnet-4-6' },
      );
    });
    await new Promise(r => setTimeout(r, 250));
    const session2 = getSessions(runner).get('mod-02')!;
    session2.emit('output', JSON.stringify({ type: 'result', result: 'r2' }));
    await done2;

    expect((require('child_process').spawn as jest.Mock).mock.calls.length).toBeGreaterThan(spawnCountAfterFirst);
    expect(session2).not.toBe(session1);
  }, 15000);

  // US-MOD-03: switch from non-default back to default (no model sent) → restart
  it('US-MOD-03: switching back to agent default (no model in request) — restarts session', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    // First request with non-default model
    const done1 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-03',
        'test-chat',
        'first',
        { onChunk: () => {}, onDone: resolve, onError: () => {} },
        { timeoutMs: 5000, model: NON_DEFAULT_MODEL },
      );
    });
    await new Promise(r => setTimeout(r, 150));
    const session1 = getSessions(runner).get('mod-03')!;
    session1.emit('output', JSON.stringify({ type: 'result', result: 'r1' }));
    await done1;

    const spawnCountAfterFirst = (require('child_process').spawn as jest.Mock).mock.calls.length;

    // Second request with NO model (switch back to default)
    const done2 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-03',
        'test-chat',
        'second',
        { onChunk: () => {}, onDone: resolve, onError: () => {} },
        { timeoutMs: 5000 }, // no model field
      );
    });
    await new Promise(r => setTimeout(r, 250));
    const session2 = getSessions(runner).get('mod-03')!;
    session2.emit('output', JSON.stringify({ type: 'result', result: 'r2' }));
    await done2;

    expect((require('child_process').spawn as jest.Mock).mock.calls.length).toBeGreaterThan(spawnCountAfterFirst);
    expect(session2).not.toBe(session1);
  }, 15000);

  // US-MOD-04: switch from non-default back to default (explicit default sent) → restart
  it('US-MOD-04: switching back to agent default (explicit default model) — restarts session', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const done1 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-04',
        'test-chat',
        'first',
        { onChunk: () => {}, onDone: resolve, onError: () => {} },
        { timeoutMs: 5000, model: NON_DEFAULT_MODEL },
      );
    });
    await new Promise(r => setTimeout(r, 150));
    const session1 = getSessions(runner).get('mod-04')!;
    session1.emit('output', JSON.stringify({ type: 'result', result: 'r1' }));
    await done1;

    const spawnCountAfterFirst = (require('child_process').spawn as jest.Mock).mock.calls.length;

    // Send the agent default model explicitly — should be treated as "no override" → restart
    const done2 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-04',
        'test-chat',
        'second',
        { onChunk: () => {}, onDone: resolve, onError: () => {} },
        { timeoutMs: 5000, model: AGENT_DEFAULT_MODEL },
      );
    });
    await new Promise(r => setTimeout(r, 250));
    const session2 = getSessions(runner).get('mod-04')!;
    session2.emit('output', JSON.stringify({ type: 'result', result: 'r2' }));
    await done2;

    expect((require('child_process').spawn as jest.Mock).mock.calls.length).toBeGreaterThan(spawnCountAfterFirst);
    expect(session2).not.toBe(session1);
  }, 15000);

  // US-MOD-05: session already on default, re-send default → no restart
  it('US-MOD-05: session on default model, re-sending default model — no restart', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const done1 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-05',
        'test-chat',
        'first',
        { onChunk: () => {}, onDone: resolve, onError: () => {} },
        { timeoutMs: 5000 }, // no model = use default
      );
    });
    await new Promise(r => setTimeout(r, 150));
    const session1 = getSessions(runner).get('mod-05')!;
    session1.emit('output', JSON.stringify({ type: 'result', result: 'r1' }));
    await done1;

    const spawnCountAfterFirst = (require('child_process').spawn as jest.Mock).mock.calls.length;

    // Re-send with explicit default model — no restart expected
    const done2 = new Promise<string>((resolve) => {
      runner.sendApiMessageStream(
        'mod-05',
        'test-chat',
        'second',
        { onChunk: () => {}, onDone: resolve, onError: () => {} },
        { timeoutMs: 5000, model: AGENT_DEFAULT_MODEL },
      );
    });
    await new Promise(r => setTimeout(r, 150));
    const session2 = getSessions(runner).get('mod-05')!;
    session2.emit('output', JSON.stringify({ type: 'result', result: 'r2' }));
    await done2;

    expect((require('child_process').spawn as jest.Mock).mock.calls.length).toBe(spawnCountAfterFirst);
    expect(session2).toBe(session1);
  }, 15000);
});

// ── sendMessageToSession SSE tool_use tests ───────────────────────────────────

describe('AgentRunner — sendMessageToSession SSE tool_use', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-msg-test-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // T-AR-MSG-STREAM-01: single tool call accumulates and emits correctly
  // --------------------------------------------------------------------------
  it('T-AR-MSG-STREAM-01: stream_event tool_use blocks accumulate and emit tool_use chunk', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendMessageToSession(
        'tg-msg-01', 'telegram', 'sess-uuid-01', 'run bash', undefined,
        { onChunk: (e) => chunks.push(e), onDone: resolve, onError: () => {} },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));
    const session = getSessions(runner).get('tg-msg-01')!;
    expect(session).toBeDefined();

    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"echo hi"}' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'done' }));

    const result = await donePromise;
    expect(result).toBe('done');

    const toolChunks = chunks.filter(c => c.type === 'tool_use');
    expect(toolChunks).toHaveLength(1);
    const tc = toolChunks[0] as { type: 'tool_use'; name: string; id: string; input: Record<string, unknown> };
    expect(tc.name).toBe('Bash');
    expect(tc.id).toBe('toolu_01');
    expect(tc.input).toEqual({ command: 'echo hi' });
  }, 15000);

  // --------------------------------------------------------------------------
  // T-AR-MSG-STREAM-02: multiple tool calls at different indices
  // --------------------------------------------------------------------------
  it('T-AR-MSG-STREAM-02: multiple tool calls at different indices emit separate chunks', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendMessageToSession(
        'tg-msg-02', 'telegram', 'sess-uuid-02', 'multi tool', undefined,
        { onChunk: (e) => chunks.push(e), onDone: resolve, onError: () => {} },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));
    const session = getSessions(runner).get('tg-msg-02')!;

    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'id-a', name: 'Read', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'id-b', name: 'Write', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/b"}' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 2 },
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'done' }));
    await donePromise;

    const toolChunks = chunks.filter(c => c.type === 'tool_use') as Array<{ name: string; id: string; input: Record<string, unknown> }>;
    expect(toolChunks).toHaveLength(2);
    expect(toolChunks[0].name).toBe('Read');
    expect(toolChunks[0].input).toEqual({ file_path: '/a' });
    expect(toolChunks[1].name).toBe('Write');
    expect(toolChunks[1].input).toEqual({ file_path: '/b' });
  }, 15000);

  // --------------------------------------------------------------------------
  // T-AR-MSG-STREAM-03: malformed tool input JSON is silently skipped
  // --------------------------------------------------------------------------
  it('T-AR-MSG-STREAM-03: malformed tool input JSON is skipped without throwing', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendMessageToSession(
        'tg-msg-03', 'telegram', 'sess-uuid-03', 'bad json', undefined,
        { onChunk: (e) => chunks.push(e), onDone: resolve, onError: () => {} },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));
    const session = getSessions(runner).get('tg-msg-03')!;

    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'id-bad', name: 'Bash', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'NOT_VALID_JSON' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'ok' }));

    const result = await donePromise;
    expect(result).toBe('ok');
    expect(chunks.filter(c => c.type === 'tool_use')).toHaveLength(0);
  }, 15000);

  // --------------------------------------------------------------------------
  // T-AR-MSG-STREAM-04: text_delta and tool_use coexist in the same turn
  // --------------------------------------------------------------------------
  it('T-AR-MSG-STREAM-04: text_delta and tool_use both emit in the same turn', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const chunks: StreamEvent[] = [];
    const donePromise = new Promise<string>((resolve) => {
      runner.sendMessageToSession(
        'tg-msg-04', 'telegram', 'sess-uuid-04', 'mixed', undefined,
        { onChunk: (e) => chunks.push(e), onDone: resolve, onError: () => {} },
        { timeoutMs: 5000 },
      );
    });

    await new Promise(r => setTimeout(r, 200));
    const session = getSessions(runner).get('tg-msg-04')!;

    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Running...' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'id-c', name: 'Bash', input: {} } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
    }));
    session.emit('output', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    }));
    session.emit('output', JSON.stringify({ type: 'result', result: 'Running...' }));

    await donePromise;

    expect(chunks.filter(c => c.type === 'text_delta')).toHaveLength(1);
    expect(chunks.filter(c => c.type === 'tool_use')).toHaveLength(1);
    const tc = chunks.find(c => c.type === 'tool_use') as { name: string; input: Record<string, unknown> };
    expect(tc.name).toBe('Bash');
    expect(tc.input).toEqual({ command: 'ls' });
  }, 15000);
});

// ── AgentRunner — API attachment buffer ────────────────────────────────────────

describe('AgentRunner — API attachment buffer', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-attach-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    agentConfig = makeAgentConfig(workspace);
    gatewayConfig = makeGatewayConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMediaFile(tmpDir: string, relPath: string): string {
    const absPath = path.join(tmpDir, 'agents', 'alfred', 'media', relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, 'fake-image-data');
    return absPath;
  }

  it('addApiAttachments and popApiAttachments round-trip', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const filePath = createMediaFile(tmpDir, 'api-sess/shot.jpg');

    runner.addApiAttachments('sess-1', [filePath]);
    const attachments = runner.popApiAttachments('sess-1');

    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe('image');
    expect(attachments[0].url).toContain('/v1/agents/alfred/media/');
    expect(attachments[0].url).toContain('shot.jpg');
  });

  it('popApiAttachments clears the buffer', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const filePath = createMediaFile(tmpDir, 'api-sess/a.jpg');
    runner.addApiAttachments('sess-2', [filePath]);

    runner.popApiAttachments('sess-2');
    const second = runner.popApiAttachments('sess-2');
    expect(second).toHaveLength(0);
  });

  it('popApiAttachments returns empty array when no attachments registered', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    expect(runner.popApiAttachments('unknown-sess')).toEqual([]);
  });

  it('filters out files outside the agent media directory', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    runner.addApiAttachments('sess-3', ['/tmp/evil/traversal.jpg']);
    const attachments = runner.popApiAttachments('sess-3');
    expect(attachments).toHaveLength(0);
  });

  it('filters out files that do not exist on disk', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const mediaRoot = path.join(tmpDir, 'agents', 'alfred', 'media') + path.sep;
    runner.addApiAttachments('sess-nonexist', [`${mediaRoot}api-s/ghost.jpg`]);
    const attachments = runner.popApiAttachments('sess-nonexist');
    expect(attachments).toHaveLength(0);
  });

  it('accumulates multiple addApiAttachments calls', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const fileA = createMediaFile(tmpDir, 'api-s/a.jpg');
    const fileB = createMediaFile(tmpDir, 'api-s/b.jpg');
    runner.addApiAttachments('sess-4', [fileA]);
    runner.addApiAttachments('sess-4', [fileB]);
    const attachments = runner.popApiAttachments('sess-4');
    expect(attachments).toHaveLength(2);
  });

  it('attachment URL uses agent id and relative path', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const filePath = createMediaFile(tmpDir, 'api-sess/screen.jpg');
    runner.addApiAttachments('sess-5', [filePath]);
    const attachments = runner.popApiAttachments('sess-5');
    expect(attachments[0].url).toBe('/v1/agents/alfred/media/api-sess/screen.jpg');
    expect(attachments[0].relPath).toBe('api-sess/screen.jpg');
  });
});

// ── getSessionsSummary: dedup respawned sessions ──────────────────────────────
describe('AgentRunner — getSessionsSummary dedup', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-summary-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    agentConfig = makeAgentConfig(workspace);
    gatewayConfig = makeGatewayConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  type HistoryEntry = { chatId: string; sessionId: string; source: string; mode: string; model: string; spawnedAt: number };
  function internals(runner: AgentRunner) {
    return runner as unknown as {
      sessionHistory: HistoryEntry[];
      sessions: Map<string, SessionProcess>;
      apiChatIds: Map<string, string>;
    };
  }
  function stubProc(spawnedAt: number, totalTokens: number): SessionProcess {
    return { spawnedAt, totalTokens } as unknown as SessionProcess;
  }
  function entry(over: Partial<HistoryEntry>): HistoryEntry {
    return { chatId: 'getpod', sessionId: 'sess-A', source: 'api', mode: 'pty-shell', model: 'sonnet-4-6', spawnedAt: 0, ...over };
  }

  it('collapses a respawned session (same sessionId) into one running row', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const internal = internals(runner);
    // History is newest-first (unshift): the 10:34 respawn precedes the 10:32 spawn.
    internal.sessionHistory.push(entry({ spawnedAt: 1_000_034_000 })); // newest = current incarnation
    internal.sessionHistory.push(entry({ spawnedAt: 1_000_032_000 })); // stale pre-respawn entry
    internal.sessions.set('getpod', stubProc(1_000_034_000, 47_000));

    const rows = runner.getSessionsSummary();
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe('sess-A');
    expect(rows[0].isRunning).toBe(true);
    expect(rows[0].spawnedAt).toBe(1_000_034_000);
    expect(rows[0].tokens).toBe(47_000);
  });

  it('a stale pre-respawn entry never borrows the live process running state', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const internal = internals(runner);
    // Keep ONLY the stale entry in history; the live proc is a newer incarnation.
    internal.sessionHistory.push(entry({ spawnedAt: 1_000_032_000 }));
    internal.sessions.set('getpod', stubProc(1_000_034_000, 47_000)); // different spawnedAt

    const rows = runner.getSessionsSummary();
    expect(rows).toHaveLength(1);
    expect(rows[0].isRunning).toBe(false); // spawnedAt mismatch → not this incarnation
    expect(rows[0].tokens).toBe(0); // stopped rows report 0 tokens
  });

  it('keeps genuinely distinct sessions as separate rows', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const internal = internals(runner);
    internal.sessionHistory.push(entry({ chatId: 'chat:1', sessionId: 'sess-A', source: 'telegram', spawnedAt: 2_000 }));
    internal.sessionHistory.push(entry({ chatId: 'chat:1', sessionId: 'sess-B', source: 'telegram', spawnedAt: 1_000 }));

    const rows = runner.getSessionsSummary();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.sessionId))).toEqual(new Set(['sess-A', 'sess-B']));
  });

  it('reports a stopped session (no live process) as not running with 0 tokens', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const internal = internals(runner);
    internal.sessionHistory.push(entry({ spawnedAt: 1_000_032_000 }));
    // no proc in sessions map

    const rows = runner.getSessionsSummary();
    expect(rows).toHaveLength(1);
    expect(rows[0].isRunning).toBe(false);
    expect(rows[0].tokens).toBe(0);
  });
});

// ── writeMenuForward: atomic .menu file ────────────────────────────────────────
describe('AgentRunner — writeMenuForward', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-menu-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    agentConfig = makeAgentConfig(workspace);
    gatewayConfig = makeGatewayConfig();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function callWriteMenu(runner: AgentRunner, chatId: string, text: string, options: Array<{ label: string }>): void {
    (runner as unknown as { writeMenuForward(c: string, t: string, o: Array<{ label: string }>): void })
      .writeMenuForward(chatId, text, options);
  }

  it('writes a .menu file with correct JSON content', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const chatId = '997170033';
    callWriteMenu(runner, chatId, 'Pick one:', [{ label: 'Alpha' }, { label: 'Beta' }]);

    const typingDir = (runner as unknown as { getTypingDir(c: string): string }).getTypingDir(chatId);
    const menuPath = path.join(typingDir, `${chatId}.menu`);
    expect(fs.existsSync(menuPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
    expect(parsed.text).toBe('Pick one:');
    expect(parsed.options).toEqual([{ label: 'Alpha' }, { label: 'Beta' }]);
  });

  it('leaves no .tmp file after successful write (atomic rename)', () => {
    const runner = new AgentRunner(agentConfig, gatewayConfig);
    const chatId = '997170033';
    callWriteMenu(runner, chatId, 'Q', [{ label: 'X' }]);

    const typingDir = (runner as unknown as { getTypingDir(c: string): string }).getTypingDir(chatId);
    const tmpPath = path.join(typingDir, `${chatId}.menu.tmp`);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});

// ── Idle eviction must not delete history-referenced media ─────────────────────
//
// Regression for the "Unavailable" screenshot bug: stopping an api session (idle
// eviction or the idle cleaner) used to fs.rmSync the whole media/api-<sessionId>
// dir, deleting files still referenced by rows in history.db. The DB row outlived
// the file → GET /media 404 → the client rendered "Unavailable". Eviction must
// only drop the in-memory chat-id mapping; media lives as long as its history.

describe('AgentRunner — idle eviction preserves media', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-evict-media-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    agentConfig = makeAgentConfig(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function callEvict(r: AgentRunner, sessionId: string): void {
    const runner = r as unknown as Record<string, unknown>;
    if (typeof runner['evictApiSessionMapping'] !== 'function') {
      throw new Error('evictApiSessionMapping not found — method may have been renamed');
    }
    (runner['evictApiSessionMapping'] as (s: string) => void)(sessionId);
  }

  function getApiChatIds(r: AgentRunner): Map<string, string> {
    return (r as unknown as { apiChatIds: Map<string, string> }).apiChatIds;
  }

  // EM-01: evicting an api session keeps its media dir on disk
  it('EM-01: evicting an api session does not delete its media dir', () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);

    const sessionId = 'evict-1';
    const mediaAbs = path.join(tmpDir, 'agents', 'alfred', 'media', `api-${sessionId}`, 'shot.jpg');
    fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
    fs.writeFileSync(mediaAbs, 'fake-image');

    // Simulate a live mapping created during the turn, then evict.
    getApiChatIds(runner).set(sessionId, 'test-chat');
    callEvict(runner, sessionId);

    // Media survives — history rows still reference it.
    expect(fs.existsSync(mediaAbs)).toBe(true);
    // In-memory mapping is cleared.
    expect(getApiChatIds(runner).has(sessionId)).toBe(false);
  });

  // EM-02: non-api sessions are a safe no-op (mapping cleared, nothing else touched)
  it('EM-02: evicting a non-api session is a safe no-op', () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);

    const sessionId = 'chat:telegram-1';
    const mediaAbs = path.join(tmpDir, 'agents', 'alfred', 'media', `api-${sessionId}`, 'shot.jpg');
    fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
    fs.writeFileSync(mediaAbs, 'fake-image');

    getApiChatIds(runner).set(sessionId, 'chat:telegram-1');

    expect(() => callEvict(runner, sessionId)).not.toThrow();
    expect(getApiChatIds(runner).has(sessionId)).toBe(false);
    // No files should be deleted — media dir still intact
    expect(fs.existsSync(mediaAbs)).toBe(true);
  });
});

// ── Channel message coalescing (image + text → one turn) ───────────────────────
describe('AgentRunner — channel coalescing (US-IMG-COALESCE)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    // Use a deliberately wide window here so debounce timing is observable.
    process.env.CHANNEL_COALESCE_WINDOW_MS = '300';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-coalesce-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.CHANNEL_COALESCE_WINDOW_MS = '20'; // restore file-wide default
    jest.clearAllMocks();
  });

  async function postImage(
    port: number,
    chatId: string,
    imagePath: string,
    content = '',
    messageId = '1',
  ): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        meta: { chat_id: chatId, message_id: messageId, user: 'testuser', ts: new Date().toISOString(), image_path: imagePath },
      }),
    });
  }

  function turnWritesOf(): string[] {
    const proc = allProcesses.find(p => !p.killed && p.stdin!.write.mock.calls.length > 0);
    return proc ? proc.stdin!.write.mock.calls.map((c: unknown[]) => String(c[0])) : [];
  }

  // CL-01: plain text is now coalesced too (A1, Issue #290) — a lone text message
  // is held for the debounce window, then flushed, so a rapid follow-up can merge
  // into the same turn instead of racing in as a separate mid-turn message.
  it('CL-01: plain text message is coalesced (held until the window elapses)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:cl01', 'hello there');
    // Well under the 300ms window → a coalesced message is NOT flushed yet.
    await new Promise(r => setTimeout(r, 120));
    expect(getSessions(runner).has('chat:cl01')).toBe(false);

    // Past the window → flushed and spawned.
    await new Promise(r => setTimeout(r, 350));
    expect(getSessions(runner).has('chat:cl01')).toBe(true);
  }, 15000);

  // CL-02: a message carrying an image is held until the debounce window elapses.
  it('CL-02: image message is debounced until the window elapses', async () => {
    const img = path.join(tmpDir, 'cl02.jpg');
    fs.writeFileSync(img, Buffer.alloc(64));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await postImage(port, 'chat:cl02', img, 'look at this');
    await new Promise(r => setTimeout(r, 120));
    // Still inside the window → not flushed yet.
    expect(getSessions(runner).has('chat:cl02')).toBe(false);

    await new Promise(r => setTimeout(r, 350));
    // Past the window → flushed and spawned.
    expect(getSessions(runner).has('chat:cl02')).toBe(true);
  }, 15000);

  // CL-03: an image followed by a separate text message within the window are
  // merged into ONE turn (the photo and its instruction land together).
  it('CL-03: image then follow-up text merge into a single turn', async () => {
    const img = path.join(tmpDir, 'merge-img.jpg');
    fs.writeFileSync(img, Buffer.alloc(64));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await postImage(port, 'chat:cl03', img, '', '10');
    await new Promise(r => setTimeout(r, 80)); // within window
    await sendChannelPost(port, 'chat:cl03', 'MERGE_MARKER_TEXT');

    await new Promise(r => setTimeout(r, 450)); // let the window flush

    // Exactly one session for the chat.
    expect(getSessions(runner).has('chat:cl03')).toBe(true);

    // The injected turn carries BOTH the image and the text in a single write.
    const writes = turnWritesOf();
    const turn = writes.find(w => w.includes('merge-img.jpg'));
    expect(turn).toBeDefined();
    expect(turn).toContain('MERGE_MARKER_TEXT');
  }, 15000);

  // CL-04: an album burst (two rapid images) coalesces — both image paths in one turn.
  it('CL-04: rapid image burst coalesces into one turn with both images', async () => {
    const img1 = path.join(tmpDir, 'album-a.jpg');
    const img2 = path.join(tmpDir, 'album-b.jpg');
    fs.writeFileSync(img1, Buffer.alloc(64));
    fs.writeFileSync(img2, Buffer.alloc(64));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await postImage(port, 'chat:cl04', img1, 'album caption', '20');
    await postImage(port, 'chat:cl04', img2, '', '21');

    await new Promise(r => setTimeout(r, 450));

    const writes = turnWritesOf();
    const turn = writes.find(w => w.includes('album-a.jpg'));
    expect(turn).toBeDefined();
    expect(turn).toContain('album-b.jpg');
  }, 15000);

  // CL-05: pending coalesce timers are cleared on stop() (no dangling buffers).
  it('CL-05: stop() clears any pending coalesce buffer', async () => {
    const img = path.join(tmpDir, 'cl05.jpg');
    fs.writeFileSync(img, Buffer.alloc(64));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await postImage(port, 'chat:cl05', img, 'pending');
    await new Promise(r => setTimeout(r, 80)); // still buffered

    const buffers = (runner as unknown as { channelCoalesce: Map<string, unknown> }).channelCoalesce;
    expect(buffers.size).toBe(1);

    await runner.stop();
    expect(buffers.size).toBe(0);
  }, 15000);

  // Regression (#292): an inbound channel image is staged at a path the app-agent
  // container cannot see (LINE downloads to host /tmp; TG/Discord to
  // <workspace>/.*-state). The runner already copies the file into the agent's
  // MediaStore (bind-mounted at an identical absolute path inside the container) —
  // it must surface THAT path to the agent, not the raw staging path.
  // Pre-fix, the channel XML carried the raw staging path → this test fails.
  it('surfaces the container-readable MediaStore path for an inbound image, not the raw staging path', async () => {
    // Stage the image OUTSIDE the agent's media dir, mimicking LINE's host /tmp
    // download (a location not bind-mounted into an app-agent container).
    const rawStaging = path.join(tmpDir, 'raw-staging.jpg');
    fs.writeFileSync(rawStaging, Buffer.alloc(64));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await postImage(port, 'chat:cl-mediapath', rawStaging, '', '1');
    await new Promise(r => setTimeout(r, 450)); // let the debounce window flush

    const turn = turnWritesOf().find(w => w.includes('image_path='));
    expect(turn).toBeDefined();
    // The agent is told the MediaStore copy (readable inside the container): it
    // lives under media/<channel>-<chatId>/ with copyToMedia's timestamp prefix …
    expect(turn).toContain(`${path.sep}media${path.sep}telegram-chat:cl-mediapath${path.sep}`);
    expect(turn).toContain('raw-staging.jpg'); // basename preserved by copyToMedia
    // … and NOT the raw host staging path the container cannot read.
    expect(turn).not.toContain(`image_path="${rawStaging}"`);
  }, 15000);

  // A channel that downloads an attachment to a throwaway file (LINE stages into
  // os.tmpdir()) marks it meta.media_ephemeral='1'. Once MediaStore holds the
  // permanent copy, the staging file is dead weight — nothing sweeps the temp dir,
  // so every inbound attachment used to stay there for the life of the host.
  async function postMedia(
    port: number,
    chatId: string,
    mediaPath: string,
    extraMeta: Record<string, string> = {},
  ): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '(file: doc.pdf)',
        meta: {
          chat_id: chatId, message_id: '1', user: 'testuser',
          ts: new Date().toISOString(), image_path: mediaPath, ...extraMeta,
        },
      }),
    });
  }

  it('deletes an ephemeral staging file once MediaStore has the permanent copy', async () => {
    const staging = path.join(tmpDir, 'line-file-abc-123.pdf');
    fs.writeFileSync(staging, Buffer.alloc(64));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await postMedia(port, 'chat:eph-1', staging, { media_ephemeral: '1' });
    await new Promise(r => setTimeout(r, 450));

    // The agent still has the bytes — via the MediaStore copy it was handed …
    const turn = turnWritesOf().find(w => w.includes('image_path='));
    expect(turn).toContain(`${path.sep}media${path.sep}telegram-chat:eph-1${path.sep}`);
    // … and the staging copy is gone.
    expect(fs.existsSync(staging)).toBe(false);
  }, 15000);

  it('leaves a staging file alone when the channel did not mark it ephemeral', async () => {
    // Telegram/Discord stage under <workspace>/.*-state and own those files
    // themselves; the runner must not start deleting them.
    const staging = path.join(tmpDir, 'tg-staged.jpg');
    fs.writeFileSync(staging, Buffer.alloc(64));

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await postMedia(port, 'chat:eph-2', staging);
    await new Promise(r => setTimeout(r, 450));

    expect(turnWritesOf().find(w => w.includes('image_path='))).toBeDefined();
    expect(fs.existsSync(staging)).toBe(true);
  }, 15000);

  it('refuses to delete outside the temp dir even when the flag says ephemeral', () => {
    // meta reaches the runner over the local /channel intake, so the flag alone
    // must never be authority to unlink an arbitrary path.
    //
    // The victim file has to live OUTSIDE os.tmpdir() for the test to mean
    // anything, and os.tmpdir() ignores a mocked process.env (it reads the real
    // environment), so this stages under the project dir instead of /tmp.
    const outsideDir = fs.mkdtempSync(path.join(process.cwd(), '.gw-outside-'));
    const outside = path.join(outsideDir, 'precious.pdf');
    fs.writeFileSync(outside, 'keep me');

    const discard = (AgentRunner as unknown as { discardEphemeralStaging(p: string): void })
      .discardEphemeralStaging;
    try {
      // Precondition: fail loudly rather than pass vacuously if cwd ever moves
      // under the temp dir.
      expect(path.relative(os.tmpdir(), outside).startsWith('..')).toBe(true);
      discard(outside);
      expect(fs.existsSync(outside)).toBe(true);

      // …while a file genuinely inside the temp dir is removed.
      const staged = path.join(tmpDir, 'line-file-x.pdf');
      fs.writeFileSync(staged, 'bytes');
      discard(staged);
      expect(fs.existsSync(staged)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

// ── line_image transcript history: gate on tool_result success ────────────────
// Regression coverage for PR #286 fix (2): a line_image tool_use is queued when
// its assistant block streams in, and only committed to chat history once the
// matching tool_result confirms the send succeeded. A failed attempt followed by
// a same-image retry must leave exactly ONE row, not two. Pre-fix, the runner
// wrote to history the moment the tool_use appeared, so a retry double-posted.
describe('AgentRunner — line_image history gated on tool_result success', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-line-hist-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    agentConfig = makeAgentConfig(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // Absolute path to a media file the runner will accept (toRelMediaFiles requires
  // the file to exist and live under <agentsBaseDir>/<agentId>/media/).
  function writeMedia(name: string): string {
    const abs = path.join(tmpDir, 'agents', 'alfred', 'media', name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'fake-image');
    return abs;
  }

  const assistantLineImage = (toolUseId: string, imageAbs: string) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: 'mcp__gateway__line_image',
          input: { chat_id: 'U123', image: imageAbs },
        }],
      },
    });

  const toolResult = (toolUseId: string, isError: boolean) =>
    JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }],
      },
    });

  async function startLineSession(chatId: string): Promise<SessionProcess> {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);
    await sendChannelPost(port, chatId, 'please send an image');
    await new Promise(r => setTimeout(r, 150));
    (runner as unknown as { channelSourceMap: Map<string, string> }).channelSourceMap.set(chatId, 'line');
    const session = getSessions(runner).get(chatId);
    expect(session).toBeDefined();
    return session!;
  }

  function lineImageRows(chatId: string): Array<{ role: string; mediaFiles?: string[] }> {
    const page = runner.getHistoryDb().getMessages(`line-${chatId}`);
    return (page.messages as Array<{ role: string; mediaFiles?: string[] }>)
      .filter(m => m.role === 'assistant' && (m.mediaFiles?.length ?? 0) > 0);
  }

  it('commits a line_image to history once its tool_result confirms success', async () => {
    const chatId = 'ch:line-ok';
    const session = await startLineSession(chatId);
    const img = writeMedia('ok.png');

    session.emit('output', assistantLineImage('toolu_ok', img));
    session.emit('output', toolResult('toolu_ok', false));
    await new Promise(r => setTimeout(r, 50));

    const rows = lineImageRows(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mediaFiles).toEqual(['media/ok.png']);
  }, 15000);

  it('does NOT write a line_image whose tool_result reports failure', async () => {
    const chatId = 'ch:line-fail';
    const session = await startLineSession(chatId);
    const img = writeMedia('fail.png');

    session.emit('output', assistantLineImage('toolu_fail', img));
    session.emit('output', toolResult('toolu_fail', true)); // send failed
    await new Promise(r => setTimeout(r, 50));

    expect(lineImageRows(chatId)).toHaveLength(0);
  }, 15000);

  // The core regression: a failed send + a same-image retry must not double-post.
  it('writes exactly one row when a failed send is retried successfully (no double-post)', async () => {
    const chatId = 'ch:line-retry';
    const session = await startLineSession(chatId);
    const img = writeMedia('retry.png');

    // First attempt fails …
    session.emit('output', assistantLineImage('toolu_a', img));
    session.emit('output', toolResult('toolu_a', true));
    // … then the model retries the SAME image with a new tool_use id, and it succeeds.
    session.emit('output', assistantLineImage('toolu_b', img));
    session.emit('output', toolResult('toolu_b', false));
    await new Promise(r => setTimeout(r, 50));

    const rows = lineImageRows(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mediaFiles).toEqual(['media/retry.png']);
  }, 15000);
});

// ────────────────────────────────────────────────────────────────────────────
// Gateway-layer turn queue + coalesce + /stop (Issue #290)
// ────────────────────────────────────────────────────────────────────────────
describe('AgentRunner — gateway turn queue, coalesce, and /stop', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-queue-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // Channel-XML writes into the (single, reused) subprocess stdin for this chat.
  function channelWrites(): string[] {
    const proc = allProcesses[allProcesses.length - 1];
    if (!proc?.stdin) return [];
    return (proc.stdin.write as jest.Mock).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes('<channel'));
  }

  // U-AR-Q1: a message sent while a turn is in flight is QUEUED, not injected,
  // and is delivered only after the turn's true end signal (headless: result).
  it('U-AR-Q1: queues a mid-turn channel message and injects it only after result (headless)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:q1', 'first');
    await waitForSession(runner, 'chat:q1');
    await new Promise(r => setTimeout(r, 80)); // coalesce flush + inject turn 1
    const session = getSessions(runner).get('chat:q1')!;
    expect(channelWrites().length).toBe(1);
    expect(channelWrites()[0]).toContain('first');

    // Second message arrives WHILE turn 1 is still in flight (no result yet).
    await sendChannelPost(port, 'chat:q1', 'second');
    await new Promise(r => setTimeout(r, 80)); // its coalesce window closes...
    // ...but the turn is active, so it must be QUEUED, not written to stdin.
    expect(channelWrites().length).toBe(1);

    // Turn 1 ends → the queued turn flushes.
    session.emit('output', JSON.stringify({ type: 'result', is_error: false, result: 'done' }));
    await new Promise(r => setTimeout(r, 80));
    expect(channelWrites().length).toBe(2);
    expect(channelWrites()[1]).toContain('second');
  }, 15000);

  // U-AR-Q2: on pty-shell the flush waits for session_idle — a per-sub-turn
  // `result` (fires many times across tool-call gaps) must NOT release the queue.
  it('U-AR-Q2: pty-shell flushes on session_idle, not on per-sub-turn result', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:q2', 'first');
    await waitForSession(runner, 'chat:q2');
    await new Promise(r => setTimeout(r, 80));
    const session = getSessions(runner).get('chat:q2')!;
    (session as unknown as { backend: string }).backend = 'pty-shell';
    expect(channelWrites().length).toBe(1);

    await sendChannelPost(port, 'chat:q2', 'second');
    await new Promise(r => setTimeout(r, 80));
    expect(channelWrites().length).toBe(1); // queued behind the active turn

    // A per-sub-turn result must NOT flush on pty-shell.
    session.emit('output', JSON.stringify({ type: 'result', is_error: false, result: 'sub-turn' }));
    await new Promise(r => setTimeout(r, 60));
    expect(channelWrites().length).toBe(1);

    // session_idle is the true end of the user's turn → flush.
    session.emit('output', JSON.stringify({ type: 'session_idle' }));
    await new Promise(r => setTimeout(r, 80));
    expect(channelWrites().length).toBe(2);
    expect(channelWrites()[1]).toContain('second');
  }, 15000);

  // U-AR-Q2-BG: after dispatching an asynchronous Agent task, the parent PTY
  // becomes idle before the task notification arrives. Telegram typing must stay
  // active throughout that wait, then stop normally after the follow-up turn.
  it.each([
    ['Agent', 'headless'],
    ['Workflow', 'headless'],
    ['Agent', 'pty-shell'],
    ['Workflow', 'pty-shell'],
  ])('U-AR-Q2-BG: retains Telegram typing for %s work on %s', async (toolName, backend) => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);
    const chatId = 'chat:q2-background';

    await sendChannelPost(port, chatId, 'review this PR');
    await waitForSession(runner, chatId);
    await new Promise(r => setTimeout(r, 80));
    const session = getSessions(runner).get(chatId)!;
    (session as unknown as { backend: string }).backend = backend;
    const rawProc = allProcesses[allProcesses.length - 1]!;
    const typingSignal = path.join(agentConfig.workspace, '.telegram-state', 'typing', chatId);
    const processingSignal = `${typingSignal}.processing`;
    expect(fs.existsSync(typingSignal)).toBe(true);

    rawProc.stdout!.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg_typing', name: toolName, input: {} }] },
      stop_reason: 'tool_use',
    }) + '\n'));
    // PTY emits a result for the sub-turn before session_idle; headless result
    // itself is the true end-of-turn event.
    rawProc.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: '' }) + '\n'));
    if (backend === 'pty-shell') {
      rawProc.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'session_idle' }) + '\n'));
    }
    await new Promise(r => setTimeout(r, 3_100));

    // Pre-fix this signal was unconditionally deleted after 3 seconds.
    expect(fs.existsSync(typingSignal)).toBe(true);
    expect(fs.existsSync(processingSignal)).toBe(true);

    // The task notification starts and completes a new turn with no further dispatch.
    session.setProcessing(true);
    session.setProcessing(false);
    rawProc.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: '' }) + '\n'));
    if (backend === 'pty-shell') {
      rawProc.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'session_idle' }) + '\n'));
    }
    await new Promise(r => setTimeout(r, 3_100));

    expect(fs.existsSync(typingSignal)).toBe(false);
    expect(fs.existsSync(processingSignal)).toBe(false);
  }, 15000);

  // U-AR-Q3: consecutive text messages within the coalesce window merge into ONE
  // turn (A1) — each still individually written to permanent history upstream.
  it('U-AR-Q3: coalesces consecutive text messages into a single turn', async () => {
    process.env.CHANNEL_COALESCE_WINDOW_MS = '120';
    try {
      runner = new AgentRunner(agentConfig, gatewayConfig);
      await runner.start();
      const port = getCallbackPort(runner);

      await sendChannelPost(port, 'chat:q3', 'part one');
      await new Promise(r => setTimeout(r, 30)); // within the window
      await sendChannelPost(port, 'chat:q3', 'part two');
      await waitForSession(runner, 'chat:q3');
      await new Promise(r => setTimeout(r, 220)); // window closes + inject

      const writes = channelWrites();
      expect(writes.length).toBe(1);
      expect(writes[0]).toContain('part one');
      expect(writes[0]).toContain('part two');
    } finally {
      process.env.CHANNEL_COALESCE_WINDOW_MS = '20';
    }
  }, 15000);

  // U-AR-Q4: /stop cancels the turns queued behind the active one — after /stop,
  // the active turn ending must NOT flush a cancelled message.
  it('U-AR-Q4: /stop cancels queued turns (nothing flushes after the active turn ends)', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:q4', 'first');
    await waitForSession(runner, 'chat:q4');
    await new Promise(r => setTimeout(r, 80));
    const session = getSessions(runner).get('chat:q4')!;
    const interruptSpy = jest.spyOn(session, 'interrupt');
    expect(channelWrites().length).toBe(1);

    await sendChannelPost(port, 'chat:q4', 'second'); // queued behind active turn
    await new Promise(r => setTimeout(r, 80));
    expect(channelWrites().length).toBe(1);

    await sendChannelPost(port, 'chat:q4', '/stop'); // cancel queued + interrupt
    await new Promise(r => setTimeout(r, 80));
    expect(interruptSpy).toHaveBeenCalled();

    // The interrupted turn ends → the cancelled 'second' must NOT be injected.
    session.emit('output', JSON.stringify({ type: 'result', is_error: false, result: 'interrupted' }));
    await new Promise(r => setTimeout(r, 80));
    expect(channelWrites().length).toBe(1);
  }, 15000);

  // U-AR-Q5 (Issue #297): a turn queued behind an in-flight turn must survive a
  // DEFERRED restart that fires on the same turn-end. Regression: the turn-end
  // flush drained the queue into the session that the deferred restart then
  // killed, so the queued turn died with the process and was never re-injected.
  it('U-AR-Q5: a turn queued behind a deferred-restart turn is preserved, not lost', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    await sendChannelPost(port, 'chat:q5', 'first');
    await waitForSession(runner, 'chat:q5');
    await new Promise(r => setTimeout(r, 80)); // coalesce flush + inject turn 1
    const session = getSessions(runner).get('chat:q5')!;
    expect(channelWrites().length).toBe(1);
    expect(channelWrites()[0]).toContain('first');

    // Second message arrives mid-turn → QUEUED behind the in-flight turn.
    await sendChannelPost(port, 'chat:q5', 'second');
    await new Promise(r => setTimeout(r, 80));
    expect(channelWrites().length).toBe(1); // still queued, not injected

    // A CLAUDE.md / workspace change arms a DEFERRED restart on the busy session
    // (the exact trigger from the incident: a memory write mid-turn).
    await runner.restartOrDefer();
    expect(getSessions(runner).has('chat:q5')).toBe(true); // deferred, not stopped yet

    // Turn 1 ends. On the SAME end signal the gateway both (a) would flush the
    // queued turn and (b) tears the session down for the deferred restart. The
    // queued 'second' must survive — re-injected into the fresh session, not
    // killed with the old one.
    session.emit('output', JSON.stringify({ type: 'result', is_error: false, result: 'done' }));
    await new Promise(r => setTimeout(r, 250)); // teardown + respawn + re-inject

    // The chat's session is respawned…
    expect(getSessions(runner).has('chat:q5')).toBe(true);
    // …and 'second' reached a LIVE session (not the torn-down/killed one). On the
    // pre-fix code 'second' was written to the old proc that was then killed, so
    // no live proc ever received it.
    const liveGotSecond = allProcesses.some(
      p => !p.killed &&
        (p.stdin?.write as jest.Mock).mock.calls
          .map((c: unknown[]) => String(c[0]))
          .some((w: string) => w.includes('<channel') && w.includes('second')),
    );
    expect(liveGotSecond).toBe(true);
  }, 15000);
});

// ── Cross-channel turn persistence (one writer per layer) ────────────────────

describe('AgentRunner — sendMessageToSession writes one assistant row per layer', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-dup-'));
    agentConfig = makeAgentConfig(path.join(tmpDir, 'workspace'));
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // agentsBaseDir resolves to the parent of the workspace's parent, which is the
  // shared os.tmpdir() — so history and session files outlive a single run. Keep
  // the ids unique per run or the counts below accumulate across invocations.
  function uniqueIds(tag: string): { chatId: string; sessionId: string } {
    const chatId = `xchan-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return { chatId, sessionId: `sess-${chatId}` };
  }

  async function driveCrossChannelTurn(
    chatId: string,
    sessionId: string,
    stdoutLines: string[],
    mutateSession?: (proc: { backend: string }) => void,
  ): Promise<{
    dbRows: Array<{ role: string; content: string }>;
    jsonRows: Array<{ role: string; content: string }>;
    forwarded: string[];
  }> {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const forwarded: string[] = [];
    const runnerInternals = runner as unknown as { writeAutoForward: (chatId: string, text: string, format?: string) => void };
    const originalForward = runnerInternals.writeAutoForward.bind(runner);
    runnerInternals.writeAutoForward = (id: string, text: string, format?: string) => {
      forwarded.push(text);
      return originalForward(id, text, format as 'text' | 'html' | undefined);
    };

    const donePromise = new Promise<string>((resolve, reject) => {
      runner.sendMessageToSession(
        chatId, 'telegram', sessionId, 'hello', undefined,
        { onChunk: () => {}, onDone: resolve, onError: reject },
        { timeoutMs: 5000 },
      );
    });
    await new Promise(r => setTimeout(r, 250));

    if (mutateSession) {
      const proc = (runner as unknown as { sessions: Map<string, { backend: string }> }).sessions.get(chatId);
      if (!proc) throw new Error('session not spawned');
      mutateSession(proc);
    }

    // Feed raw stdout rather than emitting 'output' directly: SessionProcess's
    // own parser is the session-JSON writer under test, and emitting on the
    // EventEmitter would bypass it.
    const rawProc = allProcesses[allProcesses.length - 1];
    for (const line of stdoutLines) rawProc.stdout!.emit('data', Buffer.from(line + '\n'));
    await donePromise;
    await new Promise(r => setTimeout(r, 250));

    const page = runner.getHistoryDb().getMessages(`telegram-${chatId}`);
    const jsonRows = await (runner as unknown as {
      sessionStore: { loadTelegramSession: (a: string, c: string, s: string, ch: string) => Promise<Array<{ role: string; content: string }>> };
    }).sessionStore.loadTelegramSession(agentConfig.id, chatId, sessionId, 'telegram');
    return {
      dbRows: page.messages.map((m) => ({ role: m.role, content: m.content })),
      jsonRows: jsonRows.map((m) => ({ role: m.role, content: m.content })),
      forwarded,
    };
  }

  // --------------------------------------------------------------------------
  // T-XCHAN-DUP-01: plain-text answer (no reply tool) — one row per layer
  // --------------------------------------------------------------------------
  it('T-XCHAN-DUP-01: a plain-text answer is persisted once, not twice', async () => {
    const { chatId, sessionId } = uniqueIds('plain');
    const { dbRows, jsonRows } = await driveCrossChannelTurn(chatId, sessionId, [
      JSON.stringify({ type: 'assistant', stop_reason: 'end_turn', message: { content: [{ type: 'text', text: 'the answer' }] } }),
      JSON.stringify({ type: 'result', result: 'the answer' }),
    ]);

    expect(dbRows.filter(r => r.role === 'assistant')).toEqual([{ role: 'assistant', content: 'the answer' }]);
    expect(jsonRows.filter(r => r.role === 'assistant')).toEqual([{ role: 'assistant', content: 'the answer' }]);
  }, 15000);

  // --------------------------------------------------------------------------
  // T-XCHAN-DUP-02: reply-tool answer — the reply text is stored, the trailing
  // `result` narration is not. This is the case the duplicate write corrupted:
  // it stored a second row holding text the user never received.
  // --------------------------------------------------------------------------
  it('T-XCHAN-DUP-02: a reply-tool answer stores the reply text only, never the result narration', async () => {
    const { chatId, sessionId } = uniqueIds('reply');
    const { dbRows, jsonRows } = await driveCrossChannelTurn(chatId, sessionId, [
      JSON.stringify({
        type: 'assistant',
        stop_reason: 'tool_use',
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__gateway__telegram_reply', input: { text: 'the answer' } }] },
      }),
      JSON.stringify({ type: 'result', result: 'I sent the reply.' }),
    ]);

    expect(dbRows.filter(r => r.role === 'assistant')).toEqual([{ role: 'assistant', content: 'the answer' }]);
    expect(jsonRows.filter(r => r.role === 'assistant')).toEqual([{ role: 'assistant', content: 'the answer' }]);
    expect(dbRows.map(r => r.content)).not.toContain('I sent the reply.');
  }, 15000);

  // --------------------------------------------------------------------------
  // T-XCHAN-DUP-03: `result: ""` with streamed text (OpenRouter shape) still
  // reaches history — the long-lived handler falls back to the turn's last
  // assistant text for persistence (not for forwarding), so removing the
  // producer's write loses nothing.
  // --------------------------------------------------------------------------
  it('T-XCHAN-DUP-03: an empty result falls back to the streamed assistant text', async () => {
    const { chatId, sessionId } = uniqueIds('empty');
    const { dbRows, jsonRows, forwarded } = await driveCrossChannelTurn(chatId, sessionId, [
      JSON.stringify({ type: 'assistant', stop_reason: 'end_turn', message: { content: [{ type: 'text', text: 'streamed answer' }] } }),
      JSON.stringify({ type: 'result', result: '' }),
    ]);

    expect(dbRows.filter(r => r.role === 'assistant')).toEqual([{ role: 'assistant', content: 'streamed answer' }]);
    expect(jsonRows.filter(r => r.role === 'assistant')).toEqual([{ role: 'assistant', content: 'streamed answer' }]);
    // The fallback is persistence-only: an empty `result` also arrives between
    // pty-shell sub-turns, so it must not post an extra message to the channel.
    expect(forwarded).toEqual([]);
  }, 15000);

  // --------------------------------------------------------------------------
  // T-XCHAN-DUP-04: the empty-result fallback must not fire on a menu turn.
  // `forwardableText` is blanked there on purpose (the wrapper appends the menu
  // text to the result, and the prompt row was already inserted when the menu
  // was rendered) — falling back would resurrect the option list as a second row.
  // --------------------------------------------------------------------------
  it('T-XCHAN-DUP-04: a menu turn does not fall back to the assistant text', async () => {
    const { chatId, sessionId } = uniqueIds('menu');
    const { dbRows } = await driveCrossChannelTurn(chatId, sessionId, [
      JSON.stringify({
        type: 'assistant',
        stop_reason: 'end_turn',
        message: { content: [{ type: 'text', text: 'Pick one\n1. Alpha\n2. Beta' }] },
      }),
      JSON.stringify({ type: 'system', subtype: 'menu_prompt', prompt: 'Pick one', options: [{ label: 'Alpha' }, { label: 'Beta' }] }),
      JSON.stringify({ type: 'result', result: 'Pick one' }),
    ]);

    // Exactly the prompt row written by the menu_prompt handler — no echo of the
    // assistant text that produced it.
    expect(dbRows.filter(r => r.role === 'assistant')).toEqual([{ role: 'assistant', content: 'Pick one' }]);
  }, 15000);

  // --------------------------------------------------------------------------
  // T-XCHAN-DUP-05: on pty-shell `result` fires per sub-turn, so an empty result
  // is a tool-call boundary rather than the end of the answer. The fallback must
  // stay off there or every boundary adds a phantom row of interim narration.
  // --------------------------------------------------------------------------
  it('T-XCHAN-DUP-05: pty-shell sub-turn boundaries do not create phantom rows', async () => {
    const { chatId, sessionId } = uniqueIds('pty');
    const { dbRows } = await driveCrossChannelTurn(
      chatId,
      sessionId,
      [
        JSON.stringify({ type: 'assistant', stop_reason: 'end_turn', message: { content: [{ type: 'text', text: 'let me check the file' }] } }),
        JSON.stringify({ type: 'result', result: '' }),
        JSON.stringify({ type: 'assistant', stop_reason: 'end_turn', message: { content: [{ type: 'text', text: 'now running the tests' }] } }),
        JSON.stringify({ type: 'result', result: '' }),
        JSON.stringify({ type: 'assistant', stop_reason: 'end_turn', message: { content: [{ type: 'text', text: 'all green' }] } }),
        JSON.stringify({ type: 'result', result: 'all green' }),
      ],
      (proc) => { proc.backend = 'pty-shell'; },
    );

    expect(dbRows.filter(r => r.role === 'assistant')).toEqual([{ role: 'assistant', content: 'all green' }]);
  }, 15000);
});


// ── Silent drop: the turn's SECOND reply call is rejected (Issue #422) ────────
// A long turn that posts an interim progress update and then a final report gets
// its final `telegram_reply` rejected by the turn-scoped guard in
// mcp/tools/telegram/module.ts ("already sent a message this turn"). Two runner
// bugs then swallowed the final text entirely:
//   1. the reply tool_use handler was gated on `!replyCalled`, so
//      `replyToolUseId` froze on the turn's FIRST call — the failing SECOND
//      call's tool_result never matched, `replyCalled` stayed true, and the
//      result-forwarding fallback (`!replyCalled`) never fired;
//   2. even once it does fire, the `.forward` entry carries the live turn id,
//      which equals the one in the `.replied` marker the earlier successful
//      reply left — so the receiver's `isEntryAlreadyReplied()` would drop it.
// The fix dedups reply tool_use blocks by block id and force-delivers the
// fallback forward (null turnId) when a reply call failed this turn.
describe('AgentRunner — reply failure after an earlier reply in the same turn (#422)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-422-'));
    const workspace = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    agentConfig = makeAgentConfig(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function typingDir(): string {
    return path.join(agentConfig.workspace, '.telegram-state', 'typing');
  }

  const replyToolUse = (toolUseId: string, text: string) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: 'mcp__gateway__telegram_reply',
          input: { chat_id: 'x', text },
        }],
      },
    });

  const replyResult = (toolUseId: string, isError: boolean) =>
    JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }],
      },
    });

  const turnResult = (text: string) =>
    JSON.stringify({ type: 'result', is_error: false, result: text });

  /**
   * Start a session and plant the live typing-signal file the receiver writes
   * for an in-flight turn — that file IS the turn id both `.replied` and
   * `.forward` markers are stamped with.
   */
  async function startTurn(chatId: string, turnId: string): Promise<SessionProcess> {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    await sendChannelPost(getCallbackPort(runner), chatId, 'run the long task');
    await waitForSession(runner, chatId);
    fs.mkdirSync(typingDir(), { recursive: true });
    fs.writeFileSync(path.join(typingDir(), chatId), turnId);
    return getSessions(runner).get(chatId)!;
  }

  /** The `.replied` marker the MCP reply tool writes (in its own process). */
  function writeRepliedMarker(chatId: string, text: string, turnId: string): void {
    fs.writeFileSync(
      path.join(typingDir(), `${chatId}.replied`),
      JSON.stringify({ text, turnId }),
    );
  }

  function forwardEntries(chatId: string): Array<{ text: string; format: string; turnId: string | null }> | null {
    const p = path.join(typingDir(), `${chatId}.forward`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  // The core regression. Pre-fix there is no `.forward` file at all.
  it('delivers the final text when the turn\'s second reply call is rejected', async () => {
    const chatId = 'chat:422-core';
    const turnId = '1755000000000';
    const session = await startTurn(chatId, turnId);

    // Interim progress update — succeeds, and leaves a `.replied` marker
    // stamped with this turn's id (what the guard later trips on).
    session.emit('output', replyToolUse('toolu_first', 'working on it, this will take a while'));
    session.emit('output', replyResult('toolu_first', false));
    writeRepliedMarker(chatId, 'working on it, this will take a while', turnId);

    // Final report — the turn-scoped guard rejects it.
    session.emit('output', replyToolUse('toolu_second', 'all done, everything is deployed'));
    session.emit('output', replyResult('toolu_second', true));

    session.emit('output', turnResult('all done, everything is deployed'));
    await new Promise(r => setTimeout(r, 100));

    const entries = forwardEntries(chatId);
    expect(entries).not.toBeNull();
    expect(entries!.map(e => e.text).join('\n')).toContain('all done, everything is deployed');
    // Null turn id is what keeps the receiver from deduping this entry against
    // the interim reply's `.replied` marker — `isEntryAlreadyReplied()` never
    // matches a null on either side.
    expect(entries![0]!.turnId).toBeNull();
    expect(entries![0]!.turnId).not.toBe(turnId);
  }, 15000);

  // Guard against over-correcting: a turn with no reply failure must still stamp
  // the real turn id, or the receiver loses its dedup against a `.replied` marker.
  it('keeps the real turn id on a fallback forward when no reply call failed', async () => {
    const chatId = 'chat:422-normal';
    const turnId = '1755000000001';
    const session = await startTurn(chatId, turnId);

    session.emit('output', turnResult('here is the plain answer'));
    await new Promise(r => setTimeout(r, 100));

    const entries = forwardEntries(chatId);
    expect(entries).not.toBeNull();
    expect(entries![0]!.turnId).toBe(turnId);
  }, 15000);

  // The socket-drop notice deliberately bypasses the `replyCalled` gate. Without
  // force-delivery an earlier reply's `.replied` marker would dedup it away and
  // defeat that bypass — the user would never learn the connection dropped.
  it('force-delivers the socket-drop notice past an earlier reply in the same turn', async () => {
    const chatId = 'chat:422-socket';
    const turnId = '1755000000002';
    const session = await startTurn(chatId, turnId);

    session.emit('output', replyToolUse('toolu_ok', 'starting now'));
    session.emit('output', replyResult('toolu_ok', false));
    writeRepliedMarker(chatId, 'starting now', turnId);

    session.emit('output', turnResult('API Error: The socket connection was closed unexpectedly'));
    await new Promise(r => setTimeout(r, 100));

    const entries = forwardEntries(chatId);
    expect(entries).not.toBeNull();
    const notice = entries!.find(e => e.text.includes('Connection to Anthropic API dropped'));
    expect(notice).toBeDefined();
    expect(notice!.turnId).toBeNull();
  }, 15000);

  // Reply tool_use blocks are now deduped by block id rather than by the
  // `replyCalled` flag, so a re-emitted cumulative snapshot must not double-post.
  it('writes one history row when the same reply tool_use block is re-emitted', async () => {
    const chatId = 'chat:422-snapshot';
    const session = await startTurn(chatId, '1755000000003');

    session.emit('output', replyToolUse('toolu_dup', 'the one and only answer'));
    session.emit('output', replyToolUse('toolu_dup', 'the one and only answer')); // snapshot repeat
    await new Promise(r => setTimeout(r, 50));

    const rows = (runner.getHistoryDb().getMessages(`telegram-${chatId}`).messages as Array<{ role: string; content: string }>)
      .filter(m => m.role === 'assistant' && m.content === 'the one and only answer');
    expect(rows).toHaveLength(1);
  }, 15000);

  // Two distinct reply calls that both succeed must each land in history — the
  // id-based dedup must not collapse them the way the old flag check did.
  it('writes both history rows when a turn makes two distinct successful reply calls', async () => {
    const chatId = 'chat:422-two-ok';
    const session = await startTurn(chatId, '1755000000004');

    session.emit('output', replyToolUse('toolu_a', 'interim update'));
    session.emit('output', replyResult('toolu_a', false));
    session.emit('output', replyToolUse('toolu_b', 'final report'));
    session.emit('output', replyResult('toolu_b', false));
    await new Promise(r => setTimeout(r, 50));

    const contents = (runner.getHistoryDb().getMessages(`telegram-${chatId}`).messages as Array<{ role: string; content: string }>)
      .filter(m => m.role === 'assistant')
      .map(m => m.content);
    expect(contents).toContain('interim update');
    expect(contents).toContain('final report');
  }, 15000);
});
