import { EventEmitter } from 'events';

// ── Mock child_process ─────────────────────────────────────────────────────────

interface MockStdio extends EventEmitter { }

interface MockChildProcess extends EventEmitter {
  stdout: MockStdio;
  stderr: MockStdio;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

let lastProcess: MockChildProcess | null = null;
const spawnCalls: { cmd: string; args: string[]; env: Record<string, string> }[] = [];

function makeMockProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 90000) + 10000;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = true;
    process.nextTick(() => proc.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  });
  lastProcess = proc;
  return proc;
}

jest.mock('child_process', () => ({
  spawn: jest.fn((cmd: string, args: string[], opts: any) => {
    spawnCalls.push({ cmd, args, env: opts?.env ?? {} });
    return makeMockProcess();
  }),
}));

jest.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { DiscordReceiver } from '../../src/discord/receiver';
import type { AgentConfig } from '../../src/types';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'test-agent',
    description: 'test',
    workspace: '/tmp/test-workspace',
    discord: { botToken: 'test-discord-token' },
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    ...overrides,
  } as AgentConfig;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DiscordReceiver', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    lastProcess = null;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('start()', () => {
    it('DR1: spawns bun with receiver-server.ts', () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      receiver.start();
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].cmd).toBe('bun');
      expect(spawnCalls[0].args[0]).toContain('receiver-server.ts');
    });

    it('DR2: passes DISCORD_BOT_TOKEN from agent config', () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      receiver.start();
      expect(spawnCalls[0].env['DISCORD_BOT_TOKEN']).toBe('test-discord-token');
    });

    it('DR3: passes DISCORD_STATE_DIR based on workspace', () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      receiver.start();
      expect(spawnCalls[0].env['DISCORD_STATE_DIR']).toBe('/tmp/test-workspace/.discord-state');
    });

    it('DR4: passes CLAUDE_CHANNEL_CALLBACK with correct port', () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 9090, '/tmp/logs');
      receiver.start();
      expect(spawnCalls[0].env['CLAUDE_CHANNEL_CALLBACK']).toBe('http://127.0.0.1:9090/channel');
    });

    it('DR5: passes GATEWAY_AGENT_ID', () => {
      const receiver = new DiscordReceiver(makeAgentConfig({ id: 'shadow' }), 8080, '/tmp/logs');
      receiver.start();
      expect(spawnCalls[0].env['GATEWAY_AGENT_ID']).toBe('shadow');
    });

    it('DR6: passes empty string when botToken is missing', () => {
      const cfg = makeAgentConfig();
      delete (cfg as any).discord;
      const receiver = new DiscordReceiver(cfg, 8080, '/tmp/logs');
      receiver.start();
      expect(spawnCalls[0].env['DISCORD_BOT_TOKEN']).toBe('');
    });
  });

  describe('isRunning()', () => {
    it('DR7: returns true after start', () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      receiver.start();
      expect(receiver.isRunning()).toBe(true);
    });

    it('DR8: returns false before start', () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      expect(receiver.isRunning()).toBe(false);
    });

    it('DR9: returns false after process exits and stop() was called', () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      receiver.start();
      receiver.stop();
      jest.runAllTimers();
      expect(receiver.isRunning()).toBe(false);
    });
  });

  describe('auto-restart', () => {
    it('DR10: restarts automatically after unexpected exit', async () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      receiver.start();
      expect(spawnCalls).toHaveLength(1);

      lastProcess!.emit('exit', 1, null);
      jest.advanceTimersByTime(6000);
      await Promise.resolve();

      expect(spawnCalls).toHaveLength(2);
    });

    it('DR11: stops restarting after MAX_RESTARTS (3)', async () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      receiver.start();

      for (let i = 0; i < 3; i++) {
        lastProcess!.emit('exit', 1, null);
        jest.advanceTimersByTime(6000);
        await Promise.resolve();
      }

      // 4th exit — no more restarts
      lastProcess!.emit('exit', 1, null);
      jest.advanceTimersByTime(6000);
      await Promise.resolve();

      expect(spawnCalls).toHaveLength(4); // 1 initial + 3 restarts
    });
  });

  describe('stop()', () => {
    it('DR12: kills the process', () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      receiver.start();
      const proc = lastProcess!;
      receiver.stop();
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('DR13: prevents auto-restart after stop', async () => {
      const receiver = new DiscordReceiver(makeAgentConfig(), 8080, '/tmp/logs');
      receiver.start();
      receiver.stop();

      lastProcess!.emit('exit', 0, 'SIGTERM');
      jest.advanceTimersByTime(6000);
      await Promise.resolve();

      expect(spawnCalls).toHaveLength(1);
    });
  });
});
