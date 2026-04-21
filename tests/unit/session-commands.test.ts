/**
 * Tests for /session info display logic (U22, U23).
 *
 * These tests drive the AgentRunner's handleCommandSessionInfo via the HTTP
 * callback server (same pattern as agent-runner.test.ts) and inspect the
 * .forward file written by writeAutoForward.
 */

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

import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig, GatewayConfig } from '../../src/types';
import { SessionStore } from '../../src/session/store';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentConfig(workspace: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'test-agent',
    description: 'test agent',
    workspace,
    env: '',
    telegram: {
      botToken: 'test-token',
    },
    claude: {
      model: 'claude-sonnet-4-6',
      dangerouslySkipPermissions: false,
      extraFlags: [],
    },
    ...overrides,
  };
}

function makeGatewayConfig(contextWindow = 200000): GatewayConfig {
  return {
    gateway: {
      logDir: '/tmp/test-sc-logs',
      timezone: 'UTC',
      models: [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', alias: 'sonnet', contextWindow },
      ],
    },
    agents: [],
  };
}

function getCallbackPort(runner: AgentRunner): number {
  return (runner as unknown as { callbackPort: number }).callbackPort;
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentRunner — /session info display (U22, U23)', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;
  let sessionStore: SessionStore;

  const chatId = 'chat:session-info';

  function getForwardFile(): string {
    return path.join(agentConfig.workspace, '.telegram-state', 'typing', `${chatId}.forward`);
  }

  function getForwardText(): string {
    const forwardFile = getForwardFile();
    expect(fs.existsSync(forwardFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    return content.text as string;
  }

  async function setupSession(lastInputTokens: number): Promise<void> {
    // Manually write the session index and set lastInputTokens (used for context % display)
    const agentsBaseDir = path.resolve(agentConfig.workspace, '..', '..');
    const store = new SessionStore(agentsBaseDir);

    const index = await store.getOrCreateIndex(agentConfig.id, chatId);
    const sessionId = index.activeSessionId;

    await store.updateSessionMeta(agentConfig.id, chatId, sessionId, {
      lastInputTokens,
      name: 'Test Session',
      messageCount: 10,
    });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-session-info-'));
    // AgentRunner resolves agentsBaseDir as workspace/../..
    // So workspace must be at <tmpDir>/test-agent/workspace
    const workspace = path.join(tmpDir, 'agents', 'test-agent', 'workspace');
    agentConfig = makeAgentConfig(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig(200000);
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // U22: session with totalTokensUsed < 50% of contextWindow → "plenty of room"
  // -------------------------------------------------------------------------
  it('U22: session with tokens < 50% of contextWindow shows "plenty of room"', async () => {
    // contextWindow = 200000; 40% = 80000 tokens
    await setupSession(80000);

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, '/session');
    await new Promise(r => setTimeout(r, 300));

    const text = getForwardText();
    expect(text).toContain('Context: 40%');
    expect(text).not.toContain('Near limit');
  }, 15000);

  it('U22b: session with 0 tokens also shows low context %', async () => {
    await setupSession(0);

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, '/session');
    await new Promise(r => setTimeout(r, 300));

    const text = getForwardText();
    expect(text).toContain('Context: 0%');
  }, 15000);

  // -------------------------------------------------------------------------
  // U23: session with totalTokensUsed > 80% of contextWindow → warning
  // -------------------------------------------------------------------------
  it('U23: session with tokens > 80% of contextWindow shows near-limit warning', async () => {
    // contextWindow = 200000; 85% = 170000 tokens
    await setupSession(170000);

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, '/session');
    await new Promise(r => setTimeout(r, 300));

    const text = getForwardText();
    expect(text).toContain('Near limit');
    expect(text).toContain('/compact');
  }, 15000);

  it('U23b: session at exactly 80% boundary shows near-limit warning', async () => {
    // contextWindow = 200000; 80% = 160000 tokens
    await setupSession(160000);

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, '/session');
    await new Promise(r => setTimeout(r, 300));

    const text = getForwardText();
    expect(text).toContain('Near limit');
  }, 15000);

  it('U23c: session between 50% and 80% shows just percentage', async () => {
    // contextWindow = 200000; 65% = 130000 tokens
    await setupSession(130000);

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, '/session');
    await new Promise(r => setTimeout(r, 300));

    const text = getForwardText();
    expect(text).toContain('Context: 65%');
    expect(text).not.toContain('Near limit');
  }, 15000);

  // -------------------------------------------------------------------------
  // Additional: /session info output includes session name and token count
  // -------------------------------------------------------------------------
  it('/session info output includes session name and token usage percentage', async () => {
    await setupSession(50000);

    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, '/session');
    await new Promise(r => setTimeout(r, 300));

    const text = getForwardText();
    expect(text).toContain('Test Session');
    expect(text).toContain('Context: 25%');     // 50000/200000 = 25%
  }, 15000);
});

