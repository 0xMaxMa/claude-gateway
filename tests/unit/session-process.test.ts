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

import { SessionProcess } from '../../src/session/process';
import { SessionStore } from '../../src/session/store';
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
    expect(config.mcpServers.gateway.env.TELEGRAM_SEND_ONLY).toBe('true');
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
    // Use new telegram multi-session API: write to telegram-chat:111/chat:111.json
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'user',
      content: 'Hello',
      ts: Date.now(),
    });
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
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
    // Insert 60 messages using new telegram multi-session API
    for (let i = 0; i < 60; i++) {
      await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
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
  // U-SP-09a: >50 msgs with summary at [0] → summary + last 49 loaded (total 50)
  // --------------------------------------------------------------------------
  it('U-SP-09a: summary at history[0] is rescued when history exceeds 50 messages', async () => {
    const summaryContent = '[Conversation Summary]\n**Summary:**\n\nPrior work on the project.';
    // Insert summary as message[0]
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'system',
      content: summaryContent,
      ts: 1000,
    });
    // Insert 60 normal messages (indices 1–60)
    for (let i = 1; i <= 60; i++) {
      await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
        role: 'user',
        content: `Message ${i}`,
        ts: 1000 + i,
      });
    }

    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    // Summary and last message must be present
    expect(text).toContain('[Conversation Summary]');
    expect(text).toContain('Message 60');
    // Message 12 is outside the 49-tail window (last 49 = messages 12–60)
    expect(text).not.toContain('Message 11');
  });

  // --------------------------------------------------------------------------
  // U-SP-09b: >50 msgs without summary → last 50 loaded normally
  // --------------------------------------------------------------------------
  it('U-SP-09b: last 50 messages loaded when no summary exists and history > 50', async () => {
    for (let i = 0; i < 60; i++) {
      await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
        role: 'user',
        content: `Msg ${i}`,
        ts: Date.now() + i,
      });
    }

    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    expect(text).toContain('Msg 59');
    expect(text).not.toContain('Msg 0');
  });

  // --------------------------------------------------------------------------
  // U-SP-09c: <=50 msgs with summary → all messages loaded (summary included)
  // --------------------------------------------------------------------------
  it('U-SP-09c: all messages loaded when history <=50 even with a summary present', async () => {
    const summaryContent = '[Conversation Summary]\n**Summary:**\n\nEarly work.';
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'system',
      content: summaryContent,
      ts: 1000,
    });
    for (let i = 1; i <= 10; i++) {
      await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
        role: 'user',
        content: `Short ${i}`,
        ts: 1000 + i,
      });
    }

    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    expect(text).toContain('[Conversation Summary]');
    expect(text).toContain('Short 1');
    expect(text).toContain('Short 10');
  });

  // --------------------------------------------------------------------------
  // U-SP-09d: summary at index 1 (not 0) → treated as normal, last 50 loaded
  // --------------------------------------------------------------------------
  it('U-SP-09d: summary not at history[0] is not rescued', async () => {
    // First message is a normal user message
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'user',
      content: 'First normal message',
      ts: 1000,
    });
    // Summary at index 1
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'system',
      content: '[Conversation Summary]\nShould not be rescued.',
      ts: 1001,
    });
    for (let i = 2; i <= 60; i++) {
      await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
        role: 'user',
        content: `Bulk ${i}`,
        ts: 1000 + i,
      });
    }

    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    // Last 50 messages = indices 11–60, so 'First normal message' (idx 0) is out
    expect(text).not.toContain('First normal message');
    expect(text).toContain('Bulk 60');
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
      expect(config.mcpServers.gateway).toBeDefined(); // gateway plugin still present
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

      expect(config.mcpServers.gateway.command).toBe('bun'); // gateway version
      expect(config.mcpServers.gateway.command).not.toBe('bad-command');
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

      expect(Object.keys(config.mcpServers)).toEqual(['gateway']);
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
    const messages = await sessionStore.loadTelegramSession('alfred', 'chat:partial', 'chat:partial');
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
  // U9: stream-json result with usage data → tokenUsage event fired with correct counts
  // --------------------------------------------------------------------------
  it('U9: result event with usage data fires tokenUsage event with correct counts', async () => {
    const sp = new SessionProcess('chat:tok9', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const tokenEvents: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = [];
    sp.on('tokenUsage', (data) => tokenEvents.push(data));

    // Emit message_start first (context is derived from this event now)
    const messageStart = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
        },
      },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(messageStart + '\n'));

    const resultLine = JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'Done',
      usage: { output_tokens: 50 },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(resultLine + '\n'));

    expect(tokenEvents).toHaveLength(1);
    // inputTokens = 100 + 20 + 10 = 130 (from message_start)
    expect(tokenEvents[0].inputTokens).toBe(130);
    expect(tokenEvents[0].outputTokens).toBe(50);
    // totalTokens = 130 + 50 = 180
    expect(tokenEvents[0].totalTokens).toBe(180);
  });

  it('U9b: result event without usage data does not fire tokenUsage event', async () => {
    const sp = new SessionProcess('chat:tok9b', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const tokenEvents: unknown[] = [];
    sp.on('tokenUsage', (data) => tokenEvents.push(data));

    // Result with no usage field
    const resultLine = JSON.stringify({ type: 'result', is_error: false, result: 'Done' });
    lastProcess!.stdout!.emit('data', Buffer.from(resultLine + '\n'));

    expect(tokenEvents).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // U10: cumulative tokens tracked — each turn adds to total
  // --------------------------------------------------------------------------
  it('U10: cumulative tokens tracked — each result event fires tokenUsage with that turn count', async () => {
    const sp = new SessionProcess('chat:tok10', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const tokenEvents: Array<{ totalTokens: number }> = [];
    sp.on('tokenUsage', (data) => tokenEvents.push(data));

    // Helper to emit a message_start + result pair
    const emitTurn = (inputTokens: number, outputTokens: number, label: string) => {
      const ms = JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { usage: { input_tokens: inputTokens } } },
      });
      lastProcess!.stdout!.emit('data', Buffer.from(ms + '\n'));
      const result = JSON.stringify({
        type: 'result', is_error: false, result: label,
        usage: { output_tokens: outputTokens },
      });
      lastProcess!.stdout!.emit('data', Buffer.from(result + '\n'));
    };

    emitTurn(60, 40, 'Turn 1');   // total = 60 + 40 = 100
    emitTurn(50, 30, 'Turn 2');   // total = 50 + 30 = 80
    emitTurn(150, 50, 'Turn 3');  // total = 150 + 50 = 200

    // Three separate tokenUsage events emitted, one per turn
    expect(tokenEvents).toHaveLength(3);
    expect(tokenEvents[0].totalTokens).toBe(100);  // 60 + 40
    expect(tokenEvents[1].totalTokens).toBe(80);   // 50 + 30
    expect(tokenEvents[2].totalTokens).toBe(200);  // 150 + 50
  });

  it('U10b: tokenUsage correctly handles missing optional cache fields', async () => {
    const sp = new SessionProcess('chat:tok10b', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const tokenEvents: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = [];
    sp.on('tokenUsage', (data) => tokenEvents.push(data));

    // message_start without cache fields
    const messageStart = JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { usage: { input_tokens: 200 } } },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(messageStart + '\n'));

    const resultLine = JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'Done',
      usage: { output_tokens: 100 },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(resultLine + '\n'));

    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0].inputTokens).toBe(200);
    expect(tokenEvents[0].outputTokens).toBe(100);
    // totalTokens = 200 + 100 = 300
    expect(tokenEvents[0].totalTokens).toBe(300);
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

