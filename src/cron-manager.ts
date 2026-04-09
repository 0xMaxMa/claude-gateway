import { EventEmitter } from 'events';
import * as nodeCron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import {
  CronJob,
  CronJobCreate,
  CronJobUpdate,
  CronRunLog,
  CronManagerConfig,
  Logger,
  AgentConfig,
} from './types';
import type { AgentRunner } from './agent-runner';

const DEFAULT_STORE_PATH = path.join(
  process.env.HOME ?? '/tmp',
  '.claude-gateway',
  'crons.json',
);

const DEFAULT_RUNS_DIR = path.join(
  process.env.HOME ?? '/tmp',
  '.claude-gateway',
  'cron-runs',
);

const MAX_RUN_LOGS_PER_JOB = 100;
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_FAILURE_ALERT_COOLDOWN_MS = 3_600_000; // 1 hour
const TELEGRAM_API_BASE = 'https://api.telegram.org';

interface StoreFormat {
  version: 1;
  jobs: CronJob[];
}

export class CronManager extends EventEmitter {
  private readonly storePath: string;
  private readonly runsDir: string;
  private readonly logger: Logger;
  private readonly agentRunners: Map<string, AgentRunner>;
  private readonly agentConfigs: Map<string, AgentConfig>;
  private jobs: Map<string, CronJob> = new Map();
  private scheduledTasks: Map<string, nodeCron.ScheduledTask | NodeJS.Timeout> = new Map();

  constructor(
    config?: CronManagerConfig,
    agentRunners?: Map<string, AgentRunner>,
    agentConfigs?: Map<string, AgentConfig>,
    logger?: Logger,
  ) {
    super();
    this.storePath = config?.storePath ?? DEFAULT_STORE_PATH;
    this.runsDir = config?.runsDir ?? DEFAULT_RUNS_DIR;
    this.agentRunners = agentRunners ?? new Map();
    this.agentConfigs = agentConfigs ?? new Map();
    this.logger = logger ?? console;
  }

  /**
   * Load persisted jobs from disk and schedule them.
   */
  async start(): Promise<void> {
    const storeDir = path.dirname(this.storePath);
    await fs.promises.mkdir(storeDir, { recursive: true });
    await fs.promises.mkdir(this.runsDir, { recursive: true });

    if (fs.existsSync(this.storePath)) {
      try {
        const raw = await fs.promises.readFile(this.storePath, 'utf8');
        const store: StoreFormat = JSON.parse(raw);
        if (store.version === 1 && Array.isArray(store.jobs)) {
          for (const job of store.jobs) {
            this.jobs.set(job.id, job);
            if (job.enabled) {
              this.scheduleJob(job);
            }
          }
          this.logger.info(`Loaded ${store.jobs.length} cron job(s) from disk`);
        }
      } catch (err) {
        this.logger.error('Failed to load crons.json', { error: (err as Error).message });
      }
    } else {
      this.logger.info('No existing crons.json — starting fresh');
    }

    await this.catchUpMissedJobs();
  }

  /**
   * Stop all scheduled tasks.
   */
  stop(): void {
    for (const task of this.scheduledTasks.values()) {
      if (typeof (task as nodeCron.ScheduledTask).stop === 'function') {
        (task as nodeCron.ScheduledTask).stop();
      } else {
        clearInterval(task as NodeJS.Timeout);
      }
    }
    this.scheduledTasks.clear();
    this.logger.info('All cron jobs stopped');
  }

  // ─── CRUD Operations ───────────────────────────────────────────────────────

