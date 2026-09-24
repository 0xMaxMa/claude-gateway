import {preparedBrowserAnswers} from '../browser-fields';
import {ComputerInputs} from '../../jev/computer-inputs';
import {automationSession} from './automation-session';
import { parentVerifiableBrowserResult } from '../../jev/browser-contract';
import { isAbsolute } from 'path';
import { parseWorkflow, advanceWorkflow } from '../workflow';
import { advanceTiming } from './timing';
import { taskDirective } from './task-directive';
import { normalizeTaskRevisions } from './task-directive';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { taskFailure } from './failure';
import { WorkerPool } from './pool';
import { randomUUID } from 'crypto';
import { OrchestrationStore, boundedText, payloadHash } from '../store';
import { resolveOrchestrationConfig, OrchestrationConfig } from '../config';
import { CommandContext, OrchestrationError, TaskSnapshot, TaskRevision, TaskAttempt, TaskResult, WorkerOutcome, TERMINAL_TASK_STATES, ChangeMode } from '../types';

export interface SpawnTask { browserFields?:unknown; computerInputs?:TaskRevision["computerInputs"]; gatewayTarget?: import("../types").GatewayTaskTarget; workingDirectory?: string; title: string; instructions: string; targetProfile: string; skill?: import('../skills').TaskSkill; contextRefs?: string[]; continueTaskId?: string; continuationPolicy?: 'after_success' | 'after_terminal'; }

/** How many finished tasks the per-turn index page keeps. Unfinished tasks are never dropped;
 * older finished ones stay reachable through task_status with an explicit task_id. */
const INDEXED_FINISHED_TASKS = 20;

export type TaskIndexEntry = ReturnType<typeof taskIndexEntry>;
/** One index row: identity, live state and how to fetch the rest — never a report body.
 * A finished task's progress, execution observation and workflow checkpoint/review history
 * are report bodies, so they are dropped here and read back via task_status when needed.
 */
export function taskIndexEntry(task: TaskSnapshot) {
  const terminal = TERMINAL_TASK_STATES.has(task.state);
  return {
    taskId: task.taskId, title: task.title, state: task.state,
    stateVersion: task.stateVersion, revision: task.revision, appliedRevision: task.appliedRevision,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
    workflow: terminal ? undefined : task.workflow,
    latestProgress: terminal ? undefined : task.latestProgress,
    execution: terminal ? undefined : task.execution,
    pendingQuestion: task.pendingQuestion, failure: task.failure,
    cancellation: task.cancellation, replacedByTaskId: task.replacedByTaskId,
    workstreamId: task.workstreamId, continueTaskId: task.continueTaskId, continuationPolicy: task.continuationPolicy,
    resultAvailable: Boolean(task.result),
    gatewayTarget: task.gatewayTarget, automationSession: automationSession(task),
    details: { tool: 'task_status', task_id: task.taskId },
  };
}

/** Task mutations use short durable transactions; admission probes are read-only. */
export class TaskService {
  private config;
  readonly pool: WorkerPool;
  constructor(readonly store: OrchestrationStore, config?: OrchestrationConfig, private readonly defaultProjectRoot = '') { this.config = resolveOrchestrationConfig(config); this.pool = new WorkerPool(store); }
  configure(config?: OrchestrationConfig): void { this.config = resolveOrchestrationConfig(config); }

  /** Admission feedback reaches the agent before a doomed task is committed. */
  async validateSpawnProfile(context: CommandContext, targetProfile: string): Promise<void> {
    // A committed receipt remains replayable even if its original repository disappeared.
    if (this.store.get('SELECT action_id FROM task_commands WHERE action_id=?', context.actionId)) return;
    if (targetProfile !== 'default-worker' || this.config.tasks.workspaceMode !== 'isolated-worktree') return;
    const root = this.config.tasks.projectRoot || this.defaultProjectRoot;
    try {
      await promisify(execFile)('git', ['-C', root, 'rev-parse', '--show-toplevel'], { timeout: 3000, maxBuffer: 4096 });
    } catch {
      throw new OrchestrationError('WORKER_GIT_PROJECT_REQUIRED',
        'No task was queued: explicitly configured isolated-worktree mode could not validate the Git repository for default-worker. This requirement applies only to worktree isolation, not ordinary host/container execution. For GitHub status/API commands or other standalone work, use media-worker with an explicit repository (for example gh --repo owner/repo), preserving continue_task_id and existing user authorization. For project edits, configure tasks.projectRoot to the intended repository. Do not switch to host execution or replay already completed side effects.');
    }
  }

