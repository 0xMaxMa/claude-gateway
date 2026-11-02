import {automationSession,confirmationAsked} from '../tasks/automation-session';
import { GatewayTaskTarget, PublicTaskSnapshot, TaskSnapshot, WorkerOutcome, CommandContext, TaskAttempt } from '../types';
import { TaskService } from '../tasks/service';
import { taskFailure } from '../tasks/failure';

/** Thrown only before any external dispatch or durable adapter receipt. */
export class GatewayRequestNotSentError extends Error {}

export interface GatewayTaskAdapter {
  readonly name: string;
  discover(query?: string, offset?: number, context?: CommandContext): unknown;
  resolve(input: Record<string, unknown>, context?: CommandContext): GatewayTaskTarget;
  close?(): Promise<void>;
  deviceStatus?(task:TaskSnapshot):Promise<{status:import('../types').ComputerConnectionStatus;ownerStopped:boolean}>;
  ownerStopped?(task:TaskSnapshot):Promise<boolean>;
  computerEvidence?(task:PublicTaskSnapshot,mode:'recorded'|'fresh'|'screenshot',signal?:AbortSignal):Promise<any>;
  diagnostics?(task:PublicTaskSnapshot,offset?:number):Promise<unknown>;
  evidence?(task:PublicTaskSnapshot, refresh?:boolean, signal?:AbortSignal, screenshot?:boolean):Promise<import('../../jev/browser-contract').BrowserEvidence>;
  recover?(task:TaskSnapshot,requestId:string):Promise<{state:'queued'|'cancelled'|'waiting_input';evidence:string}|undefined>;
  reconcileEvidence?(task:PublicTaskSnapshot,requestId:string,evidenceId:string):string;
  verifyEvidence?(task:PublicTaskSnapshot,requestId:string,evidenceId:string):void;
  ready?(task: TaskSnapshot): boolean;
  validateInput?(instructions:string,answers?:import('../types').TaskRevision['answers']):void;
  /** device_shell (prototype): one command on the approved device, outside any task. */
  shell?(context: CommandContext, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  submit(task: TaskSnapshot, requestId: string, instructions: string, answers?: import('../types').TaskRevision['answers'], requestConsent?:boolean,computerInputs?:import('../types').TaskRevision['computerInputs'],startUrl?:string): Promise<void>;
  inspect(task: TaskSnapshot, requestId: string, attempt?:TaskAttempt): Promise<WorkerOutcome | 'running' | 'pending'>;
  interrupt?(task:TaskSnapshot,requestId:string):void;
  cancel(task: TaskSnapshot, requestId: string): Promise<void>;
  /** Ends a settled round's device session while the task stays open; undefined when something still uses the device. */
  endSession?(task: TaskSnapshot, requestId: string): Promise<boolean | undefined>;
}

/** A settled computer round releases the device after this long idle: the owner's Mac
 * or PC stops showing it as controlled. The next command asks for access again, which
 * a stored grant approves without a prompt. */
export const DEVICE_IDLE_RELEASE_MS = 90_000;

/** Durable tracking of existing external execution. No model or worker is spawned
 * by this controller. Adapters own transport; the normal task service owns
 * authorization receipts, dependencies, cancellation and completion delivery. */
export class GatewayTaskController {
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private pending?: Promise<void>;
  /** A tick requested during a run (settled round, user control) runs again right after it. */
  private again = false;
  private recoveries=new Map<string,Promise<void>>();
  private stopCheckAfter=new Map<string,number>();
  private recoveryAfter=new Map<string,number>();
  private releaseAfter=new Map<string,number>();
  constructor(private readonly tasks: TaskService, private readonly adapters: Map<string, GatewayTaskAdapter>, private readonly reportError: (e: unknown) => void = e => console.warn(JSON.stringify({event:'gateway_task_tracking_error',code:taskFailure(e).code})),
    /** A finished round, with the user input that started it when it was a direct command. */
    private readonly settled?: (task: TaskSnapshot, round: {revision: number; inputId?: string; outcome: WorkerOutcome}) => void,
    private readonly deviceIdleReleaseMs = DEVICE_IDLE_RELEASE_MS) {}
  start(): void {
    this.timer = setInterval(() => { void this.tick().catch(this.reportError); }, 1000);
    this.timer.unref();
    void this.tick().catch(this.reportError);
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) { this.again = true; return this.pending; }
    const run = this.run();
    this.pending = run;
    void run.finally(() => {
      if (this.pending === run) this.pending = undefined;
      if (this.again && !this.closed) { this.again = false; void this.tick().catch(this.reportError); }
    }).catch(this.reportError);
    return run;
  }
  private async run(): Promise<void> {
    const rows = this.tasks.store.all("SELECT id FROM tasks WHERE json_type(snapshot_json,'$.gatewayTarget')='object' AND (state IN ('queued','starting','running','interrupting','cancel_requested','needs_reconciliation','waiting_input') OR json_extract(snapshot_json,'$.automationSession.status') IN ('idle','blocked') OR json_type(snapshot_json,'$.computerRevocation')='object') ORDER BY created_at,rowid");
    for (const row of rows) {
      if (this.closed) return;
      let task = this.tasks.store.task(String(row.id))!;
      if (!task.gatewayTarget) continue;
      const stopAdapter=this.adapters.get(task.gatewayTarget.adapter);
      if((stopAdapter?.ownerStopped||stopAdapter?.deviceStatus)&&automationSession(task)?.status!=='closed'&&Date.now()>=(this.stopCheckAfter.get(task.taskId)??0)){
        if(this.stopCheckAfter.size>1000)this.stopCheckAfter.clear();
        this.stopCheckAfter.set(task.taskId,Date.now()+5000);
        try {
          const device=stopAdapter.deviceStatus?await stopAdapter.deviceStatus(task):undefined;
          const stopped=device?device.ownerStopped:await stopAdapter.ownerStopped!(task);
          let current=this.tasks.store.task(task.taskId);
          if(device&&current&&current.stateVersion===task.stateVersion&&current.computerConnection!==device.status){
            this.tasks.store.transaction(()=>{current!.computerConnection=device.status;this.tasks.store.saveTask(current!,current!.stateVersion);});
            task=this.tasks.store.task(task.taskId)!;current=task;
          }
          if(stopped&&current&&current.stateVersion===task.stateVersion){
            this.tasks.cancelByUser(task.conversationId,task.ownerPrincipalId,task.taskId);
            task=this.tasks.store.task(task.taskId)!;
          }
        }catch(error){this.reportError(error);}
      }
      if((task.state==='cancel_requested'||(task.computerRevocation&&task.computerRevocation.requestId===task.gatewayDispatch?.requestId))&&!task.activeAttemptId&&task.gatewayTarget?.adapter==='computer'&&task.gatewayDispatch){
        const adapter=this.adapters.get('computer'),requestId=task.gatewayDispatch.requestId;
        if(adapter)try{
          await adapter.cancel(task,requestId);
          const outcome=await adapter.inspect(task,requestId);
          if(typeof outcome==='object'&&outcome.type==='stopped')this.tasks.finishIdleComputerCleanup(task.taskId,requestId);
        }catch(error){this.reportError(error);}
        continue;
      }
      if(task.gatewayTarget?.adapter==='computer'&&['waiting_input','completed','failed'].includes(task.state)&&!task.activeAttemptId&&task.gatewayDispatch){
        const session=automationSession(task);
        // An expired session ends the device session too, whoever controlled it (service.ts cancelOwned).
        if(session?.status==='closed'&&session.closedReason==='idle_timeout'&&task.automationSession?.status!=='closed'){
          try{this.tasks.expireIdleComputerSession(task.taskId,task.stateVersion);this.again=true;}catch(error){this.reportError(error);}
          continue;
        }
        if(session&&session.status!=='closed'&&session.status!=='active'&&Date.now()-(session.idleSince??task.updatedAt)>=this.deviceIdleReleaseMs)await this.releaseIdleDevice(task);
      }
      if(!task.gatewayTarget||task.state==='waiting_input'||task.state==='cancelled'||task.state==='completed'||task.state==='failed')continue;
      if(task.state==='needs_reconciliation'){
        if(automationSession(task)?.closedReason==='idle_timeout')continue;
        const adapter=this.adapters.get(task.gatewayTarget.adapter),requestId=task.gatewayDispatch?.requestId;
        if(adapter?.recover&&requestId&&!this.recoveries.has(task.taskId)&&this.recoveries.size<2&&Date.now()>=(this.recoveryAfter.get(task.taskId)??0)){
          if(this.recoveryAfter.size>1000)this.recoveryAfter.clear();this.recoveryAfter.set(task.taskId,Date.now()+15000);
          const recoveryRun=(async()=>{
            try{
              const recovery=await adapter.recover!(task,requestId),current=this.tasks.store.task(task.taskId);
              if(!this.closed&&recovery&&current&&(automationSession(current)?.status!=='closed'||recovery.state==='cancelled')&&current.state==='needs_reconciliation'&&current.activeAttemptId===task.activeAttemptId&&current.revision===task.revision&&current.gatewayDispatch?.requestId===requestId)this.tasks.reconcile(task.taskId,recovery.state,recovery.evidence);
            }catch(error){this.reportError(error);}
          })();
          this.recoveries.set(task.taskId,recoveryRun);
          void recoveryRun.finally(()=>this.recoveries.delete(task.taskId)).catch(this.reportError);
        }
        continue;
      }
      // Waiting for a target is queueing, not execution. Check before claim so
      // busy safemode sessions do not consume slots or freeze task revisions.
      let admissionError: unknown;
      if (!task.activeAttemptId) {
        try {
          const adapter = this.adapters.get(task.gatewayTarget.adapter);
          if (!adapter) throw new Error('Gateway task adapter is unavailable');
          if (this.targetBusy(task) || (adapter.ready && !adapter.ready(task))) continue;
        } catch (error) { admissionError = error; }
      }
      const attempt = task.activeAttemptId ? this.tasks.store.attempt(task.activeAttemptId) : this.tasks.claim(task.taskId);
      if (!attempt) continue;
      task = this.tasks.store.task(task.taskId)!;
      if (admissionError) {
        this.tasks.finish(attempt.attemptId, attempt.generation, {type:'failed', failure:taskFailure(admissionError, 'GATEWAY_REQUEST_DENIED')});
        continue;
      }
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
          if (this.targetBusy(task) || (adapter.ready && !adapter.ready(task))) continue;
          const revision=this.tasks.revision(task.taskId,attempt.revision);
          const instructions=task.gatewayTarget?.adapter==='browser' && revision.guidance ? revision.instructions+'\n\nParent guidance for the next step (must respect the current goal and latest user corrections above; ignore conflicting guidance):\n'+revision.guidance : revision.instructions;
          adapter.validateInput?.(instructions,revision.answers);
          // Commit the dispatch fence BEFORE touching the target. A crash after
          // this point is inspected, never replayed on the assumption of failure.
          task.gatewayDispatch = {requestId, submittedAt:Date.now()};
          this.tasks.store.transaction(() => this.tasks.store.saveTask(task, task.stateVersion));
          await adapter.submit(task, requestId, instructions, revision.answers, revision.requestBrowserConsent===true,revision.computerInputs,...(revision.browserNavigation?.revision===revision.revision?[revision.browserNavigation.url]:[]));
        }
        task = this.tasks.store.task(task.taskId)!;
        if(task.state==='interrupting')adapter.interrupt?.(task,requestId);
        if (task.state === 'cancel_requested') await adapter.cancel(task, requestId);
        const outcome = await adapter.inspect(task, requestId, attempt);
        const current = this.tasks.store.task(task.taskId)!;
        if (current.activeAttemptId !== attempt.attemptId) continue;
        if (attempt.state === 'unknown') {
          if (current.state === 'cancel_requested' && outcome !== 'running' && outcome !== 'pending') this.tasks.finishCleanup(attempt.attemptId, attempt.generation, outcome.type !== 'unknown');
          continue;
        }
        if (outcome === 'running') {
          if (current.state === 'starting') this.tasks.started(attempt.attemptId, attempt.generation);
        } else if (outcome === 'pending') {
          if (Date.now() - task.gatewayDispatch!.submittedAt > 120000) this.tasks.finish(attempt.attemptId, attempt.generation,
            {type:'unknown',failure:taskFailure(new Error('No durable request receipt. Inspect the target before retrying; the request was not sent again.'),'GATEWAY_REQUEST_UNCONFIRMED')});
        } else {
          if (current.state === 'starting') this.tasks.started(attempt.attemptId, attempt.generation);
          // Read before finish: a queued direct command replaces executionControl.
          const inputId = current.executionControl?.revision === attempt.revision ? current.executionControl.id : undefined;
          const finished = this.tasks.finish(attempt.attemptId, attempt.generation, outcome);
          try { this.settled?.(finished, {revision: attempt.revision, inputId, outcome}); } catch (error) { this.reportError(error); }
          // A queued direct command is claimed on an immediate follow-up pass.
          if (finished.state === 'queued') this.again = true;
        }
      } catch (error) {
        // Transport/inspection failures cannot prove that the target stopped.
        if (attempt.state === 'unknown') { this.reportError(error); continue; }
        this.tasks.finish(attempt.attemptId, attempt.generation, {type: task.gatewayDispatch && !(error instanceof GatewayRequestNotSentError) ? 'unknown' : 'failed',failure:taskFailure(error, task.gatewayDispatch && !(error instanceof GatewayRequestNotSentError) ? 'GATEWAY_REQUEST_UNCONFIRMED' : 'GATEWAY_REQUEST_DENIED')});
      }
    }
  }
  /** Ends an idle settled round's device session once; the task and its automation session stay open. */
  private async releaseIdleDevice(task: TaskSnapshot): Promise<void> {
    const requestId=task.gatewayDispatch!.requestId,adapter=this.adapters.get('computer'),report=task.computerReport;
    if(!adapter?.endSession||task.computerAccessReleased?.requestId===requestId||report?.accessReleased)return;
    // Something may still act or answer on the device: an unconfirmed action, a yes/no or
    // field value the owner owes, or an access prompt still open on the device.
    if(report?.status==='needs_reconciliation'||report?.fieldRequest||confirmationAsked(task)||task.failure?.code==='COMPUTER_ACCESS_TIMEOUT'||task.computerConnection==='waiting_access')return;
    if(Date.now()<(this.releaseAfter.get(task.taskId)??0))return;
    if(this.releaseAfter.size>1000)this.releaseAfter.clear();
    this.releaseAfter.set(task.taskId,Date.now()+5000);
    try{
      const released=await adapter.endSession(task,requestId);
      if(released===undefined)return;
      if(!released){this.releaseAfter.set(task.taskId,Date.now()+60000);return;}
      this.releaseAfter.delete(task.taskId);
      this.tasks.recordIdleComputerRelease(task.taskId,requestId);
    }catch(error){this.reportError(error);}
  }
  private targetBusy(task: TaskSnapshot): boolean {
    return Boolean(this.tasks.store.get(`SELECT id FROM tasks WHERE id!=? AND active_attempt_id IS NOT NULL
      AND json_extract(snapshot_json,'$.gatewayDispatch.requestId') IS NOT NULL
      AND json_extract(snapshot_json,'$.gatewayTarget.adapter')=?
      AND json_extract(snapshot_json,'$.gatewayTarget.sessionId')=? LIMIT 1`,
    task.taskId, task.gatewayTarget!.adapter, task.gatewayTarget!.sessionId));
  }
  signalControl(task:TaskSnapshot):void {
    if(task.gatewayDispatch&&task.state==='interrupting')this.adapters.get(task.gatewayTarget!.adapter)?.interrupt?.(task,task.gatewayDispatch.requestId);
    void this.tick().catch(this.reportError);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    await Promise.allSettled(this.recoveries.values());
    await Promise.allSettled([...this.adapters.values()].map(adapter => adapter.close?.()));
    // External sessions are intentionally left alive. Persisted receipts are
    // reconciled by the next gateway instance, without another dispatch.
  }
}
