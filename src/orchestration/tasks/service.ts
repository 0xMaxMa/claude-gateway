import {CURRENT_CONTROL_ROUND_SQL} from '../control-notification';
import {preparedBrowserAnswers} from '../browser-fields';
import {ComputerInputs} from '../../jev/computer-inputs';
import {AUTOMATION_IDLE_TIMEOUT_MS,agentStepRunEnded,automationSession,pausedForCommand,stoppedForCommand} from './automation-session';
import {computerActionText,computerOutcomeText} from '../../automation/computer-outcome';
import {browserOutcomeText} from '../../automation/browser-outcome';
import {textCommand} from '../../automation/direct-command';
import { parentVerifiableBrowserResult } from '../../jev/browser-contract';
import { isAbsolute } from 'path';
import { parseWorkflow, advanceWorkflow } from '../workflow';
import { advanceTiming } from './timing';
import { taskDirective } from './task-directive';
import { normalizeTaskRevisions } from './task-directive';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { taskFailure, shutdownFailure } from './failure';
import { WorkerPool } from './pool';
import { createHash, randomUUID } from 'crypto';
import { OrchestrationStore, LISTED_TASK_SQL, boundedText, payloadHash } from '../store';
import { resolveOrchestrationConfig, OrchestrationConfig } from '../config';
import { MAX_INTAKE_INPUTS } from '../conversation-intake';
import { CommandContext, OrchestrationError, TaskSnapshot, TaskRevision, TaskAttempt, TaskResult, WorkerOutcome, TERMINAL_TASK_STATES, ChangeMode, PublicTaskSnapshot, publicTask } from '../types';
import type { Effort } from '../../agent/model-registry';
import { SUBAGENT_MAX_DEPTH } from '../subagent-tool-schemas';
import { MAX_RESTART_RESUMES, restartResumable } from '../restart-resume';

/** Parent states a subagent runs under; any other parent can neither start nor wait for one. */
export const RUNNING_PARENT: readonly string[] = ['starting', 'running', 'interrupting'];

/** Refs the agent may name itself; the gateway's own additions are bounded separately by MAX_INTAKE_INPUTS. */
export const MAX_AGENT_CONTEXT_REFS = 64;
/** Safety net only: an agent list plus a full semantic-intake batch, so normal use cannot reach it. */
export const MAX_CONTEXT_REFS = MAX_AGENT_CONTEXT_REFS + MAX_INTAKE_INPUTS;

/**
 * Merge agent-supplied refs with the gateway-added pending input IDs. Attachments are not added:
 * every input ref already carries its own attachments when the worker context is built.
 */
export function assertAgentContextRefs(supplied: unknown): unknown[] {
  const own = Array.isArray(supplied) ? supplied : [];
  if (own.length > MAX_AGENT_CONTEXT_REFS) throw new OrchestrationError('INVALID_INPUT', `context_refs has ${own.length} entries; an agent may reference at most ${MAX_AGENT_CONTEXT_REFS}. The gateway adds the pending input IDs itself, so omit them.`);
  return own;
}

export function mergeContextRefs(supplied: unknown, inputRefs: string[]): unknown[] {
  return [...new Set([...assertAgentContextRefs(supplied), ...inputRefs])];
}

export interface SpawnTask { browserFields?:unknown; computerInputs?:TaskRevision["computerInputs"]; gatewayTarget?: import("../types").GatewayTaskTarget; workingDirectory?: string; title: string; instructions: string; targetProfile: string; skill?: import('../skills').TaskSkill; contextRefs?: string[]; continueTaskId?: string; continuationPolicy?: 'after_success' | 'after_terminal';
  /** Model id already resolved against the registry by the caller; `requestedModel` is what was asked for. */
  model?: string; requestedModel?: string; effort?: import('../../agent/model-registry').Effort; }

/** How many finished tasks the per-turn index page keeps. Unfinished tasks are never dropped;
 * older finished ones stay reachable through task_status with an explicit task_id. */
const INDEXED_FINISHED_TASKS = 20;
/** Direct Computer/Remote Browser commands that may wait behind a settling round. */
const COMMAND_QUEUE_MAX = 20;
/** Stable control ID for the agent's one command on a handed-off utterance. */
export function handoffCommandId(inputId: string): string {
  const h = createHash('sha256').update('agent-handoff:' + inputId).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/** The live execution state an index row carries. The process sample, its timestamps and the
 * quiet/activity status are refreshed every observation, so including them made an unchanged
 * task look changed and resent it on every turn; task_status still returns all of them. */
function indexExecution(execution: NonNullable<TaskSnapshot['execution']>) {
  const { phase, activeTools, lastTool, lastProgressAt, attemptId } = execution;
  return { phase, activeTools, lastProgressAt, attemptId, ...(lastTool ? { lastTool: { name: lastTool.name, status: lastTool.status, ...(lastTool.exitCode !== undefined ? { exitCode: lastTool.exitCode } : {}) } } : {}) };
}
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
    execution: terminal || !task.execution ? undefined : indexExecution(task.execution),
    pendingQuestion: task.pendingQuestion, failure: task.failure,
    cancellation: task.cancellation, replacedByTaskId: task.replacedByTaskId,
    workstreamId: task.workstreamId, continueTaskId: task.continueTaskId, continuationPolicy: task.continuationPolicy,
    model: task.model, effort: task.effort,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId, rootTaskId: task.rootTaskId } : {}),
    resultAvailable: Boolean(task.result),
    actionLog: task.actionLog,
    computerConnection:task.computerConnection, automationController:task.automationController??"agent", gatewayTarget: task.gatewayTarget, automationSession: automationSession(task),
    details: { tool: 'task_status', task_id: task.taskId },
  };
}

/** What a pstack run actually did, for the decision turn that reports it: the pstack skills its
 * tree invoked (Skill calls, or the skill a skill-worker was assigned) and its subagents by model.
 * Absent when it used neither, so every other task's status is unchanged. */
function pstackEvidence(store: OrchestrationStore, task: TaskSnapshot, assigned: string | undefined, tree: TaskSnapshot[]) {
  const skills = new Set(assigned?.startsWith('pstack:') ? [assigned] : []);
  // One query for the whole tree, not one per subagent.
  for (const row of store.all("SELECT DISTINCT json_extract(payload_json,'$.payload.input.skill') AS skill FROM conversation_events WHERE conversation_id=? AND type='tool.activity' AND json_extract(payload_json,'$.task_id') IN (SELECT value FROM json_each(?)) AND json_extract(payload_json,'$.payload.name')='Skill' AND json_extract(payload_json,'$.payload.type')='tool_use'", task.conversationId, JSON.stringify([task.taskId, ...tree.map(child => child.taskId)])))
    if (typeof row.skill === 'string' && row.skill.startsWith('pstack:')) skills.add(row.skill.slice(0, 256));
  const subagentModels: Record<string, number> = {};
  for (const child of tree) { const key = [child.model ?? 'parent model', child.effort].filter(Boolean).join(' '); subagentModels[key] = (subagentModels[key] ?? 0) + 1; }
  if (!skills.size && !tree.length) return {};
  return { pstackEvidence: { ...(skills.size ? { skills: [...skills].sort() } : {}), ...(tree.length ? { subagents: tree.length, subagentModels } : {}) } };
}