// ── isProcessing + deferred restart ──────────────────────────────────────────

describe('SessionProcess — isProcessing and deferred restart', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-proc-'));
    agentConfig = makeAgentConfig({ workspace: path.join(tmpDir, 'workspace') });
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions'));
    lastProcess = null;
    (require('child_process').spawn as jest.Mock).mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // IP1: defaults to not processing
  it('IP1: isProcessing defaults to false', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    expect(sp.isProcessing).toBe(false);
    await sp.stop();
  });

  // IP2: setProcessing(true) flips the flag
  it('IP2: setProcessing(true) → isProcessing true', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    expect(sp.isProcessing).toBe(true);
    await sp.stop();
  });

  // IP3: setProcessing(false) resets the flag
  it('IP3: setProcessing(false) → isProcessing false', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    sp.setProcessing(false);
    expect(sp.isProcessing).toBe(false);
    await sp.stop();
  });

  // IP4: emits processingChange event on transition
  it('IP4: emits processingChange event when state changes', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const changes: boolean[] = [];
    sp.on('processingChange', (v: boolean) => changes.push(v));
    sp.setProcessing(true);
    sp.setProcessing(true);  // same value — no event
    sp.setProcessing(false);
    expect(changes).toEqual([true, false]);
    await sp.stop();
  });

  // IP5: stop() works while processing
  it('IP5: stop() succeeds while isProcessing is true', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    await expect(sp.stop()).resolves.toBeUndefined();
  });

  // IP6: markPendingRestart while not processing → emits deferredRestartReady immediately
  it('IP6: markPendingRestart while idle emits deferredRestartReady immediately', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    let fired = false;
    sp.once('deferredRestartReady', () => { fired = true; });
    sp.markPendingRestart();
    expect(fired).toBe(true);
    await sp.stop();
  });

  // IP7: markPendingRestart while processing → deferred until setProcessing(false)
  it('IP7: markPendingRestart while processing defers until turn ends', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    let fired = false;
    sp.once('deferredRestartReady', () => { fired = true; });
    sp.markPendingRestart();
    expect(fired).toBe(false);  // not yet
    sp.setProcessing(false);
    expect(fired).toBe(true);  // fires when turn ends
    await sp.stop();
  });

  // ── interrupt() ────────────────────────────────────────────────────────────

  // IP8: setProcessing(true) for telegram writes .processing sentinel
  it('IP8: setProcessing(true) for telegram writes .processing file', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const processingPath = path.join(agentConfig.workspace, '.telegram-state', 'typing', 's1.processing');

    sp.setProcessing(true);

    expect(fs.existsSync(processingPath)).toBe(true);
    await sp.stop();
  });

  // IP9: setProcessing(false) for telegram deletes .processing sentinel
  it('IP9: setProcessing(false) for telegram deletes .processing file', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const processingPath = path.join(agentConfig.workspace, '.telegram-state', 'typing', 's1.processing');

    sp.setProcessing(true);
    expect(fs.existsSync(processingPath)).toBe(true);

    sp.setProcessing(false);
    expect(fs.existsSync(processingPath)).toBe(false);
    await sp.stop();
  });

  // IP10: setProcessing for discord source does NOT write .processing
  it('IP10: setProcessing(true) for discord does not write .processing file', async () => {
    const sp = new SessionProcess('s1', 'discord', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const discordPath = path.join(agentConfig.workspace, '.discord-state', 'typing', 's1.processing');
    const telegramPath = path.join(agentConfig.workspace, '.telegram-state', 'typing', 's1.processing');

    sp.setProcessing(true);

    expect(fs.existsSync(discordPath)).toBe(false);
    expect(fs.existsSync(telegramPath)).toBe(false);
    await sp.stop();
  });

  // IP11: setProcessing for api source does NOT write .processing
  it('IP11: setProcessing(true) for api does not write .processing file', async () => {
    const sp = new SessionProcess('s1', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const processingPath = path.join(agentConfig.workspace, '.telegram-state', 'typing', 's1.processing');

    sp.setProcessing(true);

    expect(fs.existsSync(processingPath)).toBe(false);
    await sp.stop();
  });

  // IP12: stop() cleans up .processing sentinel for telegram
  it('IP12: stop() cleans up .processing file for telegram source', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const processingPath = path.join(agentConfig.workspace, '.telegram-state', 'typing', 's1.processing');

    sp.setProcessing(true);
    expect(fs.existsSync(processingPath)).toBe(true);

    await sp.stop();
    expect(fs.existsSync(processingPath)).toBe(false);
  });

  // ── interrupt() ────────────────────────────────────────────────────────────

  it('U-SP-INT-01: interrupt() sends SIGINT when a turn is in flight', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);

    const result = sp.interrupt();

    expect(result).toBe(true);
    expect(lastProcess!.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('U-SP-INT-02: interrupt() returns false when no turn is in flight', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    // Do NOT setProcessing(true) — idle state

    const result = sp.interrupt();

    expect(result).toBe(false);
    expect(lastProcess!.kill).not.toHaveBeenCalled();
    await sp.stop();
  });

  it('U-SP-INT-03: interrupt() returns false when subprocess is already killed', async () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.killed = true;

    const result = sp.interrupt();

    expect(result).toBe(false);
    expect(lastProcess!.kill).not.toHaveBeenCalled();
  });

  it('U-SP-INT-04: interrupt() returns false when subprocess never started', () => {
    const sp = new SessionProcess('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    // No start() — process is null

    const result = sp.interrupt();

    expect(result).toBe(false);
  });
});

