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
import { CronManager } from '../../src/cron-manager';
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
    sendApiMessage: jest.fn().mockResolvedValue(response),
  };
}

function makeAgentConfig(agentId: string, botToken = 'bot-token-123'): AgentConfig {
  return {
    id: agentId,
    description: 'test agent',
    workspace: '/tmp/workspace',
    env: '',
    telegram: {
      botToken,
      allowedUsers: [],
      dmPolicy: 'allowlist',
    },
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
  tmpDir?: string;
} = {}) {
  const agentId = opts.agentId ?? 'test-agent';
  const tmpDir = opts.tmpDir ?? makeTmpDir();
  const agentRunners = new Map<string, any>();
  const agentConfigs = new Map<string, AgentConfig>();

  if (opts.runner) {
    agentRunners.set(agentId, opts.runner);
  }
  agentConfigs.set(agentId, makeAgentConfig(agentId, opts.botToken ?? 'bot-token-123'));

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
