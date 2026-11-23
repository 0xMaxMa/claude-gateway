/**
 * Unit tests for CronScheduler (Phase 3).
 *
 * These tests use a mock AgentRunner (EventEmitter with sendMessage) so that
 * no real subprocess is spawned and cron ticks are driven via triggerTask().
 */

import { EventEmitter } from 'events';
import { CronScheduler } from '../../src/cron/scheduler';
import { HeartbeatHistory } from '../../src/heartbeat/history';
import { AgentConfig, GatewayConfig, HeartbeatResult } from '../../src/types';
import { AgentRunner } from '../../src/agent/runner';

// ─── helpers ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'test-agent';

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function makeAgentConfig(rateLimitMinutes?: number): AgentConfig {
  return {
    id: AGENT_ID,
    description: 'test',
    workspace: '/tmp/ws',
    env: '',
    telegram: { botToken: 'token' },
    claude: { model: 'test', dangerouslySkipPermissions: false, extraFlags: [] },
    ...(rateLimitMinutes !== undefined ? { heartbeat: { rateLimitMinutes } } : {}),
  };
}

/**
 * Build a mock AgentRunner that responds to every sendMessage() with the given
 * response string emitted on 'output', with an optional delay.
 */
function makeMockRunner(response: string, delayMs = 5): AgentRunner {
  const emitter = new EventEmitter() as AgentRunner;
  (emitter as unknown as Record<string, unknown>).isRunning = () => true;
  emitter.sendMessage = (msg: string) => {
    setTimeout(() => emitter.emit('output', response + ' for: ' + msg), delayMs);
  };
  return emitter;
}

const HEARTBEAT_CONTENT = `tasks:
  - name: morning-brief
    cron: "0 8 * * *"
    prompt: "Give Max a morning summary."
  - name: idle-checkin
    cron: "0 */2 * * *"
    prompt: "Any updates?"
`;

const SINGLE_TASK_CONTENT = `tasks:
  - name: morning-brief
    cron: "0 8 * * *"
    prompt: "Give Max a morning summary."
`;

// Make sure NODE_ENV is 'test' for triggerTask() support
// Use a very short response timeout so unit tests don't wait 60s
beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS = '100';
});

