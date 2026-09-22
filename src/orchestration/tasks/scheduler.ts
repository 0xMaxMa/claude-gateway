import { taskFailure, shutdownFailure } from './failure';
import { TaskService } from './service';
import { TaskAttempt, TaskSnapshot, WorkerOutcome } from '../types';
import { ProviderAdmission, ProviderPermit, ProviderFailure } from '../provider-admission';

export interface WorkerAdmission {
  acquire(task: TaskSnapshot): ProviderAdmission;
  renew(permit: ProviderPermit): void;
  settle(permit: ProviderPermit, result: 'success' | ProviderFailure): void;
  release(permit: ProviderPermit): void;
}

export interface WorkerHandle {
  /** First actual model output, independent of long tool/task completion. */
  providerReady?: Promise<void>;
  identity?(): TaskAttempt['processIdentity'];
  /** Resolves only after turn admission is observed, never just stdin.write. */
  accepted: Promise<void>;
  result: Promise<WorkerOutcome>;
  stop(): Promise<void>;
}
export interface WorkerDriver {
  cleanup?(attempt: TaskAttempt): Promise<boolean>;
  available?(taskId: string): boolean;
  release?(taskId: string): Promise<void>;
  reserve?(taskId: string): (() => void) | undefined;
  start(task: TaskSnapshot, attempt: TaskAttempt, capacityReserved?: boolean, providerPermit?: ProviderPermit): Promise<WorkerHandle>;
}

/** Workers run outside the scheduler's claim transaction and outside agent
 * turns. All attempts count toward admission, including uncertain processes. */
