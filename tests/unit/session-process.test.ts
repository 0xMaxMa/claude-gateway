import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── os.homedir mock (set per-test) ────────────────────────────────────────────
let mockHomeDir: string | null = null;
jest.mock('os', () => {
  const real = jest.requireActual<typeof os>('os');
  return {
    ...real,
    homedir: () => mockHomeDir ?? real.homedir(),
  };
});

// ── Minimal mock types ────────────────────────────────────────────────────────

interface MockStdin {
  writable: boolean;
  write: jest.Mock;
}

interface MockStdout extends EventEmitter {
  _emit(event: string, data: Buffer): void;
}

interface MockStderr extends EventEmitter {
  _emit(event: string, data: Buffer): void;
}

interface MockChildProcess extends EventEmitter {
  stdin: MockStdin | null;
  stdout: MockStdout | null;
  stderr: MockStderr | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

// ── Capture spawn calls ───────────────────────────────────────────────────────

let spawnMock: jest.Mock;
let lastProcess: MockChildProcess | null = null;

function makeMockProcess(): MockChildProcess {
  const stdin: MockStdin = { writable: true, write: jest.fn() };
  const stdout = new EventEmitter() as MockStdout;
  const stderr = new EventEmitter() as MockStderr;

  const proc = new EventEmitter() as MockChildProcess;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.pid = 12345;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = true;
    // Emit exit on next tick to simulate async
    process.nextTick(() => proc.emit('exit', signal === 'SIGKILL' ? 1 : 0, signal ?? 'SIGTERM'));
    return true;
  });

  return proc;
}

