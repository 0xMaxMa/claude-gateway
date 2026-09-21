import { GatewayTaskTarget, TaskSnapshot, WorkerOutcome } from '../types';
import { TaskService } from '../tasks/service';
import { taskFailure } from '../tasks/failure';

export interface GatewayTaskAdapter {
  readonly name: string;
  discover(query?: string, offset?: number): unknown;
  resolve(input: Record<string, unknown>): GatewayTaskTarget;
  ready?(task: TaskSnapshot): boolean;
  submit(task: TaskSnapshot, requestId: string, instructions: string): Promise<void>;
  inspect(task: TaskSnapshot, requestId: string): Promise<WorkerOutcome | 'running' | 'pending'>;
  cancel(task: TaskSnapshot, requestId: string): Promise<void>;
}

/** Durable tracking of existing external execution. No model or worker is spawned
 * by this controller. Adapters own transport; the normal task service owns
 * authorization receipts, dependencies, cancellation and completion delivery. */
export class GatewayTaskController {
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private pending?: Promise<void>;
  constructor(private readonly tasks: TaskService, private readonly adapters: Map<string, GatewayTaskAdapter>, private readonly reportError: (e: unknown) => void = e => console.warn(JSON.stringify({event:'gateway_task_tracking_error',code:taskFailure(e).code}))) {}
  start(): void {
    this.timer = setInterval(() => { void this.tick().catch(this.reportError); }, 1000);
    this.timer.unref();
    void this.tick().catch(this.reportError);
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    const run = this.run();
    this.pending = run;
    void run.finally(() => { if (this.pending === run) this.pending = undefined; }).catch(this.reportError);
    return run;
  }
  private async run(): Promise<void> {
    const rows = this.tasks.store.all("SELECT id FROM tasks WHERE json_type(snapshot_json,'$.gatewayTarget')='object' AND state IN ('queued','starting','running','cancel_requested') ORDER BY created_at,id");
    for (const row of rows) {
      if (this.closed) return;
      let task = this.tasks.store.task(String(row.id))!;
      if (!task.gatewayTarget) continue;
      const attempt = task.activeAttemptId ? this.tasks.store.attempt(task.activeAttemptId) : this.tasks.claim(task.taskId);
      if (!attempt) continue;
      task = this.tasks.store.task(task.taskId)!;
      const adapter = this.adapters.get(task.gatewayTarget!.adapter);
      if (!adapter) {
        if (attempt.state === 'unknown') this.tasks.finishCleanup(attempt.attemptId, attempt.generation, false);
        else this.tasks.finish(attempt.attemptId, attempt.generation, {type:'unknown',failure:taskFailure(new Error('Gateway task adapter is unavailable'), 'GATEWAY_ADAPTER_UNAVAILABLE')});
        continue;
      }
      const requestId = task.gatewayDispatch?.requestId ?? `task-${attempt.attemptId}`;
      try {
        if (!task.gatewayDispatch) {
          if (task.state === 'cancel_requested') {
            this.tasks.finish(attempt.attemptId, attempt.generation, {type:'stopped'});
            continue;
          }
          // Serialize target writers even during the gap before the detached
          // CLI publishes its owner file. This fence survives gateway restart.
          const competing = this.tasks.store.get(`SELECT id FROM tasks WHERE id!=? AND active_attempt_id IS NOT NULL
            AND json_extract(snapshot_json,'$.gatewayDispatch.requestId') IS NOT NULL
            AND json_extract(snapshot_json,'$.gatewayTarget.adapter')=?
            AND json_extract(snapshot_json,'$.gatewayTarget.sessionId')=? LIMIT 1`, task.taskId, task.gatewayTarget!.adapter, task.gatewayTarget!.sessionId);
          if (competing || (adapter.ready && !adapter.ready(task))) continue;
          // Commit the dispatch fence BEFORE touching the target. A crash after
          // this point is inspected, never replayed on the assumption of failure.
          task.gatewayDispatch = {requestId, submittedAt:Date.now()};
          this.tasks.store.transaction(() => this.tasks.store.saveTask(task, task.stateVersion));
          await adapter.submit(task, requestId, this.tasks.revision(task.taskId, attempt.revision).instructions);
        }
        task = this.tasks.store.task(task.taskId)!;
        if (task.state === 'cancel_requested') await adapter.cancel(task, requestId);
        const outcome = await adapter.inspect(task, requestId);
        const current = this.tasks.store.task(task.taskId)!;
        if (current.activeAttemptId !== attempt.attemptId) continue;
        if (attempt.state === 'unknown') {
          if (current.state === 'cancel_requested' && outcome !== 'running' && outcome !== 'pending' && outcome.type !== 'unknown') this.tasks.finishCleanup(attempt.attemptId, attempt.generation, true);
          continue;
        }
        if (outcome === 'running') {
          if (current.state === 'starting') this.tasks.started(attempt.attemptId, attempt.generation);
        } else if (outcome === 'pending') {
          if (Date.now() - task.gatewayDispatch!.submittedAt > 120000) this.tasks.finish(attempt.attemptId, attempt.generation,
            {type:'unknown',failure:taskFailure(new Error('No durable request receipt. Inspect the target before retrying; the request was not sent again.'),'GATEWAY_REQUEST_UNCONFIRMED')});
        } else {
          if (current.state === 'starting') this.tasks.started(attempt.attemptId, attempt.generation);
          this.tasks.finish(attempt.attemptId, attempt.generation, outcome);
        }
      } catch (error) {
        // Transport/inspection failures cannot prove that the target stopped.
        if (attempt.state === 'unknown') { this.reportError(error); continue; }
        this.tasks.finish(attempt.attemptId, attempt.generation, {type: task.gatewayDispatch ? 'unknown' : 'failed',failure:taskFailure(error, task.gatewayDispatch ? 'GATEWAY_REQUEST_UNCONFIRMED' : 'GATEWAY_REQUEST_DENIED')});
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    // External sessions are intentionally left alive. Persisted receipts are
    // reconciled by the next gateway instance, without another dispatch.
  }
}