  async create(input: CronJobCreate): Promise<CronJob> {
    this.validateSchedule(input);
    this.validatePayload(input);

    const now = Date.now();
    const scheduleKind = input.scheduleKind ?? 'cron';
    const payloadKind = input.payloadKind ?? 'command';

    const job: CronJob = {
      id: randomUUID(),
      agentId: input.agentId,
      name: input.name,
      scheduleKind,
      schedule: input.schedule,
      scheduleAt: input.scheduleAt,
      everyMs: input.everyMs,
      anchorMs: input.anchorMs,
      payloadKind,
      command: input.command,
      agentTurnMessage: input.agentTurnMessage,
      agentTurnSessionId: input.agentTurnSessionId,
      agentTurnTimeoutMs: input.agentTurnTimeoutMs,
      deleteAfterRun: input.deleteAfterRun,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      notify: input.notify,
      failureAlert: input.failureAlert,
      state: {
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        consecutiveErrors: 0,
        runCount: 0,
        lastAlertAt: null,
      },
    };

    this.jobs.set(job.id, job);

    if (job.enabled) {
      this.scheduleJob(job);
    }

    await this.persist();
    this.logger.info(`Created cron job "${job.name}"`, { id: job.id, scheduleKind });
    this.emit('job:created', job);

    return job;
  }

