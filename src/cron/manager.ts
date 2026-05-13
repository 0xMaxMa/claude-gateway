import { EventEmitter } from 'events';
import * as nodeCron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import {
  CronJob,
  CronJobCreate,
  CronJobUpdate,
  CronRunLog,
  CronManagerConfig,
  Logger,
  AgentConfig,
} from '../types';
import type { AgentRunner } from '../agent/runner';

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
const DEFAULT_TIMEOUT_MS = 120_000;
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

interface StoreFormat {
  version: 1;
  jobs: CronJob[];
}

function chunkDiscordText(text: string, limit: number): string[] {
  if (text.length <= limit) return text.length === 0 ? [] : [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit);
    const nl = rest.lastIndexOf('\n', limit);
    const sp = rest.lastIndexOf(' ', limit);
    const cut = para > limit / 2 ? para : nl > limit / 2 ? nl : sp > 0 ? sp : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
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
    const type = input.type ?? 'command';

    const job: CronJob = {
      id: randomUUID(),
      agentId: input.agentId,
      name: input.name,
      scheduleKind,
      schedule: input.schedule,
      scheduleAt: input.scheduleAt,
      type,
      command: input.command,
      prompt: input.prompt,
      telegram: input.telegram,
      discord: input.discord,
      timeoutMs: input.timeoutMs,
      deleteAfterRun: input.deleteAfterRun,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      state: {
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        consecutiveErrors: 0,
        runCount: 0,
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
      input.scheduleAt !== undefined
    ) {
      const merged = { ...job, ...input };
      this.validateSchedule(merged);
    }

    // Validate payload if payload fields are being updated
    if (input.type !== undefined || input.command !== undefined || input.prompt !== undefined) {
      const merged = { ...job, ...input };
      this.validatePayload(merged);
    }

    if (input.scheduleKind !== undefined) job.scheduleKind = input.scheduleKind;
    if (input.schedule !== undefined) job.schedule = input.schedule;
    if (input.scheduleAt !== undefined) job.scheduleAt = input.scheduleAt;
    if (input.type !== undefined) job.type = input.type;
    if (input.command !== undefined) job.command = input.command;
    if (input.prompt !== undefined) job.prompt = input.prompt;
    if (input.telegram !== undefined) job.telegram = input.telegram;
    if (input.discord !== undefined) job.discord = input.discord;
    if (input.timeoutMs !== undefined) job.timeoutMs = input.timeoutMs;
    if (input.deleteAfterRun !== undefined) job.deleteAfterRun = input.deleteAfterRun;
    if (input.name !== undefined) job.name = input.name;

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

  private validateSchedule(input: { scheduleKind?: string; schedule?: string; scheduleAt?: string }): void {
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
    }
  }

  private validatePayload(input: { type?: string; command?: string; prompt?: string; telegram?: string; discord?: string }): void {
    const kind = input.type ?? 'command';
    if (kind === 'command') {
      if (!input.command) throw new Error('command is required for type=command');
    } else if (kind === 'agent') {
      if (!input.prompt) throw new Error('prompt is required for type=agent');
      if (!input.telegram && !input.discord) {
        throw new Error('telegram or discord is required for type=agent');
      }
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
      if (isNaN(targetMs)) {
        this.logger.error(`at-job "${job.name}" has invalid scheduleAt "${job.scheduleAt}", skipping`, { id: job.id });
        return;
      }
      const delayMs = targetMs - Date.now();

      // Fix 1: If the job already ran before a crash, skip re-fire and complete cleanup.
      // executeJob() always persists lastRunAt before disableOrDeleteJob() runs, so
      // lastRunAt !== null reliably indicates the job fired even if cleanup was interrupted.
      if (job.state.lastRunAt !== null) {
        this.logger.info(
          `at-job "${job.name}" already ran (lastRunAt=${job.state.lastRunAt}), skipping re-fire — cleaning up`,
          { id: job.id }
        );
        this.disableOrDeleteJob(job).catch((err) =>
          this.logger.error(`Cleanup failed for at-job "${job.name}"`, {
            id: job.id,
            error: (err as Error).message,
          })
        );
        return;
      }

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
    this.logger.info(`Executing cron job "${job.name}"`, { id: job.id, type: job.type ?? 'command' });

    let status: 'ok' | 'error' = 'ok';
    let output = '';
    let error: string | null = null;

    try {
      const type = job.type ?? 'command';
      if (type === 'agent') {
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

    // Deliver agent response to configured channels (independently; one failure must not block the other)
    if (status === 'ok' && job.type === 'agent') {
      const deliveries: Promise<void>[] = [];
      if (job.telegram) {
        deliveries.push(this.sendTelegram(job.agentId, job.telegram, runLog.output));
      }
      if (job.discord) {
        deliveries.push(this.sendDiscord(job.agentId, job.discord, runLog.output));
      }
      if (deliveries.length > 0) {
        await Promise.allSettled(deliveries);
      }
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

    const sessionId = `cron-${job.id}`;
    const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return runner.sendApiMessage(sessionId, `cron-${job.id}`, job.prompt!, { timeoutMs });
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

  private async sendDiscord(agentId: string, channelId: string, text: string): Promise<void> {
    const agentConfig = this.agentConfigs.get(agentId);
    const botToken = agentConfig?.discord?.botToken;

    if (!botToken) {
      this.logger.warn(`Cannot send Discord notify: no botToken for agent "${agentId}"`);
      return;
    }

    const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`;
    const chunks = chunkDiscordText(text, DISCORD_MAX_MESSAGE_LENGTH);

    for (const content of chunks) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${botToken}`,
          },
          body: JSON.stringify({ content }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          const body = await resp.text();
          this.logger.warn(`Discord notify failed: ${resp.status} ${body}`, { channelId });
          return;
        }
      } catch (err) {
        this.logger.warn(`Discord notify error: ${(err as Error).message}`, { channelId });
        return;
      }
    }
  }

  private async persist(): Promise<void> {
    const store: StoreFormat = {
      version: 1,
      jobs: [...this.jobs.values()],
    };

    const tmpPath = `${this.storePath}.tmp.${randomUUID()}`;
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

      // at-jobs are handled in scheduleJob(); cron-parser is only meaningful for recurring crons
      if (kind !== 'cron') continue;

      // Never ran — let the normal cron schedule handle it
      if (!job.state.lastRunAt) continue;

      // Fix 2: Compute the most recent scheduled tick before now.
      // Only catch up if a new tick occurred after lastRunAt (genuine missed execution).
      // This replaces the crude "age > 30 min" heuristic which re-fired any job that ran
      // more than 30 minutes ago, regardless of whether the schedule produced a new tick.
      let lastExpectedRun: Date;
      try {
        const interval = CronExpressionParser.parse(job.schedule!, { currentDate: new Date() });
        lastExpectedRun = interval.prev().toDate();
      } catch {
        continue; // unparseable schedule — skip catch-up
      }

      if (lastExpectedRun.getTime() > job.state.lastRunAt) {
        this.logger.info(`Catching up missed job "${job.name}"`, {
          id: job.id,
          lastRunAt: job.state.lastRunAt,
          lastExpectedRun: lastExpectedRun.toISOString(),
        });
        setTimeout(() => this.executeJob(job), caught * 5000);
        caught++;
      }
    }

    if (caught > 0) {
      this.logger.info(`Catching up ${caught} missed job(s)`);
    }
  }
}
