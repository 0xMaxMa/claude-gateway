/**
 * Unit tests for CronManager (Planning-27: Agent Integration & OpenClaw Feature Parity)
 *
 * T1-T5:   Schedule types (at / every / cron)
 * T6-T10:  Agent turn payload
 * T11-T15: Delivery (notify)
 * T16-T20: Failure alert
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
      payloadKind: 'command',
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
      payloadKind: 'command',
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

  it('T3: every job schedules with setInterval', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'interval-job',
      scheduleKind: 'every',
      everyMs: 5000,
      payloadKind: 'command',
      command: 'echo interval',
    });

    expect(job.scheduleKind).toBe('every');
    expect(job.everyMs).toBe(5000);

    manager.stop();
  });

  it('T4: at job with invalid ISO string throws error', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    await expect(manager.create({
      agentId,
      name: 'bad-at',
      scheduleKind: 'at',
      scheduleAt: 'not-a-date',
      payloadKind: 'command',
      command: 'echo x',
    })).rejects.toThrow(/Invalid ISO-8601/);

    manager.stop();
  });

  it('T5: every job with everyMs <= 0 throws error', async () => {
    const { manager, agentId } = makeManager();
    await manager.start();

    await expect(manager.create({
      agentId,
      name: 'bad-every',
      scheduleKind: 'every',
      everyMs: -1,
      payloadKind: 'command',
      command: 'echo x',
    })).rejects.toThrow(/positive/);

    manager.stop();
  });
});

// ─── T6-T10: Agent turn payload ───────────────────────────────────────────────

describe('T6-T10: Agent turn payload', () => {
  it('T6: agentTurn job calls sendApiMessage on run', async () => {
    const runner = makeRunner('agent response text');
    const { manager, agentId } = makeManager({ runner });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'agent-job',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'agentTurn',
      agentTurnMessage: 'hello agent',
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
    const { manager, agentId } = makeManager({ runner });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'capture-test',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'agentTurn',
      agentTurnMessage: 'ping',
    });

    const log = await manager.run(job.id);
    expect(log.output).toBe('my specific output');

    manager.stop();
  });

  it('T8: agentTurnSessionId defaults to cron-{jobId}', async () => {
    const runner = makeRunner();
    const { manager, agentId } = makeManager({ runner });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'session-default',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'agentTurn',
      agentTurnMessage: 'test',
      // no agentTurnSessionId
    });

    await manager.run(job.id);

    const [sessionId] = (runner.sendApiMessage as jest.Mock).mock.calls[0];
    expect(sessionId).toBe(`cron-${job.id}`);

    manager.stop();
  });

  it('T9: agentTurn timeout → status=error', async () => {
    const runner = {
      sendApiMessage: jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
    };
    const { manager, agentId } = makeManager({ runner });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'timeout-job',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'agentTurn',
      agentTurnMessage: 'slow prompt',
    });

    const log = await manager.run(job.id);
    expect(log.status).toBe('error');
    expect(log.error).toContain('timeout');

    manager.stop();
  });

  it('T10: payloadKind=command still uses exec (regression)', async () => {
    const runner = makeRunner();
    const { manager, agentId } = makeManager({ runner });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'command-regression',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'command',
      command: 'echo regression-ok',
    });

    const log = await manager.run(job.id);
    expect(log.status).toBe('ok');
    expect(log.output).toContain('regression-ok');
    // runner should NOT have been called
    expect(runner.sendApiMessage).not.toHaveBeenCalled();

    manager.stop();
  });
});

// ─── T11-T15: Delivery (notify) ───────────────────────────────────────────────

describe('T11-T15: Delivery (notify)', () => {
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

  it('T11: success + notify.telegram → fetch with ✅', async () => {
    const runner = makeRunner('done');
    const { manager, agentId } = makeManager({ runner, botToken: 'TOKEN123' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'notify-success',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'agentTurn',
      agentTurnMessage: 'hi',
      notify: { telegram: '12345' },
    });

    await manager.run(job.id);

    const telegramCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('sendMessage'),
    );
    expect(telegramCalls.length).toBe(1);
    const body = JSON.parse(telegramCalls[0][1].body);
    expect(body.chat_id).toBe('12345');
    expect(body.text).toContain('✅');

    manager.stop();
  });

  it('T12: error + notify.telegram → fetch with ❌', async () => {
    const runner = {
      sendApiMessage: jest.fn().mockRejectedValue(new Error('agent failed')),
    };
    const { manager, agentId } = makeManager({ runner, botToken: 'TOKEN123' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'notify-error',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'agentTurn',
      agentTurnMessage: 'hi',
      notify: { telegram: '99999' },
    });

    await manager.run(job.id);

    const telegramCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('sendMessage'),
    );
    expect(telegramCalls.length).toBe(1);
    const body = JSON.parse(telegramCalls[0][1].body);
    expect(body.text).toContain('❌');

    manager.stop();
  });

  it('T13: onSuccess=false + success → Telegram not called', async () => {
    const runner = makeRunner('ok');
    const { manager, agentId } = makeManager({ runner, botToken: 'TOKEN123' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'no-success-notify',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'agentTurn',
      agentTurnMessage: 'hi',
      notify: { telegram: '12345', onSuccess: false },
    });

    await manager.run(job.id);

    const telegramCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('sendMessage'),
    );
    expect(telegramCalls.length).toBe(0);

    manager.stop();
  });

  it('T14: notify.webhook → fetch POST with JSON body', async () => {
    const runner = makeRunner('webhook-output');
    const { manager, agentId } = makeManager({ runner });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'webhook-job',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'agentTurn',
      agentTurnMessage: 'hi',
      notify: { webhook: 'https://hooks.example.com/test' },
    });

    await manager.run(job.id);

    const webhookCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('hooks.example.com'),
    );
    expect(webhookCalls.length).toBe(1);
    const [, opts] = webhookCalls[0];
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.status).toBe('ok');
    expect(body.output).toBe('webhook-output');

    manager.stop();
  });

  it('T15: Telegram API error → job status still ok, warn logged', async () => {
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
      payloadKind: 'agentTurn',
      agentTurnMessage: 'hi',
      notify: { telegram: '12345' },
    });

    const log = await manager.run(job.id);
    expect(log.status).toBe('ok'); // job itself succeeded
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Telegram notify error'),
      expect.anything(),
    );

    manager.stop();
  });
});

// ─── T16-T20: Failure alert ───────────────────────────────────────────────────

describe('T16-T20: Failure alert', () => {
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

  async function makeFailingJob(manager: CronManager, agentId: string, alertAfter = 3) {
    return manager.create({
      agentId,
      name: 'failing-job',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'command',
      command: 'exit 1',
      failureAlert: { after: alertAfter, telegram: '55555' },
    });
  }

  it('T16: 3rd error triggers alert when failureAlert.after=3', async () => {
    const { manager, agentId } = makeManager({ botToken: 'TOKEN' });
    await manager.start();

    const job = await makeFailingJob(manager, agentId, 3);

    // Force 3 consecutive errors
    for (let i = 0; i < 3; i++) {
      await manager.run(job.id).catch(() => {});
    }

    const alertCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('sendMessage'),
    );
    expect(alertCalls.length).toBe(1);
    const body = JSON.parse(alertCalls[0][1].body);
    expect(body.text).toContain('⚠️');
    expect(body.text).toContain('3 times');

    manager.stop();
  });

  it('T17: 2nd error does not trigger alert when failureAlert.after=3', async () => {
    const { manager, agentId } = makeManager({ botToken: 'TOKEN' });
    await manager.start();

    const job = await makeFailingJob(manager, agentId, 3);

    for (let i = 0; i < 2; i++) {
      await manager.run(job.id).catch(() => {});
    }

    const alertCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('sendMessage'),
    );
    expect(alertCalls.length).toBe(0);

    manager.stop();
  });

  it('T18: alert within cooldown is not sent again', async () => {
    const { manager, agentId } = makeManager({ botToken: 'TOKEN' });
    await manager.start();

    const job = await makeFailingJob(manager, agentId, 1);

    // First error → alert
    await manager.run(job.id).catch(() => {});
    // Second error → within cooldown, no second alert
    await manager.run(job.id).catch(() => {});

    const alertCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('sendMessage'),
    );
    expect(alertCalls.length).toBe(1);

    manager.stop();
  });

  it('T19: alert is sent again after cooldown expires', async () => {
    const { manager, agentId } = makeManager({ botToken: 'TOKEN' });
    await manager.start();

    const job = await manager.create({
      agentId,
      name: 'cooldown-expired',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'command',
      command: 'exit 1',
      failureAlert: { after: 1, telegram: '55555', cooldownMs: 1 }, // 1ms cooldown
    });

    await manager.run(job.id).catch(() => {});
    // Wait for cooldown (1ms)
    await new Promise((r) => setTimeout(r, 10));
    await manager.run(job.id).catch(() => {});

    const alertCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('sendMessage'),
    );
    expect(alertCalls.length).toBe(2);

    manager.stop();
  });

  it('T20: success after error resets consecutiveErrors', async () => {
    const { manager, agentId } = makeManager({ botToken: 'TOKEN' });
    await manager.start();

    // Create a job that initially fails then succeeds
    const job = await manager.create({
      agentId,
      name: 'recover-job',
      scheduleKind: 'cron',
      schedule: '* * * * *',
      payloadKind: 'command',
      command: 'exit 1',
      failureAlert: { after: 2, telegram: '55555' },
    });

    // Fail once
    await manager.run(job.id).catch(() => {});
    expect(manager.get(job.id)!.state.consecutiveErrors).toBe(1);

    // Change command to succeed
    await manager.update(job.id, { command: 'echo ok' });
    await manager.run(job.id);

    expect(manager.get(job.id)!.state.consecutiveErrors).toBe(0);

    manager.stop();
  });
});