export class WorkerScheduler {
  /** Sessions whose workers were admitted in this runtime, including recovered queued work. */
  readonly startedSessions = new Set<string>();
  private readonly active = new Map<string, WorkerHandle>();
  private readonly uncertainReservations: Map<string, () => void>;
  private readonly starting = new Set<string>();
  private ticking = false;
  private closed = false;
  private readonly pending = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly tasks: TaskService, private readonly driver: WorkerDriver, private readonly reportError: (error: unknown) => void = () => {}, recoveredReservations = new Map<string, () => void>(), private readonly admission?: WorkerAdmission) {
    this.uncertainReservations = recoveredReservations;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(this.reportError); }, 100);
    this.timer.unref();
    void this.tick().catch(this.reportError);
  }
  async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      this.tasks.pruneWorkers();
      for (const [taskId, handle] of this.active) {
        const task = this.tasks.store.task(taskId);
        if (task && ['cancel_requested', 'interrupting'].includes(task.state)) void handle.stop().catch(this.reportError);
      }
      for (const row of this.tasks.store.all("SELECT id FROM tasks WHERE state='cancel_requested'")) {
        const taskId = String(row.id);
        if (this.active.has(taskId) || this.starting.has(taskId)) continue;
        const task = this.tasks.store.task(taskId)!;
        if (task.gatewayTarget) continue;
        const attempt = task.activeAttemptId ? this.tasks.store.attempt(task.activeAttemptId) : undefined;
        if (!attempt) continue;
        let stopped = false;
        try { stopped = await this.driver.cleanup?.(attempt) ?? false; } catch (error) { this.reportError(error); }
        const current = this.tasks.store.task(taskId);
        if (current?.state !== 'cancel_requested' || current.activeAttemptId !== attempt.attemptId) continue;
        this.tasks.finishCleanup(attempt.attemptId, attempt.generation, stopped);
        if (stopped) {
          this.uncertainReservations.get(taskId)?.(); this.uncertainReservations.delete(taskId);
          await this.driver.release?.(taskId).catch(this.reportError);
        }
      }
      if (this.closed) return;
      const ceiling = Number(this.tasks.store.get('SELECT COALESCE(MAX(rowid),0) n FROM tasks')!.n);
      let cursor: {createdAt: number; id: string} | undefined;
      admission: while (!this.closed) {
        const rows = this.tasks.store.all(`SELECT id,created_at FROM tasks WHERE state='queued' AND rowid<=?
          ${cursor ? 'AND (created_at>? OR (created_at=? AND id>?))' : ''}
          ORDER BY created_at,id LIMIT 100`, ceiling, ...(cursor ? [cursor.createdAt,cursor.createdAt,cursor.id] : []));
        if (!rows.length) break;
        for (const row of rows) {
          cursor = {createdAt:Number(row.created_at),id:String(row.id)};
          const taskId = String(row.id);
          if (this.tasks.store.task(taskId)?.gatewayTarget) continue;
          if (this.starting.has(taskId) || this.active.has(taskId)) continue;
          if (this.driver.available && !this.driver.available(taskId)) continue;
          const release = this.driver.reserve?.(taskId);
          if (this.driver.reserve && !release) break admission;
          let provider: ProviderAdmission | undefined;
          let attempt: TaskAttempt | undefined;
          try {
            provider = this.admission?.acquire(this.tasks.store.task(taskId)!);
            if (provider?.waiting) { release?.(); continue; }
            attempt = this.tasks.claim(taskId);
          } catch (error) {
            release?.();
            if (provider?.permit) { try { this.admission?.release(provider.permit); } catch (cleanupError) { this.reportError(cleanupError); } }
            throw error;
          }
          if (!attempt) { release?.(); if (provider?.permit) { try { this.admission?.release(provider.permit); } catch (error) { this.reportError(error); } } continue; }
          this.startedSessions.add(this.tasks.store.task(taskId)!.agentSessionId);
          this.starting.add(taskId);
          // Do not await startup here: one slow spawn cannot serialize every task
          // or control operation behind it.
          const run = this.run(taskId, attempt, release, provider?.permit);
          this.pending.add(run);
          void run.finally(() => this.pending.delete(run)).catch(this.reportError);
        }
      }
    } finally { this.ticking = false; }
  }
  private async run(taskId: string, attempt: TaskAttempt, release?: () => void, permit?: ProviderPermit): Promise<void> {
    let handle: WorkerHandle | undefined;
    const renewal = permit ? setInterval(() => { try { this.admission?.renew(permit); } catch (error) { this.reportError(error); } }, 250) : undefined;
    renewal?.unref();
    try {
      handle = await this.driver.start(this.tasks.store.task(taskId)!, attempt, Boolean(release), permit);
      this.active.set(taskId, handle);
      let providerResponded = false;
      void handle.providerReady?.then(() => {
        providerResponded = true;
        if (permit && !this.closed) { try { this.admission?.settle(permit, 'success'); } catch (error) { this.reportError(error); } }
      }).catch(() => {});
      if (this.closed) await handle.stop();
      // Attach rejection handlers before waiting on either branch.
      const outcome = handle.result.catch(error => ({ type: 'unknown' as const, failure: taskFailure(error) }));
      try {
        await handle.accepted;
        const task = this.tasks.store.task(taskId)!;
        if (task.state === 'starting') this.tasks.started(attempt.attemptId, attempt.generation, handle.identity?.());
        else await handle.stop();
      } catch { await handle.stop(); }
      let result = await outcome;
      if (permit && !this.closed) {
        try {
          if (result.type === 'completed' && !providerResponded) this.admission?.settle(permit, 'success');
          else if (result.type !== 'completed' && result.failure?.provider) this.admission?.settle(permit, result.failure.provider);
        } catch (error) { this.reportError(error); }
      }
      if (this.closed && result.type !== 'completed' && !['cancel_requested','interrupting'].includes(this.tasks.store.task(taskId)?.state ?? '')) result = {...result, failure: shutdownFailure()};
      this.tasks.finish(attempt.attemptId, attempt.generation, result);
    } catch (error) {
      const task = this.tasks.store.task(taskId);
      if (!handle && ['RESOURCE_BUSY','PROVIDER_WAITING'].includes((error as { code?: string }).code ?? '') && task?.state === 'starting') this.tasks.deferUnstarted(attempt.attemptId, attempt.generation, (error as {code?:string}).code === 'PROVIDER_WAITING' ? 'provider' : 'workspace');
      else if (task?.activeAttemptId === attempt.attemptId && task.state !== 'needs_reconciliation') this.tasks.finish(attempt.attemptId, attempt.generation, { type: handle ? 'unknown' : 'failed', failure: this.closed ? shutdownFailure() : taskFailure(error, 'WORKER_START_FAILED') });
      this.reportError(error);
    } finally {
      if (renewal) clearInterval(renewal);
      if (permit) { try { this.admission?.release(permit); } catch (error) { this.reportError(error); } }
      await this.driver.release?.(taskId).catch(this.reportError);
      if (this.tasks.store.task(taskId)?.state !== 'needs_reconciliation') release?.();
      else if (release) this.uncertainReservations.set(taskId, release);
      this.active.delete(taskId); this.starting.delete(taskId);
      if (!this.closed) void this.tick().catch(this.reportError);
    }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    // A persisted-process cleanup may be awaiting termination outside a run handle.
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 25));
    await Promise.allSettled([...this.active.values()].map(handle => handle.stop()));
    await Promise.allSettled([...this.pending]);
  }
}
