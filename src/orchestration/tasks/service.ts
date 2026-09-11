import { normalizeTaskRevisions } from './task-directive';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { taskFailure } from './failure';
import { WorkerPool } from './pool';
import { randomUUID } from 'crypto';
import { OrchestrationStore, boundedText, payloadHash } from '../store';
import { resolveOrchestrationConfig, OrchestrationConfig } from '../config';
import { CommandContext, OrchestrationError, TaskSnapshot, TaskRevision, TaskAttempt, TaskResult, WorkerOutcome, TERMINAL_TASK_STATES, ChangeMode } from '../types';

export interface SpawnTask { title: string; instructions: string; targetProfile: string; skill?: import('../skills').TaskSkill; contextRefs?: string[]; continueTaskId?: string; continuationPolicy?: 'after_success' | 'after_terminal'; }

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
  private owned(taskId: string, conversationId: string): TaskSnapshot {
    const task = this.store.task(taskId);
    if (!task || task.conversationId !== conversationId) throw new OrchestrationError('ACCESS_DENIED');
    return task;
  }
  status(conversationId: string, principalId: string, taskId?: string): TaskSnapshot[] {
    this.store.assertMember(conversationId, principalId);
    if (taskId) { const task = this.owned(taskId, conversationId); delete task.skill; return [this.withRecentTools(task)]; }
    return this.store.all(`SELECT snapshot_json FROM tasks WHERE conversation_id=? AND (state NOT IN ('completed','failed','cancelled') OR id IN
      (SELECT id FROM tasks WHERE conversation_id=? AND state IN ('completed','failed','cancelled') ORDER BY created_at DESC,id DESC LIMIT 100))
      ORDER BY CASE WHEN state IN ('completed','failed','cancelled') THEN 1 ELSE 0 END,created_at DESC,id DESC`, conversationId, conversationId).map(row => {
      const task = JSON.parse(String(row.snapshot_json)) as TaskSnapshot;
      delete task.skill; // Installed skill bodies are worker-only execution context.
      if (task.result) task.result = { summary: task.result.summary.slice(0, 1024), artifactIds: task.result.artifactIds };
      return this.withRecentTools(task);
    });
  }
  private withRecentTools(task: TaskSnapshot): TaskSnapshot {
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
    return task;
  }
  spawn(context: CommandContext, command: SpawnTask): TaskSnapshot {
    if (command.continueTaskId !== undefined) boundedText(command.continueTaskId, 128);
    if (command.continuationPolicy !== undefined && (!command.continueTaskId || !['after_success', 'after_terminal'].includes(command.continuationPolicy))) throw new OrchestrationError('INVALID_INPUT');
    boundedText(command.title, 512); boundedText(command.instructions); boundedText(command.targetProfile, 128);
    if ((command.contextRefs?.length ?? 0) > 64 || command.contextRefs?.some(ref => typeof ref !== 'string' || ref.length > 1024)) throw new OrchestrationError('INVALID_INPUT');
    if (!['default-worker', 'media-worker', 'skill-worker'].includes(command.targetProfile)) throw new OrchestrationError('UNKNOWN_WORKER_PROFILE');
    return this.command(context, 'spawn', command, true, () => {
      const conversation = this.store.get('SELECT * FROM conversations WHERE id=?', context.conversationId)!;
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
        capabilities: { execute: context.execute, writeMemory: context.writeMemory }, createdAt: now, updatedAt: now };
      task.workstreamId = prior?.workstreamId ?? prior?.taskId ?? task.taskId;
      if (prior) {
        task.continueTaskId = prior.taskId;
        task.continuationPolicy = command.continuationPolicy ?? 'after_success';
        task.latestProgress = { source: 'runtime', observedAt: now, text: `Queued after task ${prior.taskId} (${task.continuationPolicy}).` };
      }
      if (command.skill) task.skill = command.skill;
      if (context.model) task.model = context.model;
      const projectRoot = this.config.tasks.projectRoot || this.defaultProjectRoot;
      if (projectRoot) task.resourceProfile = { projectRoot, mode: this.config.tasks.workspaceMode };
      this.store.run('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)', task.taskId, task.conversationId, task.state, 1, 1, null, JSON.stringify(task), now, now);
      const revision: TaskRevision = { taskId: task.taskId, revision: 1, instructions: command.instructions,
        contextRefs: command.contextRefs ?? [], mode: 'when_ready', originatingInputId: context.inputId };
      this.store.run('INSERT INTO task_revisions VALUES(?,?,?)', task.taskId, 1, JSON.stringify(revision));
      this.store.appendEvent(task.conversationId, 'task.created', task, task.taskId);
      this.store.enqueue('schedule', `schedule:${task.taskId}:1`, { taskId: task.taskId });
      return task;
    });
  }
  update(context: CommandContext, taskId: string, expectedRevision: number, instruction: string, mode: ChangeMode): TaskSnapshot {
    boundedText(instruction);
    if (!['when_ready', 'interrupt_and_resume'].includes(mode)) throw new OrchestrationError('INVALID_INPUT');
    return this.command(context, 'update', { taskId, expectedRevision, instruction, mode }, true, () => {
      const task = this.owned(taskId, context.conversationId), version = task.stateVersion;
      if (TERMINAL_TASK_STATES.has(task.state)) throw new OrchestrationError('TASK_TERMINAL');
      if (['cancel_requested', 'recovering', 'needs_reconciliation', 'interrupting'].includes(task.state)) throw new OrchestrationError('STATE_CONFLICT');
      if (task.revision !== expectedRevision) throw new OrchestrationError('REVISION_CONFLICT');
      task.revision++;
      const revision: TaskRevision = { taskId, revision: task.revision, instructions: instruction,
        contextRefs: this.revision(taskId, expectedRevision).contextRefs, mode, originatingInputId: context.inputId };
      this.store.run('INSERT INTO task_revisions VALUES(?,?,?)', taskId, task.revision, JSON.stringify(revision));
      if (task.state === 'waiting_input') { task.pendingQuestion = undefined; task.state = task.activeAttemptId ? 'interrupting' : 'queued'; }
      else if (mode === 'interrupt_and_resume' && task.activeAttemptId) task.state = 'interrupting';
      this.store.saveTask(task, version);
      this.store.appendEvent(task.conversationId, 'task.revision_accepted', { taskId, revision: task.revision }, taskId);
      this.store.enqueue(task.state === 'interrupting' ? 'interrupt' : 'schedule', `revision:${taskId}:${task.revision}`, { taskId });
      return task;
    }, taskId);
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
    if (TERMINAL_TASK_STATES.has(task.state)) return task;
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
  answer(context: CommandContext, taskId: string, questionId: string, answer: string): TaskSnapshot {
    boundedText(answer);
    return this.command(context, 'answer', { taskId, questionId, answer }, true, () => {
      const task = this.owned(taskId, context.conversationId), version = task.stateVersion;
      if (task.state !== 'waiting_input' || task.pendingQuestion?.questionId !== questionId || task.pendingQuestion.revision !== task.revision) throw new OrchestrationError('STALE_QUESTION');
      // An early user answer can be persisted, but the scheduler must still wait
      // for the old attempt's true end before claiming the next revision.
      const previous = this.revision(taskId, task.revision);
      task.revision++;
      this.store.run('INSERT INTO task_revisions VALUES(?,?,?)', taskId, task.revision, JSON.stringify({ ...previous, revision: task.revision,
        answers: [...(previous.answers ?? []), { questionId, text: answer, inputId: context.inputId }], originatingInputId: context.inputId }));
      task.pendingQuestion = undefined;
      task.state = task.activeAttemptId ? 'interrupting' : 'queued';
      this.store.saveTask(task, version);
      this.store.enqueue(task.activeAttemptId ? 'interrupt' : 'schedule', `answer:${questionId}`, { taskId });
      return task;
    }, taskId);
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
      const worker = this.pool.acquire(task, this.config.tasks.maxConcurrentPerAgent, this.config.tasks.workerIdleTtlMs);
      if (!worker) return undefined;
      task.workerId = worker.workerId;
      delete task.failure;
      delete task.execution; // A new attempt must not look active on old telemetry.
      const generation = Number(this.store.get('SELECT COALESCE(MAX(generation),0)+1 AS n FROM task_attempts WHERE task_id=?', taskId)!.n);
      const attempt: TaskAttempt = { attemptId: randomUUID(), taskId, generation, revision: task.revision, ...worker, state: 'starting' };
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
      attempt.state = 'running'; attempt.processIdentity = identity;
      task.state = 'running'; task.appliedRevision = attempt.revision;
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
      this.store.run('UPDATE tasks SET snapshot_json=? WHERE id=? AND active_attempt_id=?', JSON.stringify(task), task.taskId, attemptId);
      this.store.appendEvent(task.conversationId, 'task.execution', observation, task.taskId);
    });
  }
  progress(attemptId: string, generation: number, text: string, actionId?: string): void {
    boundedText(text, 4096);
    this.store.transaction(() => {
      const { task } = this.active(attemptId, generation);
      const receipt = this.workerReceipt(attemptId, actionId, 'progress', text);
      if (receipt.prior) return;
      if (task.state !== 'running') throw new OrchestrationError('STATE_CONFLICT');
      task.latestProgress = { text, observedAt: Date.now(), source: 'worker' };
      this.store.saveTask(task, task.stateVersion);
      this.saveWorkerReceipt(attemptId, actionId, 'progress', receipt.hash, { accepted: true });
    });
  }
  requestInput(attemptId: string, generation: number, question: string, actionId?: string): TaskSnapshot {
    boundedText(question, 4096);
    return this.store.transaction(() => {
      const { task, attempt } = this.active(attemptId, generation);
      const receipt = this.workerReceipt(attemptId, actionId, 'question', question);
      if (receipt.prior) return receipt.prior as TaskSnapshot;
      if (task.state !== 'running' || task.revision !== attempt.revision) throw new OrchestrationError('SUPERSEDED_QUESTION');
      task.state = 'waiting_input';
      task.pendingQuestion = { questionId: randomUUID(), text: question, revision: attempt.revision };
      this.store.saveTask(task, task.stateVersion); this.notify(task);
      this.saveWorkerReceipt(attemptId, actionId, 'question', receipt.hash, task);
      return task;
    });
  }
  /** Driver terminal/exit acknowledgment, never a model's unverified "done". */
  finish(attemptId: string, generation: number, outcome: WorkerOutcome): TaskSnapshot {
    if (outcome.type === 'completed') {
      boundedText(outcome.result.summary);
      if (Buffer.byteLength(JSON.stringify(outcome.result)) > 48000) throw new OrchestrationError('PAYLOAD_TOO_LARGE');
      if (outcome.result.artifactIds.length > 64 || outcome.result.artifactIds.some(id => typeof id !== 'string' || id.length > 1024)) throw new OrchestrationError('INVALID_INPUT');
    }
    return this.store.transaction(() => {
      const { task, attempt } = this.active(attemptId, generation);
      if (outcome.type !== 'completed') {
        attempt.failure = outcome.failure ?? taskFailure(undefined, outcome.type === 'stopped' ? 'WORKER_STOPPED' : 'WORKER_FAILED');
        task.failure = attempt.failure;
      } else { delete task.failure; }
      if (outcome.type === 'unknown') { attempt.state = 'unknown'; task.state = 'needs_reconciliation'; }
      else {
        attempt.state = 'ended'; task.activeAttemptId = undefined;
        if (outcome.type === 'completed') attempt.result = outcome.result;
        if (task.state === 'cancel_requested') {
          task.state = outcome.type === 'completed' && task.revision === attempt.revision ? 'completed' : 'cancelled';
        } else if (task.state === 'waiting_input' && task.pendingQuestion) { /* retain question; execution slot now free */ }
        else if (task.state === 'interrupting' || task.revision > attempt.revision) task.state = 'queued';
        else task.state = outcome.type === 'completed' ? 'completed' : 'failed';
        if (task.state === 'completed' && outcome.type === 'completed') task.result = outcome.result;
      }
      if (task.state === 'cancelled') {
        delete task.failure;
        task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: `Cancelled by ${task.cancellation?.requestedBy ?? 'agent'}. Existing files and prior effects are retained.` };
      }
      if (outcome.type !== 'unknown') this.pool.release(task.taskId, outcome.type === 'completed');
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
  /** Offline operator workflow only; not exposed through conversation tools.
   * Caller holds the instance lock and has checked liveness/side effects. */
  reconcile(taskId: string, state: 'queued' | 'failed' | 'cancelled', evidence: string): TaskSnapshot {
    boundedText(evidence, 4096);
    if (!['queued', 'failed', 'cancelled'].includes(state)) throw new OrchestrationError('INVALID_RECONCILIATION');
    return this.store.transaction(() => {
      const task = this.store.task(taskId);
      if (!task || task.state !== 'needs_reconciliation' || !task.activeAttemptId) throw new OrchestrationError('RECONCILIATION_NOT_REQUIRED');
      const attempt = this.store.attempt(task.activeAttemptId)!;
      attempt.state = 'ended'; task.activeAttemptId = undefined; task.state = state;
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
  deferUnstarted(attemptId: string, generation: number): void {
    this.store.transaction(() => {
      const { task, attempt } = this.active(attemptId, generation);
      if (attempt.state !== 'starting' || task.state !== 'starting') throw new OrchestrationError('STATE_CONFLICT');
      attempt.state = 'ended'; task.activeAttemptId = undefined; task.state = 'queued';
      this.pool.release(task.taskId, false);
      task.latestProgress = { source: 'runtime', text: 'Waiting for the shared workspace owner to release its lock.', observedAt: Date.now() };
      this.store.saveAttempt(attempt); this.store.saveTask(task, task.stateVersion);
    });
  }
}
