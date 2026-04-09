import { EventEmitter } from 'events';
import * as nodeCron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { CronJob, CronJobCreate, CronJobUpdate, CronRunLog, CronManagerConfig, Logger } from './types';

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

interface StoreFormat {
  version: 1;
  jobs: CronJob[];
}

export class CronManager extends EventEmitter {
  private readonly storePath: string;
  private readonly runsDir: string;
  private readonly logger: Logger;
  private jobs: Map<string, CronJob> = new Map();
  private scheduledTasks: Map<string, nodeCron.ScheduledTask> = new Map();

  constructor(config?: CronManagerConfig, logger?: Logger) {
    super();
    this.storePath = config?.storePath ?? DEFAULT_STORE_PATH;
    this.runsDir = config?.runsDir ?? DEFAULT_RUNS_DIR;
    this.logger = logger ?? console;
  }

  /**
   * Load persisted jobs from disk and schedule them.
   */
  async start(): Promise<void> {
    // Ensure directories exist
    const storeDir = path.dirname(this.storePath);
    await fs.promises.mkdir(storeDir, { recursive: true });
    await fs.promises.mkdir(this.runsDir, { recursive: true });

    // Load existing jobs
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

    // Check for missed jobs on startup
    await this.catchUpMissedJobs();
  }

  /**
   * Stop all scheduled tasks.
   */
  stop(): void {
    for (const [id, task] of this.scheduledTasks) {
      task.stop();
    }
    this.scheduledTasks.clear();
    this.logger.info('All cron jobs stopped');
  }

  // ─── CRUD Operations ─────────────────────────────────────────────────────

  /**
   * Create a new cron job.
   */
  async create(input: CronJobCreate): Promise<CronJob> {
    // Validate cron expression
    if (!nodeCron.validate(input.schedule)) {
      throw new Error(`Invalid cron expression: "${input.schedule}"`);
    }

    const now = Date.now();
    const job: CronJob = {
      id: randomUUID(),
      agentId: input.agentId,
      name: input.name,
      schedule: input.schedule,
      command: input.command,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      notify: input.notify,
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
    this.logger.info(`Created cron job "${job.name}"`, { id: job.id, schedule: job.schedule });
    this.emit('job:created', job);

    return job;
  }

  /**
   * Update an existing cron job.
   */
  async update(id: string, input: CronJobUpdate): Promise<CronJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);

    // Validate new schedule if provided
    if (input.schedule !== undefined) {
      if (!nodeCron.validate(input.schedule)) {
        throw new Error(`Invalid cron expression: "${input.schedule}"`);
      }
      job.schedule = input.schedule;
    }

    if (input.name !== undefined) job.name = input.name;
    if (input.command !== undefined) job.command = input.command;
    if (input.notify !== undefined) job.notify = input.notify;

    if (input.enabled !== undefined) {
      job.enabled = input.enabled;
    }

    job.updatedAt = Date.now();

    // Reschedule
    this.unscheduleJob(id);
    if (job.enabled) {
      this.scheduleJob(job);
    }

    await this.persist();
    this.logger.info(`Updated cron job "${job.name}"`, { id });
    this.emit('job:updated', job);

    return job;
  }

  /**
   * Delete a cron job.
   */
  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);

    this.unscheduleJob(id);
    this.jobs.delete(id);

    await this.persist();
    this.logger.info(`Removed cron job "${job.name}"`, { id });
    this.emit('job:removed', id);
  }

  /**
   * Get a job by ID.
   */
  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * List all jobs, optionally filtered by agentId.
   */
  list(agentId?: string): CronJob[] {
    const all = [...this.jobs.values()];
    if (agentId) return all.filter((j) => j.agentId === agentId);
    return all;
  }

  /**
   * Manually trigger a job immediately.
   */
  async run(id: string): Promise<CronRunLog> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return this.executeJob(job);
  }

  /**
   * Get run history for a job.
   */
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

  /**
   * Get overall status.
   */
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

  // ─── Internal ─────────────────────────────────────────────────────────────

  private scheduleJob(job: CronJob): void {
    const task = nodeCron.schedule(job.schedule, async () => {
      await this.executeJob(job);
    });
    this.scheduledTasks.set(job.id, task);
    this.logger.info(`Scheduled "${job.name}" [${job.schedule}]`, { id: job.id });
  }

  private unscheduleJob(id: string): void {
    const task = this.scheduledTasks.get(id);
    if (task) {
      task.stop();
      this.scheduledTasks.delete(id);
    }
  }

  private async executeJob(job: CronJob): Promise<CronRunLog> {
    const startedAt = Date.now();
    this.logger.info(`Executing cron job "${job.name}"`, { id: job.id });

    let status: 'ok' | 'error' = 'ok';
    let output = '';
    let error: string | null = null;

    try {
      output = await this.runCommand(job.command, job.agentId);
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
      output: output.slice(0, 5000), // cap output size
      error,
    };

    // Persist state and log
    await Promise.all([
      this.persist(),
      this.appendRunLog(job.id, runLog),
    ]);

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

  private async persist(): Promise<void> {
    const store: StoreFormat = {
      version: 1,
      jobs: [...this.jobs.values()],
    };

    // Write atomically (write to temp, then rename)
    const tmpPath = this.storePath + '.tmp';
    await fs.promises.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, this.storePath);
  }

  private async appendRunLog(jobId: string, log: CronRunLog): Promise<void> {
    const logFile = path.join(this.runsDir, `${jobId}.jsonl`);
    await fs.promises.appendFile(logFile, JSON.stringify(log) + '\n', 'utf8');

    // Prune old entries
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

  /**
   * On startup, check for jobs that should have run while we were down.
   * Run them once to catch up (max 5 missed jobs).
   */
  private async catchUpMissedJobs(): Promise<void> {
    const MAX_CATCHUP = 5;
    let caught = 0;

    for (const job of this.jobs.values()) {
      if (!job.enabled || caught >= MAX_CATCHUP) continue;
      if (!job.state.lastRunAt) continue;

      // Simple heuristic: if lastRunAt is more than 2x the cron interval ago, run it
      const ageMs = Date.now() - job.state.lastRunAt;
      if (ageMs > 30 * 60 * 1000) { // more than 30 min stale
        this.logger.info(`Catching up missed job "${job.name}"`, { id: job.id, ageMs });
        // Stagger catchup runs
        setTimeout(() => this.executeJob(job), caught * 5000);
        caught++;
      }
    }

    if (caught > 0) {
      this.logger.info(`Catching up ${caught} missed job(s)`);
    }
  }
}