afterAll(() => {
  delete process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS;
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe('CronScheduler (unit)', () => {
  // ── load() with valid content schedules tasks ───────────────────────────
  it('load() with valid heartbeat content schedules tasks', () => {
    const runner = makeMockRunner('ok');
    const logger = makeLogger();
    const config = makeAgentConfig();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config);

    scheduler.load(HEARTBEAT_CONTENT);

    // triggerTask() works only if taskDefs were populated
    expect(() => scheduler.triggerTask('nonexistent')).rejects.toThrow();

    // Should not throw for valid task names
    expect(scheduler.triggerTask('morning-brief')).resolves.toBeUndefined();

    scheduler.stop();
  });

  // ── load() replaces old schedule on reload (no duplicate firing) ────────
  it('load() replaces old schedule on reload — no duplicate tasks', async () => {
    const sentMessages: string[] = [];
    const runner = new EventEmitter() as AgentRunner;
    (runner as unknown as Record<string, unknown>).isRunning = () => true;
    runner.sendMessage = (msg: string) => {
      sentMessages.push(msg);
      setTimeout(() => runner.emit('output', 'response'), 5);
    };

    const logger = makeLogger();
    const config = makeAgentConfig();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config);

    scheduler.load(SINGLE_TASK_CONTENT);
    // Reload with same content — should replace, not add
    scheduler.load(SINGLE_TASK_CONTENT);

    await scheduler.triggerTask('morning-brief');
    // Only one message should have been sent (not two duplicates)
    expect(sentMessages).toHaveLength(1);

    scheduler.stop();
  });

  // ── HEARTBEAT_OK response → suppressed=true ──────────────────────────────
  it('HEARTBEAT_OK response → HeartbeatResult.suppressed is true', async () => {
    const runner = makeMockRunner('HEARTBEAT_OK');
    const logger = makeLogger();
    const config = makeAgentConfig();
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config, history);

    scheduler.load(SINGLE_TASK_CONTENT);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    await scheduler.triggerTask('morning-brief');

    expect(results).toHaveLength(1);
    expect(results[0].suppressed).toBe(true);
    expect(results[0].rateLimited).toBe(false);
    expect(results[0].taskName).toBe('morning-brief');

    scheduler.stop();
  });

  it('lowercase heartbeat_ok is also detected (case-insensitive)', async () => {
    const runner = makeMockRunner('heartbeat_ok — all clear');
    const logger = makeLogger();
    const config = makeAgentConfig();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config);

    scheduler.load(SINGLE_TASK_CONTENT);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    await scheduler.triggerTask('morning-brief');
    expect(results[0].suppressed).toBe(true);

    scheduler.stop();
  });

  // ── Non-HEARTBEAT_OK response → suppressed=false ─────────────────────────
  it('Non-HEARTBEAT_OK response → HeartbeatResult.suppressed is false', async () => {
    const runner = makeMockRunner('Good morning! Here is your summary.');
    const logger = makeLogger();
    const config = makeAgentConfig();
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config, history);

    scheduler.load(SINGLE_TASK_CONTENT);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    await scheduler.triggerTask('morning-brief');

    expect(results).toHaveLength(1);
    expect(results[0].suppressed).toBe(false);
    expect(results[0].rateLimited).toBe(false);

    scheduler.stop();
  });

  // ── Rate limit: second task within window → rateLimited=true ────────────
  it('rate limit: second task within window → rateLimited=true', async () => {
    const runner = makeMockRunner('HEARTBEAT_OK');
    const logger = makeLogger();
    // 30 minute rate limit (default)
    const config = makeAgentConfig(30);
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config, history);

    scheduler.load(SINGLE_TASK_CONTENT);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    // First run — should succeed
    await scheduler.triggerTask('morning-brief');
    expect(results).toHaveLength(1);
    expect(results[0].rateLimited).toBe(false);

    // Second run immediately — should be rate-limited
    await scheduler.triggerTask('morning-brief');
    expect(results).toHaveLength(2);
    expect(results[1].rateLimited).toBe(true);
    expect(results[1].suppressed).toBe(true);

    scheduler.stop();
  });

  it('rate limit: second task after window expires → not rate-limited', async () => {
    const runner = makeMockRunner('HEARTBEAT_OK');
    const logger = makeLogger();
    // Very short rate limit window (0 minutes) so the second run is never blocked
    const config = makeAgentConfig(0);
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config, history);

    scheduler.load(SINGLE_TASK_CONTENT);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    await scheduler.triggerTask('morning-brief');
    await scheduler.triggerTask('morning-brief');

    // Both should succeed (window = 0 ms)
    expect(results).toHaveLength(2);
    expect(results[0].rateLimited).toBe(false);
    expect(results[1].rateLimited).toBe(false);

    scheduler.stop();
  });

  // ── stop() cancels all scheduled tasks ──────────────────────────────────
  it('stop() cancels all scheduled tasks', async () => {
    const runner = makeMockRunner('HEARTBEAT_OK');
    const logger = makeLogger();
    const config = makeAgentConfig();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config);

    scheduler.load(SINGLE_TASK_CONTENT);
    scheduler.stop();

    // After stop, triggerTask should fail because taskDefs are cleared
    await expect(scheduler.triggerTask('morning-brief')).rejects.toThrow('No task named');
  });

  // ── Session ID format ─────────────────────────────────────────────────────
  it('each runTask() generates a unique session ID matching heartbeat:<agentId>:<taskName>:<ts>', async () => {
    const runner = makeMockRunner('HEARTBEAT_OK');
    const logger = makeLogger();
    const config = makeAgentConfig();
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config, history);

    scheduler.load(SINGLE_TASK_CONTENT);

    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    // Reset rate limit by using 0-minute window config
    const configNoLimit = makeAgentConfig(0);
    const schedulerNoLimit = new CronScheduler(AGENT_ID, runner, logger, configNoLimit, history);
    schedulerNoLimit.load(SINGLE_TASK_CONTENT);

    const ids: Set<string> = new Set();
    for (let i = 0; i < 3; i++) {
      schedulerNoLimit.on('heartbeat:result', (r: HeartbeatResult) => ids.add(r.sessionId));
    }

    await schedulerNoLimit.triggerTask('morning-brief');
    await schedulerNoLimit.triggerTask('morning-brief');

    const allResults = history.getHistory(AGENT_ID, 'morning-brief');
    const sessionIds = allResults.map((r) => r.sessionId);

    // All session IDs should match the format heartbeat:<agentId>:<taskName>:<timestamp>
    for (const sid of sessionIds) {
      expect(sid).toMatch(/^heartbeat:test-agent:morning-brief:\d+$/);
    }

    // IDs should be unique across runs
    expect(new Set(sessionIds).size).toBe(sessionIds.length);

    scheduler.stop();
    schedulerNoLimit.stop();
  }, 15000);

  // ── HeartbeatResult is recorded in history after run ────────────────────
  it('runTask() records result in HeartbeatHistory', async () => {
    const runner = makeMockRunner('HEARTBEAT_OK');
    const logger = makeLogger();
    const config = makeAgentConfig();
    const history = new HeartbeatHistory();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config, history);

    scheduler.load(SINGLE_TASK_CONTENT);
    await scheduler.triggerTask('morning-brief');

    const last = history.getLastResult(AGENT_ID, 'morning-brief');
    expect(last).not.toBeNull();
    expect(last!.taskName).toBe('morning-brief');

    scheduler.stop();
  });

  // ── triggerTask() outside test env is a no-op ────────────────────────────
  it('triggerTask() outside test environment (NODE_ENV != test) is a no-op', async () => {
    const runner = makeMockRunner('ok');
    const logger = makeLogger();
    const config = makeAgentConfig();
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config);

    scheduler.load(SINGLE_TASK_CONTENT);

    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    // Should resolve without throwing
    await expect(scheduler.triggerTask('morning-brief')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('triggerTask() called outside of test environment'),
    );

    process.env.NODE_ENV = savedEnv;
    scheduler.stop();
  });

  // ── rate-limited event is emitted ───────────────────────────────────────
  it('emits heartbeat:rate-limited event when rate limit is hit', async () => {
    const runner = makeMockRunner('HEARTBEAT_OK');
    const logger = makeLogger();
    const config = makeAgentConfig(30);
    const scheduler = new CronScheduler(AGENT_ID, runner, logger, config);

    scheduler.load(SINGLE_TASK_CONTENT);

    const rateLimitedEvents: HeartbeatResult[] = [];
    scheduler.on('heartbeat:rate-limited', (r: HeartbeatResult) => rateLimitedEvents.push(r));

    await scheduler.triggerTask('morning-brief');
    await scheduler.triggerTask('morning-brief');

    expect(rateLimitedEvents).toHaveLength(1);
    expect(rateLimitedEvents[0].rateLimited).toBe(true);

    scheduler.stop();
  });
});

