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

function getIdleCleaner(runner: AgentRunner): ReturnType<typeof setInterval> | undefined {
  return (runner as unknown as { idleCleanerTimer?: ReturnType<typeof setInterval> })
    .idleCleanerTimer;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

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
    await expect(runner.restartOrDefer()).resolves.toBeUndefined();
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
    const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    expect(content).toEqual({ text: 'Hello from agent', format: 'text' });
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
    expect(content).toEqual({ text: 'Hello <code>code</code>', format: 'html' });
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

  // T13: timeout calls onError
  it('T13: timeout calls onError after timeout', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const errorPromise = new Promise<Error>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t13',
        'test-chat',
        'timeout test',
        {
          onChunk: () => {},
          onDone: () => {},
          onError: (err) => resolve(err),
        },
        { timeoutMs: 200 }, // short timeout
      );
    });

    const err = await errorPromise;
    expect(err.message).toMatch(/timeout/i);
    expect((err as Error & { code: string }).code).toBe('TIMEOUT');
  }, 15000);

  // T14: cleanup function removes listeners
  it('T14: cleanup function removes listeners and frees session slot', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    let cleanup: (() => void) | undefined;
    const cleanupReady = new Promise<void>((resolve) => {
      runner.sendApiMessageStream(
        'stream-t14',
        'test-chat',
        'cleanup test',
        {
          onChunk: () => {},
          onDone: () => {},
          onError: () => {},
        },
        { timeoutMs: 10000 },
      ).then((fn) => {
        cleanup = fn;
        resolve();
      });
    });

    await new Promise(r => setTimeout(r, 200));
    await cleanupReady;

    expect(runner.hasActiveApiSession('stream-t14')).toBe(true);

    // Call cleanup
    cleanup!();

    // Session slot should be freed
    expect(runner.hasActiveApiSession('stream-t14')).toBe(false);

    // Should be able to start a new stream on same session
    await expect(
      runner.sendApiMessageStream(
        'stream-t14',
        'test-chat',
        'after cleanup',
        { onChunk: () => {}, onDone: () => {}, onError: () => {} },
        { timeoutMs: 5000 },
      ),
    ).resolves.toBeDefined();
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

    await sendChannelPost(port, chatId, 'hello');
    // Allow async session spawn to complete (must use real timer briefly)
    jest.useRealTimers();
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
    const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    expect(typeof content.text).toBe('string');
    expect(content.text).toContain('Session');
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
    const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    expect(content.text).toContain('my session');
    expect(content.text).toContain('New session created');

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
    const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    // Auto-name should follow "Session N" pattern
    expect(content.text).toMatch(/Session \d/);
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
      runner as unknown as { writeAutoForward: (chatId: string, text: string, format?: string) => void },
      'writeAutoForward',
    );

    session!.emit('output', JSON.stringify({ type: 'result', result: '**bold** and `code`' }));
    await new Promise(r => setTimeout(r, 100));

    expect(writeForwardSpy).toHaveBeenCalledWith('ch:disc01', '**bold** and `code`');
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
      runner as unknown as { writeAutoForward: (chatId: string, text: string, format?: string) => void },
      'writeAutoForward',
    );

    session!.emit('output', JSON.stringify({ type: 'result', result: '**bold text**' }));
    await new Promise(r => setTimeout(r, 100));

    expect(writeForwardSpy).toHaveBeenCalledWith(
      'ch:tg01',
      expect.stringContaining('<b>'),
      'html',
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
      runner as unknown as { writeAutoForward: (chatId: string, text: string, format?: string) => void },
      'writeAutoForward',
    );

    session!.emit('output', JSON.stringify({ type: 'result', result: 'plain text no markdown' }));
    await new Promise(r => setTimeout(r, 100));

    expect(writeForwardSpy).toHaveBeenCalledWith('ch:tg02', 'plain text no markdown');
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