// ── query() tests ─────────────────────────────────────────────────────────────

describe('SessionProcess — query()', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-query-'));
    agentConfig = makeAgentConfig({ workspace: path.join(tmpDir, 'workspace') });
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions'));
    lastProcess = null;
    spawnMock = require('child_process').spawn as jest.Mock;
    spawnMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function emitStdout(line: string): void {
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));
  }

  it('U-SP-QRY-01: query() resolves with assistant text when result fires', async () => {
    const sp = new SessionProcess('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const queryPromise = sp.query('describe all images');

    emitStdout(JSON.stringify({
      type: 'assistant',
      stop_reason: 'end_turn',
      message: { content: [{ type: 'text', text: 'Image 1: A dashboard screenshot' }] },
    }));
    emitStdout(JSON.stringify({ type: 'result', result: '', is_error: false }));

    const result = await queryPromise;
    expect(result).toBe('Image 1: A dashboard screenshot');
  });

  it('U-SP-QRY-02: query() sets queryMode=false after resolving', async () => {
    const sp = new SessionProcess('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const queryPromise = sp.query('describe all images');
    expect(sp.queryMode).toBe(true);

    emitStdout(JSON.stringify({
      type: 'assistant',
      stop_reason: 'end_turn',
      message: { content: [{ type: 'text', text: 'Image 1: test' }] },
    }));
    emitStdout(JSON.stringify({ type: 'result', result: '', is_error: false }));

    await queryPromise;
    expect(sp.queryMode).toBe(false);
  });

  it('U-SP-QRY-03: query() does not save assistant message to session store', async () => {
    const sp = new SessionProcess('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const appendSpy = jest.spyOn(sessionStore, 'appendTelegramMessage');

    const queryPromise = sp.query('describe all images');
    emitStdout(JSON.stringify({
      type: 'assistant',
      stop_reason: 'end_turn',
      message: { content: [{ type: 'text', text: 'Image 1: test' }] },
    }));
    emitStdout(JSON.stringify({ type: 'result', result: '', is_error: false }));

    await queryPromise;
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it('U-SP-QRY-04: query() rejects when timeout fires', async () => {
    const sp = new SessionProcess('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    await expect(sp.query('describe all images', 50)).rejects.toThrow('query timeout');
    expect(sp.queryMode).toBe(false);
  }, 5000);

  it('U-SP-QRY-05: query() rejects immediately when subprocess not running', async () => {
    const sp = new SessionProcess('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
    // No start() — process is null

    await expect(sp.query('describe all images')).rejects.toThrow('Cannot query');
  });
});

// ── buildInitialPrompt system role tests ──────────────────────────────────────

describe('SessionProcess — buildInitialPrompt system role', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sysrole-'));
    agentConfig = makeAgentConfig({ workspace: path.join(tmpDir, 'workspace') });
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions'));
    lastProcess = null;
    spawnMock = require('child_process').spawn as jest.Mock;
    spawnMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('U-SP-SYS-01: system messages are formatted as "System:" in initial prompt', async () => {
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'user',
      content: 'what is in the picture?',
      ts: Date.now(),
    });
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'system',
      content: '[Image Context Summary]\nImage 1: A dashboard screenshot',
      ts: Date.now(),
    });

    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    expect(text).toContain('System: [Image Context Summary]');
    expect(text).not.toContain('Assistant: [Image Context Summary]');
  });

  it('U-SP-SYS-02: system messages coexist with user and assistant messages', async () => {
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'user', content: 'show me a picture', ts: Date.now(),
    });
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'assistant', content: 'Here is the image.', ts: Date.now(),
    });
    await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
      role: 'system', content: '[Image Context Summary]\nImage 1: A chart', ts: Date.now(),
    });

    const sp = new SessionProcess('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    expect(text).toContain('User: show me a picture');
    expect(text).toContain('Assistant: Here is the image.');
    expect(text).toContain('System: [Image Context Summary]');
  });
});

