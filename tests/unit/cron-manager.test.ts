/**
 * Unit tests for CronManager
 *
 * T1-T4:   Schedule types (at / cron)
 * T6-T10:  Agent type payload
 * T11-T13: Telegram delivery (type=agent)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CronManager } from '../../src/cron/manager';
import { CronJobCreate, AgentConfig } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cron-test-'));
}

function makeRunner(response = 'agent ok') {
  return {
    sendApiMessage: jest.fn().mockResolvedValue({ text: response, attachments: [] }),
  };
}

function makeAgentConfig(
  agentId: string,
  botToken = 'bot-token-123',
  discordBotToken?: string,
): AgentConfig {
  return {
    id: agentId,
    description: 'test agent',
    workspace: '/tmp/workspace',
    env: '',
    telegram: {
      botToken,
    },
    ...(discordBotToken ? { discord: { botToken: discordBotToken } } : {}),
    claude: {
      model: 'claude-opus-4-6',
      dangerouslySkipPermissions: false,
      extraFlags: [],
    },
  };
}

function makeManager(opts: {
  agentId?: string;
  runner?: ReturnType<typeof makeRunner>;
  botToken?: string;
  discordBotToken?: string;
  tmpDir?: string;
} = {}) {
  const agentId = opts.agentId ?? 'test-agent';
  const tmpDir = opts.tmpDir ?? makeTmpDir();
  const agentRunners = new Map<string, any>();
  const agentConfigs = new Map<string, AgentConfig>();

  if (opts.runner) {
    agentRunners.set(agentId, opts.runner);
  }
  agentConfigs.set(
    agentId,
    makeAgentConfig(agentId, opts.botToken ?? 'bot-token-123', opts.discordBotToken),
  );

  const manager = new CronManager(
    { storePath: path.join(tmpDir, 'crons.json'), runsDir: path.join(tmpDir, 'runs') },
    agentRunners,
    agentConfigs,
    makeLogger(),
  );

  return { manager, tmpDir, agentId, agentRunners, agentConfigs };
}

// ─── T1-T5: Schedule types ────────────────────────────────────────────────────

describe('T1-T5: Schedule types', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('T1: at job schedules with setTimeout for future timestamp', async () => {
    jest.useFakeTimers();
    const { manager, agentId } = makeManager();
    await manager.start();

    const futureTs = new Date(Date.now() + 60_000).toISOString();
    const job = await manager.create({
      agentId,
      name: 'one-shot',
      scheduleKind: 'at',
      scheduleAt: futureTs,
      command: 'echo hi',
    });

    expect(job.scheduleKind).toBe('at');
    expect(job.scheduleAt).toBe(futureTs);
    expect(job.enabled).toBe(true);

    manager.stop();
  });

  it('T2: at job with past timestamp auto-disables after run', async () => {
    const tmpDir = makeTmpDir();
    const { manager, agentId } = makeManager({ tmpDir });
    await manager.start();

    // Use a signal file to know when exec completed
    const signalFile = path.join(tmpDir, 'at-ran.txt');
    const pastTs = new Date(Date.now() - 1000).toISOString();
    const job = await manager.create({
      agentId,
      name: 'past-shot',
      scheduleKind: 'at',
      scheduleAt: pastTs,
      command: `touch "${signalFile}"`,
    });

    // Poll until enabled=false (disableOrDeleteJob completed after exec)
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(signalFile) && manager.get(job.id)?.enabled === false) break;
    }

    expect(fs.existsSync(signalFile)).toBe(true);
    const updated = manager.get(job.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.state.runCount).toBe(1);

    manager.stop();
  }, 25000);

  it('T4: at job with invalid ISO string throws error', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    await expect(manager.create({
      agentId,
      name: 'bad-at',
      scheduleKind: 'at',
      scheduleAt: 'not-a-date',
      command: 'echo x',
    })).rejects.toThrow(/Invalid ISO-8601/);

    manager.stop();
  });

});

// ─── T6-T10: Agent type payload ───────────────────────────────────────────────

describe('T6-T10: Agent type payload', () => {
  it('T6: type=agent calls sendApiMessage on run', async () => {
    const runner = makeRunner('agent response text');
    const { manager, agentId } = makeManager({ runner, botToken: 'BOT' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'agent-job',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hello agent',
      telegram: '12345',
    });

    const log = await manager.run(job.id);

    expect(runner.sendApiMessage).toHaveBeenCalledWith(
      expect.stringContaining('cron-'),
      expect.stringContaining('cron-'),
      'hello agent',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(log.status).toBe('ok');
    expect(log.output).toContain('agent response text');

    manager.stop();
  });

  it('T7: agent response captured in runLog.output', async () => {
    const runner = makeRunner('my specific output');
    const { manager, agentId } = makeManager({ runner, botToken: 'BOT' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'capture-test',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'ping',
      telegram: '12345',
    });

    const log = await manager.run(job.id);
    expect(log.output).toBe('my specific output');

    manager.stop();
  });

  it('T8: sessionId defaults to cron-{jobId}', async () => {
    const runner = makeRunner();
    const { manager, agentId } = makeManager({ runner, botToken: 'BOT' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'session-default',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'test',
      telegram: '12345',
    });

    await manager.run(job.id);

    const [sessionId] = (runner.sendApiMessage as jest.Mock).mock.calls[0];
    expect(sessionId).toBe(`cron-${job.id}`);

    manager.stop();
  });

  it('T9: agent timeout → status=error', async () => {
    const runner = {
      sendApiMessage: jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
    };
    const { manager, agentId } = makeManager({ runner, botToken: 'BOT' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'timeout-job',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'slow prompt',
      telegram: '12345',
    });

    const log = await manager.run(job.id);
    expect(log.status).toBe('error');
    expect(log.error).toContain('timeout');

    manager.stop();
  });

  it('T10: type=command uses exec (not runner)', async () => {
    const runner = makeRunner();
    const { manager, agentId } = makeManager({ runner });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'command-regression',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      command: 'echo regression-ok',
    });

    const log = await manager.run(job.id);
    expect(log.status).toBe('ok');
    expect(log.output).toContain('regression-ok');
    expect(runner.sendApiMessage).not.toHaveBeenCalled();

    manager.stop();
  });
});

// ─── T-allowTools: agent tool policy is honored (regression for allow_tools bug) ─

describe('T-allowTools: cron honors the agent allow_tools setting', () => {
  async function runAgentJob(allowTools: boolean | undefined) {
    const runner = makeRunner('ok');
    const { manager, agentId, agentConfigs } = makeManager({ runner, botToken: 'BOT' });
    // Set the agent's tool policy the same way the UI toggle persists it to config.
    agentConfigs.get(agentId)!.allow_tools = allowTools;
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'tool-policy',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'do work',
      telegram: '12345',
    });

    await manager.run(job.id);
    const opts = (runner.sendApiMessage as jest.Mock).mock.calls[0][3];
    manager.stop();
    return opts;
  }

  it('forwards allowTools: true when agent.allow_tools is true', async () => {
    const opts = await runAgentJob(true);
    expect(opts).toEqual(expect.objectContaining({ allowTools: true }));
  });

  it('forwards allowTools: false when agent.allow_tools is false', async () => {
    const opts = await runAgentJob(false);
    expect(opts).toEqual(expect.objectContaining({ allowTools: false }));
  });

  it('defaults allowTools to false when agent.allow_tools is unset', async () => {
    const opts = await runAgentJob(undefined);
    expect(opts).toEqual(expect.objectContaining({ allowTools: false }));
  });
});

// ─── T11-T13: Telegram delivery ───────────────────────────────────────────────

describe('T11-T13: Telegram delivery', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '',
    } as Response);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('T11: type=agent + telegram → sends raw output to Telegram (no prefix)', async () => {
    const runner = makeRunner('สวัสดีครับ');
    const { manager, agentId } = makeManager({ runner, botToken: 'TOKEN123' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'deliver-test',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hello',
      telegram: '12345',
    });

    await manager.run(job.id);

    const telegramCall = fetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('/sendMessage'),
    );
    expect(telegramCall).toBeDefined();
    const body = JSON.parse(telegramCall![1].body);
    expect(body.chat_id).toBe('12345');
    expect(body.text).toBe('สวัสดีครับ');

    manager.stop();
  });

  it('T12: type=agent error → Telegram not called', async () => {
    const runner = {
      sendApiMessage: jest.fn().mockRejectedValue(new Error('agent failed')),
    };
    const { manager, agentId } = makeManager({ runner, botToken: 'TOKEN123' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'agent-error',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hi',
      telegram: '12345',
    });

    await manager.run(job.id);

    const telegramCall = fetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('/sendMessage'),
    );
    expect(telegramCall).toBeUndefined();

    manager.stop();
  });

  it('T13: Telegram API error → job status still ok, warn logged', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));

    const runner = makeRunner('ok');
    const logger = makeLogger();
    const agentId = 'test-agent';
    const tmpDir = makeTmpDir();
    const agentRunners = new Map<string, any>([[agentId, runner]]);
    const agentConfigs = new Map<string, AgentConfig>([[agentId, makeAgentConfig(agentId)]]);

    const manager = new CronManager(
      { storePath: path.join(tmpDir, 'crons.json'), runsDir: path.join(tmpDir, 'runs') },
      agentRunners,
      agentConfigs,
      logger,
    );
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'network-fail',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hi',
      telegram: '12345',
    });

    const log = await manager.run(job.id);
    expect(log.status).toBe('ok');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Telegram notify error'),
      expect.anything(),
    );

    manager.stop();
  });
});

// ─── T14-T19: Discord delivery ────────────────────────────────────────────────

describe('T14-T19: Discord delivery', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    } as Response);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('T14: fetch → 200, discord CHANNEL_123 → posts to channels API with Bot auth and output content', async () => {
    const runner = makeRunner('hello world');
    const { manager, agentId } = makeManager({ runner, discordBotToken: 'DISC123' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'discord-ok',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hi',
      discord: 'CHANNEL_123',
    });

    await manager.run(job.id);

    const discordCall = fetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('discord.com/api'),
    );
    expect(discordCall).toBeDefined();
    expect(discordCall![0]).toContain('/channels/CHANNEL_123/messages');
    const init = discordCall![1];
    const authHeader = (init.headers as Record<string, string>).Authorization;
    expect(authHeader.startsWith('Bot ')).toBe(true);
    expect(JSON.parse(init.body).content).toContain('hello world');

    manager.stop();
  });

  it('T15: runner throws → Discord fetch not called', async () => {
    const runner = {
      sendApiMessage: jest.fn().mockRejectedValue(new Error('agent failed')),
    };
    const { manager, agentId } = makeManager({ runner, discordBotToken: 'DISC123' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'discord-runner-fail',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hi',
      discord: 'CHANNEL_123',
    });

    await manager.run(job.id);

    const discordCall = fetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('discord.com/api'),
    );
    expect(discordCall).toBeUndefined();

    manager.stop();
  });

  it('T16: fetch → 500, runner succeeds → runLog.status=ok, warn logged with Discord failure info', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal server error',
    } as Response);

    const runner = makeRunner('ok');
    const logger = makeLogger();
    const agentId = 'test-agent';
    const tmpDir = makeTmpDir();
    const agentRunners = new Map<string, any>([[agentId, runner]]);
    const agentConfigs = new Map<string, AgentConfig>([
      [agentId, makeAgentConfig(agentId, 'bot-token-123', 'DISC')],
    ]);

    const manager = new CronManager(
      { storePath: path.join(tmpDir, 'crons.json'), runsDir: path.join(tmpDir, 'runs') },
      agentRunners,
      agentConfigs,
      logger,
    );
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'discord-500',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hi',
      discord: 'CHANNEL_123',
    });

    const log = await manager.run(job.id);
    expect(log.status).toBe('ok');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Discord notify failed'),
      expect.objectContaining({ channelId: 'CHANNEL_123' }),
    );

    manager.stop();
  });

  it('T17: output longer than 2000 chars → chunked into multiple Discord messages', async () => {
    const longText = 'a'.repeat(4500);
    const runner = makeRunner(longText);
    const { manager, agentId } = makeManager({ runner, discordBotToken: 'DISC' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'discord-chunked',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hi',
      discord: 'CHANNEL_123',
    });

    await manager.run(job.id);

    const discordCalls = fetchMock.mock.calls.filter((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('discord.com/api'),
    );
    // output truncated to 5000 chars in runLog, then split into <=2000-char chunks
    expect(discordCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of discordCalls) {
      const body = JSON.parse(call[1].body);
      expect(body.content.length).toBeLessThanOrEqual(2000);
    }

    manager.stop();
  });

  it('T18: missing Discord botToken → warn logged, no fetch call, status still ok', async () => {
    const runner = makeRunner('ok');
    const logger = makeLogger();
    const agentId = 'test-agent';
    const tmpDir = makeTmpDir();
    const agentRunners = new Map<string, any>([[agentId, runner]]);
    // agent config omits discord block → no botToken
    const agentConfigs = new Map<string, AgentConfig>([[agentId, makeAgentConfig(agentId)]]);

    const manager = new CronManager(
      { storePath: path.join(tmpDir, 'crons.json'), runsDir: path.join(tmpDir, 'runs') },
      agentRunners,
      agentConfigs,
      logger,
    );
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'no-token',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hi',
      discord: 'CHANNEL_123',
    });

    const log = await manager.run(job.id);
    expect(log.status).toBe('ok');

    const discordCall = fetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('discord.com/api'),
    );
    expect(discordCall).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no botToken'),
    );

    manager.stop();
  });

  it('T19: both telegram and discord → delivered independently; Discord failure does not block Telegram', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('discord.com/api')) {
        return Promise.reject(new Error('discord down'));
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => '' } as Response);
    });

    const runner = makeRunner('both');
    const { manager, agentId } = makeManager({ runner, discordBotToken: 'DISC' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'both-channels',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      type: 'agent',
      prompt: 'hi',
      telegram: '12345',
      discord: 'CHANNEL_123',
    });

    const log = await manager.run(job.id);
    expect(log.status).toBe('ok');

    const telegramCall = fetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('/sendMessage'),
    );
    const discordCall = fetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('discord.com/api'),
    );
    expect(telegramCall).toBeDefined();
    expect(discordCall).toBeDefined();

    manager.stop();
  });
});

// ─── Fix 1 regression tests ──────────────────────────────────────────────────

describe('Fix 1: at-job does not re-fire when lastRunAt is already set', () => {
  function writeStore(storePath: string, job: Record<string, unknown>) {
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, jobs: [job] }, null, 2));
  }

  function makeAtJobStore(overrides: Record<string, unknown>) {
    const pastTs = new Date(Date.now() - 5000).toISOString();
    return {
      id: 'test-at-' + Math.random().toString(36).slice(2),
      agentId: 'test-agent',
      name: 'test-at-job',
      scheduleKind: 'at',
      scheduleAt: pastTs,
      command: 'echo hi',
      type: 'command',
      enabled: true,
      deleteAfterRun: false,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
      state: {
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        runCount: 0,
        consecutiveErrors: 0,
      },
      ...overrides,
    };
  }

  it('Fix1-1: at job with lastRunAt set should not re-fire on start', async () => {
    const tmpDir = makeTmpDir();
    const storePath = path.join(tmpDir, 'crons.json');
    const runsDir = path.join(tmpDir, 'runs');
    const signalFile = path.join(tmpDir, 'refire.txt');

    const jobBase = makeAtJobStore({
      command: `touch "${signalFile}"`,
      state: {
        lastRunAt: Date.now() - 5000,
        lastStatus: 'ok',
        lastError: null,
        runCount: 1,
        consecutiveErrors: 0,
      },
    });
    writeStore(storePath, jobBase);

    const logger = makeLogger();
    const agentRunners = new Map<string, any>();
    const agentConfigs = new Map<string, AgentConfig>();
    agentConfigs.set('test-agent', makeAgentConfig('test-agent'));
    const manager = new CronManager({ storePath, runsDir }, agentRunners, agentConfigs, logger);

    await manager.start();
    await new Promise((r) => setTimeout(r, 300));

    expect(fs.existsSync(signalFile)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('already ran'),
      expect.anything()
    );

    manager.stop();
  });

  it('Fix1-2: at job with lastRunAt set should be disabled after cleanup on start', async () => {
    const tmpDir = makeTmpDir();
    const storePath = path.join(tmpDir, 'crons.json');
    const runsDir = path.join(tmpDir, 'runs');

    const jobBase = makeAtJobStore({
      state: {
        lastRunAt: Date.now() - 5000,
        lastStatus: 'ok',
        lastError: null,
        runCount: 1,
        consecutiveErrors: 0,
      },
    });
    writeStore(storePath, jobBase);

    const agentRunners = new Map<string, any>();
    const agentConfigs = new Map<string, AgentConfig>();
    agentConfigs.set('test-agent', makeAgentConfig('test-agent'));
    const manager = new CronManager({ storePath, runsDir }, agentRunners, agentConfigs, makeLogger());

    await manager.start();
    await new Promise((r) => setTimeout(r, 300));

    const job = manager.get(jobBase.id as string);
    expect(job?.enabled).toBe(false);

    manager.stop();
  });

  it('Fix1-3: at job with lastRunAt=null and past scheduleAt fires normally', async () => {
    const tmpDir = makeTmpDir();
    const storePath = path.join(tmpDir, 'crons.json');
    const runsDir = path.join(tmpDir, 'runs');
    const signalFile = path.join(tmpDir, 'ran.txt');

    const jobBase = makeAtJobStore({
      command: `touch "${signalFile}"`,
      state: {
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        runCount: 0,
        consecutiveErrors: 0,
      },
    });
    writeStore(storePath, jobBase);

    const agentRunners = new Map<string, any>();
    const agentConfigs = new Map<string, AgentConfig>();
    agentConfigs.set('test-agent', makeAgentConfig('test-agent'));
    const manager = new CronManager({ storePath, runsDir }, agentRunners, agentConfigs, makeLogger());

    await manager.start();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !fs.existsSync(signalFile)) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(fs.existsSync(signalFile)).toBe(true);

    manager.stop();
  }, 10000);
});

// ─── Fix 2 regression tests ──────────────────────────────────────────────────

describe('Fix 2: catchUpMissedJobs uses cron-parser to detect genuine missed ticks', () => {
  function writeCronStore(storePath: string, job: Record<string, unknown>) {
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, jobs: [job] }, null, 2));
  }

  function makeCronJobStore(overrides: Record<string, unknown>) {
    return {
      id: 'test-cron-' + Math.random().toString(36).slice(2),
      agentId: 'test-agent',
      name: 'test-cron-job',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      command: 'echo hi',
      type: 'command',
      enabled: true,
      deleteAfterRun: false,
      createdAt: Date.now() - 200000,
      updatedAt: Date.now() - 200000,
      state: {
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        runCount: 0,
        consecutiveErrors: 0,
      },
      ...overrides,
    };
  }

  it('Fix2-1: cron job with lastRunAt before last expected tick triggers catch-up', async () => {
    const tmpDir = makeTmpDir();
    const storePath = path.join(tmpDir, 'crons.json');
    const runsDir = path.join(tmpDir, 'runs');
    const signalFile = path.join(tmpDir, 'caught-up.txt');

    const twoMinAgo = Date.now() - 2 * 60 * 1000;
    const jobBase = makeCronJobStore({
      command: `touch "${signalFile}"`,
      state: {
        lastRunAt: twoMinAgo,
        lastStatus: 'ok',
        lastError: null,
        runCount: 5,
        consecutiveErrors: 0,
      },
    });
    writeCronStore(storePath, jobBase);

    const agentRunners = new Map<string, any>();
    const agentConfigs = new Map<string, AgentConfig>();
    agentConfigs.set('test-agent', makeAgentConfig('test-agent'));
    const manager = new CronManager({ storePath, runsDir }, agentRunners, agentConfigs, makeLogger());

    await manager.start();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !fs.existsSync(signalFile)) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(fs.existsSync(signalFile)).toBe(true);

    manager.stop();
  }, 15000);

  it('Fix2-2: cron job with lastRunAt after last expected tick does not catch up', async () => {
    const tmpDir = makeTmpDir();
    const storePath = path.join(tmpDir, 'crons.json');
    const runsDir = path.join(tmpDir, 'runs');
    const signalFile = path.join(tmpDir, 'no-catchup.txt');

    const jobBase = makeCronJobStore({
      command: `touch "${signalFile}"`,
      state: {
        lastRunAt: Date.now(),
        lastStatus: 'ok',
        lastError: null,
        runCount: 10,
        consecutiveErrors: 0,
      },
    });
    writeCronStore(storePath, jobBase);

    const agentRunners = new Map<string, any>();
    const agentConfigs = new Map<string, AgentConfig>();
    agentConfigs.set('test-agent', makeAgentConfig('test-agent'));
    const manager = new CronManager({ storePath, runsDir }, agentRunners, agentConfigs, makeLogger());

    await manager.start();
    await new Promise((r) => setTimeout(r, 500));

    expect(fs.existsSync(signalFile)).toBe(false);

    manager.stop();
  });

  it('Fix2-3: cron job that never ran (lastRunAt=null) does not trigger catch-up', async () => {
    const tmpDir = makeTmpDir();
    const storePath = path.join(tmpDir, 'crons.json');
    const runsDir = path.join(tmpDir, 'runs');
    const signalFile = path.join(tmpDir, 'never-ran.txt');

    const jobBase = makeCronJobStore({
      command: `touch "${signalFile}"`,
      state: {
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        runCount: 0,
        consecutiveErrors: 0,
      },
    });
    writeCronStore(storePath, jobBase);

    const agentRunners = new Map<string, any>();
    const agentConfigs = new Map<string, AgentConfig>();
    agentConfigs.set('test-agent', makeAgentConfig('test-agent'));
    const manager = new CronManager({ storePath, runsDir }, agentRunners, agentConfigs, makeLogger());

    await manager.start();
    await new Promise((r) => setTimeout(r, 500));

    expect(fs.existsSync(signalFile)).toBe(false);

    manager.stop();
  });
});

// ─── TZ1-TZ6: Per-job timezone (#225) ─────────────────────────────────────────

describe('TZ1-TZ6: Per-job timezone', () => {
  // Spy on the shared node-cron module instance the manager imports, so we can
  // assert the timezone option handed to nodeCron.schedule without waiting on
  // real timers. spyOn calls through by default, so manager.stop() still cleans
  // the created tasks up.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCron = require('node-cron');
  let scheduleSpy: jest.SpyInstance;

  beforeEach(() => {
    scheduleSpy = jest.spyOn(nodeCron, 'schedule');
  });
  afterEach(() => {
    scheduleSpy.mockRestore();
  });

  it('TZ1: cron job with a timezone is scheduled in that zone', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'tz-job',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 'Asia/Bangkok',
      command: 'echo hi',
    });

    expect(job.timezone).toBe('Asia/Bangkok');
    expect(scheduleSpy).toHaveBeenCalledWith(
      '0 9 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: 'Asia/Bangkok' }),
    );

    manager.stop();
  });

  it('TZ2: cron job without a timezone defaults to UTC', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'no-tz-job',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      command: 'echo hi',
    });

    expect(job.timezone).toBeUndefined();
    expect(scheduleSpy).toHaveBeenCalledWith(
      '0 9 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: 'UTC' }),
    );

    manager.stop();
  });

  it('TZ3: an invalid IANA timezone is rejected on create', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    await expect(manager.create({
      agentId,
      name: 'bad-tz',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 'Not/AZone',
      command: 'echo x',
    })).rejects.toThrow(/Invalid timezone/);

    manager.stop();
  });

  it('TZ4: update persists the timezone and reschedules in the new zone', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'tz-update',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 'UTC',
      command: 'echo hi',
    });

    scheduleSpy.mockClear();
    const updated = await manager.update(job.id, { timezone: 'America/New_York' });

    expect(updated.timezone).toBe('America/New_York');
    expect(scheduleSpy).toHaveBeenCalledWith(
      '0 9 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: 'America/New_York' }),
    );

    manager.stop();
  });

  it('TZ5: update to an invalid timezone is rejected', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'tz-bad-update',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      command: 'echo hi',
    });

    await expect(manager.update(job.id, { timezone: 'Mars/Phobos' }))
      .rejects.toThrow(/Invalid timezone/);

    manager.stop();
  });

  it('TZ6: timezone survives a store reload (persistence)', async () => {
    const tmpDir = makeTmpDir();
    const { manager, agentId } = makeManager({ tmpDir });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'tz-persist',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 'Europe/London',
      command: 'echo hi',
    });
    manager.stop();

    // Fresh manager reading the same store file must recover the timezone.
    const { manager: manager2 } = makeManager({ tmpDir });
    await manager2.start();
    expect(manager2.get(job.id)?.timezone).toBe('Europe/London');
    manager2.stop();
  });
});

// ─── TZ7-TZ15: Additional timezone edge cases (#225 hardening) ────────────────

describe('TZ7-TZ15: Additional timezone edge cases', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCron = require('node-cron');
  let scheduleSpy: jest.SpyInstance;

  beforeEach(() => {
    scheduleSpy = jest.spyOn(nodeCron, 'schedule');
  });
  afterEach(() => {
    scheduleSpy.mockRestore();
  });

  it('TZ7: an empty-string timezone is rejected on create', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    await expect(manager.create({
      agentId,
      name: 'empty-tz',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: '',
      command: 'echo hi',
    })).rejects.toThrow(/non-empty time zone/);

    manager.stop();
  });

  it('TZ8: a lower-cased zone name is accepted (Intl resolves it case-insensitively, matching node-cron\'s own check)', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'lowercase-tz',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 'asia/bangkok',
      command: 'echo hi',
    });

    expect(job.timezone).toBe('asia/bangkok');
    expect(scheduleSpy).toHaveBeenCalledWith(
      '0 9 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: 'asia/bangkok' }),
    );

    manager.stop();
  });

  it('TZ9: a fixed-offset zone identifier ("+07:00") is accepted AND scheduled with that offset (Intl treats it as a valid time zone, not just IANA names)', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'offset-tz',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: '+07:00',
      command: 'echo hi',
    });

    expect(job.timezone).toBe('+07:00');
    // End-to-end: the offset must reach nodeCron.schedule, not just pass create()
    // validation — proves the accepted-set claim holds through the scheduling path.
    expect(scheduleSpy).toHaveBeenCalledWith(
      '0 9 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: '+07:00' }),
    );

    manager.stop();
  });

  it('TZ10: a whitespace-padded zone name is rejected', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    await expect(manager.create({
      agentId,
      name: 'padded-tz',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: ' Asia/Bangkok ',
      command: 'echo hi',
    })).rejects.toThrow(/Invalid timezone/);

    manager.stop();
  });

  it('TZ11: an at-job with a bogus timezone value is accepted (timezone validation only applies to scheduleKind=cron)', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const futureTs = new Date(Date.now() + 60_000).toISOString();
    const job = await manager.create({
      agentId,
      name: 'at-with-garbage-tz',
      scheduleKind: 'at',
      scheduleAt: futureTs,
      timezone: 'Not/AZone',
      command: 'echo hi',
    });

    expect(job.timezone).toBe('Not/AZone');
    expect(scheduleSpy).not.toHaveBeenCalled();

    manager.stop();
  });

  it('TZ12: an explicit null timezone on update is rejected, not silently ignored', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'tz-null-update',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 'UTC',
      command: 'echo hi',
    });

    // Simulates a JSON API caller sending `"timezone": null` — not reachable through
    // the CronJobUpdate TS type, but valid at the HTTP/JSON boundary.
    await expect(manager.update(job.id, { timezone: null as unknown as string }))
      .rejects.toThrow(/non-empty time zone/);

    // Rejected update must not have clobbered the previously-valid timezone.
    expect(manager.get(job.id)?.timezone).toBe('UTC');

    manager.stop();
  });

  it('TZ13: updating an unrelated field preserves and re-applies the existing timezone', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'tz-untouched',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 'Asia/Tokyo',
      command: 'echo hi',
    });

    scheduleSpy.mockClear();
    const updated = await manager.update(job.id, { name: 'renamed' });

    expect(updated.timezone).toBe('Asia/Tokyo');
    expect(scheduleSpy).toHaveBeenCalledWith(
      '0 9 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: 'Asia/Tokyo' }),
    );

    manager.stop();
  });

  it('TZ14: two concurrent jobs in different zones do not leak timezone across schedules', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    await manager.create({
      agentId,
      name: 'job-bkk',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 'Asia/Bangkok',
      command: 'echo bkk',
    });

    await manager.create({
      agentId,
      name: 'job-nyc',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 'America/New_York',
      command: 'echo nyc',
    });

    expect(scheduleSpy).toHaveBeenNthCalledWith(
      1,
      '0 9 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: 'Asia/Bangkok' }),
    );
    expect(scheduleSpy).toHaveBeenNthCalledWith(
      2,
      '0 9 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: 'America/New_York' }),
    );

    manager.stop();
  });

  it('TZ15: a non-string timezone value (e.g. a number from a malformed request body) is rejected cleanly, not a raw TypeError', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    await expect(manager.create({
      agentId,
      name: 'numeric-tz',
      scheduleKind: 'cron',
      schedule: '0 9 * * *',
      timezone: 7 as unknown as string,
      command: 'echo hi',
    })).rejects.toThrow(/Invalid timezone/);

    manager.stop();
  });
});

// ─── TZ-GAP: catch-up after restart does not honor per-job timezone ──────────
//
// Found while writing coverage for #225: catchUpMissedJobs() (src/cron/manager.ts)
// parses the cron expression with `CronExpressionParser.parse(job.schedule!, { currentDate })`
// and never forwards `job.timezone`. cron-parser accepts a `tz` option (see
// node_modules/cron-parser/dist/types/CronExpression.d.ts) — without it, "last expected
// tick" is computed in the process's local/UTC time, not the job's zone. A restart shortly
// after a scheduled fire time in a non-UTC zone can therefore mis-detect a missed run (false
// catch-up, or a genuine miss going uncaught) even though live scheduling (scheduleJob) is
// correctly zone-aware via node-cron.
//
// FIXED: catchUpMissedJobs() now forwards `tz: job.timezone ?? 'UTC'` to the parser, matching
// scheduleJob()'s node-cron {timezone} default. This test locks that behavior in.
describe('TZ-GAP: catchUpMissedJobs should honor job.timezone', () => {
  it('forwards the job\'s timezone to CronExpressionParser.parse during startup catch-up', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CronExpressionParser } = require('cron-parser');
    const parseSpy = jest.spyOn(CronExpressionParser, 'parse');

    const tmpDir = makeTmpDir();
    const storePath = path.join(tmpDir, 'crons.json');
    const runsDir = path.join(tmpDir, 'runs');

    const twoMinAgo = Date.now() - 2 * 60 * 1000;
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      jobs: [{
        id: 'tz-gap-job',
        agentId: 'test-agent',
        name: 'tz-gap-job',
        scheduleKind: 'cron',
        schedule: '* * * * *',
        timezone: 'Asia/Bangkok',
        command: 'echo hi',
        type: 'command',
        enabled: true,
        deleteAfterRun: false,
        createdAt: Date.now() - 200000,
        updatedAt: Date.now() - 200000,
        state: {
          lastRunAt: twoMinAgo,
          lastStatus: 'ok',
          lastError: null,
          runCount: 5,
          consecutiveErrors: 0,
        },
      }],
    }, null, 2));

    const agentRunners = new Map<string, any>();
    const agentConfigs = new Map<string, AgentConfig>();
    agentConfigs.set('test-agent', makeAgentConfig('test-agent'));
    const manager = new CronManager({ storePath, runsDir }, agentRunners, agentConfigs, makeLogger());

    await manager.start();

    expect(parseSpy).toHaveBeenCalledWith(
      '* * * * *',
      expect.objectContaining({ tz: 'Asia/Bangkok' }),
    );

    parseSpy.mockRestore();
    manager.stop();
  });
});
