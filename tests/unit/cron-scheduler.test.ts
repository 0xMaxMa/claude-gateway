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
  });

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