  async update(id: string, input: CronJobUpdate): Promise<CronJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);

    // Validate schedule if any schedule fields are being updated
    if (
      input.scheduleKind !== undefined ||
      input.schedule !== undefined ||
      input.scheduleAt !== undefined ||
      input.everyMs !== undefined
    ) {
      const merged = { ...job, ...input };
      this.validateSchedule(merged);
    }

    // Validate payload if payload fields are being updated
    if (input.payloadKind !== undefined || input.command !== undefined || input.agentTurnMessage !== undefined) {
      const merged = { ...job, ...input };
      this.validatePayload(merged);
    }

    if (input.scheduleKind !== undefined) job.scheduleKind = input.scheduleKind;
    if (input.schedule !== undefined) job.schedule = input.schedule;
    if (input.scheduleAt !== undefined) job.scheduleAt = input.scheduleAt;
    if (input.everyMs !== undefined) job.everyMs = input.everyMs;
    if (input.anchorMs !== undefined) job.anchorMs = input.anchorMs;
    if (input.payloadKind !== undefined) job.payloadKind = input.payloadKind;
    if (input.command !== undefined) job.command = input.command;
    if (input.agentTurnMessage !== undefined) job.agentTurnMessage = input.agentTurnMessage;
    if (input.agentTurnSessionId !== undefined) job.agentTurnSessionId = input.agentTurnSessionId;
    if (input.agentTurnTimeoutMs !== undefined) job.agentTurnTimeoutMs = input.agentTurnTimeoutMs;
    if (input.deleteAfterRun !== undefined) job.deleteAfterRun = input.deleteAfterRun;
    if (input.name !== undefined) job.name = input.name;
    if (input.notify !== undefined) job.notify = input.notify;
    if (input.failureAlert !== undefined) job.failureAlert = input.failureAlert;

    if (input.enabled !== undefined) {
      job.enabled = input.enabled;
    }

    job.updatedAt = Date.now();

    this.unscheduleJob(id);
    if (job.enabled) {
      this.scheduleJob(job);
    }

    await this.persist();
    this.logger.info(`Updated cron job "${job.name}"`, { id });
    this.emit('job:updated', job);

    return job;
  }

  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);

    this.unscheduleJob(id);
    this.jobs.delete(id);

    await this.persist();
    this.logger.info(`Removed cron job "${job.name}"`, { id });
    this.emit('job:removed', id);
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  list(agentId?: string): CronJob[] {
    const all = [...this.jobs.values()];
    if (agentId) return all.filter((j) => j.agentId === agentId);
    return all;
  }

  async run(id: string): Promise<CronRunLog> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return this.executeJob(job);
  }

  async getRuns(id: string, limit = 20): Promise<CronRunLog[]> {
    const logFile = path.join(this.runsDir, `${id}.jsonl`);
    if (!fs.existsSync(logFile)) return [];

    const content = await fs.promises.readFile(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as CronRunLog;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as CronRunLog[];
  }

  status(): {
    totalJobs: number;
    enabledJobs: number;
    disabledJobs: number;
    jobs: CronJob[];
  } {
    const all = [...this.jobs.values()];
    return {
      totalJobs: all.length,
      enabledJobs: all.filter((j) => j.enabled).length,
      disabledJobs: all.filter((j) => !j.enabled).length,
      jobs: all,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private validateSchedule(input: { scheduleKind?: string; schedule?: string; scheduleAt?: string; everyMs?: number }): void {
    const kind = input.scheduleKind ?? 'cron';
    if (kind === 'cron') {
      if (!input.schedule) throw new Error('schedule is required for scheduleKind=cron');
      if (!nodeCron.validate(input.schedule)) {
        throw new Error(`Invalid cron expression: "${input.schedule}"`);
      }
    } else if (kind === 'at') {
      if (!input.scheduleAt) throw new Error('scheduleAt is required for scheduleKind=at');
      const ts = Date.parse(input.scheduleAt);
      if (isNaN(ts)) throw new Error(`Invalid ISO-8601 timestamp: "${input.scheduleAt}"`);
    } else if (kind === 'every') {
      if (input.everyMs === undefined || input.everyMs === null) {
        throw new Error('everyMs is required for scheduleKind=every');
      }
      if (typeof input.everyMs !== 'number' || input.everyMs <= 0) {
        throw new Error('everyMs must be a positive number');
      }
    }
  }

  private validatePayload(input: { payloadKind?: string; command?: string; agentTurnMessage?: string }): void {
    const kind = input.payloadKind ?? 'command';
    if (kind === 'command') {
      if (!input.command) throw new Error('command is required for payloadKind=command');
    } else if (kind === 'agentTurn') {
      if (!input.agentTurnMessage) throw new Error('agentTurnMessage is required for payloadKind=agentTurn');
    }
  }

  private scheduleJob(job: CronJob): void {
    const kind = job.scheduleKind ?? 'cron';

    if (kind === 'cron') {
      const task = nodeCron.schedule(job.schedule!, async () => {
        await this.executeJob(job);
      });
      this.scheduledTasks.set(job.id, task);
      this.logger.info(`Scheduled "${job.name}" [cron: ${job.schedule}]`, { id: job.id });

    } else if (kind === 'at') {
      const targetMs = Date.parse(job.scheduleAt!);
      const delayMs = targetMs - Date.now();

      const fireAt = async () => {
        try {
          this.scheduledTasks.delete(job.id);
          await this.executeJob(job);
          await this.disableOrDeleteJob(job);
        } catch (err) {
          this.logger.error(`at-job "${job.name}" post-run cleanup failed`, { id: job.id, error: (err as Error).message });
        }
      };

      if (delayMs <= 0) {
        this.logger.info(`Scheduling "${job.name}" [at: ${job.scheduleAt}] — past, running now`, { id: job.id });
        const t = setTimeout(fireAt, 0);
        this.scheduledTasks.set(job.id, t);
      } else {
        this.logger.info(`Scheduled "${job.name}" [at: ${job.scheduleAt}] in ${Math.round(delayMs / 1000)}s`, { id: job.id });
        const t = setTimeout(fireAt, delayMs);
        this.scheduledTasks.set(job.id, t);
      }

    } else if (kind === 'every') {
      const everyMs = job.everyMs!;
      let firstDelay = 0;

      if (job.anchorMs !== undefined) {
        const elapsed = (Date.now() - job.anchorMs) % everyMs;
        firstDelay = everyMs - elapsed;
        if (firstDelay >= everyMs) firstDelay = 0;
      }

      const startInterval = () => {
        const t = setInterval(async () => {
          await this.executeJob(job);
        }, everyMs);
        this.scheduledTasks.set(job.id, t);
      };

      if (firstDelay > 0) {
        this.logger.info(`Scheduled "${job.name}" [every: ${everyMs}ms] first run in ${firstDelay}ms`, { id: job.id });
        const initialTimer = setTimeout(() => {
          startInterval();
          this.executeJob(job).catch(() => {});
        }, firstDelay);
        this.scheduledTasks.set(job.id, initialTimer);
      } else {
        this.logger.info(`Scheduled "${job.name}" [every: ${everyMs}ms]`, { id: job.id });
        startInterval();
      }
    }
  }

  private unscheduleJob(id: string): void {
    const task = this.scheduledTasks.get(id);
    if (task) {
      if (typeof (task as nodeCron.ScheduledTask).stop === 'function') {
        (task as nodeCron.ScheduledTask).stop();
      } else {
        clearTimeout(task as NodeJS.Timeout);
        clearInterval(task as NodeJS.Timeout);
      }
      this.scheduledTasks.delete(id);
    }
  }

  private async disableOrDeleteJob(job: CronJob): Promise<void> {
    if (job.deleteAfterRun) {
      this.jobs.delete(job.id);
      await this.persist();
      this.logger.info(`Auto-deleted one-shot job "${job.name}"`, { id: job.id });
      this.emit('job:removed', job.id);
    } else {
      job.enabled = false;
      job.updatedAt = Date.now();
      await this.persist();
      this.logger.info(`Auto-disabled one-shot job "${job.name}"`, { id: job.id });
      this.emit('job:updated', job);
    }
  }

  private async executeJob(job: CronJob): Promise<CronRunLog> {
    const startedAt = Date.now();
    this.logger.info(`Executing cron job "${job.name}"`, { id: job.id, payloadKind: job.payloadKind ?? 'command' });

    let status: 'ok' | 'error' = 'ok';
    let output = '';
    let error: string | null = null;

    try {
      const payloadKind = job.payloadKind ?? 'command';
      if (payloadKind === 'agentTurn') {
        output = await this.runAgentTurn(job);
      } else {
        output = await this.runCommand(job.command!, job.agentId);
      }
      job.state.consecutiveErrors = 0;
    } catch (err) {
      status = 'error';
      error = (err as Error).message;
      output = error;
      job.state.consecutiveErrors++;
      this.logger.error(`Cron job "${job.name}" failed`, { id: job.id, error });
    }

    const durationMs = Date.now() - startedAt;
    job.state.lastRunAt = startedAt;
    job.state.lastStatus = status;
    job.state.lastError = error;
    job.state.runCount++;
    job.updatedAt = Date.now();

    const runLog: CronRunLog = {
      jobId: job.id,
      startedAt,
      durationMs,
      status,
      output: output.slice(0, 5000),
      error,
    };

    await Promise.all([
      this.persist(),
      this.appendRunLog(job.id, runLog),
    ]);

    // Deliver notification
    await this.deliverNotify(job, runLog);

    // Check failure alert
    if (status === 'error') {
      await this.checkFailureAlert(job);
    }

    this.emit('job:executed', job, runLog);
    return runLog;
  }

  private runCommand(command: string, agentId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        CRON_AGENT_ID: agentId,
      };

      exec(command, { timeout: 120_000, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${err.message}\n${stderr}`.trim()));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  private async runAgentTurn(job: CronJob): Promise<string> {
    const runner = this.agentRunners.get(job.agentId);
    if (!runner) {
      throw new Error(`AgentRunner not found for agentId: "${job.agentId}"`);
    }

    const sessionId = job.agentTurnSessionId ?? `cron-${job.id}`;
    const timeoutMs = job.agentTurnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS;

    return runner.sendApiMessage(sessionId, job.agentTurnMessage!, { timeoutMs });
  }

  private async deliverNotify(job: CronJob, runLog: CronRunLog): Promise<void> {
    const notify = job.notify;
    if (!notify) return;

    const isSuccess = runLog.status === 'ok';
    const shouldNotify = isSuccess
      ? (notify.onSuccess !== false)
      : (notify.onError !== false);

    if (!shouldNotify) return;

    const icon = isSuccess ? '✅' : '❌';
    const detail = isSuccess
      ? runLog.output.slice(0, 500)
      : (runLog.error ?? runLog.output).slice(0, 500);
    const text = `${icon} ${job.name}\n${detail}`.trim();

    if (notify.telegram) {
      await this.sendTelegram(job.agentId, notify.telegram, text);
    }

    if (notify.webhook) {
      await this.sendWebhook(notify.webhook, {
        jobId: job.id,
        jobName: job.name,
        agentId: job.agentId,
        status: runLog.status,
        output: runLog.output,
        error: runLog.error,
        startedAt: runLog.startedAt,
        durationMs: runLog.durationMs,
      });
    }
  }

  private async checkFailureAlert(job: CronJob): Promise<void> {
    const alert = job.failureAlert;
    if (!alert) return;

    if (job.state.consecutiveErrors < alert.after) return;

    const cooldownMs = alert.cooldownMs ?? DEFAULT_FAILURE_ALERT_COOLDOWN_MS;
    const lastAlertAt = job.state.lastAlertAt ?? 0;
    if (Date.now() - lastAlertAt < cooldownMs) return;

    const text = `⚠️ Cron alert: ${job.name} failed ${job.state.consecutiveErrors} times in a row\nLast error: ${job.state.lastError ?? 'unknown'}`;

    if (alert.telegram) {
      await this.sendTelegram(job.agentId, alert.telegram, text);
    }

    if (alert.webhook) {
      await this.sendWebhook(alert.webhook, {
        jobId: job.id,
        jobName: job.name,
        agentId: job.agentId,
        alertKind: 'failure',
        consecutiveErrors: job.state.consecutiveErrors,
        lastError: job.state.lastError,
      });
    }

    job.state.lastAlertAt = Date.now();
    await this.persist();
  }

  private async sendTelegram(agentId: string, chatId: string, text: string): Promise<void> {
    const agentConfig = this.agentConfigs.get(agentId);
    const botToken = agentConfig?.telegram?.botToken;

    if (!botToken) {
      this.logger.warn(`Cannot send Telegram notify: no botToken for agent "${agentId}"`);
      return;
    }

    try {
      const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        this.logger.warn(`Telegram notify failed: ${resp.status} ${body}`, { chatId });
      }
    } catch (err) {
      this.logger.warn(`Telegram notify error: ${(err as Error).message}`, { chatId });
    }
  }

  private async sendWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        this.logger.warn(`Webhook notify failed: ${resp.status} ${body}`, { url });
      }
    } catch (err) {
      this.logger.warn(`Webhook notify error: ${(err as Error).message}`, { url });
    }
  }

  private async persist(): Promise<void> {
    const store: StoreFormat = {
      version: 1,
      jobs: [...this.jobs.values()],
    };

    const tmpPath = this.storePath + '.tmp';
    await fs.promises.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, this.storePath);
  }

  private async appendRunLog(jobId: string, log: CronRunLog): Promise<void> {
    const logFile = path.join(this.runsDir, `${jobId}.jsonl`);
    await fs.promises.appendFile(logFile, JSON.stringify(log) + '\n', 'utf8');

    try {
      const content = await fs.promises.readFile(logFile, 'utf8');
      const lines = content.trim().split('\n');
      if (lines.length > MAX_RUN_LOGS_PER_JOB) {
        const pruned = lines.slice(-MAX_RUN_LOGS_PER_JOB).join('\n') + '\n';
        await fs.promises.writeFile(logFile, pruned, 'utf8');
      }
    } catch {
      // Non-fatal
    }
  }

  private async catchUpMissedJobs(): Promise<void> {
    const MAX_CATCHUP = 5;
    let caught = 0;

    for (const job of this.jobs.values()) {
      if (!job.enabled || caught >= MAX_CATCHUP) continue;
      const kind = job.scheduleKind ?? 'cron';

      if (kind === 'at') {
        // Already handled in scheduleJob (past at-jobs run immediately)
        continue;
      }

      if (!job.state.lastRunAt) continue;

      const ageMs = Date.now() - job.state.lastRunAt;
      if (ageMs > 30 * 60 * 1000) {
        this.logger.info(`Catching up missed job "${job.name}"`, { id: job.id, ageMs });
        setTimeout(() => this.executeJob(job), caught * 5000);
        caught++;
      }
    }

    if (caught > 0) {
      this.logger.info(`Catching up ${caught} missed job(s)`);
    }
  }
}