// ── API session model-switch history injection tests ───────────────────────────

describe('SessionProcess — API model-switch history injection', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-apiswitch-'));
    agentConfig = makeAgentConfig({ workspace: path.join(tmpDir, 'workspace') });
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions'));
    lastProcess = null;
    spawnMock = require('child_process').spawn as jest.Mock;
    spawnMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('U-SP-API-01: API session does not send activation prompt at spawn even when prior history exists', async () => {
    // Pre-populate history so historyPrompt is non-null — verifies no write even when there is context to restore
    await sessionStore.appendMessage('alfred', 'sess-uuid', {
      role: 'user',
      content: 'Hello',
      ts: Date.now(),
    });
    await sessionStore.appendMessage('alfred', 'sess-uuid', {
      role: 'assistant',
      content: 'Hi there!',
      ts: Date.now(),
    });

    const sp = new SessionProcess('sess-uuid', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // API session must NOT write anything to stdin at spawn — history is deferred to first sendMessage()
    expect(lastProcess!.stdin!.write).not.toHaveBeenCalled();
  });

  it('U-SP-API-02: API session with history stashes historyPrompt as pendingInitialPrompt and prepends on first sendMessage', async () => {
    await sessionStore.appendMessage('alfred', 'sess-uuid', {
      role: 'user',
      content: 'What is 2+2?',
      ts: Date.now(),
    });
    await sessionStore.appendMessage('alfred', 'sess-uuid', {
      role: 'assistant',
      content: 'It is 4.',
      ts: Date.now(),
    });

    const sp = new SessionProcess('sess-uuid', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // No write at spawn
    expect(lastProcess!.stdin!.write).not.toHaveBeenCalled();

    // First sendMessage should prepend history
    sp.sendMessage('Now what is 3+3?');

    const writeCalls = lastProcess!.stdin!.write.mock.calls;
    expect(writeCalls.length).toBe(1);
    const payload = JSON.parse(writeCalls[0][0] as string);
    const text: string = payload.message.content[0].text;

    expect(text).toContain('Conversation history');
    expect(text).toContain('User: What is 2+2?');
    expect(text).toContain('Assistant: It is 4.');
    expect(text).toContain('Now what is 3+3?');
  });

  it('U-SP-API-03: pendingInitialPrompt is cleared after first sendMessage', async () => {
    await sessionStore.appendMessage('alfred', 'sess-uuid', {
      role: 'user',
      content: 'Hello',
      ts: Date.now(),
    });

    const sp = new SessionProcess('sess-uuid', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    sp.sendMessage('First message');
    sp.sendMessage('Second message');

    const writeCalls = lastProcess!.stdin!.write.mock.calls;
    expect(writeCalls.length).toBe(2);

    // First message has history prepended
    const firstText: string = JSON.parse(writeCalls[0][0] as string).message.content[0].text;
    expect(firstText).toContain('Conversation history');

    // Second message is plain — no history
    const secondText: string = JSON.parse(writeCalls[1][0] as string).message.content[0].text;
    expect(secondText).toBe('Second message');
    expect(secondText).not.toContain('Conversation history');
  });

  it('U-SP-API-04: API session with no prior history sends message as-is', async () => {
    const sp = new SessionProcess('sess-new', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    sp.sendMessage('Hello fresh session');

    const writeCalls = lastProcess!.stdin!.write.mock.calls;
    expect(writeCalls.length).toBe(1);
    const text: string = JSON.parse(writeCalls[0][0] as string).message.content[0].text;

    expect(text).toBe('Hello fresh session');
    expect(text).not.toContain('Conversation history');
  });
});

// ── Corrupted thinking-block recovery (issue #114) ──────────────────────────────

describe('SessionProcess — corrupted thinking-block recovery', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  // The exact Anthropic 400 surfaced by Claude Code on stdout, wrapped as a result event.
  const THINKING_400 =
    'API Error: 400 messages.1.content.11: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.';

  function errorResultLine(): string {
    return JSON.stringify({ type: 'result', is_error: true, result: THINKING_400 });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-recover-'));
    agentConfig = makeAgentConfig({ workspace: path.join(tmpDir, 'workspace') });
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions'));
    lastProcess = null;
    spawnMock = require('child_process').spawn as jest.Mock;
    spawnMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // R1: a 400 thinking-block error triggers a respawn (kill + restart marker)
  it('R1: thinking-block 400 on stdout kills the subprocess to respawn with clean history', async () => {
    const sp = new SessionProcess('chat:rec', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    lastProcess!.stdout!.emit('data', Buffer.from(errorResultLine() + '\n'));

    expect(lastProcess!.kill).toHaveBeenCalledWith('SIGTERM');
    expect((sp as unknown as { restartRequested: boolean }).restartRequested).toBe(true);
    expect((sp as unknown as { thinkingRecoveryCount: number }).thinkingRecoveryCount).toBe(1);

    await sp.stop();
  });

  // R2: the 400 error text is not persisted as an assistant message
  it('R2: API error text is not persisted to the session store during recovery', async () => {
    const sp = new SessionProcess('chat:rec2', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Assistant text carrying the error, then the result event.
    const assistantErr = JSON.stringify({
      type: 'assistant',
      stop_reason: 'end_turn',
      message: { role: 'assistant', content: [{ type: 'text', text: THINKING_400 }] },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(assistantErr + '\n'));
    lastProcess!.stdout!.emit('data', Buffer.from(errorResultLine() + '\n'));

    await new Promise(r => setTimeout(r, 100));

    const messages = await sessionStore.loadTelegramSession('alfred', 'chat:rec2', 'chat:rec2');
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    expect(assistantMsgs.some(m => m.content.includes('cannot be modified'))).toBe(false);

    await sp.stop();
  });

  // R3: recovery is bounded — once the budget is spent, no further respawn
  it('R3: recovery stops after MAX_THINKING_RECOVERIES to avoid an infinite respawn loop', async () => {
    const sp = new SessionProcess('chat:rec3', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Simulate the budget already being exhausted by prior respawns.
    (sp as unknown as { thinkingRecoveryCount: number }).thinkingRecoveryCount = 2;

    lastProcess!.stdout!.emit('data', Buffer.from(errorResultLine() + '\n'));

    // No respawn attempted: neither killed nor flagged for restart.
    expect(lastProcess!.kill).not.toHaveBeenCalled();
    expect((sp as unknown as { restartRequested: boolean }).restartRequested).toBe(false);

    await sp.stop();
  });

  // R4: a clean turn refills the recovery budget
  it('R4: a successful result resets the recovery budget', async () => {
    const sp = new SessionProcess('chat:rec4', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    (sp as unknown as { thinkingRecoveryCount: number }).thinkingRecoveryCount = 1;

    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) + '\n'));

    expect((sp as unknown as { thinkingRecoveryCount: number }).thinkingRecoveryCount).toBe(0);

    await sp.stop();
  });

  // R5: API sessions are not auto-respawned by this path (runner owns API error handling)
  it('R5: api source does not auto-respawn on a thinking-block 400', async () => {
    const sp = new SessionProcess('api:rec', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    lastProcess!.stdout!.emit('data', Buffer.from(errorResultLine() + '\n'));

    expect(lastProcess!.kill).not.toHaveBeenCalled();
    expect((sp as unknown as { restartRequested: boolean }).restartRequested).toBe(false);

    await sp.stop();
  });

  // R6: recovery does not fire while serving an internal query()
  it('R6: query mode does not trigger recovery', async () => {
    const sp = new SessionProcess('chat:rec6', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const queryPromise = sp.query('describe images', 1000);
    lastProcess!.stdout!.emit('data', Buffer.from(errorResultLine() + '\n'));

    expect(lastProcess!.kill).not.toHaveBeenCalled();
    expect((sp as unknown as { restartRequested: boolean }).restartRequested).toBe(false);

    // Settle the query so the test doesn't leak a pending timer.
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: '' }) + '\n'));
    await queryPromise;
    await sp.stop();
  });

  // R7: an ordinary (non-thinking) error does not trigger a respawn
  it('R7: a generic error result does not trigger recovery', async () => {
    const sp = new SessionProcess('chat:rec7', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const generic = JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 500 internal server error' });
    lastProcess!.stdout!.emit('data', Buffer.from(generic + '\n'));

    expect(lastProcess!.kill).not.toHaveBeenCalled();
    expect((sp as unknown as { restartRequested: boolean }).restartRequested).toBe(false);

    await sp.stop();
  });

  // R8: after recovery, the respawned subprocess rebuilds its prompt from clean
  // text-only history — proving the loop is actually broken, not just the kill issued.
  it('R8: respawn after recovery reloads clean text-only history (no thinking blocks)', async () => {
    await sessionStore.appendTelegramMessage('alfred', 'chat:rec8', 'chat:rec8', {
      role: 'user', content: 'hello boss', ts: Date.now(),
    });
    await sessionStore.appendTelegramMessage('alfred', 'chat:rec8', 'chat:rec8', {
      role: 'assistant', content: 'clean reply', ts: Date.now(),
    });

    const sp = new SessionProcess('chat:rec8', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const firstProcess = lastProcess!;
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Fake timers make the respawn deterministic and isolate this test from any
    // real auto-restart timers left pending by earlier tests in the suite.
    jest.useFakeTimers();
    try {
      // 400 → recovery kills the subprocess
      firstProcess.stdout!.emit('data', Buffer.from(errorResultLine() + '\n'));
      expect(firstProcess.kill).toHaveBeenCalledWith('SIGTERM');

      // mock kill() scheduled 'exit' on (faked) nextTick → flush it so the exit
      // handler runs scheduleRestart() and arms the AUTO_RESTART_DELAY_MS timer.
      jest.advanceTimersByTime(1);
      // fire the auto-restart timer → spawnProcess() (its fs reads are synchronous)
      jest.advanceTimersByTime(6000);
      // drain the microtasks from spawnProcess's awaits (promises are not faked)
      for (let i = 0; i < 5; i++) await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const respawned = lastProcess!;
    expect(respawned).not.toBe(firstProcess);

    // The respawned subprocess gets a fresh prompt rebuilt from text history —
    // clean, with no corrupted thinking content.
    const initialWrite = respawned.stdin!.write.mock.calls[0][0] as string;
    const text: string = JSON.parse(initialWrite).message.content[0].text;
    expect(text).toContain('Conversation history');
    expect(text).toContain('clean reply');
    expect(text).not.toContain('cannot be modified');

    await sp.stop();
  });

  // R9: the whole point of the tightened detection — an agent whose own reply
  // discusses the error phrase must NOT be misread as a real 400.
  it('R9: assistant text mentioning the error phrase in a clean turn does not trigger recovery', async () => {
    const sp = new SessionProcess('chat:rec9', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const chatty = JSON.stringify({
      type: 'assistant',
      stop_reason: 'end_turn',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'The 400 error "blocks in the latest assistant message cannot be modified" happens when thinking blocks change mid-stream.',
        }],
      },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(chatty + '\n'));
    // Successful result whose text also echoes the phrase
    const okResult = JSON.stringify({
      type: 'result', is_error: false,
      result: 'Explained why thinking blocks cannot be modified once sent.',
    });
    lastProcess!.stdout!.emit('data', Buffer.from(okResult + '\n'));

    expect(lastProcess!.kill).not.toHaveBeenCalled();
    expect((sp as unknown as { restartRequested: boolean }).restartRequested).toBe(false);

    await sp.stop();
  });

  // R10: a failed result that mentions the loose keywords but lacks the full API
  // signature must not trigger recovery (no two-word substring match anymore).
  it('R10: a failed result lacking the full signature does not trigger recovery', async () => {
    const sp = new SessionProcess('chat:rec10', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const loose = JSON.stringify({
      type: 'result', is_error: true,
      result: 'I was thinking, but this file cannot be modified.',
    });
    lastProcess!.stdout!.emit('data', Buffer.from(loose + '\n'));

    expect(lastProcess!.kill).not.toHaveBeenCalled();
    expect((sp as unknown as { restartRequested: boolean }).restartRequested).toBe(false);

    await sp.stop();
  });
});