const ACTION_LOG_MAX = 12;
const CORRECTION_HEAD = 'Latest user correction (apply first; supersedes conflicting earlier requirements):\n';
/** The round's own command for the log: a correction's latest text, never its preamble, and never typed field text. */
function loggedCommand(instructions: string): string {
  let command = instructions.startsWith(CORRECTION_HEAD) ? instructions.slice(CORRECTION_HEAD.length).split('\n\nEarlier requirements and corrections')[0] : instructions;
  const typed = textCommand(command);
  if (typed) command = command.replace(typed.text, '[text]');
  return command;
}
const clip = (text: string, max: number) => { const chars = [...text.replace(/\s+/gu, ' ').trim()]; return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join(''); };
/** Appends one round's own outcome line, so a later summary need not infer earlier rounds from the latest report. */
function recordAction(task: TaskSnapshot, revision: number, command: string, outcome: WorkerOutcome): void {
  let result = task.gatewayTarget?.adapter === 'computer' && outcome.computerReport ? computerOutcomeText(outcome.computerReport)
    : task.gatewayTarget?.adapter === 'browser' && outcome.browserReport ? browserOutcomeText(outcome.browserReport) : undefined;
  if (result === undefined) return;
  const last = outcome.computerReport?.lastAction;
  // A step-run line counts steps; name the last completed action as well.
  if (last && !last.blocked && !result.startsWith('Done:')) result += ` Last completed action: ${computerActionText(last)}.`;
  if (outcome.type === 'unknown') result = 'Outcome unknown; not replayed. ' + result;
  task.actionLog = [...(task.actionLog ?? []).filter(entry => entry.revision !== revision), { revision, command: clip(loggedCommand(command), 80), result: clip(result, 240) }].slice(-ACTION_LOG_MAX);
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
      if (execute && !context.execute) throw new OrchestrationError('EXECUTION_DENIED', `EXECUTION_DENIED: This is an internal report/non-executing turn (execute capability is off for this turn), so it cannot commit a task ${kind === 'answer' ? 'answer' : kind === 'spawn' ? 'creation' : 'change'} here. This is a turn-scoped permission boundary — not a system outage, and not proof that a prior answer was rejected or lost: any task command already committed on an executing turn stays durably saved and reaches the worker when it resumes. Do not retry this mutation on this turn or report the service as unavailable; reconcile the worker's request against the committed answer/receipt, and surface only a genuinely new decision to the user on a normal turn.`);
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
  status(conversationId: string, principalId: string, taskId?: string): Array<PublicTaskSnapshot & { currentInstructions?: string; harness?: 'claude' | 'codex' }> {
    this.store.assertMember(conversationId, principalId);
    if (taskId) {
      const task = this.owned(taskId, conversationId), assigned = task.skill?.name;
      // Gateway-managed tasks (browser/computer verification paths) never run pstack: no tree, no evidence.
      if (task.gatewayTarget) return [publicTask(this.withRecentTools(task))];
      // A root lists its whole subagent tree; each entry names its parent.
      const tree = task.parentTaskId ? [] : this.store.all("SELECT snapshot_json FROM tasks WHERE conversation_id=? AND json_extract(snapshot_json,'$.rootTaskId')=? ORDER BY created_at,rowid", task.conversationId, task.taskId)
        .map(row => JSON.parse(String(row.snapshot_json)) as TaskSnapshot);
      // Each subagent's latest attempt, in one query.
      const latest = new Map(tree.length ? this.store.all("SELECT a.task_id,a.payload_json FROM task_attempts a WHERE a.task_id IN (SELECT value FROM json_each(?)) AND a.generation=(SELECT MAX(b.generation) FROM task_attempts b WHERE b.task_id=a.task_id)", JSON.stringify(tree.map(child => child.taskId)))
        .map(row => [String(row.task_id), JSON.parse(String(row.payload_json)) as TaskAttempt]) : []);
      const subagents = tree.map(child => {
          const ran = latest.get(child.taskId);
          // model · harness · effort · state · duration, for the root's final report.
          return { taskId: child.taskId, parentTaskId: child.parentTaskId, title: child.title, state: child.state, model: child.model, harness: ran?.harness, effort: child.effort, subagentType: child.subagentType,
            ...(ran?.startedAt ? { durationMs: (TERMINAL_TASK_STATES.has(child.state) ? child.updatedAt : Date.now()) - ran.startedAt } : {}),
            ...(child.failure ? { failure: child.failure.code } : {}) };
        });
      return [publicTask({ ...this.withRecentTools(task), ...(subagents.length ? { subagents } : {}), ...pstackEvidence(this.store, task, assigned, tree) })];
    }
    // As in indexPage: a root's status lists its subagents.
    return this.store.all(`SELECT snapshot_json FROM tasks WHERE conversation_id=? AND ${LISTED_TASK_SQL} AND (state NOT IN ('completed','failed','cancelled') OR (json_extract(snapshot_json,'$.automationSession.status') IN ('idle','blocked') AND json_extract(snapshot_json,'$.automationSession.idleSince')+json_extract(snapshot_json,'$.automationSession.idleTimeoutMs')>${Date.now()}) OR id IN
      (SELECT id FROM tasks WHERE conversation_id=? AND ${LISTED_TASK_SQL} AND state IN ('completed','failed','cancelled') ORDER BY created_at DESC,id DESC LIMIT 100))
      ORDER BY CASE WHEN state IN ('completed','failed','cancelled') THEN 1 ELSE 0 END,created_at DESC,id DESC`, conversationId, conversationId).map(row => {
      const task = JSON.parse(String(row.snapshot_json)) as TaskSnapshot;
      const waiting = task.state === 'queued' && this.store.get('SELECT waiting_json FROM provider_waits WHERE entity_id=?', task.taskId);
      if (waiting) task.providerWaiting = JSON.parse(String(waiting.waiting_json));
      else delete task.providerWaiting;
      return publicTask(this.withRecentTools(task));
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
    const rows = new Map<string, PublicTaskSnapshot | TaskIndexEntry>(
      this.indexPage(conversationId).map(task => [task.taskId, taskIndexEntry(task)]));
    // An old task can finish after it has fallen outside the recent-task page.
    for (const id of reporting) rows.set(id, this.status(conversationId, principalId, id)[0]);
    return [...rows.values()];
  }
  /** Bounded recent-task page: every unfinished task, plus only the newest finished ones. */
  private indexPage(conversationId: string): TaskSnapshot[] {
    // Subagents are listed under their root (task_status with the root's task_id), not as separate work,
    // unless one awaits reconciliation: then it needs its own Retry cleanup.
    return this.store.all(`SELECT snapshot_json FROM tasks WHERE conversation_id=? AND ${LISTED_TASK_SQL} AND (state NOT IN ('completed','failed','cancelled') OR (json_extract(snapshot_json,'$.automationSession.status') IN ('idle','blocked') AND json_extract(snapshot_json,'$.automationSession.idleSince')+json_extract(snapshot_json,'$.automationSession.idleTimeoutMs')>${Date.now()}) OR id IN
      (SELECT id FROM tasks WHERE conversation_id=? AND ${LISTED_TASK_SQL} AND state IN ('completed','failed','cancelled') ORDER BY created_at DESC,id DESC LIMIT ${INDEXED_FINISHED_TASKS}))
      ORDER BY CASE WHEN state IN ('completed','failed','cancelled') THEN 1 ELSE 0 END,created_at DESC,id DESC`,
      conversationId, conversationId).map(row => JSON.parse(String(row.snapshot_json)) as TaskSnapshot);
  }
  private withRecentTools(task: TaskSnapshot): TaskSnapshot & { currentInstructions?: string; harness?: 'claude' | 'codex' } {
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
    // The harness is an attempt's execution choice (Codex can fall back to Claude), so report the latest one.
    const attempt = this.store.get('SELECT payload_json FROM task_attempts WHERE task_id=? ORDER BY generation DESC LIMIT 1', task.taskId);
    const harness = attempt ? (JSON.parse(String(attempt.payload_json)) as TaskAttempt).harness : undefined;
    if (harness) (task as TaskSnapshot & { harness?: string }).harness = harness;
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
    if ((command.contextRefs?.length ?? 0) > MAX_CONTEXT_REFS) throw new OrchestrationError('INVALID_INPUT', `context_refs has ${command.contextRefs!.length} entries (agent refs plus pending input IDs added by the gateway); the limit is ${MAX_CONTEXT_REFS}. Reference fewer materials.`);
    if (command.contextRefs?.some(ref => typeof ref !== 'string' || ref.length > 1024)) throw new OrchestrationError('INVALID_INPUT', 'Each context_refs entry must be a string of at most 1024 characters.');
    if (!['default-worker', 'media-worker', 'skill-worker', 'gateway-managed'].includes(command.targetProfile)) throw new OrchestrationError('UNKNOWN_WORKER_PROFILE');
    if ((command.targetProfile === 'gateway-managed') !== Boolean(command.gatewayTarget)) throw new OrchestrationError('INVALID_GATEWAY_TARGET');
    if (command.gatewayTarget && (command.workingDirectory || command.skill || command.contextRefs?.length || command.model || command.effort)) throw new OrchestrationError('INVALID_GATEWAY_TARGET');
    return this.command(context, 'spawn', command, true, () => {
      const conversation = this.store.get('SELECT * FROM conversations WHERE id=?', context.conversationId)!;
      let replaced:TaskSnapshot|undefined;
      if(['browser','computer'].includes(command.gatewayTarget?.adapter ?? '')) {
        const existing=this.store.all("SELECT snapshot_json FROM tasks WHERE conversation_id=? AND json_extract(snapshot_json,'$.gatewayTarget.adapter')=? AND json_extract(snapshot_json,'$.gatewayTarget.sessionId')=?",context.conversationId,command.gatewayTarget!.adapter,command.gatewayTarget!.sessionId).map(row=>JSON.parse(String(row.snapshot_json)) as TaskSnapshot).find(task=>task.ownerPrincipalId===context.principalId && automationSession(task)?.status!=='closed');
        // A computer session that never acted (failed before or while waiting
        // for access) holds nothing worth continuing; a new spawn replaces it.
        const neverActed=(existing?.gatewayTarget?.adapter==='computer'&&(existing.computerReport?.steps??0)===0&&!existing.computerReport?.trace?.some(event=>event.outcome==='unknown')&&
          ((existing.state==='failed'&&!existing.activeAttemptId)||(existing.state==='running'&&existing.computerReport?.status==='waiting_access')))||
          // A Remote Browser session that failed before any tab action likewise holds nothing.
          (existing?.gatewayTarget?.adapter==='browser'&&existing.state==='failed'&&!existing.activeAttemptId&&(existing.browserReport?.steps??0)===0&&
            existing.browserReport?.lastAction?.outcome!=='unknown'&&!existing.browserReport?.lastConfirmedAction);
        if(existing&&neverActed)replaced=existing;
        else if(existing){
          const report=existing.computerReport??existing.browserReport;
          const cause=`state ${existing.state}${report?.reason?`, last result ${report.reason}`:''}${existing.failure?.code?` (${existing.failure.code})`:''}, controlled by the ${existing.automationController==='user'?'user':'agent'}`;
          throw new OrchestrationError('AUTOMATION_SESSION_EXISTS',`This device session already has task ${existing.taskId} at revision ${existing.revision}: ${cause}. This is not a permission problem. Inspect it with task_status and use task_update when_ready for the next goal on the same task${existing.automationController==='user'?' (the user controls it; wait for them or ask them to hand control back)':''}, or task_cancel it to end that session. Do not open another tab or replay completed work.`);
        }
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
        if (["browser","computer"].includes(command.gatewayTarget.adapter)) {
          task.automationSession={status:"active",idleTimeoutMs:this.config.tasks.automationIdleTimeoutMs};
          task.automationController="user";
        }
      }
      if (command.skill) task.skill = command.skill;
      // A follow-up keeps the model and effort its predecessor was explicitly given, like its directory and worker session.
      const requested = command.model ? command : prior?.requestedModel ? { model: prior.model, requestedModel: prior.requestedModel } : undefined;
      if (requested?.model) { task.model = requested.model; task.requestedModel = requested.requestedModel ?? requested.model; }
      else if (context.model && !command.gatewayTarget) task.model = context.model;
      const effort = command.effort ?? (command.model ? undefined : prior?.effort);
      if (effort) task.effort = effort;
      const projectRoot = command.workingDirectory || (this.config.tasks.workspaceMode === 'host' && prior?.resourceProfile?.mode === 'host' ? prior.resourceProfile.projectRoot : undefined) || this.config.tasks.projectRoot || this.defaultProjectRoot;
      if (projectRoot && !command.gatewayTarget) task.resourceProfile = { projectRoot, mode: this.config.tasks.workspaceMode };
      this.store.run('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)', task.taskId, task.conversationId, task.state, 1, 1, null, JSON.stringify(task), now, now);
      const revision: TaskRevision = { requestBrowserConsent:command.gatewayTarget?.adapter==='browser', taskId: task.taskId, revision: 1, instructions: command.instructions, computerInputs:command.computerInputs,
        answers:prepared, contextRefs: command.contextRefs ?? [], mode: 'when_ready', originatingInputId: context.inputId };
      this.store.run('INSERT INTO task_revisions VALUES(?,?,?)', task.taskId, 1, JSON.stringify(revision));
      this.store.appendEvent(task.conversationId, 'task.created', task, task.taskId);
      this.store.enqueue('schedule', `schedule:${task.taskId}:1`, { taskId: task.taskId });
      if (replaced) {
        this.cancelOwned(context.conversationId, replaced.taskId, task.taskId);
        this.store.appendEvent(task.conversationId, 'task.session_replaced', { taskId: replaced.taskId, replacedByTaskId: task.taskId }, replaced.taskId);
      }
      return task;
    });
  }
  update(context: CommandContext, taskId: string, expectedRevision: number, instruction: string, mode: ChangeMode, browserFields?:unknown, computerInputs?:TaskRevision["computerInputs"], startUrl?:unknown): TaskSnapshot {
    let browserUrl:string|undefined;
    if(startUrl!==undefined){
      if(!context.execute)throw new OrchestrationError('EXECUTION_DENIED');
      try{if(typeof startUrl!=='string'||startUrl.length>8192)throw Error();const u=new URL(startUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error();browserUrl=u.href;}catch{throw new OrchestrationError('INVALID_BROWSER_START_URL');}
    }
    boundedText(instruction);if(computerInputs!==undefined)computerInputs=ComputerInputs.parse(computerInputs);
    if (!['when_ready', 'interrupt_and_resume'].includes(mode)) throw new OrchestrationError('INVALID_INPUT');
    const prepared=preparedBrowserAnswers(browserFields,context.inputId);
    return this.command(context, 'update', { taskId, expectedRevision, instruction, mode, browserFields, computerInputs, startUrl }, context.execute, () => {
      const task = this.owned(taskId, context.conversationId), version = task.stateVersion;
      if(browserUrl!==undefined&&task.gatewayTarget?.adapter!=='browser')throw new OrchestrationError('INVALID_BROWSER_START_URL');
      if(computerInputs!==undefined&&task.gatewayTarget?.adapter!=='computer')throw new OrchestrationError('INVALID_INPUT');
      if(automationSession(task)?.status==='closed')throw new OrchestrationError('AUTOMATION_SESSION_CLOSED','This automation session was ended or expired. Ask for a new authorized session; never replay its previous action.');
      const completionReview = task.gatewayTarget?.adapter === 'browser' && task.state === 'needs_reconciliation' &&
        Boolean(task.activeAttemptId) && task.browserReport?.status === 'needs_verification' &&
        ['COMPLETION_CANDIDATE','VERIFICATION_FAILED'].includes(task.browserReport.reason) &&
        !task.browserReport.providerFailure && task.browserReport.lastAction?.outcome !== 'unknown';
      if(task.automationController==='user'){
        // Jev gave up on this utterance and handed it to the agent: exactly one
        // command, as the user's own next direct command (user keeps control).
        const handoff=this.agentHandoff(context,task,expectedRevision,mode,browserFields,computerInputs,startUrl);
        if(handoff)return this.applyDirectControl(context.conversationId,taskId,task,{id:handoffCommandId(context.inputId),action:'revise',text:instruction},undefined,context.inputId);
        throw new OrchestrationError('USER_CONTROLS_AUTOMATION');
      }
      const agentControl = !context.execute &&
        ['browser','computer'].includes(task.gatewayTarget?.adapter??'') && task.capabilities.execute && task.ownerPrincipalId===context.principalId &&
        task.state==='waiting_input'&&!task.activeAttemptId&&!task.pendingQuestion&&task.executionControl?.phase!=='paused'&&
        ['COMMAND_WAITING_INPUT','THINKING_WAITING_INPUT','COMPLETION_CANDIDATE','VERIFICATION_FAILED'].includes(task.browserReport?.reason??task.computerReport?.reason??'')&&
        !task.browserReport?.providerFailure&&task.browserReport?.lastAction?.outcome!=='unknown'&&
        // Device disconnect/reconnect changes stateVersion without changing the
        // settled action. Authorize this decision against its immutable round,
        // while the current ownership, controller and idle guards still apply.
        Boolean(this.store.get(`SELECT n.id FROM notifications n JOIN tasks t ON t.id=n.task_id
          WHERE n.task_id=? AND n.decision_id=? AND n.status='assigned' AND ${CURRENT_CONTROL_ROUND_SQL} LIMIT 1`,
          taskId,context.decisionId));
      // A provider failure before the first action can be replanned by the
      // assigned parent. Never extend this to post-action or uncertain outcomes.
      const preActionProviderFailure = task.computerReport?.status === 'blocked' &&
        task.computerReport.steps === 0 &&
        /^THINKING_HTTP_(429|502|503|504)$/.test(task.computerReport.reason) &&
        !task.computerReport.trace?.some(event => event.outcome === 'unknown');
      const computerRecovery = !context.execute && task.gatewayTarget?.adapter === 'computer' &&
        task.capabilities.execute && task.ownerPrincipalId === context.principalId &&
        task.state === 'failed' && !task.activeAttemptId && task.executionControl?.phase !== 'paused' &&
        (preActionProviderFailure || ['COMPLETION_CANDIDATE','VERIFICATION_FAILED','NO_SUPPORTED_ACTION','COMPUTER_TEXT_UNGROUNDED'].includes(task.computerReport?.reason ?? '')) &&
        Boolean(this.store.get("SELECT id FROM notifications WHERE task_id=? AND decision_id=? AND status='assigned' AND task_state_version=?",taskId,context.decisionId,task.stateVersion));
      const browserRecovery = agentControl || computerRecovery || !context.execute && task.gatewayTarget?.adapter === 'browser' &&
        task.capabilities.execute && task.ownerPrincipalId === context.principalId &&
        !task.browserReport?.providerFailure && task.browserReport?.lastAction?.outcome !== 'unknown' &&
        (completionReview || (task.state === 'failed' && !task.activeAttemptId &&
        ['LOW_OPERATION_CONFIDENCE','LOW_TARGET_CONFIDENCE','STALE_RETRY_BUDGET','TARGET_OBSCURED','PAGE_CONTENT_UNAVAILABLE','MODEL_BLOCKED','OBSERVATION_TRUNCATED','NO_PROGRESS','NO_SUPPORTED_ACTION','TEXT_BUDGET'].includes(task.browserReport?.reason ?? ''))) &&
        Boolean(this.store.get("SELECT id FROM notifications WHERE task_id=? AND decision_id=? AND status='assigned' AND task_state_version=?",taskId,context.decisionId,task.stateVersion));
      if (TERMINAL_TASK_STATES.has(task.state) && !(task.gatewayTarget && (context.execute || browserRecovery) && ['completed','failed'].includes(task.state) && !task.activeAttemptId)) throw new OrchestrationError('TASK_TERMINAL');
      if (['cancel_requested', 'recovering', 'needs_reconciliation', 'interrupting'].includes(task.state) && !(completionReview && (context.execute || browserRecovery))) throw new OrchestrationError('STATE_CONFLICT');
      if (task.revision !== expectedRevision) throw new OrchestrationError('REVISION_CONFLICT');
      if (task.gatewayTarget && (task.ownerPrincipalId !== context.principalId || (!context.execute && !browserRecovery))) throw new OrchestrationError('EXECUTION_DENIED');
      if (task.gatewayTarget && mode !== 'when_ready') throw new OrchestrationError('INVALID_INPUT', 'Use when_ready for Gateway-managed tasks; the current request must settle before revised instructions run.');
      if(browserFields!==undefined&&task.gatewayTarget?.adapter!=='browser')throw new OrchestrationError('INVALID_BROWSER_FIELDS');
      const priorRevision = this.revision(taskId, expectedRevision);
      if (browserRecovery && !agentControl && ((priorRevision.browserRecoveryCount ?? 0) >= 3 || priorRevision.guidance === instruction))
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
      const revision: TaskRevision = { ...(browserUrl?{browserNavigation:{url:browserUrl,revision:task.revision}}:{}), requestBrowserConsent:context.execute && task.gatewayTarget?.adapter==='browser', taskId, revision: task.revision, instructions: instruction, computerInputs:context.execute||computerRecovery||agentControl?computerInputs:priorRevision.computerInputs,
        answers:prepared, contextRefs: priorRevision.contextRefs, mode, originatingInputId: context.inputId,
        ...(!context.execute&&!computerRecovery&&!agentControl ? { instructions: priorRevision.instructions, answers: prepared??priorRevision.answers, originatingInputId: priorRevision.originatingInputId, guidance: instruction, guidanceBasis: {attemptId: task.activeAttemptId, workflowVersion: task.workflow?.version??0, progressAt: task.latestProgress?.observedAt??0} } : {}),
        ...(browserRecovery&&!agentControl ? {browserRecoveryCount:(priorRevision.browserRecoveryCount ?? 0)+1,guidanceBasis:undefined} : {}) };
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
  controlByUser(conversationId:string,principalId:string,taskId:string,command:{id:string;action:'pause'|'revise'|'resume'|'agent'|'user';expectedRevision:number;text?:string}):TaskSnapshot {
    return this.store.transaction(()=>{
      this.store.assertMember(conversationId,principalId);
      const task=this.owned(taskId,conversationId);
      if(task.ownerPrincipalId!==principalId)throw new OrchestrationError('ACCESS_DENIED');
      if(!/^[0-9a-f-]{36}$/i.test(command.id)||!['pause','revise','resume','agent','user'].includes(command.action)||!Number.isSafeInteger(command.expectedRevision))throw new OrchestrationError('INVALID_INPUT');
      const id='user-control:'+command.id,hash=payloadHash({taskId,...command});
      const prior=this.store.get('SELECT * FROM task_commands WHERE action_id=?',id);
      if(prior){if(prior.principal_id!==principalId||prior.conversation_id!==conversationId)throw new OrchestrationError('ACCESS_DENIED');if(prior.payload_hash!==hash)throw new OrchestrationError('IDEMPOTENCY_CONFLICT');return task;}
      if(!['browser','computer'].includes(task.gatewayTarget?.adapter??'')||!task.capabilities.execute)throw new OrchestrationError('EXECUTION_DENIED');
      if(automationSession(task)?.status==='closed')throw new OrchestrationError('AUTOMATION_SESSION_CLOSED');
      if(task.revision!==command.expectedRevision)throw new OrchestrationError('REVISION_CONFLICT');
      if(command.action==='agent'||command.action==='user'){
        if(command.text!==undefined)throw new OrchestrationError('INVALID_INPUT');
        task.automationController=command.action;
        // The agent drives now: the user's queued direct commands must not run under it.
        if(command.action==='agent'&&task.queuedCommands?.length){
          const queue=task.queuedCommands;delete task.queuedCommands;
          task.latestProgress={source:'runtime',observedAt:Date.now(),text:`Control handed to the agent. ${queue.length} queued command${queue.length===1?' was':'s were'} not sent: ${queue.map(c=>JSON.stringify(c.text.slice(0,60))).join(', ')}.`.slice(0,4096)};
          this.store.appendEvent(conversationId,'task.command_queue_dropped',{taskId,count:queue.length,reason:'agent_control'},taskId);
        }
        this.store.saveTask(task,task.stateVersion);
        this.store.run('INSERT INTO task_commands VALUES(?,?,?,?,?,?,?,?,?)',id,taskId,conversationId,principalId,null,'user_control',hash,JSON.stringify(task),Date.now());
        if(command.action==='agent'&&task.state==='waiting_input'&&!task.activeAttemptId&&!task.pendingQuestion&&task.executionControl?.phase!=='paused')this.notify(task);
        return task;
      }
      return this.applyDirectControl(conversationId,taskId,task,{id:command.id,action:command.action,text:command.text},task=>this.store.run('INSERT INTO task_commands VALUES(?,?,?,?,?,?,?,?,?)',id,taskId,conversationId,principalId,null,'user_control',hash,JSON.stringify(task),Date.now()));
    });
  }
  /**
   * The agent turn for a handed-off utterance (needs_agent AGENT_HANDOFF receipt
   * on this input and task) may send one command: same task, the receipt's
   * revision (no newer user command), the round settled and waiting, no fields,
   * inputs or navigation, and never twice for the same utterance.
   */
  private agentHandoff(context:CommandContext,task:TaskSnapshot,expectedRevision:number,mode:ChangeMode,browserFields:unknown,computerInputs:unknown,startUrl:unknown):boolean {
    const receipt=this.liveReceipt(context.inputId);
    if(receipt?.code!=='AGENT_HANDOFF'||receipt.status!=='needs_agent'||receipt.taskId!==task.taskId)return false;
    if(!context.execute||task.ownerPrincipalId!==context.principalId)throw new OrchestrationError('EXECUTION_DENIED');
    if(this.store.get("SELECT 1 FROM task_revisions WHERE task_id=? AND json_extract(payload_json,'$.agentHandoffInputId')=?",task.taskId,context.inputId))
      throw new OrchestrationError('AGENT_HANDOFF_USED','The one command for this handed-off utterance was already sent. Report its outcome; do not send another.');
    if(mode!=='when_ready'||browserFields!==undefined||computerInputs!==undefined||startUrl!==undefined)throw new OrchestrationError('INVALID_INPUT','A handed-off command is one plain next command: mode=when_ready, no fields, inputs or start_url.');
    if(expectedRevision!==receipt.revision||task.revision!==receipt.revision)throw new OrchestrationError('REVISION_CONFLICT','The user has given a newer command since this utterance; do not act on it.');
    if(task.activeAttemptId||!(pausedForCommand(task)||stoppedForCommand(task)))throw new OrchestrationError('STATE_CONFLICT');
    return true;
  }
  /** The latest live-control receipt of an input (live-execution-input.ts liveControlReceipt). */
  private liveReceipt(inputId:string):{taskId?:string;status?:string;code?:string;revision?:number}|undefined {
    const row=this.store.get("SELECT payload_json FROM conversation_events WHERE type='input.execution_control' AND json_extract(payload_json,'$.payload.inputId')=? ORDER BY seq DESC LIMIT 1",inputId);
    return row?JSON.parse(String(row.payload_json)).payload:undefined;
  }
  /** The owner's pause/revise/resume, or (agentHandoffInputId) the agent's single command for a handed-off utterance. Runs inside the caller's transaction. */
  private applyDirectControl(conversationId:string,taskId:string,task:TaskSnapshot,command:{id:string;action:'pause'|'revise'|'resume';text?:string},record?:(task:TaskSnapshot)=>void,agentHandoffInputId?:string):TaskSnapshot {
    task.automationController='user';
    const paused=pausedForCommand(task);
    const recoverable=command.action==='revise'&&stoppedForCommand(task);
    if(!['queued','starting','running','interrupting'].includes(task.state)&&!paused&&!recoverable)throw new OrchestrationError('STATE_CONFLICT');
    // Only the owner's own pause (settled or still settling) leaves interrupted work. A settled
    // round waiting for the next command has nothing to resume: re-running it would replay it.
    if(command.action==='resume'&&!(task.executionControl?.action==='pause'&&['pending','paused'].includes(task.executionControl.phase)))throw new OrchestrationError('NOTHING_TO_RESUME','Nothing to resume: the last command already finished. Give the next command instead.');
    if(command.action==='revise')boundedText(command.text??'',4000);
    else if(command.text!==undefined)throw new OrchestrationError('INVALID_INPUT');
    const previous=this.revision(taskId,task.revision);
    // Never drop queued words silently: say which commands will not run.
    const unsent=command.action==='pause'?task.queuedCommands??[]:[];
    const dropped=unsent.length?` ${unsent.length} queued command${unsent.length===1?' was':'s were'} not sent: ${unsent.map(c=>JSON.stringify(c.text.slice(0,60))).join(', ')}.`:'';
    if(unsent.length)this.store.appendEvent(conversationId,'task.command_queue_dropped',{taskId,count:unsent.length,reason:'paused'},taskId);
    if(command.action==='pause')delete task.queuedCommands;
    // A user's own command is still settling: the next one waits its turn,
    // verbatim, instead of superseding it or being folded into a correction.
    if(command.action==='revise'&&this.queuesDirectCommand(task,previous)){
      const queue=task.queuedCommands??[];
      if(queue.length>=COMMAND_QUEUE_MAX)throw new OrchestrationError('COMMAND_QUEUE_FULL','Too many commands are waiting. Wait for the current ones to finish or pause.');
      task.queuedCommands=[...queue,{id:command.id,text:command.text!,at:Date.now()}];
      task.latestProgress={source:'runtime',observedAt:Date.now(),text:`Queued: ${JSON.stringify(command.text!.slice(0,120))} runs after the current command (${task.queuedCommands.length} waiting).`};
      this.store.saveTask(task,task.stateVersion);
      this.store.appendEvent(conversationId,'task.command_queued',{taskId,commandId:command.id,position:task.queuedCommands.length},taskId);
      record?.(task);
      return task;
    }
    const priorAnswers=previous.answers?.map(a=>({field:a.browserFieldLabel??a.computerFieldLabel,text:a.text}));
    const nextCommand=command.action==='revise'&&(paused||recoverable);
    const instructions=nextCommand?command.text!:command.action==='revise'?CORRECTION_HEAD+command.text+'\n\nEarlier requirements and corrections, newest first. Keep only requirements compatible with the latest correction; do not perform superseded actions:\n'+previous.instructions+(priorAnswers?.length?'\n\nEarlier user answers (subject to the latest correction):\n'+JSON.stringify(priorAnswers):''):previous.instructions;
    boundedText(instructions,task.gatewayTarget?.adapter==='browser'?8000:16000);
    task.revision++;
    if(recoverable&&!paused){delete task.computerReport;delete task.failure;delete task.browserReport;delete task.gatewayDispatch;}
    // The owner's new command supersedes any pending question (saveTask closes its record).
    if(command.action==='revise')delete task.pendingQuestion;
    this.store.run('INSERT INTO task_revisions VALUES(?,?,?)',taskId,task.revision,JSON.stringify({...previous,requestBrowserConsent:command.action!=='pause',revision:task.revision,instructions,mode:'interrupt_and_resume',computerInputs:command.action==='revise'?undefined:previous.computerInputs,answers:command.action==='revise'?undefined:previous.answers,browserRecoveryCount:0,guidance:undefined,guidanceBasis:undefined,...(command.action==='revise'?{directCommand:true}:{}),agentHandoffInputId}));
    task.executionControl={id:command.id,action:command.action,revision:task.revision,phase:task.activeAttemptId?'pending':command.action==='pause'?'paused':'pending',requestedAt:Date.now(),...(agentHandoffInputId?{agentHandoff:true as const}:{})};
    task.state=task.activeAttemptId?'interrupting':command.action==='pause'?'waiting_input':'queued';
    task.latestProgress={source:'runtime',observedAt:Date.now(),text:((task.activeAttemptId?'Control accepted; settling the current action before applying it.':command.action==='pause'?'Automation paused.':'Control accepted; resuming from a fresh observation.')+dropped).slice(0,4096)};
    this.store.saveTask(task,task.stateVersion);
    this.store.appendEvent(conversationId,'task.control_accepted',{taskId,control:task.executionControl},taskId);
    record?.(task);
    return task;
  }
  /** A user's direct command is still settling, so a new one joins the FIFO queue. */
  private queuesDirectCommand(task:TaskSnapshot,previous:TaskRevision):boolean {
    return ['browser','computer'].includes(task.gatewayTarget?.adapter??'')&&previous.directCommand===true&&(['queued','starting','running'].includes(task.state)||(task.state==='interrupting'&&task.executionControl?.action==='revise'));
  }
  /** Speech while a direct command settles is the next command, not an interruption:
   * pausing first would fold it into a correction of the running command. */
  voicePauseApplies(taskId:string):boolean {
    const task=this.store.task(taskId);
    if(!task)return false;
    return !(task.automationController==='user'&&this.queuesDirectCommand(task,this.revision(taskId,task.revision)));
  }
  cancel(context: CommandContext, taskId: string, replacedByTaskId?: string): TaskSnapshot {
    // A handed-off utterance allows one task_update only; it never ends the user's session.
    if (this.liveReceipt(context.inputId)?.code === 'AGENT_HANDOFF') throw new OrchestrationError('AGENT_HANDOFF_ONE_COMMAND', 'This input may only become one task_update mode=when_ready on the handed-off task.');
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
    // Ending a settled round, by the user or the agent, closes its session only:
    // the round's completed/failed outcome is not rewritten as a cancellation.
    if (TERMINAL_TASK_STATES.has(task.state)) {
      const session=automationSession(task),closes=Boolean(session&&session.status!=='closed');
      if(closes){
        task.automationSession={...session!,status:'closed',closedAt:Date.now(),closedReason:requestedBy};
        if(task.gatewayTarget?.adapter==='computer'&&task.gatewayDispatch)task.computerRevocation={requestId:task.gatewayDispatch.requestId,requestedAt:Date.now()};
      }
      if(replacedByTaskId)task.replacedByTaskId=replacedByTaskId;
      if(closes||replacedByTaskId)this.store.saveTask(task,task.stateVersion);
      // A subagent whose stop was unconfirmed outlives its ended parent; this retries its cleanup.
      this.cancelSubagents(task);
      return task;
    }
    if (task.state === 'cancel_requested') {
      // A user's explicit stop wins; an agent cancel must not erase the stall evidence.
      const overridesStall = task.cancellation?.requestedBy === 'supervisor' && requestedBy === 'user';
      if (overridesStall) task.cancellation = { requestedBy, requestedAt: Date.now() };
      if (replacedByTaskId) task.replacedByTaskId = replacedByTaskId;
      if (replacedByTaskId || overridesStall) this.store.saveTask(task, task.stateVersion);
      return task;
    }
    if (replacedByTaskId) task.replacedByTaskId = replacedByTaskId;
    const version = task.stateVersion;
    // Retrying an unconfirmed stall stop ("Retry cleanup") finishes the supervisor's
    // stop; it must not turn that stall into a user/agent cancellation.
    const retriesStall = task.state === 'needs_reconciliation' && task.cancellation?.requestedBy === 'supervisor';
    if (!retriesStall) task.cancellation = { requestedBy, requestedAt: Date.now() };
    delete task.queuedCommands;
    task.state = task.activeAttemptId || (task.gatewayTarget?.adapter==='computer' && task.gatewayDispatch) ? 'cancel_requested' : 'cancelled';
    task.pendingQuestion = undefined;
    delete task.failure;
    task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: task.state==='cancel_requested' ? 'Disconnecting; waiting for execution and access to stop.' : 'Session ended. Existing files and prior effects are retained.' };
    this.store.saveTask(task, version);
    if (task.state === 'cancelled') this.notify(task);
    else { this.store.enqueue('interrupt', `cancel:${taskId}:${task.stateVersion}`, { taskId }); this.cancelSubagents(task); }
    return task;
  }
  /** A settled computer round still owns device access until explicit revocation. */
  finishIdleComputerCleanup(taskId:string,requestId:string):void {
    this.store.transaction(()=>{
      const task=this.store.task(taskId);
      if(!task||task.activeAttemptId||task.gatewayTarget?.adapter!=='computer'||task.gatewayDispatch?.requestId!==requestId)throw new OrchestrationError('STALE_ATTEMPT');
      // A terminal round keeps its reported outcome; only the pending revocation is settled.
      if(TERMINAL_TASK_STATES.has(task.state)&&task.computerRevocation?.requestId===requestId){delete task.computerRevocation;this.store.saveTask(task,task.stateVersion);return;}
      if(task.state!=='cancel_requested')throw new OrchestrationError('STALE_ATTEMPT');
      task.state='cancelled';task.latestProgress={source:'runtime',observedAt:Date.now(),text:'Computer Use disconnected.'};
      this.store.saveTask(task,task.stateVersion);this.notify(task);
    });
  }
  /** Scheduler-only cleanup acknowledgment; never authorizes new worker writes. */
  finishCleanup(attemptId: string, generation: number, stopped: boolean): void {
    this.store.transaction(() => {
      const attempt = this.store.attempt(attemptId), task = attempt && this.store.task(attempt.taskId);
      if (!attempt || !task || attempt.generation !== generation || task.activeAttemptId !== attemptId || task.state !== 'cancel_requested') throw new OrchestrationError('STALE_ATTEMPT');
      const stalled = this.stalledFailure(task, stopped);
      const message = stalled ? stalled.message : stopped ? `Cancelled by ${task.cancellation?.requestedBy ?? 'agent'}. Task execution stopped; existing files and prior effects are retained.` : 'Cannot verify that this task has stopped. Retry cleanup; no unrelated processes were stopped.';
      task.state = stopped ? (stalled ? 'failed' : 'cancelled') : 'needs_reconciliation';
      task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: message };
      if (stopped) {
        attempt.state = 'ended'; task.activeAttemptId = undefined; delete task.failure;
        if (stalled) { attempt.failure = stalled; task.failure = stalled; }
        this.pool.release(task.taskId, false);
      } else {
        attempt.state = 'unknown'; task.failure = stalled ?? { code: 'CLEANUP_UNCONFIRMED', message, observedAt: Date.now() };
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
          throw new OrchestrationError('EXECUTION_DENIED', `EXECUTION_DENIED: This is an internal report/non-executing turn (execute capability is off for this turn), so it cannot commit a task answer here. This is a turn-scoped permission boundary — not a system outage, and not proof that a prior answer was rejected or lost: any task command already committed on an executing turn stays durably saved and reaches the worker when it resumes. Do not retry this mutation on this turn or report the service as unavailable; reconcile the worker's request against the committed answer/receipt, and surface only a genuinely new decision to the user on a normal turn.`);
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
      // A subagent's ancestors hold their slots while they wait for it. They are not counted
      // against it, so a chain can always extend (no deadlock), while siblings still queue
      // within the usual limits (no tree takes every worker process).
      const ancestors: TaskSnapshot[] = [];
      for (let id = task.parentTaskId; id;) { const parent = this.store.task(id); if (!parent) break; ancestors.push(parent); id = parent.parentTaskId; }
      // A subagent only runs for a parent that is running; after a restart its parent awaits reconciliation.
      if (task.parentTaskId && !RUNNING_PARENT.includes(ancestors[0]?.state ?? '')) return undefined;
      const holding = ancestors.filter(parent => parent.activeAttemptId).length;
      const active = this.store.all('SELECT conversation_id,COUNT(*) AS n FROM tasks WHERE active_attempt_id IS NOT NULL GROUP BY conversation_id');
      if (active.reduce((n, row) => n + Number(row.n), 0) - holding >= this.config.tasks.maxConcurrentPerAgent || Number(active.find(row => row.conversation_id === task.conversationId)?.n ?? 0) - holding >= this.config.tasks.maxConcurrentPerConversation) return undefined;
      const worker = task.gatewayTarget ? { sessionId: task.gatewayTarget.sessionId, workerId: undefined } : this.pool.acquire(task, this.config.tasks.maxConcurrentPerAgent + holding, this.config.tasks.workerIdleTtlMs);
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
      if (task.restartResume) task.restartResume.pending = false;
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
      const startedAt = attempt.startedAt ?? attempt.processIdentity?.startedAt ?? task.createdAt;
      // Reviews alone never end a task (#557): past the limit without a new
      // worker report, stop the attempt through the cancellation path.
      let reportedAt = Math.max(startedAt, task.latestProgress?.source === 'worker' ? task.latestProgress.observedAt : 0);
      const limit = this.config.tasks.progressStaleLimitMs;
      // A parent blocked in subagent_wait cannot report; its subagents' reports are its progress.
      if (limit && task.state === 'running' && observation.observedAt - reportedAt >= limit) reportedAt = Math.max(reportedAt, this.subtreeReportedAt(task.taskId));
      if (limit && task.state === 'running' && observation.observedAt - reportedAt >= limit) {
        this.stopStalled(task, observation.observedAt - reportedAt, observation);
        return;
      }
      if (observation.observedAt - startedAt >= this.config.tasks.progressStaleMs && observation.observedAt - this.subtreeReportedAt(task.taskId, startedAt) >= this.config.tasks.progressStaleMs) {
        if (observation.resultSeenAt !== undefined) {
          this.supervise(task, 'result_seen_not_terminal', `The worker returned a final result ${Math.max(0, Math.round((observation.observedAt - observation.resultSeenAt) / 1000))}s ago, but ${observation.pendingBackground ?? 0} native background task(s) have not reported completion, so the task is not terminal yet. The result is accepted automatically once the background grace period passes without activity. Report what is still being awaited; stop background work that is no longer needed.`, observation.observedAt);
        } else {
          this.supervise(task, 'stale_progress', 'A scheduled progress update is due. Report completed steps, the current step, and any concrete dependency being awaited. Use substantive evidence; process/tool activity alone does not prove progress. Do not volunteer reassurance that the task is not stuck or is really running.', observation.observedAt);
        }
      }
    });
  }
  /** The latest worker progress report, or finish, anywhere below a task; `floor` when there is none later. */
  private subtreeReportedAt(taskId: string, floor = 0): number {
    const row = this.store.get(`WITH RECURSIVE below(id) AS (SELECT id FROM tasks WHERE json_extract(snapshot_json,'$.parentTaskId')=?
        UNION SELECT t.id FROM tasks t JOIN below b ON json_extract(t.snapshot_json,'$.parentTaskId')=b.id)
      SELECT MAX(MAX(CASE WHEN json_extract(snapshot_json,'$.latestProgress.source')='worker' THEN json_extract(snapshot_json,'$.latestProgress.observedAt') ELSE 0 END),
        MAX(CASE WHEN state IN ('completed','failed','cancelled') THEN updated_at ELSE 0 END)) AS at FROM tasks WHERE id IN (SELECT id FROM below)`, taskId);
    return Math.max(floor, Number(row?.at ?? 0));
  }
  private stopStalled(task: TaskSnapshot, quietMs: number, observation: import('../execution-observation').ExecutionObservation): void {
    const minutes = Math.round(quietMs / 60000);
    const reason = `No new worker progress report for ${minutes} minute(s), past tasks.progressStaleLimitMs (${Math.round(this.config.tasks.progressStaleLimitMs / 60000)} minute(s)).` +
      (observation.resultSeenAt !== undefined ? ` A final result was received but ${observation.pendingBackground ?? 0} native background task(s) never reported completion.` : '');
    task.cancellation = { requestedBy: 'supervisor', requestedAt: observation.observedAt, reason };
    task.state = 'cancel_requested';
    task.latestProgress = { source: 'runtime', observedAt: observation.observedAt, text: `Stopping: ${reason}` };
    this.store.saveTask(task, task.stateVersion);
    this.store.appendEvent(task.conversationId, 'task.progress_stalled', { taskId: task.taskId, attemptId: observation.attemptId, quietMs, limitMs: this.config.tasks.progressStaleLimitMs, resultSeenAt: observation.resultSeenAt, pendingBackground: observation.pendingBackground }, task.taskId);
    this.store.enqueue('interrupt', `stalled:${task.taskId}:${task.stateVersion}`, { taskId: task.taskId });
    this.cancelSubagents(task);
  }
  /** A supervisor stop is a failure with its evidence, not a user/agent cancellation.
   * An unconfirmed stop keeps the cleanup code every other unconfirmed stop uses. */
  private stalledFailure(task: TaskSnapshot, stopped = true): TaskSnapshot['failure'] {
    if (task.cancellation?.requestedBy !== 'supervisor') return undefined;
    const reason = task.cancellation.reason ?? 'No new worker progress report within tasks.progressStaleLimitMs.';
    return stopped
      ? { code: 'PROGRESS_STALLED', message: `${reason} Stopped the attempt; existing files and prior effects are retained. Inspect them before retrying.`, observedAt: task.cancellation.requestedAt }
      : { code: 'CLEANUP_UNCONFIRMED', message: `${reason} Cannot verify that the attempt stopped. Retry cleanup; no unrelated processes were stopped.`, observedAt: Date.now() };
  }
  private supervise(task: TaskSnapshot, reason: NonNullable<TaskSnapshot['supervision']>['reason'], message: string, now = Date.now()): void {
    // Keep internal inspection frequent even when user-facing reports are quiet.
    // The agent independently decides whether this review merits a message.
    const since = task.supervision?.observedAt ?? (task.activeAttemptId ? this.store.attempt(task.activeAttemptId)?.startedAt : undefined) ?? task.createdAt;
    if ((task.supervision || reason !== 'repeated_tools') && now - since < this.config.tasks.progressNotifyCooldownMs) return;
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
      // As with a native subagent, only its parent reads its output and nothing could answer it here.
      if (task.parentTaskId) throw new OrchestrationError('SUBAGENT_INPUT_UNAVAILABLE', 'A subagent cannot ask questions. Finish now and put the open question, with what you found so far, in your final result; your parent decides.');
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
    const refusals = outcome.type === 'completed' ? outcome.result.providerRefusals : outcome.failure?.providerRefusals ?? outcome.providerRefusals;
    return this.store.transaction(() => {
      const { task, attempt } = this.active(attemptId, generation);
      if (task.gatewayTarget?.adapter === 'computer' && outcome.computerReport) task.computerReport=outcome.computerReport;
      if (task.gatewayTarget?.adapter === 'browser' && outcome.browserReport) task.browserReport=outcome.browserReport;
      if (outcome.computerReport || outcome.browserReport) recordAction(task, attempt.revision, this.revision(task.taskId, attempt.revision).instructions, outcome);
      // A structured unresolved blocker is not successful task completion.
      const waitingForCommand=outcome.type==='paused'&&['browser','computer'].includes(task.gatewayTarget?.adapter??'')&&['THINKING_WAITING_INPUT','COMMAND_WAITING_INPUT','COMPLETION_CANDIDATE','VERIFICATION_FAILED'].includes(outcome.computerReport?.reason??outcome.browserReport?.reason??'');
      if (outcome.type === 'paused' && !waitingForCommand && !(task.state === 'waiting_input' && task.pendingQuestion) &&
        task.state !== 'interrupting' && task.state !== 'cancel_requested' && !(task.gatewayTarget && task.revision > attempt.revision)) throw new OrchestrationError('STATE_CONFLICT');
      // Keep the full final report, and preserve cancellation / new revisions / questions.
      const blocked = outcome.type === 'completed' && task.workflow?.attemptId === attemptId &&
        task.workflow.checkpoint.phase === 'blocked' && task.workflow.checkpoint.findings.some(f => f.status === 'open');
      if (blocked && outcome.type === 'completed') {
        attempt.result = outcome.result; task.result = outcome.result;
        outcome = { type: 'failed', failure: { code: 'WORKER_BLOCKED', message: task.workflow!.checkpoint.findings.filter(f => f.status === 'open').map(f => f.summary).join('\n').slice(0, 4096), observedAt: Date.now() } };
      }
      const stalled = task.state === 'cancel_requested' ? this.stalledFailure(task, outcome.type !== 'unknown') : undefined;
      const restartInterrupted = (outcome.type === 'failed' || outcome.type === 'stopped') && outcome.failure?.code === 'GATEWAY_SHUTDOWN' && restartResumable(task);
      if (outcome.type !== 'completed' && outcome.type !== 'paused') {
        attempt.failure = stalled ?? outcome.failure ?? taskFailure(undefined, outcome.type === 'stopped' ? 'WORKER_STOPPED' : 'WORKER_FAILED');
        task.failure = attempt.failure;
      } else { delete task.failure; }
      if (outcome.type === 'unknown') { if(task.executionControl?.phase==='pending')task.executionControl.phase='blocked'; attempt.state = 'unknown'; task.state = 'needs_reconciliation'; }
      else {
        attempt.state = 'ended'; task.activeAttemptId = undefined;
        if (outcome.type === 'completed') attempt.result = outcome.result;
        if (task.state === 'cancel_requested') {
          task.state = outcome.type === 'completed' && task.revision === attempt.revision ? 'completed' : stalled ? 'failed' : 'cancelled';
        } else if (task.state === 'waiting_input' && task.pendingQuestion) { /* retain question; execution slot now free */ }
        else if(task.executionControl?.phase==='pending'&&task.executionControl.action==='pause'){task.state='waiting_input';task.executionControl.phase='paused';delete task.failure;}
        else if (task.state === 'interrupting' || task.revision > attempt.revision) task.state = 'queued';
        else if(waitingForCommand){task.state='waiting_input';task.latestProgress={source:'runtime',observedAt:Date.now(),text:task.gatewayTarget?.adapter==='computer'&&outcome.computerReport?computerOutcomeText(outcome.computerReport):task.gatewayTarget?.adapter==='browser'&&outcome.browserReport?browserOutcomeText(outcome.browserReport):'Waiting for your next command.'};}
        else if (restartInterrupted) this.resumeAfterRestart(task, attempt);
        else task.state = outcome.type === 'completed' ? 'completed' : 'failed';
        if (task.state === 'completed' && outcome.type === 'completed') task.result = outcome.result;
        // The device session ended with this round (a reached computer goal): the
        // task no longer controls anything, so it leaves the owner's composer too.
        if (task.state === 'completed' && outcome.computerReport?.accessReleased) task.automationSession = {...(automationSession(task) ?? {idleTimeoutMs:AUTOMATION_IDLE_TIMEOUT_MS}), status:'closed', closedAt:Date.now(), closedReason:'agent'};
      }
      // A paused or superseded-revision result skips the failure branch above;
      // a stalled stop still ends failed, so it must carry the stall reason.
      if (task.state === 'failed' && stalled) { attempt.failure = stalled; task.failure = stalled; task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: stalled.message }; }
      // After every failure reassignment above, so a stop or stall reason cannot drop them.
      if (refusals?.length && attempt.failure && !attempt.failure.providerRefusals) {
        attempt.failure = { ...attempt.failure, providerRefusals: refusals };
        if (task.failure) task.failure = attempt.failure;
      }
      if (task.queuedCommands?.length) this.nextQueuedCommand(task, waitingForCommand || outcome.type === 'completed');
      if (task.state === 'cancelled') {
        delete task.failure;
        task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: `Cancelled by ${task.cancellation?.requestedBy ?? 'agent'}. Existing files and prior effects are retained.` };
      }
      if (outcome.type === 'completed' && outcome.result.unresolvedBackground) {
        this.store.appendEvent(task.conversationId, 'task.background_unresolved', { attemptId, ...outcome.result.unresolvedBackground }, task.taskId);
      }
      if (refusals?.length) this.store.appendEvent(task.conversationId, 'task.provider_refusal', { attemptId, refusals }, task.taskId);
      if (outcome.type !== 'unknown') this.pool.release(task.taskId, outcome.type === 'completed' || outcome.type === 'paused');
      // A resume brief belongs only to the next attempt of a re-queued task.
      if (task.restartResume && task.state !== 'queued') task.restartResume.pending = false;
      this.store.saveAttempt(attempt); this.store.saveTask(task, task.stateVersion);
      if (task.state === 'queued') this.store.enqueue('schedule', `schedule:${task.taskId}:${task.stateVersion}`, { taskId: task.taskId });
      else if (TERMINAL_TASK_STATES.has(task.state) || task.state === 'needs_reconciliation' || (waitingForCommand&&task.state==='waiting_input'&&task.automationController!=='user'&&task.executionControl?.phase!=='paused') || (waitingForCommand&&agentStepRunEnded(task))) this.notify(task);
      return task;
    });
  }
  /** Delivers the oldest queued direct command after a settled round, or drops
   * the queue when the round did not settle cleanly; queued text is never replayed later. */
  private nextQueuedCommand(task: TaskSnapshot, settled: boolean): void {
    const queue = task.queuedCommands ?? [];
    if (!settled || !['waiting_input','completed'].includes(task.state) || task.pendingQuestion || task.executionControl?.phase === 'paused' || automationSession(task)?.status === 'closed') {
      if (TERMINAL_TASK_STATES.has(task.state) || task.state === 'needs_reconciliation' || task.state === 'waiting_input') {
        const dropped = `${queue.length} queued command${queue.length === 1 ? ' was' : 's were'} not sent because the previous command did not finish normally: ${queue.map(c => JSON.stringify(c.text.slice(0, 60))).join(', ')}.`;
        task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: [task.latestProgress?.text, dropped].filter(Boolean).join('\n').slice(0, 4096) };
        delete task.queuedCommands;
      }
      return;
    }
    const [next, ...rest] = queue;
    const previous = this.revision(task.taskId, task.revision);
    task.revision++;
    this.store.run('INSERT INTO task_revisions VALUES(?,?,?)', task.taskId, task.revision, JSON.stringify({...previous, requestBrowserConsent: true, revision: task.revision, instructions: next.text, mode: 'interrupt_and_resume', computerInputs: undefined, answers: undefined, browserRecoveryCount: 0, guidance: undefined, guidanceBasis: undefined, directCommand: true}));
    task.queuedCommands = rest.length ? rest : undefined;
    if (!task.queuedCommands) delete task.queuedCommands;
    if (task.state === 'completed') { delete task.result; delete task.computerReport; delete task.browserReport; delete task.gatewayDispatch; }
    task.executionControl = { id: next.id, action: 'revise', revision: task.revision, phase: 'pending', requestedAt: Date.now() };
    task.state = 'queued';
    const done = task.latestProgress?.text;
    task.latestProgress = { source: 'runtime', observedAt: Date.now(), text: [done, `Running queued command: ${JSON.stringify(next.text.slice(0, 120))}${rest.length ? ` (${rest.length} more waiting)` : ''}.`].filter(Boolean).join('\n').slice(0, 4096) };
  }
  private notify(task: TaskSnapshot): void {
    // A native subagent dies with its parent session; a durable child would otherwise be orphaned.
    if (TERMINAL_TASK_STATES.has(task.state) || task.state === 'needs_reconciliation') this.cancelSubagents(task);
    // Subagents report to the parent worker (subagent_wait), never to the channel, except an
    // unconfirmed stop no running parent can see: it holds a slot until someone retries its cleanup.
    if (task.parentTaskId && !(task.state === 'needs_reconciliation' && !RUNNING_PARENT.includes(this.store.task(task.parentTaskId)?.state ?? ''))) return;
    const input = this.store.get('SELECT binding_id FROM conversation_inputs WHERE id=?', task.initiatingInputId)!;
    const notificationId = randomUUID();
    this.store.run(`INSERT INTO notifications(id,conversation_id,task_id,task_state_version,originating_binding_id) VALUES(?,?,?,?,?) ON CONFLICT(task_id,task_state_version) DO NOTHING`,
      notificationId, task.conversationId, task.taskId, task.stateVersion, input.binding_id);
    this.store.enqueue('notification', `notification:${task.taskId}:${task.stateVersion}`, { conversationId: task.conversationId, taskId: task.taskId, notificationId });
  }
  private cancelSubagents(parent: TaskSnapshot): void {
    for (const row of this.store.all("SELECT snapshot_json FROM tasks WHERE json_extract(snapshot_json,'$.parentTaskId')=? AND state NOT IN ('completed','failed','cancelled')", parent.taskId)) {
      const child = JSON.parse(String(row.snapshot_json)) as TaskSnapshot;
      // cancelOwned cascades below each child (at cancel_requested, or via notify once it ends).
      this.cancelOwned(child.conversationId, child.taskId);
    }
  }
  /**
   * subagent_spawn: a worker's subagent becomes a task in the same
   * conversation, with the worker's owner, capabilities and project, linked to
   * its parent. It is scheduled and admitted like any other task.
   */
  spawnSubagent(attemptId: string, generation: number, actionId: string, spec: { title: string; instructions: string; model?: string; effort?: Effort; subagentType?: string; readonly?: boolean }): TaskSnapshot {
    boundedText(spec.title, 512); boundedText(spec.instructions);
    return this.store.transaction(() => {
      const { task: parent } = this.active(attemptId, generation);
      const receipt = this.workerReceipt(attemptId, actionId, 'subagent_spawn', JSON.stringify(spec));
      if (receipt.prior) return receipt.prior as TaskSnapshot;
      if (!['starting', 'running'].includes(parent.state)) throw new OrchestrationError('STATE_CONFLICT', `This task is ${parent.state}; it cannot start subagents.`);
      const depth = (parent.depth ?? 0) + 1;
      if (depth > SUBAGENT_MAX_DEPTH) throw new OrchestrationError('SUBAGENT_DEPTH_EXCEEDED', `Subagents nest at most ${SUBAGENT_MAX_DEPTH} levels below the root worker. Do this work inline.`);
      // The same admission as task_spawn: no new work while the conversation drains, and both queue limits.
      if (this.store.get('SELECT status FROM conversations WHERE id=?', parent.conversationId)?.status !== 'active') throw new OrchestrationError('DRAINING');
      const queuedRows = this.store.all("SELECT conversation_id,COUNT(*) AS n FROM tasks WHERE state='queued' GROUP BY conversation_id");
      const queued = Number(queuedRows.find(row => row.conversation_id === parent.conversationId)?.n ?? 0);
      if (queued >= this.config.tasks.maxQueuedPerConversation || queuedRows.reduce((n, row) => n + Number(row.n), 0) >= this.config.tasks.maxQueuedPerAgent) {
        throw new OrchestrationError('QUEUE_FULL', `This agent already has the most queued tasks it allows. Wait for a subagent to finish (subagent_wait) or do this work inline.`);
      }
      const now = Date.now();
      const task: TaskSnapshot = { taskId: randomUUID(), conversationId: parent.conversationId, agentId: parent.agentId, agentSessionId: parent.agentSessionId,
        ownerPrincipalId: parent.ownerPrincipalId, initiatingInputId: parent.initiatingInputId, title: spec.title, targetProfile: 'default-worker',
        state: 'queued', stateVersion: 1, revision: 1, appliedRevision: 0, timing: { phase: 'queued', since: now, measuredFrom: now, totals: {} },
        capabilities: parent.capabilities, createdAt: now, updatedAt: now,
        parentTaskId: parent.taskId, rootTaskId: parent.rootTaskId ?? parent.taskId, depth,
        // A read-only subagent cannot hand out write access to its own subagents.
        ...(spec.subagentType ? { subagentType: spec.subagentType } : {}), ...(spec.readonly || parent.readonly ? { readonly: true } : {}) };
      task.workstreamId = task.taskId;
      const model = spec.model ?? parent.model;
      if (model) task.model = model;
      const effort = spec.effort ?? parent.effort;
      if (effort) task.effort = effort;
      if (parent.resourceProfile) task.resourceProfile = parent.resourceProfile;
      this.store.run('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)', task.taskId, task.conversationId, task.state, 1, 1, null, JSON.stringify(task), now, now);
      const revision: TaskRevision = { taskId: task.taskId, revision: 1, instructions: spec.instructions, contextRefs: [], mode: 'when_ready', originatingInputId: parent.initiatingInputId };
      this.store.run('INSERT INTO task_revisions VALUES(?,?,?)', task.taskId, 1, JSON.stringify(revision));
      this.store.appendEvent(task.conversationId, 'task.created', task, task.taskId);
      this.store.enqueue('schedule', `schedule:${task.taskId}:1`, { taskId: task.taskId });
      this.saveWorkerReceipt(attemptId, actionId, 'subagent_spawn', receipt.hash, task);
      return task;
    });
  }
  /** A subagent's parent, grandparent and so on, nearest first; empty for a root task. */
  ancestorIds(taskId: string): string[] {
    const ids: string[] = [];
    for (let id = this.store.task(taskId)?.parentTaskId; id && ids.length <= SUBAGENT_MAX_DEPTH;) { ids.push(id); id = this.store.task(id)?.parentTaskId; }
    return ids;
  }
  /** The calling worker's own subagents among `taskIds`; anything else is denied. */
  private subagents(attemptId: string, generation: number, taskIds: unknown): TaskSnapshot[] {
    const { task: parent } = this.active(attemptId, generation);
    if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 32 || taskIds.some(id => typeof id !== 'string')) throw new OrchestrationError('INVALID_INPUT');
    return taskIds.map(id => {
      const child = this.store.task(id as string);
      if (!child || child.parentTaskId !== parent.taskId) throw new OrchestrationError('ACCESS_DENIED');
      return child;
    });
  }
  /** subagent_wait: results once every listed subagent has finished; undefined while any is still working. */
  subagentResults(attemptId: string, generation: number, taskIds: unknown) {
    const children = this.subagents(attemptId, generation, taskIds);
    if (children.some(child => !TERMINAL_TASK_STATES.has(child.state) && child.state !== 'needs_reconciliation')) return undefined;
    return children.map(child => ({ task_id: child.taskId, state: child.state, model: child.model, effort: child.effort,
      ...(child.result ? { result: child.result.summary } : {}),
      // Files it staged are delivered with the root's result; listed so the parent can refer to them.
      ...this.stagedFiles(child), ...(child.failure ? { failure: { code: child.failure.code, message: child.failure.message } } : {}),
      ...(child.state === 'needs_reconciliation' ? { note: 'Its process could not be confirmed stopped and may still be running. Cancel it with subagent_cancel before relying on files it touched.' } : {}) }));
  }
  private stagedFiles(task: TaskSnapshot): { staged_files?: string[] } {
    if (task.state !== 'completed' || !task.result?.artifactIds.length) return {};
    const names = this.store.all("SELECT f.name FROM task_files f WHERE f.task_id=? AND f.id IN (SELECT value FROM json_each(?)) ORDER BY f.created_at,f.id", task.taskId, JSON.stringify(task.result.artifactIds)).map(row => String(row.name));
    return names.length ? { staged_files: names } : {};
  }
  /** subagent_cancel: cancel the calling worker's own subagents and everything below them. */
  cancelSubagentTasks(attemptId: string, generation: number, taskIds: unknown) {
    return this.store.transaction(() => this.subagents(attemptId, generation, taskIds).map(child => {
      const task = this.cancelOwned(child.conversationId, child.taskId);
      return { task_id: task.taskId, state: task.state };
    }));
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
      if(task.ownerPrincipalId!==context.principalId || task.gatewayTarget?.adapter!=='computer' || !['failed','waiting_input'].includes(task.state) || task.revision!==revision || task.gatewayDispatch?.requestId!==requestId || !task.computerReport || task.computerReport.status!=='needs_verification')throw new OrchestrationError('COMPUTER_VERIFICATION_UNAVAILABLE');
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
  /** Re-queue already-authorized work interrupted by a gateway restart as a new attempt of the same
   * task (#603), or fail it as a blocker once the per-revision cap is spent. No failure report is
   * sent for a resume: that report turn could only ask the user to continue. */
  private resumeAfterRestart(task: TaskSnapshot, attempt: TaskAttempt): boolean {
    const previous = task.restartResume?.revision === attempt.revision ? task.restartResume : undefined;
    const count = (previous?.count ?? 0) + 1;
    if (count > MAX_RESTART_RESUMES) {
      task.state = 'failed';
      if (task.restartResume) task.restartResume.pending = false;
      attempt.failure = task.failure = { code: 'GATEWAY_SHUTDOWN_REPEATED', message: `Gateway restarts interrupted this task ${count} times; automatic resume stopped after ${MAX_RESTART_RESUMES} resumes. Existing changes are retained; any follow-up must verify them first and must not blindly repeat side effects.`, observedAt: Date.now() };
      return false;
    }
    task.state = 'queued';
    task.restartResume = { count, revision: attempt.revision, pending: true,
      lastProgress: task.latestProgress?.source === 'worker' ? task.latestProgress.text : previous?.lastProgress };
    this.cancelSubagents(task);
    return true;
  }
  /** Scheduler-only: settle a worker that restart recovery could not prove had stopped. */
  resolveRestartRecovery(attemptId: string, generation: number, stopped: boolean): void {
    this.store.transaction(() => {
      const attempt = this.store.attempt(attemptId), task = attempt && this.store.task(attempt.taskId);
      if (!attempt || !task || attempt.generation !== generation || task.activeAttemptId !== attemptId || task.state !== 'needs_reconciliation' || !task.restartRecovery) throw new OrchestrationError('STALE_ATTEMPT');
      delete task.restartRecovery;
      if (!stopped) {
        task.failure = { code: 'CLEANUP_UNCONFIRMED', message: 'Cannot verify that the worker from before the gateway restart has stopped. Retry cleanup; no unrelated processes were stopped.', observedAt: Date.now() };
        this.store.saveTask(task, task.stateVersion);
        this.notify(task);
        return;
      }
      attempt.state = 'ended'; attempt.failure = task.failure = shutdownFailure();
      task.activeAttemptId = undefined;
      this.pool.release(task.taskId, false);
      const resumed = this.resumeAfterRestart(task, attempt);
      this.store.saveAttempt(attempt); this.store.saveTask(task, task.stateVersion);
      this.store.appendEvent(task.conversationId, 'task.restart_recovered', { stopped, state: task.state }, task.taskId);
      if (resumed) this.store.enqueue('schedule', `schedule:${task.taskId}:${task.stateVersion}`, { taskId: task.taskId });
      else this.notify(task);
    });
  }
  reconcile(taskId: string, state: 'queued' | 'failed' | 'cancelled' | 'waiting_input', evidence: string): TaskSnapshot {
    boundedText(evidence, 4096);
    if (!['queued', 'failed', 'cancelled', 'waiting_input'].includes(state)) throw new OrchestrationError('INVALID_RECONCILIATION');
    return this.store.transaction(() => {
      const task = this.store.task(taskId);
      if (!task || task.state !== 'needs_reconciliation' || !task.activeAttemptId) throw new OrchestrationError('RECONCILIATION_NOT_REQUIRED');
      if(['queued','waiting_input'].includes(state)&&automationSession(task)?.status==='closed')throw new OrchestrationError('AUTOMATION_SESSION_CLOSED');
      const attempt = this.store.attempt(task.activeAttemptId)!;
      attempt.state = 'ended'; task.activeAttemptId = undefined; task.state = state;
      if(state==='cancelled')task.failure=undefined;
      if(state==='queued'&&task.gatewayTarget){task.gatewayDispatch=undefined;task.failure=undefined;task.computerReport=undefined;}
      if(state==='waiting_input'){task.failure=undefined;task.computerReport={steps:0,...task.computerReport,status:'needs_input',reason:'COMMAND_WAITING_INPUT'};if(task.automationSession)task.automationSession={...task.automationSession,status:'idle',idleSince:Date.now()};}
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
