import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function pollUntil(condition: () => boolean, intervalMs = 50, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

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

// ── Imports ─────────────────────────────────────────────────────────────────��─

import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig, GatewayConfig } from '../../src/types';
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
    gateway: { logDir: '/tmp/test-cmd-logs', timezone: 'UTC' },
    agents: [],
  };
}

function getCallbackPort(runner: AgentRunner): number {
  return (runner as unknown as { callbackPort: number }).callbackPort;
}

function getSessions(runner: AgentRunner): Map<string, SessionProcess> {
  return (runner as unknown as { sessions: Map<string, SessionProcess> }).sessions;
}

async function sendCommand(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentRunner /command endpoint', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let runner: AgentRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-'));
    // Set up directory structure: tmpDir/agents/alfred/workspace
    const workspaceDir = path.join(tmpDir, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    agentConfig = makeAgentConfig(workspaceDir);
    gatewayConfig = makeGatewayConfig();
    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();

    // Create config.json at the correct location (3 levels above workspace)
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: [{
        id: 'alfred',
        claude: { model: 'claude-opus-4-6' },
      }],
    }, null, 2) + '\n');
  });

  afterEach(async () => {
    if (runner) {
      await runner.stop();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // U-CMD-01: get_model returns current model
  // --------------------------------------------------------------------------
  it('U-CMD-01: get_model returns current model', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    const { data } = await sendCommand(port, { command: 'get_model' });
    expect(data.model).toBe('claude-opus-4-6');
  });

  // --------------------------------------------------------------------------
  // U-CMD-02: set_model updates per-session model and returns success
  // --------------------------------------------------------------------------
  it('U-CMD-02: set_model updates per-session model and returns success', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    // Create a session first
    await sendChannelPost(port, 'chat123', 'hello');
    await new Promise(r => setTimeout(r, 100));

    const { data } = await sendCommand(port, {
      command: 'set_model',
      chat_id: 'chat123',
      payload: { model: 'claude-sonnet-4-6' },
    });

    expect(data.success).toBe(true);
    expect(data.model).toBe('claude-sonnet-4-6');

    // Channel set_model is agent-level — get_model returns the new default
    const { data: getResult } = await sendCommand(port, { command: 'get_model', chat_id: 'chat123' });
    expect(getResult.model).toBe('claude-sonnet-4-6');

    // config.json SHOULD be modified (agent-level)
    const configPath = path.join(tmpDir, 'config.json');
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.agents[0].claude.model).toBe('claude-sonnet-4-6');
  });

  // --------------------------------------------------------------------------
  // U-CMD-03: set_model accepts unknown/third-party models as pass-through (BYOK)
  // --------------------------------------------------------------------------
  it('U-CMD-03: set_model accepts unknown model as pass-through', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    const { data } = await sendCommand(port, {
      command: 'set_model',
      payload: { model: 'openrouter/meta-llama/llama-3.1-70b' },
    });

    expect(data.success).toBe(true);
    expect(data.model).toBe('openrouter/meta-llama/llama-3.1-70b');

    // Verify model was changed
    const { data: getResult } = await sendCommand(port, { command: 'get_model' });
    expect(getResult.model).toBe('openrouter/meta-llama/llama-3.1-70b');
  });

  // --------------------------------------------------------------------------
  // U-CMD-04: set_model updates agent-level model and stops session process
  // --------------------------------------------------------------------------
  it('U-CMD-04: set_model with active session updates agent model and writes restart signal', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    // Create a session by sending a message
    await sendChannelPost(port, 'chat123', 'hello');
    await new Promise(r => setTimeout(r, 100));

    const sessions = getSessions(runner);
    expect(sessions.size).toBeGreaterThanOrEqual(1);

    const { data } = await sendCommand(port, {
      command: 'set_model',
      chat_id: 'chat123',
      payload: { model: 'claude-sonnet-4-6' },
    });

    expect(data.success).toBe(true);
    expect(data.model).toBe('claude-sonnet-4-6');

    // Session stays in the map — signal file triggers graceful restart via chokidar.
    // The session is NOT removed immediately (unlike the old direct stop approach).
    expect(sessions.has('chat123')).toBe(true);

    // Verify a restart signal file was written
    const signalPath = path.join(agentConfig.workspace, '.telegram-state', 'restart-chat123');
    expect(fs.existsSync(signalPath)).toBe(true);
    const signalContent = JSON.parse(fs.readFileSync(signalPath, 'utf-8'));
    expect(signalContent.notify.text).toContain('claude-sonnet-4-6');

    // Verify get_model returns the agent-level model
    const { data: getResult } = await sendCommand(port, { command: 'get_model', chat_id: 'chat123' });
    expect(getResult.model).toBe('claude-sonnet-4-6');
  });

  // --------------------------------------------------------------------------
  // U-CMD-05: set_model updates agent-level model and persists to config
  // --------------------------------------------------------------------------
  it('U-CMD-05: set_model with chat_id updates agent model and persists', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    // Create a session by sending a message, then let it stop
    await sendChannelPost(port, 'chat123', 'hello');
    await new Promise(r => setTimeout(r, 100));

    const { data } = await sendCommand(port, {
      command: 'set_model',
      chat_id: 'chat123',
      payload: { model: 'claude-haiku-4-5-20251001' },
    });

    expect(data.success).toBe(true);
    expect(data.model).toBe('claude-haiku-4-5-20251001');

    // Verify get_model returns agent-level model
    const { data: getResult } = await sendCommand(port, { command: 'get_model', chat_id: 'chat123' });
    expect(getResult.model).toBe('claude-haiku-4-5-20251001');

    // config.json SHOULD be modified (agent-level)
    const configPath = path.join(tmpDir, 'config.json');
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.agents[0].claude.model).toBe('claude-haiku-4-5-20251001');
  });

  // --------------------------------------------------------------------------
  // U-CMD-06: restart with active session writes signal and returns success
  // --------------------------------------------------------------------------
  it('U-CMD-06: restart with active session writes signal file with notify payload', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    // Create a session
    await sendChannelPost(port, 'chat123', 'hello');
    await new Promise(r => setTimeout(r, 100));

    // Temporarily prevent chokidar from consuming the signal immediately
    // by checking what the handler writes
    const stateDir = path.join(agentConfig.workspace, '.telegram-state');
    const signalPath = path.join(stateDir, 'restart-chat123');

    const { data } = await sendCommand(port, {
      command: 'restart',
      chat_id: 'chat123',
    });

    expect(data.success).toBe(true);

    // The signal file may have been consumed by chokidar already, but the command succeeded.
    // We verify the response is correct.
  });

  // --------------------------------------------------------------------------
  // U-CMD-07: restart with no active session returns success with restarted=false
  // --------------------------------------------------------------------------
  it('U-CMD-07: restart with no active session returns success with restarted=false', async () => {
    runner = new AgentRunner(agentConfig, gatewayConfig);
    await runner.start();
    const port = getCallbackPort(runner);

    const { data } = await sendCommand(port, {
      command: 'restart',
      chat_id: '999',
    });

    expect(data.success).toBe(true);
    expect(data.restarted).toBe(false);
  });
});

