import { EventEmitter } from 'events';
import * as nodeCron from 'node-cron';
import { parseHeartbeat } from './heartbeat-parser';
import { AgentRunner } from './agent-runner';
import { AgentConfig, HeartbeatResult, Logger } from './types';
import { HeartbeatHistory } from './heartbeat-history';

const DEFAULT_RATE_LIMIT_MINUTES = 30;

/** Overridable via HEARTBEAT_RESPONSE_TIMEOUT_MS env var (for unit tests). */
function getResponseTimeoutMs(): number {
  const envVal = process.env.HEARTBEAT_RESPONSE_TIMEOUT_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 60_000;
}

/**
 * Lightweight in-memory context for a single cron run.
 * Not persisted to disk — discarded after the run completes.
 */
interface EphemeralSession {
  sessionId: string;
  agentId: string;
  taskName: string;
  startedAt: number;
}

function buildSessionId(agentId: string, taskName: string): string {
  return `heartbeat:${agentId}:${taskName}:${Date.now()}`;
}

export class CronScheduler extends EventEmitter {
  private readonly agentId: string;
  private readonly runner: AgentRunner;
  private readonly agentConfig: AgentConfig;
  private readonly logger: Logger;
  private readonly history: HeartbeatHistory;
  private tasks: nodeCron.ScheduledTask[] = [];
  private lastProactiveMessageAt: Date | null = null;

  /** Populated during load() to support triggerTask() in tests */
  private readonly taskDefs = new Map<string, { name: string; prompt: string }>();

  constructor(
    agentId: string,
    runner: AgentRunner,
    logger: Logger,
    agentConfig: AgentConfig,
    history?: HeartbeatHistory,
  ) {
    super();
    this.agentId = agentId;
    this.runner = runner;
    this.logger = logger;
    this.agentConfig = agentConfig;
    this.history = history ?? new HeartbeatHistory();
  }

  get id(): string {
    return this.agentId;
  }

  /** Hot-reload: update the rate limit without restarting the scheduler */
  updateRateLimit(minutes: number): void {
    if (!this.agentConfig.heartbeat) {
      this.agentConfig.heartbeat = {};
    }
    this.agentConfig.heartbeat.rateLimitMinutes = minutes;
    this.logger.info('Heartbeat rate limit updated', { rateLimitMinutes: minutes });
  }

  /**
   * Parse the heartbeat.md content, cancel existing cron tasks,
   * and schedule new ones.
   */
  load(heartbeatContent: string): void {
    // Cancel existing tasks and clear stored definitions
    this.stop();

    let heartbeatTasks;
    try {
      heartbeatTasks = parseHeartbeat(heartbeatContent);
    } catch (err) {
      this.logger.error('Failed to parse heartbeat content', { error: (err as Error).message });
      return;
    }

    for (const task of heartbeatTasks) {
      this.logger.info(`Scheduling heartbeat task "${task.name}"`, { cron: task.cron });

      // Store for triggerTask() support
      this.taskDefs.set(task.name, { name: task.name, prompt: task.prompt });

      const scheduled = nodeCron.schedule(task.cron, async () => {
        await this.runTask(task.name, task.prompt);
      });

      this.tasks.push(scheduled);
    }

    this.logger.info(`Loaded ${this.tasks.length} heartbeat task(s)`, { agentId: this.agentId });
  }

  /**
   * Get the rate-limit window in milliseconds.
   */
  private getRateLimitWindowMs(): number {
    const minutes = this.agentConfig.heartbeat?.rateLimitMinutes ?? DEFAULT_RATE_LIMIT_MINUTES;
    return minutes * 60 * 1000;
  }

  /**
   * Execute a single heartbeat task:
   * 1. Check rate limit
   * 2. Create ephemeral session (in-memory, not persisted)
   * 3. Send prompt to agent runner
   * 4. Capture response, detect HEARTBEAT_OK
   * 5. Emit heartbeat:result event and record in history
   */
  async runTask(name: string, prompt: string): Promise<void> {
    const startedAt = Date.now();
    const rateLimitWindowMs = this.getRateLimitWindowMs();

    // Rate limit check
    if (
      this.lastProactiveMessageAt !== null &&
      startedAt - this.lastProactiveMessageAt.getTime() < rateLimitWindowMs
    ) {
      const sessionId = buildSessionId(this.agentId, name);
      const result: HeartbeatResult = {
        taskName: name,
        sessionId,
        suppressed: true,
        rateLimited: true,
        response: '',
        durationMs: 0,
        ts: new Date(startedAt).toISOString(),
      };

      this.logger.info(`Heartbeat task "${name}" suppressed by rate limit`, {
        lastProactiveMessageAt: this.lastProactiveMessageAt.toISOString(),
      });
      this.emit('heartbeat:rate-limited', result);
      this.history.record(this.agentId, result);
      this.emit('heartbeat:result', result);
      return;
    }

    // Create ephemeral session (in-memory only, not persisted to disk)
    const session: EphemeralSession = {
      sessionId: buildSessionId(this.agentId, name),
      agentId: this.agentId,
      taskName: name,
      startedAt,
    };

    this.logger.info(`Running heartbeat task "${name}"`, { sessionId: session.sessionId });

    // Collect response lines from agent output
    const responseLines: string[] = [];
    let heartbeatOk = false;
    let responseTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const result = await new Promise<HeartbeatResult>((resolve) => {
      const outputHandler = (line: string) => {
        responseLines.push(line);

        // Case-insensitive HEARTBEAT_OK detection
        if (line.toUpperCase().includes('HEARTBEAT_OK')) {
          heartbeatOk = true;
          this.logger.info(
            `Heartbeat task "${name}" returned HEARTBEAT_OK — suppressing Telegram message`,
            { sessionId: session.sessionId },
          );
        }
      };

      const finish = () => {
        if (resolved) return;
        resolved = true;

        this.runner.removeListener('output', outputHandler);
        if (responseTimer) {
          clearTimeout(responseTimer);
          responseTimer = null;
        }

        const durationMs = Date.now() - startedAt;
        const response = responseLines.join('\n');

        resolve({
          taskName: name,
          sessionId: session.sessionId,
          suppressed: heartbeatOk,
          rateLimited: false,
          response,
          durationMs,
          ts: new Date(startedAt).toISOString(),
        });
      };

      this.runner.on('output', outputHandler);

      // Update rate limit timestamp before sending (prevents concurrent tasks from bypassing)
      this.lastProactiveMessageAt = new Date(startedAt);

      // Send the prompt to the agent using the ephemeral session
      this.runner.sendMessage(prompt);

      // Resolve after timeout — collects all output within the window
      responseTimer = setTimeout(finish, getResponseTimeoutMs());
    });

    // Record and emit
    this.history.record(this.agentId, result);
    this.emit('heartbeat:result', result);
  }

  /**
   * Stop all scheduled cron tasks.
   */
  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    this.taskDefs.clear();
  }

  /**
   * Get the HeartbeatHistory instance used by this scheduler.
   */
  getHistory(): HeartbeatHistory {
    return this.history;
  }

  /**
   * Manually trigger a named task by name (testing only — requires NODE_ENV=test).
   */
  async triggerTask(taskName: string): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      this.logger.warn('triggerTask() called outside of test environment — ignoring');
      return;
    }

    const taskDef = this.taskDefs.get(taskName);
    if (!taskDef) {
      throw new Error(`No task named "${taskName}" is scheduled`);
    }
    await this.runTask(taskDef.name, taskDef.prompt);
  }
}