// ────────────────────────────────────────────────────────────────────────────
// /stop command — interrupts the in-flight turn via SIGINT
// ────────────────────────────────────────────────────────────────────────────

describe('AgentRunner — /stop command', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  const chatId = 'chat:stop-test';

  function getForwardFile(): string {
    return path.join(agentConfig.workspace, '.telegram-state', 'typing', `${chatId}.forward`);
  }

  function getForwardText(): string {
    const forwardFile = getForwardFile();
    expect(fs.existsSync(forwardFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    return content.text as string;
  }

  type SessionLike = {
    interrupt: () => boolean;
    setProcessing: (v: boolean) => void;
    process: MockChildProcess | null;
  };

  function getActiveSession(): SessionLike | undefined {
    const sessions = (runner as unknown as { sessions: Map<string, SessionLike> }).sessions;
    return sessions.get(chatId);
  }

  function getSessionSubprocess(): MockChildProcess {
    const session = getActiveSession();
    expect(session).toBeDefined();
    expect(session!.process).not.toBeNull();
    return session!.process!;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-stop-'));
    const workspace = path.join(tmpDir, 'agents', 'test-agent', 'workspace');
    agentConfig = makeAgentConfig(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig(200000);
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (runner) await runner.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // T1 acceptance: /stop with no spawned session → "No turn in progress."
  it('replies "No turn in progress." when there is no active session', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, '/stop');
    await new Promise(r => setTimeout(r, 300));

    expect(getForwardText()).toBe('No turn in progress.');
  }, 15000);

  // T1 acceptance: /stop while session exists but no turn in flight
  it('replies "No turn in progress." when session exists but is idle', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    // Spawn a session with a regular message — handler sets processing=true,
    // but we manually clear it to simulate an idle session.
    await postChannelMessage(port, chatId, 'hello');
    await new Promise(r => setTimeout(r, 300));
    const subprocess = getSessionSubprocess();
    getActiveSession()!.setProcessing(false);

    try { fs.rmSync(getForwardFile(), { force: true }); } catch {}

    await postChannelMessage(port, chatId, '/stop');
    await new Promise(r => setTimeout(r, 300));

    expect(getForwardText()).toBe('No turn in progress.');
    expect(subprocess.kill).not.toHaveBeenCalledWith('SIGINT');
  }, 15000);

  // T1 acceptance: /stop while turn in flight → SIGINT sent + "Stopped."
  it('sends SIGINT and replies "Stopped." when a turn is in flight', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, 'long task');
    await new Promise(r => setTimeout(r, 300));
    const subprocess = getSessionSubprocess();
    // Simulate an in-flight turn
    getActiveSession()!.setProcessing(true);

    try { fs.rmSync(getForwardFile(), { force: true }); } catch {}

    await postChannelMessage(port, chatId, '/stop');
    await new Promise(r => setTimeout(r, 300));

    expect(getForwardText()).toBe('Stopped.');
    expect(subprocess.kill).toHaveBeenCalledWith('SIGINT');
  }, 15000);

  // T1 acceptance: /stop is never forwarded as user text to the subprocess
  it('does not write /stop to the subprocess stdin', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, 'hello');
    await new Promise(r => setTimeout(r, 300));
    const subprocess = getSessionSubprocess();
    getActiveSession()!.setProcessing(true);

    const writesBefore = (subprocess.stdin!.write as jest.Mock).mock.calls.length;

    await postChannelMessage(port, chatId, '/stop');
    await new Promise(r => setTimeout(r, 300));

    const writesAfter = (subprocess.stdin!.write as jest.Mock).mock.calls.length;
    expect(writesAfter).toBe(writesBefore);
  }, 15000);

  // Detector behaviour — guard against word-boundary false positives
  it('does not match "/stopwatch" — forwards as a normal prompt', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();

    const port = getCallbackPort(runner);
    await postChannelMessage(port, chatId, '/stopwatch');
    await new Promise(r => setTimeout(r, 300));

    const subprocess = getSessionSubprocess();
    const stdinWrites = (subprocess.stdin!.write as jest.Mock).mock.calls;
    const allWritten = stdinWrites.map(([s]) => s as string).join(' ');
    expect(allWritten).toContain('/stopwatch');
  }, 15000);
});