// ─── Issue #652 ───────────────────────────────────────────────────────────────

describe('CronScheduler schedules (#652)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('load() rejects a cron node-cron cannot schedule without throwing', () => {
    const logger = makeLogger();
    const scheduler = new CronScheduler(AGENT_ID, makeMockRunner('ok'), logger, makeAgentConfig());
    const content = `tasks:
  - name: bad-step
    cron: "5/15 * * * *"
    prompt: "Bad step base."
`;
    expect(() => scheduler.load(content)).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to parse heartbeat content',
      expect.objectContaining({ error: expect.stringContaining('bad-step') }),
    );
    scheduler.stop();
  });

  function intervalContent(interval: string): string {
    return `tasks:
  - name: every
    interval: ${interval}
    prompt: "Check in."
`;
  }

  function recordFirings(scheduler: CronScheduler): number[] {
    const firedAt: number[] = [];
    jest.spyOn(scheduler, 'runTask').mockImplementation(async () => {
      firedAt.push(Date.now());
    });
    return firedAt;
  }

  it.each([
    ['45m', 45 * 60_000],
    ['5h', 5 * 3_600_000],
  ])('interval %s fires at an even gap and stops on stop()', (interval, gapMs) => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const scheduler = new CronScheduler(AGENT_ID, makeMockRunner('ok'), makeLogger(), makeAgentConfig());
    const firedAt = recordFirings(scheduler);

    scheduler.load(intervalContent(interval));
    // Five firings cross midnight, where `0 */5 * * *` would have left a 4h gap.
    jest.advanceTimersByTime(gapMs * 5);

    expect(firedAt).toHaveLength(5);
    expect(firedAt.slice(1).map((t, i) => t - firedAt[i])).toEqual([gapMs, gapMs, gapMs, gapMs]);

    scheduler.stop();
    jest.advanceTimersByTime(gapMs * 2);
    expect(firedAt).toHaveLength(5);
  });

  it('reloading HEARTBEAT.md does not restart an interval count', () => {
    // 00:00 UTC is a multiple of 45 minutes since the epoch.
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const scheduler = new CronScheduler(AGENT_ID, makeMockRunner('ok'), makeLogger(), makeAgentConfig());
    const firedAt = recordFirings(scheduler);
    const start = Date.now();

    scheduler.load(intervalContent('45m'));
    // Any workspace write reloads the file; here one lands every 30 minutes.
    for (let i = 0; i < 6; i++) {
      jest.advanceTimersByTime(30 * 60_000);
      scheduler.load(intervalContent('45m'));
    }

    expect(firedAt).toEqual([1, 2, 3, 4].map((n) => start + n * 45 * 60_000));
    scheduler.stop();
  });

  it('45m interval is not suppressed by the default 30-minute rate limit', async () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const scheduler = new CronScheduler(AGENT_ID, makeMockRunner('news'), makeLogger(), makeAgentConfig());
    const results: HeartbeatResult[] = [];
    scheduler.on('heartbeat:result', (r: HeartbeatResult) => results.push(r));

    scheduler.load(`tasks:
  - name: every
    interval: 45m
    prompt: "Check in."
`);
    // Under `*/45 * * * *` the 01:00 run came 15 minutes after a delivered
    // 00:45 run and was rate-limited.
    for (let i = 0; i < 3; i++) {
      await jest.advanceTimersByTimeAsync(45 * 60_000);
    }
    await jest.advanceTimersByTimeAsync(1_000);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.rateLimited)).toEqual([false, false, false]);
    scheduler.stop();
  });

  it('a failing interval run is logged, not left as an unhandled rejection', async () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const logger = makeLogger();
    const scheduler = new CronScheduler(AGENT_ID, makeMockRunner('ok'), logger, makeAgentConfig());
    jest.spyOn(scheduler, 'runTask').mockRejectedValue(new Error('history write failed'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      scheduler.load(intervalContent('45m'));
      await jest.advanceTimersByTimeAsync(45 * 60_000);
      // unhandledRejection is reported after the microtask queue drains.
      jest.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(logger.error).toHaveBeenCalledWith('Heartbeat task "every" failed', {
        error: 'history write failed',
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      scheduler.stop();
    }
  });

  it('a clock moved back across a boundary does not run the interval twice', () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const scheduler = new CronScheduler(AGENT_ID, makeMockRunner('ok'), makeLogger(), makeAgentConfig());
    const firedAt = recordFirings(scheduler);

    scheduler.load(intervalContent('45m'));
    jest.advanceTimersByTime(45 * 60_000);
    expect(firedAt).toHaveLength(1);

    // NTP steps the wall clock back 5 seconds, just before the 00:45 boundary
    // that already ran.
    jest.setSystemTime(Date.now() - 5_000);
    jest.advanceTimersByTime(10_000);
    expect(firedAt).toHaveLength(1);

    jest.advanceTimersByTime(45 * 60_000);
    expect(firedAt).toHaveLength(2);
    scheduler.stop();
  });

  it('a reload that lands just after a boundary, before its timer ran, keeps that run', () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const scheduler = new CronScheduler(AGENT_ID, makeMockRunner('ok'), makeLogger(), makeAgentConfig());
    const firedAt = recordFirings(scheduler);
    const start = Date.now();

    scheduler.load(intervalContent('45m'));
    jest.advanceTimersByTime(45 * 60_000);
    expect(firedAt).toEqual([start + 45 * 60_000]);

    // The wall clock passes the 01:30 boundary, but a workspace reload runs
    // before the pending timer callback does.
    jest.setSystemTime(start + 90 * 60_000 + 3);
    scheduler.load(intervalContent('45m'));
    jest.advanceTimersByTime(0);

    expect(firedAt).toEqual([start + 45 * 60_000, start + 90 * 60_000 + 3]);
    // The run is not repeated, and the next boundary is unaffected.
    jest.advanceTimersByTime(45 * 60_000);
    expect(firedAt).toHaveLength(3);
    scheduler.stop();
  });

  it('a first load does not run a boundary that passed before it', () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:45:00.003Z') });
    const scheduler = new CronScheduler(AGENT_ID, makeMockRunner('ok'), makeLogger(), makeAgentConfig());
    const firedAt = recordFirings(scheduler);

    scheduler.load(intervalContent('45m'));
    jest.advanceTimersByTime(1_000);
    expect(firedAt).toEqual([]);
    scheduler.stop();
  });
});