  private command<T>(context: CommandContext, kind: string, payload: unknown, execute: boolean, operation: () => T, taskId?: string): T {
    return this.store.transaction(() => {
      this.store.assertMember(context.conversationId, context.principalId);
      boundedText(context.actionId, 1024);
      const hash = payloadHash({ kind, payload, inputId: context.inputId });
      const prior = this.store.get('SELECT * FROM task_commands WHERE action_id=?', context.actionId);
      // A committed command survives its decision being interrupted. Check its
      // original identity before returning the saved receipt, then fence new work.
      if (prior) {
        if (prior.conversation_id !== context.conversationId || prior.principal_id !== context.principalId) throw new OrchestrationError('ACCESS_DENIED');
        if (prior.payload_hash !== hash) throw new OrchestrationError('IDEMPOTENCY_CONFLICT');
        return JSON.parse(String(prior.receipt_json)) as T;
      }
      const decision = this.store.get(`SELECT d.* FROM conversation_decisions d JOIN conversations c ON c.id=d.conversation_id
        WHERE d.id=? AND d.conversation_id=? AND d.epoch=? AND c.epoch=d.epoch AND d.state='running'`, context.decisionId, context.conversationId, context.epoch);
      if (!decision) throw new OrchestrationError('STALE_DECISION');
      const input = this.store.get('SELECT id FROM conversation_inputs WHERE id=? AND conversation_id=? AND principal_id=?', context.inputId, context.conversationId, context.principalId);
      if (!input || !(JSON.parse(String(decision.input_ids_json)) as string[]).includes(context.inputId)) throw new OrchestrationError('ACCESS_DENIED');
      if (execute && !context.execute) throw new OrchestrationError('EXECUTION_DENIED');
      // Recovery may re-run inference with new tool-call IDs or rephrased args.
      // Only replay committed receipts for this original input; new mutations
      // require a new user input rather than guessing whether effects happened.
      const recovered = this.store.all(`SELECT tc.* FROM task_commands tc
        JOIN conversation_decisions d ON d.id=tc.decision_id
        WHERE tc.conversation_id=? AND tc.principal_id=? AND d.id!=? AND d.state='interrupted'
        AND EXISTS (SELECT 1 FROM json_each(d.input_ids_json) WHERE value=?)`,
        context.conversationId, context.principalId, context.decisionId, context.inputId);
      if (recovered.length) {
        const receipt = recovered.find(row => row.payload_hash === hash);
        if (receipt) return JSON.parse(String(receipt.receipt_json)) as T;
        throw new OrchestrationError('RECOVERY_COMMAND_CONFLICT', 'This input already committed task commands before interruption. Inspect their receipts; new changes require a new user input.');
      }

      const receipt = operation();
      const id = taskId ?? (receipt as { taskId?: string })?.taskId ?? null;
      this.store.run('INSERT INTO task_commands VALUES(?,?,?,?,?,?,?,?,?)', context.actionId, id, context.conversationId,
        context.principalId, context.decisionId, kind, hash, JSON.stringify(receipt), Date.now());
      return receipt;
    });
  }
  /** Question presentation has the same ownership, epoch and replay fences as task commands. */
  questionAction<T>(context: CommandContext, payload: unknown, operation: () => T): T {
    return this.command(context, 'question', payload, false, operation);
  }
  private owned(taskId: string, conversationId: string): TaskSnapshot {
    const task = this.store.task(taskId);
    if (!task || task.conversationId !== conversationId) throw new OrchestrationError('ACCESS_DENIED');
    return task;
  }
  status(conversationId: string, principalId: string, taskId?: string): Array<TaskSnapshot & { currentInstructions?: string }> {
    this.store.assertMember(conversationId, principalId);
    if (taskId) { const task = this.owned(taskId, conversationId); delete task.skill; return [this.withRecentTools(task)]; }
    return this.store.all(`SELECT snapshot_json FROM tasks WHERE conversation_id=? AND (state NOT IN ('completed','failed','cancelled') OR (json_extract(snapshot_json,'$.automationSession.status') IN ('idle','blocked') AND json_extract(snapshot_json,'$.automationSession.idleSince')+json_extract(snapshot_json,'$.automationSession.idleTimeoutMs')>${Date.now()}) OR id IN
      (SELECT id FROM tasks WHERE conversation_id=? AND state IN ('completed','failed','cancelled') ORDER BY created_at DESC,id DESC LIMIT 100))
      ORDER BY CASE WHEN state IN ('completed','failed','cancelled') THEN 1 ELSE 0 END,created_at DESC,id DESC`, conversationId, conversationId).map(row => {
      const task = JSON.parse(String(row.snapshot_json)) as TaskSnapshot;
      const waiting = task.state === 'queued' && this.store.get('SELECT waiting_json FROM provider_waits WHERE entity_id=?', task.taskId);
      if (waiting) task.providerWaiting = JSON.parse(String(waiting.waiting_json));
      else delete task.providerWaiting;
      delete task.skill; // Installed skill bodies are worker-only execution context.
      return this.withRecentTools(task);
    });
  }
  /** Current reports are lossless. Other tasks are an index, never partial reports.
   * Every decision turn carries this, so it is a bounded page of the recent tasks rather
   * than the whole history: an index entry is identity, live state and how to fetch the
   * rest, and task_status with a task_id returns the complete stored snapshot on demand.
   */
  context(conversationId: string, principalId: string, decisionId: string) {
    this.store.assertMember(conversationId, principalId);
    const reporting = new Set(this.store.all(
      "SELECT DISTINCT task_id FROM notifications WHERE conversation_id=? AND decision_id=? AND status='assigned'",
      conversationId, decisionId,
    ).map(row => String(row.task_id)));
    // Only a reporting task is hydrated. Indexed rows are read straight from the stored
    // snapshot, so they cost no per-task evidence queries and no report bodies either.
    const rows = new Map<string, TaskSnapshot | TaskIndexEntry>(
      this.indexPage(conversationId).map(task => [task.taskId, taskIndexEntry(task)]));
    // An old task can finish after it has fallen outside the recent-task page.
    for (const id of reporting) rows.set(id, this.status(conversationId, principalId, id)[0]);
    return [...rows.values()];
  }
  /** Bounded recent-task page: every unfinished task, plus only the newest finished ones. */
  private indexPage(conversationId: string): TaskSnapshot[] {
    return this.store.all(`SELECT snapshot_json FROM tasks WHERE conversation_id=? AND (state NOT IN ('completed','failed','cancelled') OR (json_extract(snapshot_json,'$.automationSession.status') IN ('idle','blocked') AND json_extract(snapshot_json,'$.automationSession.idleSince')+json_extract(snapshot_json,'$.automationSession.idleTimeoutMs')>${Date.now()}) OR id IN
      (SELECT id FROM tasks WHERE conversation_id=? AND state IN ('completed','failed','cancelled') ORDER BY created_at DESC,id DESC LIMIT ${INDEXED_FINISHED_TASKS}))
      ORDER BY CASE WHEN state IN ('completed','failed','cancelled') THEN 1 ELSE 0 END,created_at DESC,id DESC`,
      conversationId, conversationId).map(row => JSON.parse(String(row.snapshot_json)) as TaskSnapshot);
  }
  private withRecentTools(task: TaskSnapshot): TaskSnapshot & { currentInstructions?: string } {
    task.automationSession = automationSession(task);
    task.recentTools = this.store.all("SELECT payload_json,occurred_at FROM conversation_events WHERE conversation_id=? AND type='tool.activity' AND json_extract(payload_json,'$.task_id')=? ORDER BY seq DESC LIMIT 8", task.conversationId, task.taskId).map(row => {
      const event = JSON.parse(String(row.payload_json)).payload;
      return {name: String(event.name ?? 'unknown'), description: typeof event.input?.description === 'string' ? taskFailure(new Error(event.input.description)).message.slice(0,512) : undefined, type: String(event.type), isError: event.is_error, occurredAt: Number(row.occurred_at)};
    });
    task.workspaceEvidence = {
      registered: this.store.all('SELECT mode,worktree_path,lifecycle_state FROM task_resources WHERE task_id=?', task.taskId)
        .map(row => ({ mode: String(row.mode), path: String(row.worktree_path), lifecycleState: String(row.lifecycle_state) })),
      observedFilePaths: this.store.all("SELECT DISTINCT json_extract(payload_json,'$.payload.input.file_path') AS path FROM conversation_events WHERE conversation_id=? AND type='tool.activity' AND json_extract(payload_json,'$.task_id')=? AND json_type(payload_json,'$.payload.input.file_path')='text' ORDER BY seq DESC LIMIT 12", task.conversationId, task.taskId)
        .map(row => String(row.path).slice(0,2048)),
      currentFilesystemVerified: false,
    };
    // Direct corrections bypass the parent inference turn. Hydrated status and
    // notifications must carry the current goal so verification cannot use stale memory.
    return ['browser','computer'].includes(task.gatewayTarget?.adapter ?? '')
      ? {...task,currentInstructions:this.revision(task.taskId,task.revision).instructions}
      : task;
  }
  spawn(context: CommandContext, command: SpawnTask): TaskSnapshot {
    if(command.computerInputs!==undefined){command.computerInputs=ComputerInputs.parse(command.computerInputs);if(command.gatewayTarget?.adapter!=='computer')throw new OrchestrationError('INVALID_INPUT');}
    if (command.workingDirectory !== undefined) {
      if (this.config.tasks.workspaceMode !== 'host') throw new OrchestrationError('WORKING_DIRECTORY_HOST_ONLY');
      if (typeof command.workingDirectory !== 'string' || !isAbsolute(command.workingDirectory) || /[\r\n\0]/.test(command.workingDirectory) || Buffer.byteLength(command.workingDirectory) > 4096) throw new OrchestrationError('INVALID_WORKING_DIRECTORY');
    }
    if (command.continueTaskId !== undefined) boundedText(command.continueTaskId, 128);
    if (command.continuationPolicy !== undefined && (!command.continueTaskId || !['after_success', 'after_terminal'].includes(command.continuationPolicy))) throw new OrchestrationError('INVALID_INPUT');
    const prepared=preparedBrowserAnswers(command.browserFields,context.inputId);
    if(command.browserFields!==undefined&&command.gatewayTarget?.adapter!=='browser')throw new OrchestrationError('INVALID_BROWSER_FIELDS');
    boundedText(command.title, 512); boundedText(command.instructions); boundedText(command.targetProfile, 128);
    if ((command.contextRefs?.length ?? 0) > 64 || command.contextRefs?.some(ref => typeof ref !== 'string' || ref.length > 1024)) throw new OrchestrationError('INVALID_INPUT');
    if (!['default-worker', 'media-worker', 'skill-worker', 'gateway-managed'].includes(command.targetProfile)) throw new OrchestrationError('UNKNOWN_WORKER_PROFILE');
    if ((command.targetProfile === 'gateway-managed') !== Boolean(command.gatewayTarget)) throw new OrchestrationError('INVALID_GATEWAY_TARGET');
    if (command.gatewayTarget && (command.workingDirectory || command.skill || command.contextRefs?.length)) throw new OrchestrationError('INVALID_GATEWAY_TARGET');
    return this.command(context, 'spawn', command, true, () => {
      const conversation = this.store.get('SELECT * FROM conversations WHERE id=?', context.conversationId)!;
      if(['browser','computer'].includes(command.gatewayTarget?.adapter ?? '')) {
        const existing=this.store.all("SELECT snapshot_json FROM tasks WHERE conversation_id=? AND json_extract(snapshot_json,'$.gatewayTarget.adapter')=? AND json_extract(snapshot_json,'$.gatewayTarget.sessionId')=?",context.conversationId,command.gatewayTarget!.adapter,command.gatewayTarget!.sessionId).map(row=>JSON.parse(String(row.snapshot_json)) as TaskSnapshot).find(task=>task.ownerPrincipalId===context.principalId && automationSession(task)?.status!=='closed');
        if(existing)throw new OrchestrationError('AUTOMATION_SESSION_EXISTS',`This device session already has task ${existing.taskId} at revision ${existing.revision}. Inspect it and use task_update when_ready for the next goal on the same task. Do not open another tab or replay completed work.`);
      }

      const available = new Set<string>();
      for (const input of this.store.all('SELECT id,attachment_refs_json FROM conversation_inputs WHERE conversation_id=?', context.conversationId)) {
        available.add(String(input.id)); available.add(`input:${input.id}`);
        for (const ref of JSON.parse(String(input.attachment_refs_json)) as string[]) available.add(ref);
      }
      for (const resource of this.store.all('SELECT r.id FROM task_resources r JOIN tasks t ON r.task_id=t.id WHERE t.conversation_id=?', context.conversationId)) available.add(String(resource.id));
      for (const file of this.store.all('SELECT f.id,f.path FROM task_files f JOIN tasks t ON f.task_id=t.id WHERE t.conversation_id=? AND t.state=?', context.conversationId, 'completed')) { available.add(String(file.id)); available.add(String(file.path)); }
      if (command.contextRefs?.some(ref => !available.has(ref))) throw new OrchestrationError('CONTEXT_ACCESS_DENIED');
      if (conversation.status !== 'active') throw new OrchestrationError('DRAINING');
      const queued = this.store.all("SELECT conversation_id,COUNT(*) AS n FROM tasks WHERE state='queued' GROUP BY conversation_id");
      if (queued.reduce((n, row) => n + Number(row.n), 0) >= this.config.tasks.maxQueuedPerAgent || Number(queued.find(row => row.conversation_id === context.conversationId)?.n ?? 0) >= this.config.tasks.maxQueuedPerConversation) throw new OrchestrationError('QUEUE_FULL');
      const prior = command.continueTaskId ? this.owned(command.continueTaskId, context.conversationId) : undefined;
      const now = Math.max(Date.now(), (prior?.createdAt ?? 0) + 1);
      const task: TaskSnapshot = { taskId: randomUUID(), conversationId: context.conversationId,
        agentId: this.store.agentId, agentSessionId: String(conversation.agent_session_id), ownerPrincipalId: context.principalId,
        initiatingInputId: context.inputId, title: command.title, targetProfile: command.targetProfile,
        state: 'queued', stateVersion: 1, revision: 1, appliedRevision: 0,
        timing: { phase: 'queued', since: Date.now(), measuredFrom: Date.now(), totals: {} },
        capabilities: { execute: context.execute, writeMemory: context.writeMemory }, createdAt: now, updatedAt: now };
      task.workstreamId = prior?.workstreamId ?? prior?.taskId ?? task.taskId;
      if (prior) {
        task.continueTaskId = prior.taskId;
        task.continuationPolicy = command.continuationPolicy ?? 'after_success';
        task.latestProgress = { source: 'runtime', observedAt: now, text: `Queued after task ${prior.taskId} (${task.continuationPolicy}).` };
      }
      if (command.gatewayTarget) { task.gatewayTarget = command.gatewayTarget;
        if (["browser","computer"].includes(command.gatewayTarget.adapter)) task.automationSession={status:"active",idleTimeoutMs:this.config.tasks.automationIdleTimeoutMs};
      }
      if (command.skill) task.skill = command.skill;
      if (context.model && !command.gatewayTarget) task.model = context.model;
      const projectRoot = command.workingDirectory || (this.config.tasks.workspaceMode === 'host' && prior?.resourceProfile?.mode === 'host' ? prior.resourceProfile.projectRoot : undefined) || this.config.tasks.projectRoot || this.defaultProjectRoot;
      if (projectRoot && !command.gatewayTarget) task.resourceProfile = { projectRoot, mode: this.config.tasks.workspaceMode };
      this.store.run('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)', task.taskId, task.conversationId, task.state, 1, 1, null, JSON.stringify(task), now, now);
      const revision: TaskRevision = { requestBrowserConsent:command.gatewayTarget?.adapter==='browser', taskId: task.taskId, revision: 1, instructions: command.instructions, computerInputs:command.computerInputs,
        answers:prepared, contextRefs: command.contextRefs ?? [], mode: 'when_ready', originatingInputId: context.inputId };
      this.store.run('INSERT INTO task_revisions VALUES(?,?,?)', task.taskId, 1, JSON.stringify(revision));
      this.store.appendEvent(task.conversationId, 'task.created', task, task.taskId);
      this.store.enqueue('schedule', `schedule:${task.taskId}:1`, { taskId: task.taskId });
      return task;
    });
  }
  update(context: CommandContext, taskId: string, expectedRevision: number, instruction: string, mode: ChangeMode, browserFields?:unknown, computerInputs?:TaskRevision["computerInputs"]): TaskSnapshot {
    boundedText(instruction);if(computerInputs!==undefined)computerInputs=ComputerInputs.parse(computerInputs);
    if (!['when_ready', 'interrupt_and_resume'].includes(mode)) throw new OrchestrationError('INVALID_INPUT');
    const prepared=preparedBrowserAnswers(browserFields,context.inputId);
    return this.command(context, 'update', { taskId, expectedRevision, instruction, mode, browserFields, computerInputs }, context.execute, () => {
      const task = this.owned(taskId, context.conversationId), version = task.stateVersion;
      if(computerInputs!==undefined&&task.gatewayTarget?.adapter!=='computer')throw new OrchestrationError('INVALID_INPUT');
      if(automationSession(task)?.status==='closed')throw new OrchestrationError('AUTOMATION_SESSION_CLOSED','This automation session was ended or expired. Ask for a new authorized session; never replay its previous action.');
      const completionReview = task.gatewayTarget?.adapter === 'browser' && task.state === 'needs_reconciliation' &&
        Boolean(task.activeAttemptId) && task.browserReport?.status === 'needs_verification' &&
        ['COMPLETION_CANDIDATE','VERIFICATION_FAILED'].includes(task.browserReport.reason) &&
        !task.browserReport.providerFailure && task.browserReport.lastAction?.outcome !== 'unknown';
      const computerRecovery=!context.execute&&task.gatewayTarget?.adapter==='computer'&&task.capabilities.execute&&task.ownerPrincipalId===context.principalId&&task.state==='failed'&&!task.activeAttemptId&&['COMPLETION_CANDIDATE','VERIFICATION_FAILED','NO_SUPPORTED_ACTION','COMPUTER_TEXT_UNGROUNDED'].includes(task.computerReport?.reason??'')&&Boolean(this.store.get("SELECT id FROM notifications WHERE task_id=? AND decision_id=? AND status='assigned' AND task_state_version=?",taskId,context.decisionId,task.stateVersion));
      const browserRecovery = computerRecovery || !context.execute && task.gatewayTarget?.adapter === 'browser' &&
        task.capabilities.execute && task.ownerPrincipalId === context.principalId &&
        !task.browserReport?.providerFailure && task.browserReport?.lastAction?.outcome !== 'unknown' &&
        (completionReview || (task.state === 'failed' && !task.activeAttemptId &&
        ['LOW_OPERATION_CONFIDENCE','LOW_TARGET_CONFIDENCE','STALE_RETRY_BUDGET','PAGE_CONTENT_UNAVAILABLE','MODEL_BLOCKED','OBSERVATION_TRUNCATED','NO_PROGRESS','NO_SUPPORTED_ACTION','TEXT_BUDGET'].includes(task.browserReport?.reason ?? ''))) &&
        Boolean(this.store.get("SELECT id FROM notifications WHERE task_id=? AND decision_id=? AND status='assigned' AND task_state_version=?",taskId,context.decisionId,task.stateVersion));
      if (TERMINAL_TASK_STATES.has(task.state) && !(task.gatewayTarget && (context.execute || browserRecovery) && ['completed','failed'].includes(task.state) && !task.activeAttemptId)) throw new OrchestrationError('TASK_TERMINAL');
      if (['cancel_requested', 'recovering', 'needs_reconciliation', 'interrupting'].includes(task.state) && !(completionReview && (context.execute || browserRecovery))) throw new OrchestrationError('STATE_CONFLICT');
      if (task.revision !== expectedRevision) throw new OrchestrationError('REVISION_CONFLICT');
      if (task.gatewayTarget && (task.ownerPrincipalId !== context.principalId || (!context.execute && !browserRecovery))) throw new OrchestrationError('EXECUTION_DENIED');
      if (task.gatewayTarget && mode !== 'when_ready') throw new OrchestrationError('INVALID_INPUT', 'Use when_ready for Gateway-managed tasks; the current request must settle before revised instructions run.');
      if(browserFields!==undefined&&task.gatewayTarget?.adapter!=='browser')throw new OrchestrationError('INVALID_BROWSER_FIELDS');
      const priorRevision = this.revision(taskId, expectedRevision);
      if (browserRecovery && ((priorRevision.browserRecoveryCount ?? 0) >= 3 || priorRevision.guidance === instruction))
        throw new OrchestrationError('BROWSER_RECOVERY_EXHAUSTED', 'Inspect the evidence and explain the unresolved blocker; do not repeat the same plan.');
      if (!context.execute && !browserRecovery) {
        // A worker progress report increments stateVersion without revoking this
        // alert. Bind advice to the immutable alert and attempt, not that counter.
        const assigned = this.store.get(`SELECT n.id FROM notifications n JOIN conversation_events e
          ON e.conversation_id=n.conversation_id AND e.type='task.state_changed'
          AND json_extract(e.payload_json,'$.payload.taskId')=n.task_id
          AND json_extract(e.payload_json,'$.payload.stateVersion')=n.task_state_version
          WHERE n.task_id=? AND n.decision_id=? AND n.status='assigned'
          AND json_extract(e.payload_json,'$.payload.supervision.id')=?
          AND json_extract(e.payload_json,'$.payload.activeAttemptId')=? LIMIT 1`,
          taskId, context.decisionId, task.supervision?.id ?? '', task.activeAttemptId ?? '');
        const alreadyAdvised = this.store.get("SELECT action_id FROM task_commands WHERE task_id=? AND decision_id=? AND command_type='update' LIMIT 1", taskId, context.decisionId);
        if (!assigned || alreadyAdvised || !task.supervision || task.state !== 'running' || !task.capabilities.execute || mode !== 'when_ready') throw new OrchestrationError('EXECUTION_DENIED');
      }
      if(completionReview) {
        const attempt=this.store.attempt(task.activeAttemptId!)!;
        attempt.state='ended';this.store.saveAttempt(attempt);this.pool.release(task.taskId,false);
        task.activeAttemptId=undefined;task.state='failed';
      }
      task.revision++;
      const revision: TaskRevision = { requestBrowserConsent:context.execute && task.gatewayTarget?.adapter==='browser', taskId, revision: task.revision, instructions: instruction, computerInputs:context.execute||computerRecovery?computerInputs:priorRevision.computerInputs,
        answers:prepared, contextRefs: priorRevision.contextRefs, mode, originatingInputId: context.inputId,
        ...(!context.execute&&!computerRecovery ? { instructions: priorRevision.instructions, answers: prepared??priorRevision.answers, originatingInputId: priorRevision.originatingInputId, guidance: instruction, guidanceBasis: {attemptId: task.activeAttemptId, workflowVersion: task.workflow?.version??0, progressAt: task.latestProgress?.observedAt??0} } : {}),
        ...(browserRecovery ? {browserRecoveryCount:(priorRevision.browserRecoveryCount ?? 0)+1,guidanceBasis:undefined} : {}) };
      this.store.run('INSERT INTO task_revisions VALUES(?,?,?)', taskId, task.revision, JSON.stringify(revision));
      if (task.gatewayTarget && ['completed','failed'].includes(task.state)) { task.state='queued'; delete task.gatewayDispatch; delete task.executionControl; delete task.failure; delete task.result; delete task.browserReport; delete task.computerReport; delete task.latestProgress; if(context.execute)task.initiatingInputId=context.inputId; }
      if (task.state === 'waiting_input') { task.pendingQuestion = undefined; task.state = task.activeAttemptId ? (task.gatewayTarget ? 'running' : 'interrupting') : 'queued'; }
      else if (mode === 'interrupt_and_resume' && task.activeAttemptId) task.state = 'interrupting';
      this.store.saveTask(task, version);
      this.store.appendEvent(task.conversationId, 'task.revision_accepted', { taskId, revision: task.revision }, taskId);
      this.store.enqueue(task.state === 'interrupting' ? 'interrupt' : 'schedule', `revision:${taskId}:${task.revision}`, { taskId });
      return task;
    }, taskId);
  }
  /** Direct authenticated user control: no inference turn, no second task. */
  controlByUser(conversationId:string,principalId:string,taskId:string,command:{id:string;action:'pause'|'revise'|'resume';expectedRevision:number;text?:string}):TaskSnapshot {
    return this.store.transaction(()=>{
      this.store.assertMember(conversationId,principalId);
      const task=this.owned(taskId,conversationId);
      if(task.ownerPrincipalId!==principalId)throw new OrchestrationError('ACCESS_DENIED');
      if(!/^[0-9a-f-]{36}$/i.test(command.id)||!['pause','revise','resume'].includes(command.action)||!Number.isSafeInteger(command.expectedRevision))throw new OrchestrationError('INVALID_INPUT');
      const id='user-control:'+command.id,hash=payloadHash({taskId,...command});
      const prior=this.store.get('SELECT * FROM task_commands WHERE action_id=?',id);
      if(prior){if(prior.principal_id!==principalId||prior.conversation_id!==conversationId)throw new OrchestrationError('ACCESS_DENIED');if(prior.payload_hash!==hash)throw new OrchestrationError('IDEMPOTENCY_CONFLICT');return task;}
      if(!['browser','computer'].includes(task.gatewayTarget?.adapter??'')||!task.capabilities.execute)throw new OrchestrationError('EXECUTION_DENIED');
      if(automationSession(task)?.status==='closed')throw new OrchestrationError('AUTOMATION_SESSION_CLOSED');
      if(task.revision!==command.expectedRevision)throw new OrchestrationError('REVISION_CONFLICT');
      const paused=task.state==='waiting_input'&&!task.activeAttemptId&&(task.executionControl?.phase==='paused'||['THINKING_WAITING_INPUT','COMMAND_WAITING_INPUT'].includes(task.computerReport?.reason??task.browserReport?.reason??''));
      const completedRound=command.action==='revise'&&task.state==='completed'&&!task.activeAttemptId;
      const stoppedBrowser=command.action==='revise' && task.state==='failed' && !task.activeAttemptId &&
        task.gatewayTarget?.adapter==='browser' && task.browserReport?.status==='blocked' &&
        task.browserReport.reason!=='OUTCOME_UNKNOWN' && !task.browserReport.providerFailure &&
        task.browserReport.lastAction?.outcome!=='unknown';
      const stoppedComputer=command.action==='revise'&&task.state==='failed'&&!task.activeAttemptId&&task.gatewayTarget?.adapter==='computer'&&task.computerReport?.status==='blocked'&&['NO_SUPPORTED_ACTION','ACTION_BUDGET','THINKING_WAITING_INPUT','THINKING_SCREENSHOT_REQUIRED'].includes(task.computerReport.reason);
      const recoverable=stoppedBrowser||stoppedComputer||completedRound;
      if(!['queued','starting','running','interrupting'].includes(task.state)&&!paused&&!recoverable)throw new OrchestrationError('STATE_CONFLICT');
      if(command.action==='resume'&&!paused)throw new OrchestrationError('STATE_CONFLICT');
      if(command.action==='revise')boundedText(command.text??'',4000);
      else if(command.text!==undefined)throw new OrchestrationError('INVALID_INPUT');
      const previous=this.revision(taskId,task.revision);
      const priorAnswers=previous.answers?.map(a=>({field:a.browserFieldLabel??a.computerFieldLabel,text:a.text}));
      const nextCommand=command.action==='revise'&&(paused||recoverable);
      const instructions=nextCommand?'Current user command (use the fresh screen; do not replay previous commands):\n'+command.text:command.action==='revise'?'Latest user correction (apply first; supersedes conflicting earlier requirements):\n'+command.text+'\n\nEarlier requirements and corrections, newest first. Keep only requirements compatible with the latest correction; do not perform superseded actions:\n'+previous.instructions+(priorAnswers?.length?'\n\nEarlier user answers (subject to the latest correction):\n'+JSON.stringify(priorAnswers):''):previous.instructions;
      boundedText(instructions,task.gatewayTarget?.adapter==='browser'?8000:16000);
      task.revision++;
      if(recoverable){delete task.computerReport;delete task.failure;delete task.browserReport;delete task.gatewayDispatch;}
      this.store.run('INSERT INTO task_revisions VALUES(?,?,?)',taskId,task.revision,JSON.stringify({...previous,requestBrowserConsent:command.action!=='pause',revision:task.revision,instructions,mode:'interrupt_and_resume',computerInputs:command.action==='revise'?undefined:previous.computerInputs,answers:command.action==='revise'?undefined:previous.answers,browserRecoveryCount:0,guidance:undefined,guidanceBasis:undefined}));
      task.executionControl={id:command.id,action:command.action,revision:task.revision,phase:task.activeAttemptId?'pending':command.action==='pause'?'paused':'pending',requestedAt:Date.now()};
      task.state=task.activeAttemptId?'interrupting':command.action==='pause'?'waiting_input':'queued';
      task.latestProgress={source:'runtime',observedAt:Date.now(),text:task.activeAttemptId?'Control accepted; settling the current action before applying it.':command.action==='pause'?'Automation paused.':'Control accepted; resuming from a fresh observation.'};
      this.store.saveTask(task,task.stateVersion);
      this.store.appendEvent(conversationId,'task.control_accepted',{taskId,control:task.executionControl},taskId);
      this.store.run('INSERT INTO task_commands VALUES(?,?,?,?,?,?,?,?,?)',id,taskId,conversationId,principalId,null,'user_control',hash,JSON.stringify(task),Date.now());
      return task;
    });
  }
  cancel(context: CommandContext, taskId: string, replacedByTaskId?: string): TaskSnapshot {
    return this.command(context, 'cancel', { taskId, ...(replacedByTaskId ? { replacedByTaskId } : {}) }, false, () => this.cancelOwned(context.conversationId, taskId, replacedByTaskId), taskId);
  }
  /** Authenticated user control bypasses inference, but retains conversation ownership and task fencing. */
  cancelByUser(conversationId: string, principalId: string, taskId: string): TaskSnapshot {
    return this.store.transaction(() => {
      this.store.assertMember(conversationId, principalId);
      const task = this.cancelOwned(conversationId, taskId, undefined, 'user');
      this.store.appendEvent(conversationId, 'task.user_cancel', { taskId, principalId, state: task.state }, taskId);
      return task;
    });
  }
  private cancelOwned(conversationId: string, taskId: string, replacedByTaskId?: string, requestedBy: 'user' | 'agent' = 'agent'): TaskSnapshot {
    const task = this.owned(taskId, conversationId);
    if (replacedByTaskId) {
      if (replacedByTaskId === taskId) throw new OrchestrationError('INVALID_REPLACEMENT');
      this.owned(replacedByTaskId, conversationId);
    }
    if (TERMINAL_TASK_STATES.has(task.state)) {
      const session=automationSession(task);
      if(session && session.status!=='closed'){task.automationSession={...session,status:'closed',closedAt:Date.now(),closedReason:requestedBy};this.store.saveTask(task,task.stateVersion);}
      return task;
    }
    if (task.state === 'cancel_requested') {
      if (replacedByTaskId) { task.replacedByTaskId = replacedByTaskId; this.store.saveTask(task, task.stateVersion); }
      return task;
    }
    if (replacedByTaskId) task.replacedByTaskId = replacedByTaskId;
    const version = task.stateVersion;
    task.cancellation = { requestedBy, requestedAt: Date.now() };
    task.state = task.activeAttemptId ? 'cancel_requested' : 'cancelled';
    task.pendingQuestion = undefined;
    delete task.failure;
    task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: task.activeAttemptId ? `Cancellation requested by ${requestedBy}; verifying that task execution has stopped.` : `Cancelled by ${requestedBy}. Existing files and prior effects are retained.` };
    this.store.saveTask(task, version);
    if (task.state === 'cancelled') this.notify(task);
    else this.store.enqueue('interrupt', `cancel:${taskId}:${task.stateVersion}`, { taskId });
    return task;
  }
  /** Scheduler-only cleanup acknowledgment; never authorizes new worker writes. */
  finishCleanup(attemptId: string, generation: number, stopped: boolean): void {
    this.store.transaction(() => {
      const attempt = this.store.attempt(attemptId), task = attempt && this.store.task(attempt.taskId);
      if (!attempt || !task || attempt.generation !== generation || task.activeAttemptId !== attemptId || task.state !== 'cancel_requested') throw new OrchestrationError('STALE_ATTEMPT');
      const message = stopped ? `Cancelled by ${task.cancellation?.requestedBy ?? 'agent'}. Task execution stopped; existing files and prior effects are retained.` : 'Cannot verify that this task has stopped. Retry cleanup; no unrelated processes were stopped.';
      task.state = stopped ? 'cancelled' : 'needs_reconciliation';
      task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: message };
      if (stopped) {
        attempt.state = 'ended'; task.activeAttemptId = undefined; delete task.failure;
        this.pool.release(task.taskId, false);
      } else {
        attempt.state = 'unknown'; task.failure = { code: 'CLEANUP_UNCONFIRMED', message, observedAt: Date.now() };
      }
      this.store.saveAttempt(attempt); this.store.saveTask(task, task.stateVersion);
      this.store.appendEvent(task.conversationId, 'task.cleanup', { stopped, message }, task.taskId);
      this.notify(task);
    });
  }
  answer(context: CommandContext, taskId: string, questionId: string, answer: string, browserFields?:unknown, computerInputs?:TaskRevision["computerInputs"]): TaskSnapshot {
    boundedText(answer);if(computerInputs!==undefined)computerInputs=ComputerInputs.parse(computerInputs);
    const prepared=preparedBrowserAnswers(browserFields,context.inputId);
    return this.command(context, 'answer', { taskId, questionId, answer, browserFields, computerInputs }, context.execute, () => {
      if (!context.execute) {
        const task = this.owned(taskId, context.conversationId);
        this.assertQuestion(task, questionId);
        // A notification can fill missing browser text in its own authorized task,
        // never approve a new operation, answer an unrelated task, or grant consent.
        const assigned = this.store.get(`SELECT n.id FROM notifications n JOIN conversation_events e
          ON e.conversation_id=n.conversation_id AND e.type='task.state_changed'
          AND json_extract(e.payload_json,'$.payload.taskId')=n.task_id
          AND json_extract(e.payload_json,'$.payload.stateVersion')=n.task_state_version
          WHERE n.task_id=? AND n.conversation_id=? AND n.decision_id=? AND n.status='assigned'
          AND json_extract(e.payload_json,'$.payload.pendingQuestion.questionId')=? LIMIT 1`,
          taskId, context.conversationId, context.decisionId, questionId);
        const reviewed = context.questionReviewIds?.includes(questionId) && this.store.get(
          'SELECT question_id FROM task_questions WHERE question_id=? AND task_id=? AND closed=0 AND revision=?',questionId,taskId,task.revision);
        const missingBrowser=task.gatewayTarget?.adapter==='browser'&&task.browserReport?.reason==='FIELD_TEXT_REQUIRED'&&task.browserReport.fieldRequest?.reason==='missing'&&Boolean(task.browserReport.fieldRequest.label);
        const missingComputer=task.gatewayTarget?.adapter==='computer'&&task.computerReport?.reason==='FIELD_TEXT_REQUIRED'&&task.computerReport.fieldRequest?.reason==='missing'&&Boolean(task.computerReport.fieldRequest.label);
        if ((!assigned && !reviewed) || task.ownerPrincipalId !== context.principalId || !task.capabilities.execute || (!missingBrowser&&!missingComputer))
          throw new OrchestrationError('EXECUTION_DENIED');
      }
      if(browserFields!==undefined&&this.owned(taskId,context.conversationId).gatewayTarget?.adapter!=='browser')throw new OrchestrationError('INVALID_BROWSER_FIELDS');
      if(computerInputs!==undefined&&this.owned(taskId,context.conversationId).gatewayTarget?.adapter!=='computer')throw new OrchestrationError('INVALID_INPUT');
      return this.answerOwned(context.conversationId, taskId, questionId, answer, context.inputId,prepared,computerInputs);
    }, taskId);
  }
  /** A scoped authenticated reply is user authorization, without a fabricated model decision. */
  answerByUser(conversationId: string, principalId: string, taskId: string, questionId: string, answer: string, acceptedInputId?: string): TaskSnapshot {
    boundedText(questionId, 128); boundedText(answer);
    return this.store.transaction(() => {
      const conversation = this.store.assertMember(conversationId, principalId);
      const task = this.owned(taskId, conversationId);
      if (!task.capabilities.execute) throw new OrchestrationError('EXECUTION_DENIED');
      const input = acceptedInputId ? this.store.get('SELECT * FROM conversation_inputs WHERE id=? AND conversation_id=? AND principal_id=?', acceptedInputId, conversationId, principalId) : undefined;
      if (acceptedInputId && (!input || JSON.parse(String(input.ingress_json)).capabilities?.execute !== true)) throw new OrchestrationError('EXECUTION_DENIED');
      // Revisions and their real input provenance outlive the prunable event stream.
      const prior = this.store.get(`SELECT json_extract(a.value,'$.text') AS answer,i.principal_id
        FROM task_revisions r,json_each(r.payload_json,'$.answers') a
        JOIN conversation_inputs i ON i.id=json_extract(a.value,'$.inputId') AND i.conversation_id=?
        WHERE r.task_id=? AND json_extract(a.value,'$.questionId')=? ORDER BY r.revision LIMIT 1`, conversationId, taskId, questionId);
      if (prior) {
        if (prior.principal_id !== principalId) throw new OrchestrationError('STALE_QUESTION');
        if (prior.answer !== answer) throw new OrchestrationError('IDEMPOTENCY_CONFLICT');
        if (input) this.handleAnswerInput(conversationId, String(input.id));
        return task;
      }
      if (input && input.status !== 'accepted') throw new OrchestrationError('INPUT_CONFLICT');
      this.assertQuestion(task, questionId);
      if (conversation.status !== 'active') throw new OrchestrationError('DRAINING');
      const inputId = acceptedInputId ?? randomUUID(), now = Date.now(), seq = Number(conversation.last_input_seq) + 1;
      if (!input) {
        const binding = this.store.get('SELECT binding_id FROM conversation_inputs WHERE id=? AND conversation_id=?', task.initiatingInputId, conversationId)!;
        this.store.run('UPDATE conversations SET last_input_seq=?,updated_at=? WHERE id=?', seq, now, conversationId);
        this.store.run(`INSERT INTO conversation_inputs(id,conversation_id,input_seq,principal_id,binding_id,modality,text,attachment_refs_json,request_id,store_user_message,status,created_at,ingress_json)
          VALUES(?,?,?,?,?,'text',?,'[]',NULL,1,'handled',?,?)`, inputId, conversationId, seq, principalId, binding.binding_id, answer, now,
          JSON.stringify({ metadata: { taskId, questionId }, capabilities: task.capabilities }));
        this.store.appendEvent(conversationId, 'input.accepted', { inputId });
      }
      this.handleAnswerInput(conversationId, inputId);
      const answered = this.answerOwned(conversationId, taskId, questionId, answer, inputId);
      this.store.appendEvent(conversationId, 'task.user_answer', { taskId, questionId, principalId, inputId, answerHash: payloadHash(answer) }, taskId);
      return answered;
    });
  }
  private handleAnswerInput(conversationId: string, inputId: string): void {
    const input = this.store.get('SELECT status FROM conversation_inputs WHERE id=?', inputId)!;
    if (!['accepted', 'handled'].includes(String(input.status))) throw new OrchestrationError('INPUT_CONFLICT');
    this.store.run("UPDATE conversation_inputs SET status='handled' WHERE id=?", inputId);
    this.store.run("UPDATE outbox SET state='completed' WHERE kind='input' AND dedup_key=?", `input:${inputId}`);
    const operationId = `input:${inputId}`;
    this.store.run('INSERT INTO history_operations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING', operationId, conversationId, inputId, null, 'append', null, 'pending', Date.now());
    this.store.enqueue('history', operationId, { operationId });
  }
  private assertQuestion(task: TaskSnapshot, questionId: string): void {
    if (task.state !== 'waiting_input' || task.pendingQuestion?.questionId !== questionId || task.pendingQuestion.revision !== task.revision) throw new OrchestrationError('STALE_QUESTION');
  }
  private answerOwned(conversationId: string, taskId: string, questionId: string, answer: string, inputId: string, prepared?:TaskRevision['answers'], computerInputs?:TaskRevision['computerInputs']): TaskSnapshot {
    const task = this.owned(taskId, conversationId), version = task.stateVersion;
    this.assertQuestion(task, questionId);
    // Persist early answers, while fencing scheduling until the old attempt really ends.
    const previous = this.revision(taskId, task.revision);
    const browserFieldLabel=task.gatewayTarget?.adapter==='browser' && task.browserReport?.reason==='FIELD_TEXT_REQUIRED' && task.browserReport.fieldRequest?.reason==='missing' ? task.browserReport.fieldRequest.label : undefined;
    if(browserFieldLabel && answer.length>2000)throw new OrchestrationError('BROWSER_FIELD_VALUE_TOO_LONG');
    const computerField=task.gatewayTarget?.adapter==='computer'&&task.computerReport?.fieldRequest?.reason==='missing'?task.computerReport.fieldRequest:undefined;
    if(computerField&&answer.length>2000)throw new OrchestrationError('COMPUTER_FIELD_VALUE_TOO_LONG');
    task.revision++;
    this.store.run('INSERT INTO task_revisions VALUES(?,?,?)', taskId, task.revision, JSON.stringify({ ...previous, ...(computerInputs!==undefined?{computerInputs}:{}), revision: task.revision,
      answers: [...(previous.answers ?? []), ...(prepared??[]), { questionId, text: answer, inputId, ...(browserFieldLabel ? {browserFieldLabel} : {}),...(computerField?{computerFieldLabel:computerField.label,computerApplication:computerField.application,computerWindowTitle:computerField.windowTitle,computerFieldRole:computerField.role}:{}) }], originatingInputId: inputId }));
    task.pendingQuestion = undefined;
    task.state = task.activeAttemptId ? (task.gatewayTarget ? 'running' : 'interrupting') : 'queued';
    this.store.saveTask(task, version);
    this.store.enqueue(task.activeAttemptId && !task.gatewayTarget ? 'interrupt' : 'schedule', `answer:${questionId}`, { taskId });
    if (this.store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_intake'")) {
      const input = this.store.get('SELECT principal_id,binding_id,input_seq FROM conversation_inputs WHERE id=? AND conversation_id=?', inputId, conversationId)!;
      this.store.run(`DELETE FROM conversation_intake WHERE conversation_id=? AND principal_id=? AND binding_id=?
        AND json_extract(data_json,'$.task_id')=? AND latest_input_seq<=?`, conversationId, input.principal_id, input.binding_id, taskId, input.input_seq);
    }
    return task;
  }
  revision(taskId: string, revision: number): TaskRevision {
    const row = this.store.get('SELECT payload_json FROM task_revisions WHERE task_id=? AND revision=?', taskId, revision);
    if (!row) throw new OrchestrationError('REVISION_NOT_FOUND');
    const rows = this.store.all('SELECT payload_json FROM task_revisions WHERE task_id=? AND revision<=? ORDER BY revision', taskId, revision);
    return normalizeTaskRevisions(rows.map(r => JSON.parse(String(r.payload_json)) as TaskRevision));
  }
  pruneWorkers(): void { this.pool.prune(this.config.tasks.workerIdleTtlMs); }
  claim(taskId: string): TaskAttempt | undefined {
    return this.store.transaction(() => {
      const task = this.store.task(taskId);
      if (!task || task.state !== 'queued' || task.activeAttemptId) return undefined;
      // Cooldown can outlive membership changes. A durable task receipt is not
      // permission to start execution for a principal who has lost access.
      if (!this.store.get('SELECT principal_id FROM conversation_members WHERE conversation_id=? AND principal_id=?', task.conversationId, task.ownerPrincipalId)) return undefined;
      if (task.continueTaskId) {
        const prior = this.store.task(task.continueTaskId);
        // Old snapshots retain their terminal-only behavior. New continuations
        // explicitly persist the success gate; notifications grant no authority.
        if (!prior || prior.conversationId !== task.conversationId) {
          this.failDependency(task, 'The recorded predecessor is unavailable.');
          return undefined;
        }
        if (!TERMINAL_TASK_STATES.has(prior.state)) return undefined;
        if (task.continuationPolicy === 'after_success' && prior.state !== 'completed') {
          this.failDependency(task, `Predecessor ${prior.taskId} ended as ${prior.state}${prior.failure ? `: ${prior.failure.code}: ${prior.failure.message}` : ''}. This step was not started.`);
          return undefined;
        }
      }
      const active = this.store.all('SELECT conversation_id,COUNT(*) AS n FROM tasks WHERE active_attempt_id IS NOT NULL GROUP BY conversation_id');
      if (active.reduce((n, row) => n + Number(row.n), 0) >= this.config.tasks.maxConcurrentPerAgent || Number(active.find(row => row.conversation_id === task.conversationId)?.n ?? 0) >= this.config.tasks.maxConcurrentPerConversation) return undefined;
      const worker = task.gatewayTarget ? { sessionId: task.gatewayTarget.sessionId, workerId: undefined } : this.pool.acquire(task, this.config.tasks.maxConcurrentPerAgent, this.config.tasks.workerIdleTtlMs);
      if (!worker) return undefined;
      task.workerId = worker.workerId;
      if (task.gatewayTarget) delete task.gatewayDispatch;
      delete task.failure;
      delete task.execution; // A new attempt must not look active on old telemetry.
      const generation = Number(this.store.get('SELECT COALESCE(MAX(generation),0)+1 AS n FROM task_attempts WHERE task_id=?', taskId)!.n);
      const attempt: TaskAttempt = { attemptId: randomUUID(), taskId, generation, revision: task.revision, ...worker, state: 'starting', ...(task.gatewayTarget ? {executionType:'gateway-managed' as const,createdAt:Date.now()} : {}) };
      this.store.run('INSERT INTO task_attempts VALUES(?,?,?,?,?,?)', attempt.attemptId, taskId, generation, attempt.revision, attempt.state, JSON.stringify(attempt));
      task.state = 'starting'; task.activeAttemptId = attempt.attemptId;
      this.store.saveTask(task, task.stateVersion);
      this.store.run("UPDATE outbox SET state='completed' WHERE kind='schedule' AND json_extract(payload_json,'$.taskId')=?", taskId);
      return attempt;
    });
  }
  private failDependency(task: TaskSnapshot, message: string): void {
    task.state = 'failed';
    task.failure = { code: 'TASK_DEPENDENCY_FAILED', message: message.slice(0, 4096), observedAt: Date.now() };
    task.latestProgress = { source: 'runtime', text: task.failure.message, observedAt: task.failure.observedAt };
    this.store.saveTask(task, task.stateVersion);
    this.store.run("UPDATE outbox SET state='completed' WHERE kind='schedule' AND json_extract(payload_json,'$.taskId')=?", task.taskId);
    this.notify(task);
  }
  private active(attemptId: string, generation: number): { task: TaskSnapshot; attempt: TaskAttempt } {
    const attempt = this.store.attempt(attemptId), task = attempt && this.store.task(attempt.taskId);
    if (!attempt || !task || attempt.generation !== generation || task.activeAttemptId !== attemptId || attempt.state === 'ended' || attempt.state === 'unknown') throw new OrchestrationError('STALE_ATTEMPT');
    return { task, attempt };
  }
  started(attemptId: string, generation: number, identity?: TaskAttempt['processIdentity']): TaskSnapshot {
    return this.store.transaction(() => {
      const { task, attempt } = this.active(attemptId, generation);
      if (task.state !== 'starting') throw new OrchestrationError('STATE_CONFLICT');
      attempt.state = 'running'; attempt.startedAt = Date.now(); attempt.processIdentity = identity;
      task.state = 'running'; task.appliedRevision = attempt.revision;
      if(task.executionControl?.revision===attempt.revision)task.executionControl.phase='applied';
      this.store.saveAttempt(attempt); this.store.saveTask(task, task.stateVersion);
      this.store.appendEvent(task.conversationId, 'task.revision_applied', { revision: attempt.revision }, task.taskId);
      return task;
    });
  }
  private workerReceipt(attemptId: string, actionId: string | undefined, kind: string, payload: string): { prior?: unknown; hash: string } {
    const hash = payloadHash({ kind, payload });
    if (!actionId) return { hash };
    boundedText(actionId, 256);
    const row = this.store.get("SELECT payload_json FROM worker_events WHERE attempt_id=? AND json_extract(payload_json,'$.actionId')=?", attemptId, actionId);
    if (!row) return { hash };
    const saved = JSON.parse(String(row.payload_json));
    if (saved.hash !== hash) throw new OrchestrationError('IDEMPOTENCY_CONFLICT');
    return { prior: saved.result, hash };
  }
  private saveWorkerReceipt(attemptId: string, actionId: string | undefined, kind: string, hash: string, result: unknown): void {
    if (!actionId) return;
    const seq = Number(this.store.get('SELECT COALESCE(MAX(local_seq),0)+1 seq FROM worker_events WHERE attempt_id=?', attemptId)!.seq);
    this.store.run('INSERT INTO worker_events VALUES(?,?,?,?,?)', attemptId, seq, kind, JSON.stringify({ actionId, hash, result }), Date.now());
  }
  /** Diagnostic snapshots do not change task state/version or refresh Updated
   * merely because a polling timer ran. Late observations are attempt-fenced. */
  observeExecution(attemptId: string, generation: number, observation: import('../execution-observation').ExecutionObservation): void {
    this.store.transaction(() => {
      let task: TaskSnapshot;
      try { task = this.active(attemptId, generation).task; } catch { return; }
      if (!['starting','running'].includes(task.state)) return;
      task.execution = observation;
      advanceTiming(task, observation.observedAt);
      this.store.run('UPDATE tasks SET snapshot_json=? WHERE id=? AND active_attempt_id=?', JSON.stringify(task), task.taskId, attemptId);
      this.store.appendEvent(task.conversationId, 'task.execution', observation, task.taskId);
      const attempt = this.store.attempt(attemptId)!;
      if (observation.observedAt - (attempt.startedAt ?? attempt.processIdentity?.startedAt ?? task.createdAt) >= this.config.tasks.progressStaleMs) {
        this.supervise(task, 'stale_progress', 'A scheduled progress update is due. Report completed steps, the current step, and any concrete dependency being awaited. Use substantive evidence; process/tool activity alone does not prove progress. Do not volunteer reassurance that the task is not stuck or is really running.', observation.observedAt);
      }
    });
  }
  private supervise(task: TaskSnapshot, reason: 'stale_progress' | 'repeated_tools', message: string, now = Date.now()): void {
    // Keep internal inspection frequent even when user-facing reports are quiet.
    // The agent independently decides whether this review merits a message.
    const since = task.supervision?.observedAt ?? (task.activeAttemptId ? this.store.attempt(task.activeAttemptId)?.startedAt : undefined) ?? task.createdAt;
    if ((task.supervision || reason === 'stale_progress') && now - since < this.config.tasks.progressNotifyCooldownMs) return;
    task.supervision = { id: randomUUID(), reason, observedAt: now, message };
    this.store.saveTask(task, task.stateVersion);
    this.notify(task);
  }
  /** Called at native CLI tool boundaries. No commands, raw tool results or secrets are persisted. */
  checkpoint(attemptId: string, generation: number, args: Record<string, unknown>): { revision?: number; directive?: string; directiveKind?: 'advice' | 'assignment'; feedback?: TaskSnapshot['supervision'] } {
    return this.store.transaction(() => {
      const { task, attempt } = this.active(attemptId, generation);
      if (task.state !== 'running' || args.sessionId !== attempt.sessionId) return {};
      if (typeof args.ackRevision === 'number' && Number.isSafeInteger(args.ackRevision) && args.ackRevision > attempt.revision && args.ackRevision <= task.revision) {
        const rev = this.revision(task.taskId, args.ackRevision);
        if (rev.mode !== 'when_ready') throw new OrchestrationError('STATE_CONFLICT');
        attempt.revision = rev.revision; task.appliedRevision = rev.revision;
        this.store.saveAttempt(attempt); this.store.saveTask(task, task.stateVersion);
        this.store.appendEvent(task.conversationId, 'task.revision_applied', { revision: rev.revision, boundary: 'tool' }, task.taskId);
      }
      if (typeof args.ackFeedback === 'string' && task.supervision?.id === args.ackFeedback && !task.supervision.deliveredAt) {
        task.supervision.deliveredAt = Date.now();
        this.store.run('UPDATE tasks SET snapshot_json=? WHERE id=?', JSON.stringify(task), task.taskId);
      }
      const latest = this.revision(task.taskId, task.revision);
      const changed = task.revision > attempt.revision && latest.mode === 'when_ready';
      // A later advisory must not hide an earlier unacknowledged user amendment.
      const pendingAssignment = changed && this.store.all('SELECT payload_json FROM task_revisions WHERE task_id=? AND revision>? AND revision<=?',task.taskId,attempt.revision,latest.revision)
        .some(row=>!JSON.parse(String(row.payload_json)).guidance);
      return {
        ...(changed ? { revision: latest.revision, directiveKind: pendingAssignment ? 'assignment' as const : 'advice' as const, directive: taskDirective(this.store, task.conversationId, latest) + '\nUpdated context references: ' + JSON.stringify(latest.contextRefs) } : {}),
        ...(task.supervision && !task.supervision.deliveredAt ? { feedback: task.supervision } : {}),
      };
    });
  }
  observeToolBoundary(attemptId: string, generation: number, activeTools: string[]): void {
    this.store.transaction(() => {
      let task: TaskSnapshot;
      try { task = this.active(attemptId,generation).task; } catch { return; }
      if (task.state !== 'running') return;
      // Before the first process sample, record phase without inventing process diagnostics.
      if (task.execution?.attemptId === attemptId) task.execution.activeTools = activeTools;
      advanceTiming(task);
      const timing = task.timing!;
      timing.activeToolCount = activeTools.length; timing.attemptId = attemptId;
      const phase = activeTools.length ? 'tool' : 'working';
      if (timing && timing.phase !== phase) {
        const now = Date.now();
        if (timing.phase !== 'finished') timing.totals[timing.phase] = (timing.totals[timing.phase] ?? 0) + Math.max(0,now-timing.since);
        timing.phase = phase; timing.since = now;
      }
      this.store.run('UPDATE tasks SET snapshot_json=? WHERE id=? AND active_attempt_id=?',JSON.stringify(task),task.taskId,attemptId);
    });
  }
  private readonly repeatedTools = new Map<string, { signatures: string[]; seen: Set<string>; progressAt: number }>();
  observeToolResult(attemptId: string, generation: number, signature: string, eventId: string): void {
    this.store.transaction(() => {
      let task: TaskSnapshot;
      try { task = this.active(attemptId,generation).task; } catch { this.repeatedTools.delete(attemptId); return; }
      if (task.state !== 'running') return;
      const progressAt = task.latestProgress?.source === 'worker' ? task.latestProgress.observedAt : 0;
      const entry = this.repeatedTools.get(attemptId);
      const state = entry && entry.progressAt === progressAt ? entry : { signatures: [], seen: new Set<string>(), progressAt };
      if (state.seen.has(eventId)) return;
      state.seen.add(eventId); state.signatures.push(signature);
      if (state.seen.size > 128) state.seen.delete(state.seen.values().next().value!);
      if (state.signatures.length > 64) state.signatures.shift();
      this.repeatedTools.set(attemptId,state);
      if (state.signatures.filter(value => value === signature).length >= this.config.tasks.repeatedToolThreshold) {
        this.supervise(task, 'repeated_tools', 'The same tool input and result have repeated without a new progress report. This may be legitimate polling, not a proven stall. Report the evidence and expected wait; if the approach is not producing new evidence, change it within the authorized scope. Do not repeat side effects blindly.');
        state.signatures = [];
      }
    });
  }
  progress(attemptId: string, generation: number, text: string, actionId?: string, checkpoint?: unknown): {accepted:true; workflowWarning?:string} {
    boundedText(text, 4096);
    const workflow=parseWorkflow(checkpoint);
    return this.store.transaction(() => {
      const { task } = this.active(attemptId, generation);
      const receipt = this.workerReceipt(attemptId, actionId, 'progress', workflow ? JSON.stringify({text,checkpoint:workflow}) : text);
      if (receipt.prior) return receipt.prior as {accepted:true;workflowWarning?:string};
      if (task.state !== 'running') throw new OrchestrationError('STATE_CONFLICT');
      if(workflow) task.workflow=advanceWorkflow(task.workflow,workflow,attemptId);
      const substantive = task.latestProgress?.text !== text;
      task.latestProgress = { text, observedAt: substantive ? Date.now() : task.latestProgress!.observedAt, source: 'worker' };
      this.store.saveTask(task, task.stateVersion);
      const result={accepted:true as const,...(task.workflow?.warning?{workflowWarning:task.workflow.warning}:{})};
      this.saveWorkerReceipt(attemptId, actionId, 'progress', receipt.hash, result);
      return result;
    });
  }
  requestInput(attemptId: string, generation: number, question: string, actionId?: string, computerReport?:TaskSnapshot['computerReport']): TaskSnapshot {
    boundedText(question, 4096);
    return this.store.transaction(() => {
      const { task, attempt } = this.active(attemptId, generation);
      const receipt = this.workerReceipt(attemptId, actionId, 'question', question);
      if (receipt.prior) return receipt.prior as TaskSnapshot;
      if (task.state !== 'running' || task.revision !== attempt.revision) throw new OrchestrationError('SUPERSEDED_QUESTION');
      if(computerReport&&task.gatewayTarget?.adapter==='computer')task.computerReport=computerReport;
      task.state = 'waiting_input';
      task.pendingQuestion = { questionId: randomUUID(), text: question, revision: attempt.revision };
      this.store.saveTask(task, task.stateVersion); this.notify(task);
      this.saveWorkerReceipt(attemptId, actionId, 'question', receipt.hash, task);
      return task;
    });
  }
  /** Driver terminal/exit acknowledgment, never a model's unverified "done". */
  finish(attemptId: string, generation: number, outcome: WorkerOutcome): TaskSnapshot {
    this.repeatedTools.delete(attemptId);
    if (outcome.type === 'completed') {
      // Match the managed-turn text limit; reject oversized output explicitly,
      // never silently shorten a successful worker report to fit an event.
      boundedText(outcome.result.summary, 262144);
      if (Buffer.byteLength(JSON.stringify(outcome.result)) > 2 * 1024 * 1024) throw new OrchestrationError('PAYLOAD_TOO_LARGE');
      if (outcome.result.artifactIds.length > 64 || outcome.result.artifactIds.some(id => typeof id !== 'string' || id.length > 1024)) throw new OrchestrationError('INVALID_INPUT');
    }
    return this.store.transaction(() => {
      const { task, attempt } = this.active(attemptId, generation);
      if (task.gatewayTarget?.adapter === 'computer' && outcome.computerReport) task.computerReport=outcome.computerReport;
      if (task.gatewayTarget?.adapter === 'browser' && outcome.browserReport) task.browserReport=outcome.browserReport;
      // A structured unresolved blocker is not successful task completion.
      const waitingForCommand=outcome.type==='paused'&&['browser','computer'].includes(task.gatewayTarget?.adapter??'')&&['THINKING_WAITING_INPUT','COMMAND_WAITING_INPUT'].includes(outcome.computerReport?.reason??outcome.browserReport?.reason??'');
      if (outcome.type === 'paused' && !waitingForCommand && !(task.state === 'waiting_input' && task.pendingQuestion) &&
        task.state !== 'interrupting' && task.state !== 'cancel_requested' && !(task.gatewayTarget && task.revision > attempt.revision)) throw new OrchestrationError('STATE_CONFLICT');
      // Keep the full final report, and preserve cancellation / new revisions / questions.
      const blocked = outcome.type === 'completed' && task.workflow?.attemptId === attemptId &&
        task.workflow.checkpoint.phase === 'blocked' && task.workflow.checkpoint.findings.some(f => f.status === 'open');
      if (blocked && outcome.type === 'completed') {
        attempt.result = outcome.result; task.result = outcome.result;
        outcome = { type: 'failed', failure: { code: 'WORKER_BLOCKED', message: task.workflow!.checkpoint.findings.filter(f => f.status === 'open').map(f => f.summary).join('\n').slice(0, 4096), observedAt: Date.now() } };
      }
      if (outcome.type !== 'completed' && outcome.type !== 'paused') {
        attempt.failure = outcome.failure ?? taskFailure(undefined, outcome.type === 'stopped' ? 'WORKER_STOPPED' : 'WORKER_FAILED');
        task.failure = attempt.failure;
      } else { delete task.failure; }
      if (outcome.type === 'unknown') { if(task.executionControl?.phase==='pending')task.executionControl.phase='blocked'; attempt.state = 'unknown'; task.state = 'needs_reconciliation'; }
      else {
        attempt.state = 'ended'; task.activeAttemptId = undefined;
        if (outcome.type === 'completed') attempt.result = outcome.result;
        if (task.state === 'cancel_requested') {
          task.state = outcome.type === 'completed' && task.revision === attempt.revision ? 'completed' : 'cancelled';
        } else if (task.state === 'waiting_input' && task.pendingQuestion) { /* retain question; execution slot now free */ }
        else if(task.executionControl?.phase==='pending'&&task.executionControl.action==='pause'){task.state='waiting_input';task.executionControl.phase='paused';delete task.failure;}
        else if (task.state === 'interrupting' || task.revision > attempt.revision) task.state = 'queued';
        else if(waitingForCommand){task.state='waiting_input';task.latestProgress={source:'runtime',observedAt:Date.now(),text:'Waiting for your next command.'};}
        else task.state = outcome.type === 'completed' ? 'completed' : 'failed';
        if (task.state === 'completed' && outcome.type === 'completed') task.result = outcome.result;
      }
      if (task.state === 'cancelled') {
        delete task.failure;
        task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: `Cancelled by ${task.cancellation?.requestedBy ?? 'agent'}. Existing files and prior effects are retained.` };
      }
      if (outcome.type !== 'unknown') this.pool.release(task.taskId, outcome.type === 'completed' || outcome.type === 'paused');
      this.store.saveAttempt(attempt); this.store.saveTask(task, task.stateVersion);
      if (task.state === 'queued') this.store.enqueue('schedule', `schedule:${task.taskId}:${task.stateVersion}`, { taskId: task.taskId });
      else if (TERMINAL_TASK_STATES.has(task.state) || task.state === 'needs_reconciliation') this.notify(task);
      return task;
    });
  }
  private notify(task: TaskSnapshot): void {
    const input = this.store.get('SELECT binding_id FROM conversation_inputs WHERE id=?', task.initiatingInputId)!;
    const notificationId = randomUUID();
    this.store.run(`INSERT INTO notifications(id,conversation_id,task_id,task_state_version,originating_binding_id) VALUES(?,?,?,?,?) ON CONFLICT(task_id,task_state_version) DO NOTHING`,
      notificationId, task.conversationId, task.taskId, task.stateVersion, input.binding_id);
    this.store.enqueue('notification', `notification:${task.taskId}:${task.stateVersion}`, { conversationId: task.conversationId, taskId: task.taskId, notificationId });
  }
  /** Parent independently checks a fresh, scoped browser observation. Never clears an uncertain mutation. */
  verifyBrowser(context:CommandContext,taskId:string,revision:number,requestId:string,evidenceId:string,evidence:string,check:()=>void):TaskSnapshot {
    boundedText(evidence,4096);boundedText(requestId,256);boundedText(evidenceId,128);
    return this.command(context,'verify_browser',{taskId,revision,requestId,evidenceId,evidence},context.execute,()=>{
      const task=this.owned(taskId,context.conversationId);
      if(task.ownerPrincipalId!==context.principalId || task.gatewayTarget?.adapter!=='browser' || !['needs_reconciliation','failed'].includes(task.state) || task.revision!==revision || task.gatewayDispatch?.requestId!==requestId || !task.browserReport || !parentVerifiableBrowserResult(task.browserReport))throw new OrchestrationError('BROWSER_VERIFICATION_UNAVAILABLE');
      if(!task.capabilities.execute || (!context.execute && !this.store.get("SELECT id FROM notifications WHERE task_id=? AND decision_id=? AND status='assigned' AND task_state_version=?",taskId,context.decisionId,task.stateVersion)))throw new OrchestrationError('EXECUTION_DENIED');
      check();
      const attemptId=task.activeAttemptId ?? this.store.get("SELECT id FROM task_attempts WHERE task_id=? AND revision=? AND state='ended' ORDER BY generation DESC LIMIT 1",taskId,revision)?.id;
      const attempt=attemptId ? this.store.attempt(String(attemptId)) : undefined;
      if(!attempt)throw new OrchestrationError('BROWSER_VERIFICATION_UNAVAILABLE');
      attempt.state='ended';task.activeAttemptId=undefined;task.state=task.revision>attempt.revision?'queued':'completed';delete task.failure;delete attempt.failure;
      task.browserReport.status='succeeded';task.browserReport.reason='PARENT_VERIFIED';
      task.browserReport.verification={source:'parent',evidence,at:Date.now()};
      task.result={summary:'Parent verified browser result: '+evidence,artifactIds:[]};attempt.result=task.result;
      this.pool.release(task.taskId,true);
      this.store.saveAttempt(attempt);this.store.saveTask(task,task.stateVersion);
      this.store.appendEvent(task.conversationId,'browser.parent_verified',{requestId,evidenceId,evidence},taskId);
      if(task.state==='queued')this.store.enqueue('schedule',`schedule:${task.taskId}:${task.stateVersion}`,{taskId:task.taskId});else this.notify(task);
      return task;
    },taskId);
  }
  verifyComputer(context:CommandContext,taskId:string,revision:number,requestId:string,evidenceId:string,evidence:string,check:()=>void):TaskSnapshot {
    boundedText(evidence,4096);boundedText(requestId,256);boundedText(evidenceId,128);
    return this.command(context,'verify_computer',{taskId,revision,requestId,evidenceId,evidence},context.execute,()=>{
      const task=this.owned(taskId,context.conversationId);
      if(task.ownerPrincipalId!==context.principalId || task.gatewayTarget?.adapter!=='computer' || task.state!=='failed' || task.revision!==revision || task.gatewayDispatch?.requestId!==requestId || !task.computerReport || task.computerReport.status!=='needs_verification')throw new OrchestrationError('COMPUTER_VERIFICATION_UNAVAILABLE');
      if(!task.capabilities.execute || (!context.execute && !this.store.get("SELECT id FROM notifications WHERE task_id=? AND decision_id=? AND status='assigned' AND task_state_version=?",taskId,context.decisionId,task.stateVersion)))throw new OrchestrationError('EXECUTION_DENIED');
      check();
      const attemptId=task.activeAttemptId ?? this.store.get("SELECT id FROM task_attempts WHERE task_id=? AND revision=? AND state='ended' ORDER BY generation DESC LIMIT 1",taskId,revision)?.id;
      const attempt=attemptId ? this.store.attempt(String(attemptId)) : undefined;
      if(!attempt)throw new OrchestrationError('COMPUTER_VERIFICATION_UNAVAILABLE');
      attempt.state='ended';task.activeAttemptId=undefined;task.state=task.revision>attempt.revision?'queued':'completed';delete task.failure;delete attempt.failure;
      task.computerReport.status='succeeded';task.computerReport.reason='PARENT_VERIFIED';
      task.result={summary:'Parent verified computer result: '+evidence,artifactIds:[]};attempt.result=task.result;
      this.pool.release(task.taskId,true);
      this.store.saveAttempt(attempt);this.store.saveTask(task,task.stateVersion);
      this.store.appendEvent(task.conversationId,'computer.parent_verified',{requestId,evidenceId,evidence},taskId);
      if(task.state==='queued')this.store.enqueue('schedule',`schedule:${task.taskId}:${task.stateVersion}`,{taskId:task.taskId});else this.notify(task);
      return task;
    },taskId);
  }
  /** User-requested continuation from fresh evidence, never replay the old dispatch. */
  reconcileBrowser(context:CommandContext,taskId:string,revision:number,requestId:string,evidenceId:string,instructions:string,check:()=>string):TaskSnapshot {
    boundedText(instructions,8000);boundedText(requestId,256);boundedText(evidenceId,128);
    return this.command(context,'reconcile_browser',{taskId,revision,requestId,evidenceId,instructions},true,()=>{
      const task=this.owned(taskId,context.conversationId);
      if(automationSession(task)?.status==='closed')throw new OrchestrationError('AUTOMATION_SESSION_CLOSED');
      if(!context.execute||!task.capabilities.execute||task.ownerPrincipalId!==context.principalId)throw new OrchestrationError('EXECUTION_DENIED');
      if(task.gatewayTarget?.adapter!=='browser'||task.state!=='needs_reconciliation'||!task.activeAttemptId||task.revision!==revision||task.gatewayDispatch?.requestId!==requestId)throw new OrchestrationError('STATE_CONFLICT');
      const resolution=check(),attempt=this.store.attempt(task.activeAttemptId)!;
      attempt.state='ended';this.store.saveAttempt(attempt);this.pool.release(taskId,false);
      const previous=this.revision(taskId,revision);
      task.revision++;task.activeAttemptId=undefined;task.state='queued';
      delete task.failure;delete task.browserReport;delete task.gatewayDispatch;delete task.pendingQuestion;
      task.executionControl=undefined;
      this.store.run('INSERT INTO task_revisions VALUES(?,?,?)',taskId,task.revision,JSON.stringify({...previous,requestBrowserConsent:true,revision:task.revision,instructions,mode:'when_ready',originatingInputId:context.inputId,answers:undefined,guidance:undefined,guidanceBasis:undefined,browserRecoveryCount:0}));
      this.store.saveTask(task,task.stateVersion);
      this.store.appendEvent(task.conversationId,'browser.continuation_authorized',{requestId,evidenceId,resolution,inputId:context.inputId},taskId);
      this.store.enqueue('schedule',`schedule:${task.taskId}:${task.stateVersion}`,{taskId});
      return task;
    },taskId);
  }
  /** Offline operator workflow only; not exposed through conversation tools.
   * Caller holds the instance lock and has checked liveness/side effects. */
  reconcile(taskId: string, state: 'queued' | 'failed' | 'cancelled', evidence: string): TaskSnapshot {
    boundedText(evidence, 4096);
    if (!['queued', 'failed', 'cancelled'].includes(state)) throw new OrchestrationError('INVALID_RECONCILIATION');
    return this.store.transaction(() => {
      const task = this.store.task(taskId);
      if (!task || task.state !== 'needs_reconciliation' || !task.activeAttemptId) throw new OrchestrationError('RECONCILIATION_NOT_REQUIRED');
      if(state==='queued'&&automationSession(task)?.status==='closed')throw new OrchestrationError('AUTOMATION_SESSION_CLOSED');
      const attempt = this.store.attempt(task.activeAttemptId)!;
      attempt.state = 'ended'; task.activeAttemptId = undefined; task.state = state;
      if(state==='queued'&&task.gatewayTarget){task.gatewayDispatch=undefined;task.failure=undefined;task.computerReport=undefined;}
      this.pool.release(taskId, false);
      task.pendingQuestion = undefined;
      task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: `Operator reconciliation: ${evidence}` };
      this.store.saveAttempt(attempt); this.store.saveTask(task, task.stateVersion);
      this.store.appendEvent(task.conversationId, 'task.reconciled', { taskId, state, evidence }, taskId);
      if (state === 'queued') this.store.enqueue('schedule', `schedule:${task.taskId}:${task.stateVersion}`, { taskId });
      else this.notify(task);
      return task;
    });
  }
  deferUnstarted(attemptId: string, generation: number, reason: 'workspace' | 'provider' = 'workspace'): void {
    this.store.transaction(() => {
      const { task, attempt } = this.active(attemptId, generation);
      if (attempt.state !== 'starting' || task.state !== 'starting') throw new OrchestrationError('STATE_CONFLICT');
      attempt.state = 'ended'; task.activeAttemptId = undefined; task.state = 'queued';
      this.pool.release(task.taskId, false);
      task.latestProgress = { source: 'runtime', text: reason === 'provider' ? 'Waiting for provider before starting inference.' : 'Waiting for the shared workspace owner to release its lock.', observedAt: Date.now() };
      this.store.saveAttempt(attempt); this.store.saveTask(task, task.stateVersion);
    });
  }
}
