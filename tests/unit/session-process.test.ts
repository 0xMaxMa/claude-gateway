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

// ── claude-bin mock (override the resolved binary per-test) ───────────────────
// Default 'claude' mirrors PATH resolution, so existing specs are unaffected;
// the app-agent guard specs raise it to a host-only path to prove the guard.
let mockResolvedBin = 'claude';
jest.mock('../../src/session/claude-bin', () => {
  const real = jest.requireActual('../../src/session/claude-bin');
  return {
    ...real,
    resolveClaudeBin: () => ({ bin: mockResolvedBin, source: 'native-bin', searched: [] }),
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

import { SessionProcess, resolveMaxHistoryMessages, MAX_HISTORY_MESSAGES } from '../../src/session/process';
import { SessionStore } from '../../src/session/store';
import { AgentConfig, GatewayConfig } from '../../src/types';

// ── SessionProcess registry ───────────────────────────────────────────────────
// start() opens a chokidar FSWatcher that only stop() closes. Tests create many
// instances but stop few, so unclosed watchers accumulated across the file and
// eventually OOM-killed the Jest worker. Route every construction through this
// factory and stop() each instance after its test — stop() is null-safe on
// never-started instances and idempotent, so blanket teardown is harmless.
const activeSps: SessionProcess[] = [];
function makeSp(...args: ConstructorParameters<typeof SessionProcess>): SessionProcess {
  const sp = new SessionProcess(...args);
  activeSps.push(sp);
  return sp;
}

afterEach(async () => {
  const pending = activeSps.splice(0);
  await Promise.all(pending.map(sp => sp.stop().catch(() => {})));
});

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
    mockResolvedBin = 'claude';
    delete process.env.CLAUDE_BIN; // keep binary-resolution specs deterministic
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
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(lastProcess).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // U-SP-02: sendMessage() writes stream-json turn to stdin
  // --------------------------------------------------------------------------
  it('U-SP-02: sendMessage() writes a stream-json turn to stdin', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    expect(sp.isRunning()).toBe(true);

    const stopPromise = sp.stop();
    await stopPromise;

    expect(lastProcess!.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // --------------------------------------------------------------------------
  // U-SP-03a: SessionProcess re-emits 'exit' when the child subprocess dies.
  // The runner's typing/processing teardown (runner.ts) listens for this event;
  // without it the Telegram typing indicator stays stuck after a session is
  // stopped/restarted until the 5-min stalled detector fires.
  // --------------------------------------------------------------------------
  it("U-SP-03a: re-emits 'exit' to listeners when the child subprocess exits", async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const exitSpy = jest.fn();
    sp.on('exit', exitSpy);

    // Simulate an external kill (e.g. restartProcess/stop) — the mock child
    // emits 'exit' on the next tick after kill().
    await sp.stop();
    // Allow any queued microtasks/nextTick exit handlers to flush.
    await new Promise((r) => setImmediate(r));

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0, 'SIGTERM');
  });

  // --------------------------------------------------------------------------
  // U-SP-03b: a /stop SIGINT the pty-shell SURVIVES must not wedge the session.
  // The pty-shell traps SIGINT (forwards ESC to interrupt the TUI turn) and
  // keeps running, but Node flips ChildProcess.killed=true the instant the
  // signal is sent. isRunning()/interrupt() must key off the observed 'exit'
  // (_exited), NOT .killed — otherwise the survived-SIGINT child reads as dead
  // and the next turn waits forever on a restart that never comes.
  // Regression for: session stuck "Session restart did not complete in time"
  // after /stop + resend.
  // --------------------------------------------------------------------------
  it('U-SP-03b: a survived /stop SIGINT keeps the session running and interruptible', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const child = lastProcess!;

    // Simulate the pty-shell: SIGINT is trapped and survived (no 'exit'); only
    // SIGTERM/SIGKILL actually kill it. Node still sets killed=true on SIGINT.
    child.kill = jest.fn((signal?: string) => {
      child.killed = true;
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        process.nextTick(() => child.emit('exit', signal === 'SIGKILL' ? 1 : 0, signal));
      }
      // SIGINT: the child survives — deliberately emit no 'exit'.
      return true;
    });

    // An actively-processing turn, then a /stop interrupt.
    sp.setProcessing(true);
    expect(sp.interrupt()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    expect(child.killed).toBe(true); // Node flipped it — but the child is alive

    // The child survived, so the session is still running and a follow-up
    // interrupt on the same live turn must still fire. On the pre-fix code
    // (isRunning/interrupt gated on child.killed) BOTH of these are false.
    expect(sp.isRunning()).toBe(true);
    expect(sp.interrupt()).toBe(true);

    // Sanity (guard against over-correction): a genuine teardown still flips
    // isRunning() to false.
    sp.setProcessing(false);
    await sp.stop();
    expect(sp.isRunning()).toBe(false);
  });

  // --------------------------------------------------------------------------
  // U-SP-04: isIdle() / touch() behaviour
  // --------------------------------------------------------------------------
  it('U-SP-04: isIdle() returns true after idle window, touch() resets it', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('api:uuid', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // For api source, writeMcpConfig returns null — no --mcp-config in args
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--mcp-config');
  });

  // --------------------------------------------------------------------------
  // U-SP-06a: allow_tools:false api session denies built-in tools at the CLI
  // --------------------------------------------------------------------------
  it('U-SP-06a: api source without allow_tools passes --disallowedTools for built-ins', async () => {
    const sp = makeSp('api:uuid', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const idx = args.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const denied = args[idx + 1].split(',');
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'WebFetch']));
  });

  // --------------------------------------------------------------------------
  // U-SP-06b: allow_tools:true api session is unaffected (no deny-list, MCP on)
  // --------------------------------------------------------------------------
  it('U-SP-06b: api source with allow_tools:true does NOT pass --disallowedTools', async () => {
    agentConfig = makeAgentConfig({ workspace: path.join(tmpDir, 'workspace'), allow_tools: true });
    const sp = makeSp('api:uuid', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--disallowedTools');
    expect(args).toContain('--mcp-config');
  });

  // --------------------------------------------------------------------------
  // U-SP-06c: channel (telegram) sessions are never given the deny-list
  // --------------------------------------------------------------------------
  it('U-SP-06c: telegram source never passes --disallowedTools', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--disallowedTools');
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

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Nothing written to stdin yet — history is deferred to first sendMessage call
    expect(lastProcess!.stdin!.write.mock.calls.length).toBe(0);
    // sendMessage bundles history + activation + user message into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

    expect(text).toContain('Conversation history');
    expect(text).toContain('User: Hello');
    expect(text).toContain('Assistant: Hi there!');
  });

  // --------------------------------------------------------------------------
  // U-SP-08: No history section when SessionStore is empty
  // --------------------------------------------------------------------------
  it('U-SP-08: no history section in prompt when session is empty', async () => {
    const sp = makeSp('chat:new', 'telegram', agentConfig, gatewayConfig, sessionStore);
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

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // sendMessage bundles history + activation + user message into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

    // Should contain Message 59 (last) but NOT Message 0 (first — truncated)
    expect(text).toContain('Message 59');
    expect(text).not.toContain('Message 0');
  });

  // --------------------------------------------------------------------------
  // U-SP-09b: a lowered historyLimit (configurable cap) truncates further
  // --------------------------------------------------------------------------
  it('U-SP-09b: history is truncated to a lowered historyLimit (30)', async () => {
    // Insert 40 messages so the 30-message cap must drop the oldest 10
    for (let i = 0; i < 40; i++) {
      await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
        role: 'user',
        content: `Message ${i}`,
        ts: Date.now() + i,
      });
    }

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    // Mirror what the runner sets from a resolved maxHistoryMessages config
    sp.historyLimit = 30;
    await sp.start();

    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

    // Last 30 (Message 39 .. Message 10) loaded; Message 9 and older truncated.
    expect(text).toContain('Message 39');
    expect(text).toContain('Message 10');
    expect(text).not.toContain('Message 9');
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

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // sendMessage bundles history + activation + user message into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

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

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // sendMessage bundles history + activation + user message into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

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

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // sendMessage bundles history + activation + user message into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

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

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // sendMessage bundles history + activation + user message into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

    // Last 50 messages = indices 11–60, so 'First normal message' (idx 0) is out
    expect(text).not.toContain('First normal message');
    expect(text).toContain('Bulk 60');
  });

  // --------------------------------------------------------------------------
  // U-SP-09e: historyLimit override shrinks the re-injected window (Bug B
  //           request_too_large escalation: 50→40→30→20→10→0)
  // --------------------------------------------------------------------------
  it('U-SP-09e: historyLimit override truncates to the lower rung', async () => {
    for (let i = 0; i < 60; i++) {
      await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
        role: 'user',
        content: `Rung ${i}`,
        ts: Date.now() + i,
      });
    }

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    sp.historyLimit = 10; // escalated rung (e.g. after several 32MB recoveries)
    await sp.start();

    // sendMessage bundles history + activation + user message into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

    // Only the last 10 messages (50–59) survive; 49 and older are dropped.
    expect(text).toContain('Rung 59');
    expect(text).toContain('Rung 50');
    expect(text).not.toContain('Rung 49');
  });

  // --------------------------------------------------------------------------
  // U-SP-09f: historyLimit === 0 injects NO history at all (fully fresh).
  //           Guards against slice(-0) === slice(0) re-injecting everything.
  // --------------------------------------------------------------------------
  it('U-SP-09f: historyLimit 0 sends no history prompt', async () => {
    for (let i = 0; i < 5; i++) {
      await sessionStore.appendTelegramMessage('alfred', 'chat:111', 'chat:111', {
        role: 'user',
        content: `Fresh ${i}`,
        ts: Date.now() + i,
      });
    }

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    sp.historyLimit = 0; // ladder's last rung — drop all history
    await sp.start();

    const firstWrite = lastProcess!.stdin!.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(firstWrite);
    const text: string = parsed.message.content[0].text;

    // No prior turns leak in even though slice(-0) would otherwise return all.
    expect(text).not.toContain('Fresh 0');
    expect(text).not.toContain('Fresh 4');
    expect(text).not.toContain('Conversation history with this user');
  });

  // --------------------------------------------------------------------------
  // U-SP-RESTART-01: subprocess crash + restart with prior history must produce
  //   exactly ONE stdin write when the next user message arrives (no double-response).
  //   Before the fix, activation was sent at spawn (Turn 1) and the channel XML
  //   arrived separately (Turn 2), causing two Claude responses forwarded to the
  //   channel. After the fix, both are bundled into a single stdin write.
  // --------------------------------------------------------------------------
  it('U-SP-RESTART-01: session restart with history produces one bundled stdin write, not two separate turns', async () => {
    await sessionStore.appendTelegramMessage('alfred', 'chat:rst', 'chat:rst', {
      role: 'user', content: 'Prior question', ts: 1000,
    });
    await sessionStore.appendTelegramMessage('alfred', 'chat:rst', 'chat:rst', {
      role: 'assistant', content: 'Prior answer', ts: 1001,
    });

    const sp = makeSp('chat:rst', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const firstProcess = lastProcess!;
    spawnMock.mockClear();

    // Verify: nothing written to stdin yet (activation deferred, no double-response risk)
    expect(firstProcess.stdin!.write.mock.calls.length).toBe(0);

    jest.useFakeTimers();
    try {
      // Simulate subprocess crash
      firstProcess.emit('exit', 1, null);
      jest.advanceTimersByTime(1); // drain nextTick from kill()
      jest.advanceTimersByTime(6000); // fire AUTO_RESTART_DELAY_MS (5s) timer
      for (let i = 0; i < 5; i++) await Promise.resolve(); // drain spawnProcess promises
    } finally {
      jest.useRealTimers();
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const restarted = lastProcess!;
    expect(restarted).not.toBe(firstProcess);

    // Verify: still nothing written to the restarted process (history still deferred)
    expect(restarted.stdin!.write.mock.calls.length).toBe(0);

    // Simulates the user's next message arriving (e.g. "Y" to a pending plan menu)
    sp.sendMessage('<channel source="telegram" chat_id="chat:rst">Y</channel>');

    // Exactly ONE write — history + activation + user message bundled together
    expect(restarted.stdin!.write.mock.calls.length).toBe(1);
    const bundled: string = JSON.parse(restarted.stdin!.write.mock.calls[0][0] as string).message.content[0].text;
    expect(bundled).toContain('Prior question');
    expect(bundled).toContain('Prior answer');
    expect(bundled).toContain('Channels mode is active');
    expect(bundled).toContain('Y');

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-10: --strict-mcp-config must NOT be in subprocess args
  // --------------------------------------------------------------------------
  it('U-SP-10: subprocess is spawned without --strict-mcp-config', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--strict-mcp-config');
  });

  // --------------------------------------------------------------------------
  // U-SP-11: --mcp-config is still present for telegram sessions
  // --------------------------------------------------------------------------
  it('U-SP-11: --mcp-config arg is present for telegram sessions', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--mcp-config');
  });

  // --------------------------------------------------------------------------
  // U-SP-11a: --dangerously-skip-permissions is built-in (no config needed)
  // --------------------------------------------------------------------------
  it('U-SP-11a: --dangerously-skip-permissions is always passed (built-in)', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--dangerously-skip-permissions');
  });

  // --------------------------------------------------------------------------
  // U-SP-11b: gateway.headless=false spawns the PTY wrapper instead of claude
  // --------------------------------------------------------------------------
  it('U-SP-11b: gateway.headless=false spawns the claude-pty-shell wrapper', async () => {
    gatewayConfig.gateway.headless = false;
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [bin, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(bin).toBe(process.execPath);
    expect(args[0]).toMatch(/shell[/\\]claude-pty-shell\.js$/);
    expect(args).toContain('--dangerously-skip-permissions');
    expect(opts.env.CLAUDE_REAL_BIN).toBeDefined();
    expect(opts.env.CLAUDE_REAL_BIN).not.toContain('claude-pty-shell');
  });

  // --------------------------------------------------------------------------
  // U-SP-11c: gateway.headless omitted/true keeps the headless backend
  // --------------------------------------------------------------------------
  it('U-SP-11c: gateway.headless omitted or true spawns claude directly', async () => {
    const sp1 = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp1.start();
    gatewayConfig.gateway.headless = true;
    const sp2 = makeSp('chat:222', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp2.start();

    for (const call of spawnMock.mock.calls) {
      const [bin, args] = call as [string, string[]];
      expect(bin).not.toBe(process.execPath);
      expect(args.join(' ')).not.toContain('claude-pty-shell');
      expect(args).toContain('--print');
    }
  });

  // --------------------------------------------------------------------------
  // U-SP-11d: pty-shell does NOT append [1m] even when contextWindow >= 1M.
  // The TUI 1M billing tier requires real account credits; without them the
  // session silently drops to 200k mid-conversation, so we leave the model as-is.
  // --------------------------------------------------------------------------
  it('U-SP-11d: pty-shell does not append [1m] even when model contextWindow is 1M', async () => {
    gatewayConfig.gateway.headless = false;
    gatewayConfig.gateway.models = [
      { id: 'claude-opus-4-8', label: 'Opus 4.8', alias: 'opus', contextWindow: 1_000_000 },
    ];
    agentConfig = makeAgentConfig({
      workspace: agentConfig.workspace,
      claude: { model: 'claude-opus-4-8', dangerouslySkipPermissions: false, extraFlags: [] },
    });
    const sp = makeSp('chat:1md', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).not.toBe(-1);
    expect(args[modelIdx + 1]).toBe('claude-opus-4-8');

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-11e: headless backend leaves model unchanged even with 1M contextWindow
  // --------------------------------------------------------------------------
  it('U-SP-11e: headless backend does not append [1m] even with 1M contextWindow', async () => {
    gatewayConfig.gateway.models = [
      { id: 'claude-opus-4-8', label: 'Opus 4.8', alias: 'opus', contextWindow: 1_000_000 },
    ];
    agentConfig = makeAgentConfig({
      workspace: agentConfig.workspace,
      claude: { model: 'claude-opus-4-8', dangerouslySkipPermissions: false, extraFlags: [] },
    });
    const sp = makeSp('chat:1mh', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).not.toBe(-1);
    expect(args[modelIdx + 1]).toBe('claude-opus-4-8');

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-11f: sub-1M model on pty-shell gets no suffix
  // --------------------------------------------------------------------------
  it('U-SP-11f: pty-shell does not append [1m] when model contextWindow is sub-1M', async () => {
    gatewayConfig.gateway.headless = false;
    gatewayConfig.gateway.models = [
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', alias: 'haiku', contextWindow: 200_000 },
    ];
    agentConfig = makeAgentConfig({
      workspace: agentConfig.workspace,
      claude: { model: 'claude-haiku-4-5', dangerouslySkipPermissions: false, extraFlags: [] },
    });
    const sp = makeSp('chat:haik', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).not.toBe(-1);
    expect(args[modelIdx + 1]).toBe('claude-haiku-4-5');

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-11g: explicit [xxx] suffix in model string is passed verbatim (no double-append)
  // --------------------------------------------------------------------------
  it('U-SP-11g: pty-shell passes through a model that already has an explicit [...] suffix verbatim', async () => {
    gatewayConfig.gateway.headless = false;
    gatewayConfig.gateway.models = [
      { id: 'claude-opus-4-8', label: 'Opus 4.8', alias: 'opus', contextWindow: 1_000_000 },
    ];
    agentConfig = makeAgentConfig({
      workspace: agentConfig.workspace,
      claude: { model: 'claude-opus-4-8[1m]', dangerouslySkipPermissions: false, extraFlags: [] },
    });
    const sp = makeSp('chat:dbl', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).not.toBe(-1);
    expect(args[modelIdx + 1]).toBe('claude-opus-4-8[1m]');

    await sp.stop();
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

      const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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

      const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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

      const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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

      const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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

      const sp = makeSp('api:uuid', 'api', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const typingDir = path.join(agentConfig.workspace, '.telegram-state', 'typing');
    fs.mkdirSync(typingDir, { recursive: true });

    sp.sendMessage('hello');

    const sp_path = statusPath(agentConfig.workspace, 'chat:111');
    expect(fs.existsSync(sp_path)).toBe(true);
    expect(fs.readFileSync(sp_path, 'utf-8')).toBe('queued');
  });

  // --------------------------------------------------------------------------
  // hasLikelyOutstandingBackgroundWork() — a session that dispatches a
  // background Agent/Workflow tool_use and then ends its own turn looks idle
  // from the outside, but a sub-agent it launched may still be doing real
  // work. This is the signal restartOrDefer consults so a config-driven
  // restart never SIGKILLs a session mid-dispatch (the incident: 3 in-flight
  // code-review sub-agents were destroyed when a skill-learning write
  // triggered an immediate restart of their idle-but-waiting parent).
  // --------------------------------------------------------------------------

  function agentDispatchLine(toolName: string, input: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_bg_1', name: toolName, input }],
      },
      stop_reason: 'tool_use',
    });
  }

  it('BG1: false before any Agent/Workflow dispatch is seen', async () => {
    const sp = makeSp('chat:bg-none', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(false);

    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(false);
  });

  it('BG2: true after a final-message Agent tool_use, while idle', async () => {
    const sp = makeSp('chat:bg-agent', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true); // dispatch happens mid-turn
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Agent') + '\n'));
    sp.setProcessing(false); // turn ends right after — this is the observed incident shape

    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(true);
  });

  it('BG3: true after a Workflow dispatch too (same background-task contract as Agent)', async () => {
    const sp = makeSp('chat:bg-workflow', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Workflow') + '\n'));
    sp.setProcessing(false);

    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(true);
  });

  it('BG3b: true after a Monitor dispatch too — Monitor returns a task id immediately and notifies later, same contract as Agent/Workflow (#413)', async () => {
    const sp = makeSp('chat:bg-monitor', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Monitor') + '\n'));
    sp.setProcessing(false); // turn ends right after — the observed #413 incident shape

    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(true);
  });

  it('BG4: an ordinary tool_use (e.g. Bash) never arms it — no false positive', async () => {
    const sp = makeSp('chat:bg-bash', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Bash') + '\n'));
    sp.setProcessing(false);

    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(false);
  });

  it('BG5: false while the session is actively processing (isProcessing takes precedence)', async () => {
    const sp = makeSp('chat:bg-processing', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Agent') + '\n'));
    // Still processing — isProcessing's own branch in restartOrDefer already
    // covers this session correctly, so this getter defers to it (false here).

    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(false);
  });

  it('BG6: clears when a fresh turn starts, and does not silently re-arm on that turn ending', async () => {
    const sp = makeSp('chat:bg-clear', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Agent') + '\n'));
    sp.setProcessing(false);
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(true);

    // A fresh turn begins — e.g. the notification this dispatch was waiting on
    // woke the session, or unrelated new work superseded it.
    sp.setProcessing(true);
    // Turn ends with NO new Agent/Workflow dispatch this time.
    sp.setProcessing(false);

    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(false);
  });

  it('BG7: expires after BACKGROUND_AGENT_GRACE_MS — a dispatch that never reports back cannot block a restart forever', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 3_000_000_000;
    nowSpy.mockReturnValue(T0);

    const sp = makeSp('chat:bg-ttl', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Agent') + '\n'));
    sp.setProcessing(false);
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(true);

    nowSpy.mockReturnValue(T0 + 16 * 60 * 1000); // +16 min, past the 15-min grace window
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(false);

    nowSpy.mockRestore();
  });

  it('BG7b: a Monitor dispatch expires after BACKGROUND_AGENT_GRACE_MS too — the safety valve is not Agent/Workflow-specific (#413)', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 3_000_000_000;
    nowSpy.mockReturnValue(T0);

    const sp = makeSp('chat:bg-monitor-ttl', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Monitor') + '\n'));
    sp.setProcessing(false);
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(true);

    nowSpy.mockReturnValue(T0 + 16 * 60 * 1000); // +16 min, past the 15-min grace window
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(false);

    nowSpy.mockRestore();
  });

  it('BG8: a Monitor with a declared timeout_ms beyond 15 min stays retained past the flat window (#415)', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 3_000_000_000;
    nowSpy.mockReturnValue(T0);

    const sp = makeSp('chat:bg-monitor-timeout', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Monitor', { timeout_ms: 30 * 60 * 1000 }) + '\n'));
    sp.setProcessing(false);

    // Past the old flat 15-min window, but well inside a 30-min declared timeout.
    nowSpy.mockReturnValue(T0 + 20 * 60 * 1000);
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(true);

    // Past timeout_ms plus its buffer (30min + 15min headroom).
    nowSpy.mockReturnValue(T0 + 46 * 60 * 1000);
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(false);

    nowSpy.mockRestore();
  });

  it('BG9: a persistent:true Monitor stays retained far past 15 min but is still bounded, not forever (#415)', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 3_000_000_000;
    nowSpy.mockReturnValue(T0);

    const sp = makeSp('chat:bg-monitor-persistent', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Monitor', { persistent: true }) + '\n'));
    sp.setProcessing(false);

    // 2 hours in — still well inside the 24h ceiling.
    nowSpy.mockReturnValue(T0 + 2 * 60 * 60 * 1000);
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(true);

    // Past the 24h ceiling — the crash-safety backstop still applies even to persistent monitors.
    nowSpy.mockReturnValue(T0 + 25 * 60 * 60 * 1000);
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(false);

    nowSpy.mockRestore();
  });

  it('BG10: a declared timeout_ms far beyond the 24h ceiling is still capped, not honored verbatim (#415)', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 3_000_000_000;
    nowSpy.mockReturnValue(T0);

    const sp = makeSp('chat:bg-monitor-huge-timeout', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    lastProcess!.stdout!.emit('data', Buffer.from(agentDispatchLine('Monitor', { timeout_ms: 72 * 60 * 60 * 1000 }) + '\n'));
    sp.setProcessing(false);

    // 20h in: past the old flat 15-min window (proves scaling happened at all —
    // this alone would be false without the fix) and still inside the 24h cap.
    nowSpy.mockReturnValue(T0 + 20 * 60 * 60 * 1000);
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(true);

    // 25h in: past the 24h ceiling — proves the 72h timeout_ms was NOT honored
    // verbatim (an uncapped scale would still read true here).
    nowSpy.mockReturnValue(T0 + 25 * 60 * 60 * 1000);
    expect(sp.hasLikelyOutstandingBackgroundWork()).toBe(false);

    nowSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // U-SP-17: --include-partial-messages flag is in spawn args
  // --------------------------------------------------------------------------
  it('U-SP-17: --include-partial-messages flag is in spawn args', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--include-partial-messages');
  });

  // --------------------------------------------------------------------------
  // U-SP-18: Partial messages don't double-count in assistantBuffer
  // --------------------------------------------------------------------------
  it('U-SP-18: partial messages dont double-count in assistantBuffer', async () => {
    const sp = makeSp('chat:partial', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
  // U-SP-20: Channel reply-tool turns are mirrored to the resumable session store
  //          (regression for #331 — reply text lives in tool_use.input, not a
  //           text block, so assistantBuffer never captured it and the turn was
  //           lost on resume).
  // --------------------------------------------------------------------------
  it('U-SP-20a: a reply-tool-only turn is persisted even with no result event', async () => {
    const sp = makeSp('chat:reply-only', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Final assistant message whose ONLY output is a telegram_reply tool call —
    // no text block, and (critically) NO subsequent 'result' event, mirroring a
    // long report delivered to the user right before the subprocess exits.
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_report_1', name: 'mcp__gateway__telegram_reply', input: { chat_id: '111', text: 'FULL REPORT: 2 HIGH + 4 MEDIUM findings…' } },
        ],
      },
      stop_reason: 'tool_use',
    });
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));

    await new Promise(r => setTimeout(r, 200));

    const messages = await sessionStore.loadTelegramSession('alfred', 'chat:reply-only', 'chat:reply-only');
    const assistant = messages.filter(m => m.role === 'assistant');
    expect(assistant.length).toBe(1);
    expect(assistant[0].content).toBe('FULL REPORT: 2 HIGH + 4 MEDIUM findings…');
  });

  it('U-SP-20b: the same reply tool_use is persisted exactly once across partial + final events', async () => {
    const sp = makeSp('chat:reply-once', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Partial message carrying the reply tool_use (input still streaming)…
    const partial = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_dup', name: 'mcp__gateway__telegram_reply', input: { text: 'hi there' } }] },
      stop_reason: null,
    });
    lastProcess!.stdout!.emit('data', Buffer.from(partial + '\n'));
    // …then the final message with the SAME tool_use id.
    const final = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_dup', name: 'mcp__gateway__telegram_reply', input: { text: 'hi there' } }] },
      stop_reason: 'tool_use',
    });
    lastProcess!.stdout!.emit('data', Buffer.from(final + '\n'));

    await new Promise(r => setTimeout(r, 200));

    const messages = await sessionStore.loadTelegramSession('alfred', 'chat:reply-once', 'chat:reply-once');
    expect(messages.filter(m => m.role === 'assistant' && m.content === 'hi there').length).toBe(1);
  });

  it('U-SP-20c: a narration text block that duplicates the reply text is not double-written', async () => {
    const sp = makeSp('chat:reply-dup', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Same text emitted BOTH as a visible text block and as the reply tool input.
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Done ✅' },
          { type: 'tool_use', id: 'toolu_same', name: 'mcp__gateway__telegram_reply', input: { text: 'Done ✅' } },
        ],
      },
      stop_reason: 'tool_use',
    });
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));
    // Result event flushes assistantBuffer (the 'Done ✅' text block).
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'Done ✅' }) + '\n'));

    await new Promise(r => setTimeout(r, 200));

    const messages = await sessionStore.loadTelegramSession('alfred', 'chat:reply-dup', 'chat:reply-dup');
    expect(messages.filter(m => m.role === 'assistant' && m.content === 'Done ✅').length).toBe(1);
  });

  it('U-SP-20d: a normal text-only turn is still persisted exactly once (no regression)', async () => {
    const sp = makeSp('chat:plain', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'plain answer' }] },
      stop_reason: 'end_turn',
    }) + '\n'));
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'plain answer' }) + '\n'));

    await new Promise(r => setTimeout(r, 200));

    const messages = await sessionStore.loadTelegramSession('alfred', 'chat:plain', 'chat:plain');
    const assistant = messages.filter(m => m.role === 'assistant');
    expect(assistant.length).toBe(1);
    expect(assistant[0].content).toBe('plain answer');
  });

  it('U-SP-20e: a same-text reply retried with a fresh tool_use id in one turn is stored once', async () => {
    const sp = makeSp('chat:retry', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // First reply attempt (delivery is assumed to have failed downstream)…
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_try1', name: 'mcp__gateway__telegram_reply', input: { text: 'retry me' } }] },
      stop_reason: 'tool_use',
    }) + '\n'));
    // …retried with the SAME text but a FRESH tool_use id, same turn (no result yet).
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_try2', name: 'mcp__gateway__telegram_reply', input: { text: 'retry me' } }] },
      stop_reason: 'tool_use',
    }) + '\n'));
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: '' }) + '\n'));

    await new Promise(r => setTimeout(r, 200));

    const messages = await sessionStore.loadTelegramSession('alfred', 'chat:retry', 'chat:retry');
    expect(messages.filter(m => m.role === 'assistant' && m.content === 'retry me').length).toBe(1);
  });

  it('U-SP-20f: the same-text guard is per-turn — a genuine resend in a later turn is stored again', async () => {
    const sp = makeSp('chat:resend', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Turn 1: reply 'ping', then result (which must reset the per-turn dedup).
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p1', name: 'mcp__gateway__telegram_reply', input: { text: 'ping' } }] },
      stop_reason: 'tool_use',
    }) + '\n'));
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: '' }) + '\n'));
    // Turn 2: the model deliberately sends 'ping' again (fresh id) — a real message.
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p2', name: 'mcp__gateway__telegram_reply', input: { text: 'ping' } }] },
      stop_reason: 'tool_use',
    }) + '\n'));
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: '' }) + '\n'));

    await new Promise(r => setTimeout(r, 200));

    const messages = await sessionStore.loadTelegramSession('alfred', 'chat:resend', 'chat:resend');
    expect(messages.filter(m => m.role === 'assistant' && m.content === 'ping').length).toBe(2);
  });

  it('U-SP-20g: persistedReplyToolIds is reset each turn (a recurring id in a later turn is not swallowed)', async () => {
    const sp = makeSp('chat:idreset', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Turn 1: reply with id 'toolu_reused'.
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_reused', name: 'mcp__gateway__telegram_reply', input: { text: 'first' } }] },
      stop_reason: 'tool_use',
    }) + '\n'));
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: '' }) + '\n'));
    // Turn 2: a DIFFERENT reply that (pathologically) reuses the same tool_use id.
    // If the id set were not reset at the turn boundary, this second reply would be
    // wrongly deduped and lost.
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_reused', name: 'mcp__gateway__telegram_reply', input: { text: 'second' } }] },
      stop_reason: 'tool_use',
    }) + '\n'));
    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: '' }) + '\n'));

    await new Promise(r => setTimeout(r, 200));

    const messages = await sessionStore.loadTelegramSession('alfred', 'chat:idreset', 'chat:idreset');
    const contents = messages.filter(m => m.role === 'assistant').map(m => m.content);
    expect(contents).toContain('first');
    expect(contents).toContain('second');
  });

  // --------------------------------------------------------------------------
  // U-SP-19: Partial messages don't spam status file with "thinking"
  // --------------------------------------------------------------------------
  it('U-SP-19: partial text-only messages do not write thinking status', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:tok9', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:tok9b', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:tok10', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:tok10b', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
  // U-SP-21..25: lastModel — real model captured from the assistant stream (#273)
  // --------------------------------------------------------------------------
  it('U-SP-21: lastModel is empty string before any assistant message arrives', async () => {
    const sp = makeSp('chat:model1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    expect(sp.lastModel).toBe('');
  });

  it('U-SP-22: lastModel is captured from message.model on an assistant stream event', async () => {
    const sp = makeSp('chat:model2', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'hi' }],
      },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));

    expect(sp.lastModel).toBe('claude-opus-4-8');
  });

  it('U-SP-23: lastModel updates to the newest value across multiple turns (model switch mid-session)', async () => {
    const sp = makeSp('chat:model3', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const turn1 = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'first' }] },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(turn1 + '\n'));
    expect(sp.lastModel).toBe('claude-sonnet-4-6');

    const turn2 = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'second' }] },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(turn2 + '\n'));
    expect(sp.lastModel).toBe('claude-opus-4-8');
  });

  it('U-SP-24: lastModel is unaffected (stays at prior value) when message.model is missing or non-string', async () => {
    const sp = makeSp('chat:model4', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Establish a known value first.
    const good = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'first' }] },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(good + '\n'));
    expect(sp.lastModel).toBe('claude-sonnet-4-6');

    // No model field at all.
    const noModel = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'second' }] },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(noModel + '\n'));
    expect(sp.lastModel).toBe('claude-sonnet-4-6');

    // model present but wrong type (e.g. server sends a number/null instead of a string).
    const badType = JSON.stringify({
      type: 'assistant',
      message: { model: 12345, content: [{ type: 'text', text: 'third' }] },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(badType + '\n'));
    expect(sp.lastModel).toBe('claude-sonnet-4-6');
  });

  it('U-SP-25: lastModel is captured even from a tool-only assistant message (no text block)', async () => {
    const sp = makeSp('chat:model5', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));

    expect(sp.lastModel).toBe('claude-opus-4-8');
  });

  // --------------------------------------------------------------------------
  // U-SP-20: Status file still works for tool_use in partial messages
  // --------------------------------------------------------------------------
  it('U-SP-20: tool_use in partial assistant message still writes status', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    expect(sp.isProcessing).toBe(false);
    await sp.stop();
  });

  // IP2: setProcessing(true) flips the flag
  it('IP2: setProcessing(true) → isProcessing true', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    expect(sp.isProcessing).toBe(true);
    await sp.stop();
  });

  // IP3: setProcessing(false) resets the flag
  it('IP3: setProcessing(false) → isProcessing false', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    sp.setProcessing(false);
    expect(sp.isProcessing).toBe(false);
    await sp.stop();
  });

  // IP4: emits processingChange event on transition
  it('IP4: emits processingChange event when state changes', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);
    await expect(sp.stop()).resolves.toBeUndefined();
  });

  // IP6: markPendingRestart while not processing → emits deferredRestartReady immediately
  it('IP6: markPendingRestart while idle emits deferredRestartReady immediately', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    let fired = false;
    sp.once('deferredRestartReady', () => { fired = true; });
    sp.markPendingRestart();
    expect(fired).toBe(true);
    await sp.stop();
  });

  // IP7: markPendingRestart while processing → deferred until setProcessing(false)
  it('IP7: markPendingRestart while processing defers until turn ends', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const processingPath = path.join(agentConfig.workspace, '.telegram-state', 'typing', 's1.processing');

    sp.setProcessing(true);

    expect(fs.existsSync(processingPath)).toBe(true);
    await sp.stop();
  });

  // IP9: setProcessing(false) for telegram deletes .processing sentinel
  it('IP9: setProcessing(false) for telegram deletes .processing file', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('s1', 'discord', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('s1', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const processingPath = path.join(agentConfig.workspace, '.telegram-state', 'typing', 's1.processing');

    sp.setProcessing(true);

    expect(fs.existsSync(processingPath)).toBe(false);
    await sp.stop();
  });

  // IP12: stop() cleans up .processing sentinel for telegram
  it('IP12: stop() cleans up .processing file for telegram source', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    const processingPath = path.join(agentConfig.workspace, '.telegram-state', 'typing', 's1.processing');

    sp.setProcessing(true);
    expect(fs.existsSync(processingPath)).toBe(true);

    await sp.stop();
    expect(fs.existsSync(processingPath)).toBe(false);
  });

  // ── interrupt() ────────────────────────────────────────────────────────────

  it('U-SP-INT-01: interrupt() sends SIGINT when a turn is in flight', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);

    const result = sp.interrupt();

    expect(result).toBe(true);
    expect(lastProcess!.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('U-SP-INT-02: interrupt() returns false when no turn is in flight', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    // Do NOT setProcessing(true) — idle state

    const result = sp.interrupt();

    expect(result).toBe(false);
    expect(lastProcess!.kill).not.toHaveBeenCalled();
    await sp.stop();
  });

  it('U-SP-INT-03: interrupt() returns false after the subprocess has actually exited', async () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    sp.setProcessing(true);

    // A GENUINE teardown — the child's 'exit' is observed (process gone).
    // This is distinct from a survived /stop SIGINT, which sets Node's
    // .killed=true while the child stays alive (see U-SP-03b): that case must
    // remain interruptible, so interrupt() keys off the observed exit, not
    // .killed.
    await sp.stop();

    const result = sp.interrupt();

    expect(result).toBe(false);
  });

  it('U-SP-INT-04: interrupt() returns false when subprocess never started', () => {
    const sp = makeSp('s1', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    await expect(sp.query('describe all images', 50)).rejects.toThrow('query timeout');
    expect(sp.queryMode).toBe(false);
  }, 5000);

  it('U-SP-QRY-05: query() rejects immediately when subprocess not running', async () => {
    const sp = makeSp('chat:qry', 'telegram', agentConfig, gatewayConfig, sessionStore);
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

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // sendMessage bundles history + activation + user message into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

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

    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // sendMessage bundles history + activation + user message into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(lastProcess!.stdin!.write.mock.calls[0][0] as string).message.content[0].text;

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

    const sp = makeSp('sess-uuid', 'api', agentConfig, gatewayConfig, sessionStore);
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

    const sp = makeSp('sess-uuid', 'api', agentConfig, gatewayConfig, sessionStore);
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

    const sp = makeSp('sess-uuid', 'api', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('sess-new', 'api', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:rec', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    lastProcess!.stdout!.emit('data', Buffer.from(errorResultLine() + '\n'));

    expect(lastProcess!.kill).toHaveBeenCalledWith('SIGTERM');
    expect((sp as unknown as { restartRequested: boolean }).restartRequested).toBe(true);
    expect((sp as unknown as { thinkingRecoveryCount: number }).thinkingRecoveryCount).toBe(1);

    await sp.stop();
  });

  // R2: the 400 error text is not persisted as an assistant message
  it('R2: API error text is not persisted to the session store during recovery', async () => {
    const sp = makeSp('chat:rec2', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:rec3', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:rec4', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    (sp as unknown as { thinkingRecoveryCount: number }).thinkingRecoveryCount = 1;

    lastProcess!.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) + '\n'));

    expect((sp as unknown as { thinkingRecoveryCount: number }).thinkingRecoveryCount).toBe(0);

    await sp.stop();
  });

  // R5: API sessions are not auto-respawned by this path (runner owns API error handling)
  it('R5: api source does not auto-respawn on a thinking-block 400', async () => {
    const sp = makeSp('api:rec', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    lastProcess!.stdout!.emit('data', Buffer.from(errorResultLine() + '\n'));

    expect(lastProcess!.kill).not.toHaveBeenCalled();
    expect((sp as unknown as { restartRequested: boolean }).restartRequested).toBe(false);

    await sp.stop();
  });

  // R6: recovery does not fire while serving an internal query()
  it('R6: query mode does not trigger recovery', async () => {
    const sp = makeSp('chat:rec6', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:rec7', 'telegram', agentConfig, gatewayConfig, sessionStore);
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

    const sp = makeSp('chat:rec8', 'telegram', agentConfig, gatewayConfig, sessionStore);
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

    // Nothing written to the new process yet — history deferred to first sendMessage
    expect(respawned.stdin!.write.mock.calls.length).toBe(0);
    // sendMessage bundles clean text-only history + activation into one stdin write
    sp.sendMessage('probe');
    const text: string = JSON.parse(respawned.stdin!.write.mock.calls[0][0] as string).message.content[0].text;
    expect(text).toContain('Conversation history');
    expect(text).toContain('clean reply');
    expect(text).not.toContain('cannot be modified');

    await sp.stop();
  });

  // R9: the whole point of the tightened detection — an agent whose own reply
  // discusses the error phrase must NOT be misread as a real 400.
  it('R9: assistant text mentioning the error phrase in a clean turn does not trigger recovery', async () => {
    const sp = makeSp('chat:rec9', 'telegram', agentConfig, gatewayConfig, sessionStore);
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
    const sp = makeSp('chat:rec10', 'telegram', agentConfig, gatewayConfig, sessionStore);
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

  // --------------------------------------------------------------------------
  // U-SP-BIN1: the last non-empty stderr line is retained so a fatal restart
  // failure can name what actually died (e.g. an unresolvable claude binary).
  // --------------------------------------------------------------------------
  it('U-SP-BIN1: retains the last stderr line and the spawned binary', async () => {
    const sp = makeSp('chat:bin1', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    lastProcess!.stderr!.emit('data', Buffer.from('some warning\nclaude: binary not found\n'));

    const priv = sp as unknown as { lastStderrLine: string | null; lastClaudeBin: string };
    expect(priv.lastStderrLine).toBe('claude: binary not found');
    expect(typeof priv.lastClaudeBin).toBe('string');
    expect(priv.lastClaudeBin.length).toBeGreaterThan(0);

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-BIN2: once MAX_RESTARTS is hit the session emits 'failed' rather than
  // looping silently — the fatal branch that logs the actionable error.
  // --------------------------------------------------------------------------
  it("U-SP-BIN2: emits 'failed' after MAX_RESTARTS is reached", async () => {
    const sp = makeSp('chat:bin2', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();
    lastProcess!.stderr!.emit('data', Buffer.from('claude: binary not found\n'));

    let failed = false;
    sp.on('failed', () => { failed = true; });

    const priv = sp as unknown as { restartCount: number; scheduleRestart: () => void };
    priv.restartCount = 3; // at the MAX_RESTARTS cap
    priv.scheduleRestart();

    expect(failed).toBe(true);

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-BIN3: a non-app-agent session spawns the host-resolved binary directly.
  // --------------------------------------------------------------------------
  it('U-SP-BIN3: host session spawns the resolved binary path', async () => {
    mockResolvedBin = '/home/u/.local/bin/claude';
    const sp = makeSp('chat:bin3', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    expect(spawnMock.mock.calls[0][0]).toBe('/home/u/.local/bin/claude');

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-BIN4: app-agents run claude INSIDE the container, so host-side
  // resolution must NOT leak a host path into the container — the in-container
  // binary stays bare `claude` (resolved by the container PATH). Regression guard.
  // --------------------------------------------------------------------------
  it('U-SP-BIN4: app-agent does not leak the host-resolved path into the container', async () => {
    mockResolvedBin = '/home/u/.local/bin/claude'; // a host-only path
    const appAgent = makeAgentConfig({
      workspace: agentConfig.workspace,
      type: 'app-agent',
      container: 'my-app-container',
    });
    const sp = makeSp('chat:bin4', 'telegram', appAgent, gatewayConfig, sessionStore);
    await sp.start();

    const [spawnBin, spawnArgs] = spawnMock.mock.calls[0] as [string, string[]];
    expect(spawnBin).toBe('docker');
    // The in-container binary is bare `claude`, never the host-resolved path.
    expect(spawnArgs).toContain('claude');
    expect(spawnArgs).not.toContain('/home/u/.local/bin/claude');

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-BIN5: a genuinely unresolvable binary surfaces as an ENOENT `error`
  // event (NOT on stderr). It must still be captured into lastStderrLine so the
  // fatal max-restarts log can name the cause and fire the CLAUDE_BIN hint.
  // --------------------------------------------------------------------------
  it('U-SP-BIN5: captures a spawn ENOENT error into lastStderrLine', async () => {
    const sp = makeSp('chat:bin5', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    lastProcess!.emit('error', new Error('spawn /home/u/.local/bin/claude ENOENT'));

    const priv = sp as unknown as { lastStderrLine: string | null };
    expect(priv.lastStderrLine).toBe('spawn /home/u/.local/bin/claude ENOENT');
    // The fatal-log hint keys off this via /binary not found|ENOENT/i.
    expect(/binary not found|ENOENT/i.test(priv.lastStderrLine ?? '')).toBe(true);

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-BIN6: a stderr line split across two `data` chunks is reassembled into
  // one line, not captured as two partials.
  // --------------------------------------------------------------------------
  it('U-SP-BIN6: reassembles a stderr line split across chunks', async () => {
    const sp = makeSp('chat:bin6', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    lastProcess!.stderr!.emit('data', Buffer.from('claude: binary not '));
    const priv = sp as unknown as { lastStderrLine: string | null };
    // Nothing complete yet — the fragment stays buffered.
    expect(priv.lastStderrLine).toBeNull();

    lastProcess!.stderr!.emit('data', Buffer.from('found\n'));
    expect(priv.lastStderrLine).toBe('claude: binary not found');

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-BIN7: an unterminated final stderr line (process dies mid-line, no
  // trailing newline) is flushed into lastStderrLine on exit.
  // --------------------------------------------------------------------------
  it('U-SP-BIN7: flushes an unterminated trailing stderr line on exit', async () => {
    const sp = makeSp('chat:bin7', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    lastProcess!.stderr!.emit('data', Buffer.from('fatal: claude crashed mid-line'));
    const priv = sp as unknown as { lastStderrLine: string | null };
    expect(priv.lastStderrLine).toBeNull(); // still buffered, no newline yet

    lastProcess!.emit('exit', 1, null);
    expect(priv.lastStderrLine).toBe('fatal: claude crashed mid-line');

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-IDLE-CHILD: child output counts as activity for the idle reaper.
  // Regression for the idle cleaner reaping a session whose child is actively
  // self-paced looping (a /loop in dynamic mode driven by ScheduleWakeup): the
  // wake iterations run inside the child and produce output, but the parent
  // never injects a message, so before the fix `lastActivityAt` was stale and
  // `isIdle()` wrongly returned true -> the loop got killed mid-flight.
  // --------------------------------------------------------------------------
  it('U-SP-IDLE-CHILD: child stdout output resets the idle clock', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    // Simulate a session that has had no parent-side injection for 2 minutes:
    // the last human turn was long ago and it is now waiting between self-wakes.
    (sp as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 120_000;
    expect(sp.isIdle(60_000)).toBe(true);

    // The child wakes itself and produces output (a self-paced loop iteration).
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on the next batch' }] } });
    lastProcess!.stdout!.emit('data', Buffer.from(line + '\n'));

    // The session did real work just now, so it must NOT be considered idle.
    expect(sp.isIdle(60_000)).toBe(false);

    await sp.stop();
  });

  // --------------------------------------------------------------------------
  // U-SP-IDLE-QUIET: a genuinely quiet session (no child output, no parent
  // injection) still ages out — the fix must not defeat idle cleanup.
  // --------------------------------------------------------------------------
  it('U-SP-IDLE-QUIET: session with no child output stays idle and remains reapable', async () => {
    const sp = makeSp('chat:111', 'telegram', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    (sp as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 120_000;

    // No stdout output emitted — the child is sleeping. It must remain idle.
    expect(sp.isIdle(60_000)).toBe(true);

    await sp.stop();
  });
});

// ── crash-budget reset on healthy uptime (#371) ──────────────────────────────
// restartCount only ever reset in start()/graceful-restart, never after a
// crash-triggered respawn succeeded. A long-lived session that crashed a few
// times over its whole life (each recovering fine) would slowly accumulate
// toward MAX_RESTARTS and then permanently `failed` on the next crash — tearing
// down a healthy session (and, for API, wedging it). The fix resets the budget
// when a child dies after sustained healthy uptime, while a tight crash loop
// (no uptime gap) still trips MAX_RESTARTS so the backstop is preserved.
describe('SessionProcess — crash-budget reset on healthy uptime (#371)', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let agentConfig: AgentConfig;
  let gatewayConfig: GatewayConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-budget-'));
    agentConfig = makeAgentConfig({ workspace: path.join(tmpDir, 'workspace') });
    fs.mkdirSync(agentConfig.workspace, { recursive: true });
    gatewayConfig = makeGatewayConfig();
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions'));
    lastProcess = null;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const getRestartCount = (sp: SessionProcess) =>
    (sp as unknown as { restartCount: number }).restartCount;

  it("resets the crash budget after sustained uptime — no false 'failed' over many lifetime crashes", async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 1_000_000_000;
    nowSpy.mockReturnValue(T0);

    const sp = makeSp('sess:budget-1', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start(); // lastSpawnAt = T0

    const failedSpy = jest.fn();
    sp.on('failed', failedSpy);

    // Crash the child far more times than MAX_RESTARTS, but each death comes
    // after a long healthy uptime gap (well past RESTART_COUNT_RESET_MS = 60s).
    // No live respawn happens (the 5s timers never fire in the test), so
    // lastSpawnAt stays at T0 and each advanced clock reads as a huge uptime →
    // the budget resets every time and 'failed' is never emitted.
    for (let i = 1; i <= 8; i++) {
      nowSpy.mockReturnValue(T0 + i * 120_000); // +2min each crash
      lastProcess!.emit('exit', 1, null);
      await Promise.resolve();
      // Budget resets to 0 then increments to 1 on each healthy-uptime crash.
      expect(getRestartCount(sp)).toBeLessThanOrEqual(1);
    }
    expect(failedSpy).not.toHaveBeenCalled();

    await sp.stop();
  });

  it("still trips 'failed' at MAX_RESTARTS for a tight crash loop (backstop preserved)", async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const T0 = 2_000_000_000;
    nowSpy.mockReturnValue(T0);

    const sp = makeSp('sess:budget-2', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start();

    const failedSpy = jest.fn();
    sp.on('failed', failedSpy);

    // Rapid crashes with NO uptime gap (clock barely advances) → uptime stays
    // under RESTART_COUNT_RESET_MS → budget never resets → after MAX_RESTARTS
    // the next crash emits the permanent 'failed'.
    for (let i = 1; i <= 5; i++) {
      nowSpy.mockReturnValue(T0 + i * 100); // +100ms each — a tight loop
      lastProcess!.emit('exit', 1, null);
      await Promise.resolve();
    }
    expect(failedSpy).toHaveBeenCalled();

    await sp.stop();
  });

  it("emits 'restartFailed' when stop() races the auto-restart window, so waiters don't hang — #371", async () => {
    const sp = makeSp('sess:budget-race', 'api', agentConfig, gatewayConfig, sessionStore);
    await sp.start(); // real timers for the spawn + fs I/O

    // Switch to fake timers only for the restart-delay window. The timer's
    // stop-race branch does NOT call spawnProcess (stopping===true), so no fs
    // I/O runs under fake timers.
    jest.useFakeTimers();
    try {
      const restartFailedSpy = jest.fn();
      sp.on('restartFailed', restartFailedSpy);

      // Crash → scheduleRestart arms the 5s timer and marks a restart in flight.
      lastProcess!.emit('exit', 1, null);
      await Promise.resolve();
      expect(sp.isRestartScheduled()).toBe(true);

      // stop() races in before the timer fires (the child is already gone, so
      // stop() just sets stopping=true and returns).
      await sp.stop();

      // Timer fires into the stop-race branch: it must wake waiters, not clear
      // the flag silently (which previously left waitForSessionRestart to hang
      // for the full 20s timeout before rejecting).
      jest.advanceTimersByTime(5_000); // AUTO_RESTART_DELAY_MS
      await Promise.resolve();

      expect(restartFailedSpy).toHaveBeenCalledTimes(1);
      expect(sp.isRestartScheduled()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── resolveMaxHistoryMessages ────────────────────────────────────────────────

describe('resolveMaxHistoryMessages', () => {
  it('returns the per-agent value when set (overrides global)', () => {
    expect(resolveMaxHistoryMessages(30, 50)).toBe(30);
  });

  it('falls back to the global value when the agent value is undefined', () => {
    expect(resolveMaxHistoryMessages(undefined, 40)).toBe(40);
  });

  it('returns the default (MAX_HISTORY_MESSAGES) when both are undefined', () => {
    expect(resolveMaxHistoryMessages(undefined, undefined)).toBe(MAX_HISTORY_MESSAGES);
  });

  it('treats 0 as a valid value meaning "inject no history"', () => {
    expect(resolveMaxHistoryMessages(0, 50)).toBe(0);
  });

  it('ignores negative / non-finite values and falls through to the next level', () => {
    expect(resolveMaxHistoryMessages(-5, 40)).toBe(40);
    expect(resolveMaxHistoryMessages(NaN, 40)).toBe(40);
    expect(resolveMaxHistoryMessages(Infinity, 40)).toBe(40);
    expect(resolveMaxHistoryMessages(-1, undefined)).toBe(MAX_HISTORY_MESSAGES);
  });

  it('floors fractional values', () => {
    expect(resolveMaxHistoryMessages(30.9, 50)).toBe(30);
  });
});