jest.mock('child_process', () => ({
  spawn: jest.fn((...args) => {
    lastProcess = makeMockProcess();
    return lastProcess;
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { SessionProcess } from '../../src/session-process';
import { SessionStore } from '../../src/session-store';
import { AgentConfig, GatewayConfig } from '../../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'alfred',
    description: 'test agent',
    workspace: '/tmp/workspace',
    env: '',
    telegram: {
      botToken: 'test-token',
      allowedUsers: [],
      dmPolicy: 'allowlist',
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
    gateway: { logDir: '/tmp/logs', timezone: 'UTC' },
    agents: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionProcess', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-'));
    agentConfig = makeAgentConfig({ workspace: path.join(tmpDir, 'workspace') });
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions'));
    lastProcess = null;
    mockHomeDir = null;
    spawnMock = require('child_process').spawn as jest.Mock;
    spawnMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mockHomeDir = null;
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // U-SP-01: start() spawns a subprocess
  // --------------------------------------------------------------------------
  it('U-SP-01: start() spawns a subprocess', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(lastProcess).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // U-SP-02: sendMessage() writes stream-json turn to stdin
  // --------------------------------------------------------------------------
  it('U-SP-02: sendMessage() writes a stream-json turn to stdin', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    sp.sendMessage('hello world');

    expect(lastProcess!.stdin!.write).toHaveBeenCalledWith(
      expect.stringMatching(/"type":"user".*"text":"hello world"/s),
    );
  });

  // --------------------------------------------------------------------------
  // U-SP-03: stop() kills the subprocess
  // --------------------------------------------------------------------------
  it('U-SP-03: stop() kills the subprocess', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    expect(sp.isRunning()).toBe(true);

    const stopPromise = sp.stop();
    await stopPromise;

    expect(lastProcess!.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // --------------------------------------------------------------------------
  // U-SP-04: isIdle() / touch() behaviour
  // --------------------------------------------------------------------------
  it('U-SP-04: isIdle() returns true after idle window, touch() resets it', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Manually set lastActivityAt to 2 minutes ago
    (sp as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 120_000;

    expect(sp.isIdle(60_000)).toBe(true);

    sp.touch();

    expect(sp.isIdle(60_000)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // U-SP-05: MCP config has TELEGRAM_SEND_ONLY=true for telegram source
  // --------------------------------------------------------------------------
  it('U-SP-05: MCP config written for telegram source has TELEGRAM_SEND_ONLY=true', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const sessionDir = path.join(agentConfig.workspace, '.sessions', 'chat:111');
    const configPath = path.join(sessionDir, 'mcp-config.json');

    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.telegram.env.TELEGRAM_SEND_ONLY).toBe('true');
  });

  // --------------------------------------------------------------------------
  // U-SP-06: No MCP config for api source
  // --------------------------------------------------------------------------
  it('U-SP-06: No MCP config written for api source', async () => {
    const sp = new SessionProcess('api:uuid', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // For api source, writeMcpConfig returns null — no --mcp-config in args
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--mcp-config');
  });

  // --------------------------------------------------------------------------
  // U-SP-07: History injected into initial prompt when SessionStore has data
  // --------------------------------------------------------------------------
  it('U-SP-07: injects history into initial prompt when session has stored messages', async () => {
    await sessionStore.appendMessage('alfred', 'chat:111', {
      role: 'user',
      content: 'Hello',
      ts: Date.now(),
    });
    await sessionStore.appendMessage('alfred', 'chat:111', {
      role: 'assistant',
      content: 'Hi there!',
      ts: Date.now(),
    });

    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // The first stdin.write call contains the initial prompt
    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    expect(text).toContain('Conversation history');
    expect(text).toContain('User: Hello');
    expect(text).toContain('Assistant: Hi there!');
  });

  // --------------------------------------------------------------------------
  // U-SP-08: No history section when SessionStore is empty
  // --------------------------------------------------------------------------
  it('U-SP-08: no history section in prompt when session is empty', async () => {
    const sp = new SessionProcess('chat:new', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    expect(text).not.toContain('Conversation history');
    expect(text).toContain('Channels mode is active');
  });

  // --------------------------------------------------------------------------
  // U-SP-09: History truncated to MAX_HISTORY_MESSAGES (50)
  // --------------------------------------------------------------------------
  it('U-SP-09: history is truncated to 50 messages', async () => {
    // Insert 60 messages
    for (let i = 0; i < 60; i++) {
      await sessionStore.appendMessage('alfred', 'chat:111', {
        role: 'user',
        content: `Message ${i}`,
        ts: Date.now() + i,
      });
    }

    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    // Should contain Message 59 (last) but NOT Message 0 (first — truncated)
    expect(text).toContain('Message 59');
    expect(text).not.toContain('Message 0');
  });

  // --------------------------------------------------------------------------
  // U-SP-10: --strict-mcp-config must NOT be in subprocess args
  // --------------------------------------------------------------------------
  it('U-SP-10: subprocess is spawned without --strict-mcp-config', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--strict-mcp-config');
  });

  // --------------------------------------------------------------------------
  // U-SP-11: --mcp-config is still present for telegram sessions
  // --------------------------------------------------------------------------
  it('U-SP-11: --mcp-config arg is present for telegram sessions', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--mcp-config');
  });

  // --------------------------------------------------------------------------
  // U-SP-12: User-scoped stdio MCP servers merged into mcp-config.json
  // --------------------------------------------------------------------------
  it('U-SP-12: user-scoped stdio mcpServers are merged into mcp-config.json', async () => {
    // Setup fake home with settings.json containing a custom MCP server
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-home-'));
    try {
      fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.claude', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
          },
        }),
      );
      mockHomeDir = fakeHome;

      const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
      await sp.start();

      const configPath = path.join(agentConfig.workspace, '.sessions', 'chat:111', 'mcp-config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(config.mcpServers.github).toBeDefined();
      expect(config.mcpServers.github.command).toBe('npx');
      expect(config.mcpServers.telegram).toBeDefined(); // gateway telegram still present
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // U-SP-13: Project-scoped MCP servers override user-scoped on name collision
  // --------------------------------------------------------------------------
  it('U-SP-13: project-scoped servers override user-scoped on name collision', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-home-'));
    try {
      fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });

      // User-scoped: github with command "old"
      fs.writeFileSync(
        path.join(fakeHome, '.claude', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            github: { command: 'old', args: [] },
          },
        }),
      );

      // Project-scoped: github with command "new" (should win)
      fs.writeFileSync(
        path.join(fakeHome, '.claude.json'),
        JSON.stringify({
          projects: {
            [agentConfig.workspace]: {
              mcpServers: {
                github: { command: 'new', args: [] },
              },
            },
          },
        }),
      );
      mockHomeDir = fakeHome;

      const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
      await sp.start();

      const configPath = path.join(agentConfig.workspace, '.sessions', 'chat:111', 'mcp-config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(config.mcpServers.github.command).toBe('new');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // U-SP-14: "telegram" in user/project config is skipped — gateway telegram wins
  // --------------------------------------------------------------------------
  it('U-SP-14: telegram server in user config is skipped, gateway telegram always wins', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-home-'));
    try {
      fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.claude', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            telegram: { command: 'bad-command', args: [] }, // should be ignored
          },
        }),
      );
      mockHomeDir = fakeHome;

      const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
      await sp.start();

      const configPath = path.join(agentConfig.workspace, '.sessions', 'chat:111', 'mcp-config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(config.mcpServers.telegram.command).toBe('bun'); // gateway version
      expect(config.mcpServers.telegram.command).not.toBe('bad-command');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // U-SP-15: Missing or corrupt Claude config files → no error, only telegram
  // --------------------------------------------------------------------------
  it('U-SP-15: missing or corrupt Claude config files produce no error, only telegram in config', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-home-'));
    try {
      // No settings.json, no .claude.json
      mockHomeDir = fakeHome;

      const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
      await expect(sp.start()).resolves.not.toThrow();

      const configPath = path.join(agentConfig.workspace, '.sessions', 'chat:111', 'mcp-config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(Object.keys(config.mcpServers)).toEqual(['telegram']);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // U-SP-16: API session — no MCP config, no --mcp-config arg (unchanged)
  // --------------------------------------------------------------------------
  it('U-SP-16: api session still has no --mcp-config even with user-scoped servers', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-home-'));
    try {
      fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.claude', 'settings.json'),
        JSON.stringify({ mcpServers: { github: { command: 'npx', args: [] } } }),
      );
      mockHomeDir = fakeHome;

      const sp = new SessionProcess('api:uuid', 'api', agentConfig, gatewayConfig, sessionStore);
      await sp.start();

      const [, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(args).not.toContain('--mcp-config');
      expect(args).not.toContain('--strict-mcp-config');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // T7-T11: Status file writes from stream-json parsing
  // --------------------------------------------------------------------------

  function statusPath(workspace: string, sessionId: string): string {
    return path.join(workspace, '.telegram-state', 'typing', `${sessionId}.status`);
  }

  it('T7: stdout tool_use Write → writes "coding" to status file', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const typingDir = path.join(agentConfig.workspace, '.telegram-state', 'typing');
    fs.mkdirSync(typingDir, { recursive: true });

    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/home/user/src/app.ts' } }],
      },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));

    const sp_path = statusPath(agentConfig.workspace, 'chat:111');
    expect(fs.existsSync(sp_path)).toBe(true);
    const written = JSON.parse(fs.readFileSync(sp_path, 'utf-8'));
    expect(written.status).toBe('coding');
    expect(written.detail).toContain('Writing');
    expect(written.detail).toContain('src/app.ts');
  });

  it('T8: stdout tool_use Bash → writes "tool" to status file', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const typingDir = path.join(agentConfig.workspace, '.telegram-state', 'typing');
    fs.mkdirSync(typingDir, { recursive: true });

    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }],
      },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));

    const sp_path = statusPath(agentConfig.workspace, 'chat:111');
    expect(fs.existsSync(sp_path)).toBe(true);
    const written = JSON.parse(fs.readFileSync(sp_path, 'utf-8'));
    expect(written.status).toBe('tool');
    expect(written.detail).toContain('Running');
    expect(written.detail).toContain('Run tests');
  });

  it('T9: stdout result ok → writes "done" to status file', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const typingDir = path.join(agentConfig.workspace, '.telegram-state', 'typing');
    fs.mkdirSync(typingDir, { recursive: true });

    const line = JSON.stringify({ type: 'result', is_error: false });
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));

    const sp_path = statusPath(agentConfig.workspace, 'chat:111');
    expect(fs.existsSync(sp_path)).toBe(true);
    expect(fs.readFileSync(sp_path, 'utf-8')).toBe('done');
  });

  it('T10: stdout result is_error → writes "error" to status file', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const typingDir = path.join(agentConfig.workspace, '.telegram-state', 'typing');
    fs.mkdirSync(typingDir, { recursive: true });

    const line = JSON.stringify({ type: 'result', is_error: true });
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));

    const sp_path = statusPath(agentConfig.workspace, 'chat:111');
    expect(fs.existsSync(sp_path)).toBe(true);
    expect(fs.readFileSync(sp_path, 'utf-8')).toBe('error');
  });

  it('T11: sendMessage() writes "queued" to status file for telegram source', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const typingDir = path.join(agentConfig.workspace, '.telegram-state', 'typing');
    fs.mkdirSync(typingDir, { recursive: true });

    sp.sendMessage('hello');

    const sp_path = statusPath(agentConfig.workspace, 'chat:111');
    expect(fs.existsSync(sp_path)).toBe(true);
    expect(fs.readFileSync(sp_path, 'utf-8')).toBe('queued');
  });

  // --------------------------------------------------------------------------
  // U-SP-17: --include-partial-messages flag is in spawn args
  // --------------------------------------------------------------------------
  it('U-SP-17: --include-partial-messages flag is in spawn args', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--include-partial-messages');
  });

  // --------------------------------------------------------------------------
  // U-SP-18: Partial messages don't double-count in assistantBuffer
  // --------------------------------------------------------------------------
  it('U-SP-18: partial messages dont double-count in assistantBuffer', async () => {
    const sp = new SessionProcess('chat:partial', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Partial assistant with cumulative text "Hello"
    const partial1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      stop_reason: null,
    });
    lastProcess!.stdout!.emit('data', Buffer.from(partial1 + '\n'));

    // Partial assistant with cumulative text "Hello world"
    const partial2 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
      stop_reason: null,
    });
    lastProcess!.stdout!.emit('data', Buffer.from(partial2 + '\n'));

    // Result event triggers persistence
    const result = JSON.stringify({ type: 'result', result: 'Hello world', is_error: false });
    lastProcess!.stdout!.emit('data', Buffer.from(result + '\n'));

    // Wait for async appendMessage to flush
    await new Promise(r => setTimeout(r, 200));

    // Load session from store — should contain "Hello world", not "HelloHello world"
    const messages = await sessionStore.loadSession('alfred', 'chat:partial');
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    expect(lastAssistant.content).toBe('Hello world');
  });

  // --------------------------------------------------------------------------
  // U-SP-19: Partial messages don't spam status file with "thinking"
  // --------------------------------------------------------------------------
  it('U-SP-19: partial text-only messages do not write thinking status', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const typingDir = path.join(agentConfig.workspace, '.telegram-state', 'typing');
    fs.mkdirSync(typingDir, { recursive: true });

    const sp_path = statusPath(agentConfig.workspace, 'chat:111');

    // Emit a partial assistant message (stop_reason: null) with only text content
    const partial = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Thinking about it...' }] },
      stop_reason: null,
    });
    lastProcess!.stdout!.emit('data', Buffer.from(partial + '\n'));

    // Status file should NOT have been written with "thinking" for a partial text-only message
    if (fs.existsSync(sp_path)) {
      const content = fs.readFileSync(sp_path, 'utf-8');
      // If status was written, it should not be a "thinking" status from this partial
      try {
        const parsed = JSON.parse(content);
        expect(parsed.status).not.toBe('thinking');
      } catch {
        // Plain string status (like "queued" or "done") is fine
        expect(content).not.toContain('thinking');
      }
    }
    // If status file doesn't exist at all, that's the expected behavior — partial didn't write it
  });

  // --------------------------------------------------------------------------
  // U-SP-20: Status file still works for tool_use in partial messages
  // --------------------------------------------------------------------------
  it('U-SP-20: tool_use in partial assistant message still writes status', async () => {
    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const typingDir = path.join(agentConfig.workspace, '.telegram-state', 'typing');
    fs.mkdirSync(typingDir, { recursive: true });

    // Emit an assistant message with a tool_use block (partial — stop_reason: null)
    const partial = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check...' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List files' } },
        ],
      },
      stop_reason: null,
    });
    lastProcess!.stdout!.emit('data', Buffer.from(partial + '\n'));

    const sp_path = statusPath(agentConfig.workspace, 'chat:111');
    expect(fs.existsSync(sp_path)).toBe(true);
    const written = JSON.parse(fs.readFileSync(sp_path, 'utf-8'));
    expect(written.status).toBe('tool');
    expect(written.detail).toContain('List files');
  });
});