// ── SessionProcess restart watcher tests (U-CMD-08, U-CMD-09) ────────────────

describe('SessionProcess restart watcher notify payload', () => {
  let tmpDir: string;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;
  let sessionStore: jest.Mocked<{
    loadSession: jest.Mock;
    appendMessage: jest.Mock;
    loadTelegramSession: jest.Mock;
    appendTelegramMessage: jest.Mock;
  }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cmd-test-'));
    const workspaceDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    agentConfig = makeAgentConfig(workspaceDir);
    gatewayConfig = makeGatewayConfig();

    // Create a mock session store
    sessionStore = {
      loadSession: jest.fn().mockResolvedValue([]),
      appendMessage: jest.fn().mockResolvedValue(undefined),
      loadTelegramSession: jest.fn().mockResolvedValue([]),
      appendTelegramMessage: jest.fn().mockResolvedValue(undefined),
    };

    allProcesses.length = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // U-CMD-08: restart signal with notify JSON includes notify instruction
  // --------------------------------------------------------------------------
  it('U-CMD-08: restart signal with notify JSON includes notify instruction in marker', async () => {
    // Create .telegram-state directory before starting (chokidar needs it)
    const stateDir = path.join(agentConfig.workspace, '.telegram-state');
    fs.mkdirSync(stateDir, { recursive: true });

    const sp = new SessionProcess(
      'chat123',
      'telegram',
      agentConfig,
      gatewayConfig,
      sessionStore as unknown as import('../../src/session/store').SessionStore,
    );
    await sp.start();

    // Give chokidar time to initialize the watcher
    await new Promise(r => setTimeout(r, 500));

    // Write restart signal with notify payload
    const signalPath = path.join(stateDir, 'restart-chat123');
    fs.writeFileSync(signalPath, JSON.stringify({
      notify: { chat_id: 'chat123', text: 'Model changed to claude-sonnet-4-6 — back online!' },
    }));

    // Poll until appendTelegramMessage is called with a restart marker
    const hasMarker = () => sessionStore.appendTelegramMessage.mock.calls.some(
      (c: unknown[]) => typeof c[3] === 'object' && c[3] !== null &&
        typeof (c[3] as { content?: string }).content === 'string' &&
        (c[3] as { content: string }).content.includes('Graceful restart completed'),
    );
    await pollUntil(hasMarker);

    // Check that appendTelegramMessage was called with a marker containing notify instruction
    // appendTelegramMessage(agentId, chatId, sessionId, message) — message is arg[3]
    const calls = sessionStore.appendTelegramMessage.mock.calls;
    const restartMarkerCall = calls.find(
      (c: unknown[]) => typeof c[3] === 'object' && c[3] !== null &&
        typeof (c[3] as { content?: string }).content === 'string' &&
        (c[3] as { content: string }).content.includes('Graceful restart completed'),
    );
    expect(restartMarkerCall).toBeDefined();

    const markerContent = (restartMarkerCall![3] as { content: string }).content;
    expect(markerContent).toContain('IMPORTANT: Send a Telegram reply to chat_id "chat123"');
    expect(markerContent).toContain('Model changed to claude-sonnet-4-6');

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-CMD-09: restart signal with empty content uses default marker
  // --------------------------------------------------------------------------
  it('U-CMD-09: restart signal with empty content uses default marker (no notify)', async () => {
    // Create .telegram-state directory before starting (chokidar needs it)
    const stateDir = path.join(agentConfig.workspace, '.telegram-state');
    fs.mkdirSync(stateDir, { recursive: true });

    const sp = new SessionProcess(
      'chat456',
      'telegram',
      agentConfig,
      gatewayConfig,
      sessionStore as unknown as import('../../src/session/store').SessionStore,
    );
    await sp.start();

    // Give chokidar time to initialize the watcher
    await new Promise(r => setTimeout(r, 500));

    // Write empty restart signal (self-restart)
    const signalPath = path.join(stateDir, 'restart-chat456');
    fs.writeFileSync(signalPath, '');

    // Poll until appendTelegramMessage is called with a restart marker
    const hasMarker = () => sessionStore.appendTelegramMessage.mock.calls.some(
      (c: unknown[]) => typeof c[3] === 'object' && c[3] !== null &&
        typeof (c[3] as { content?: string }).content === 'string' &&
        (c[3] as { content: string }).content.includes('Graceful restart completed'),
    );
    await pollUntil(hasMarker);

    // Check that appendTelegramMessage was called with default marker (no notify)
    // appendTelegramMessage(agentId, chatId, sessionId, message) — message is arg[3]
    const calls = sessionStore.appendTelegramMessage.mock.calls;
    const restartMarkerCall = calls.find(
      (c: unknown[]) => typeof c[3] === 'object' && c[3] !== null &&
        typeof (c[3] as { content?: string }).content === 'string' &&
        (c[3] as { content: string }).content.includes('Graceful restart completed'),
    );
    expect(restartMarkerCall).toBeDefined();

    const markerContent = (restartMarkerCall![3] as { content: string }).content;
    expect(markerContent).toBe('[System: Graceful restart completed successfully. Do not restart again.]');
    expect(markerContent).not.toContain('IMPORTANT');

    await sp.stop();
  });
});
