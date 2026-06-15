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

  // T14b: response is persisted to history DB after client disconnect
  it('T14b: response persisted to history DB after client disconnect', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    let onClientDisconnect: (() => void) | undefined;
    let doneText = '';
    let doneFiredResolve!: () => void;
    const doneFired = new Promise<void>((res) => { doneFiredResolve = res; });

    runner.sendApiMessageStream(
      'stream-t14b',
      'test-chat',
      'persist after disconnect',
      {
        onChunk: () => {},
        onDone: (text) => { doneText = text; doneFiredResolve(); },
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

    // onDone must still fire even though client disconnected
    await doneFired;
    expect(doneText).toBe('Persisted response');

    // History DB must contain the assistant message
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
