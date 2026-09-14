import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { CommandContext, ConversationScope } from '../../../src/orchestration/types';
import { recoverOrchestration } from '../../../src/orchestration/recovery';

const scope: ConversationScope = { agentId: 'agent', agentSessionId: 'agentSession', source: 'api', accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'user' };
describe('durable conversation/task state', () => {
  let root: string, store: OrchestrationStore, tasks: TaskService, decisions: DecisionService, ctx: CommandContext;
  const spawn = () => tasks.spawn(ctx, { title: 'Fix login', instructions: 'Inspect and fix login', targetProfile: 'default-worker' });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orchestration-store-'));
    store = new OrchestrationStore(join(root, 'orchestration.db'), 'agent'); tasks = new TaskService(store); decisions = new DecisionService(store);
    const receipt = store.acceptInput({ scope, text: 'Fix login' });
    const decision = decisions.begin(receipt.conversationId, 'user', [receipt.inputId]);
    ctx = { ...receipt, ...decision, principalId: 'user', execute: true, writeMemory: false, actionId: 'action-1' };
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  test('voice and task report admissions inherit the selected model without crossing conversations or changing retries', () => {
    store.acceptInput({ scope, text: 'Use Luna', model: 'gpt-5.6-luna' });
    const voice = store.acceptInput({ scope, text: 'Voice follow-up', modality: 'live_voice', ingressKey: 'voice-one' });
    const report = store.acceptInput({ scope, text: 'Task report', storeUserMessage: false });
    const modelOf = (id: string) => JSON.parse(String(store.get('SELECT ingress_json FROM conversation_inputs WHERE id=?', id)!.ingress_json)).model;
    expect(modelOf(voice.inputId)).toBe('gpt-5.6-luna');
    expect(modelOf(report.inputId)).toBe('gpt-5.6-luna');
    store.acceptInput({ scope, text: 'Switch', model: 'another-model' });
    expect(store.acceptInput({ scope, text: 'Voice follow-up', modality: 'live_voice', ingressKey: 'voice-one' }).inputId).toBe(voice.inputId);
    expect(modelOf(voice.inputId)).toBe('gpt-5.6-luna');
    const other = store.acceptInput({ scope: { ...scope, agentSessionId: 'another-session', chatId: 'another-chat' }, text: 'First message' });
    expect(modelOf(other.inputId)).toBeUndefined();
  });
  test('Agent task status includes recent tools and persisted failure evidence',()=>{
    const task=spawn(),attempt=tasks.claim(task.taskId)!;
    store.transaction(()=>store.appendEvent(ctx.conversationId,'tool.activity',{name:'Bash',type:'tool_result',is_error:true},task.taskId));
    tasks.finish(attempt.attemptId,attempt.generation,{type:'failed',failure:{code:'GATEWAY_SHUTDOWN',message:'Stopped during shutdown',observedAt:Date.now()}});
    const view=tasks.status(ctx.conversationId,'user')[0];
    expect(view.failure?.code).toBe('GATEWAY_SHUTDOWN');expect(view.recentTools).toEqual([expect.objectContaining({name:'Bash',isError:true})]);
  });
  test('commit includes task, revision, receipt and schedule; survives reopening', () => {
    const task = spawn();
    expect(task.state).toBe('queued');
    expect(store.get('SELECT COUNT(*) AS n FROM task_attempts')!.n).toBe(0);
    expect(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='schedule'")!.n).toBe(1);
    store.close(); store = new OrchestrationStore(join(root, 'orchestration.db'), 'agent'); tasks = new TaskService(store);
    expect(spawn()).toEqual(task);
    expect(store.task(task.taskId)).toEqual(task);
  });
  test('retry same action returns same task; changed payload conflicts', () => {
    const a = spawn(); expect(spawn()).toEqual(a);
    expect(() => tasks.spawn(ctx, { title: 'Other', instructions: 'Other', targetProfile: 'default-worker' })).toThrow('IDEMPOTENCY_CONFLICT');
    ctx.actionId = 'action-2'; expect(spawn().taskId).not.toBe(a.taskId);
  });
  test('rollback if receipt write fails leaves no task or schedule', () => {
    const original = store.run.bind(store);
    jest.spyOn(store, 'run').mockImplementation((sql, ...args) => {
      if (sql.startsWith('INSERT INTO task_commands')) throw new Error('disk full');
      return original(sql, ...args);
    });
    expect(spawn).toThrow('disk full');
    expect(store.get('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(0);
    expect(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='schedule'")!.n).toBe(0);
  });
  test('provider retry after session switch returns original agent session; new delivery creates new agent session', () => {
    const a = store.acceptInput({ scope, text: 'same', ingressKey: 'provider-1' });
    const b = store.acceptInput({ scope: { ...scope, agentSessionId: 'new-agentSession' }, text: 'same', ingressKey: 'provider-1' });
    expect(b).toEqual(a);
    const c = store.acceptInput({ scope: { ...scope, agentSessionId: 'new-agentSession' }, text: 'same', ingressKey: 'provider-2' });
    expect(c.conversationId).not.toBe(a.conversationId);
    expect(() => store.acceptInput({ scope, text: 'changed', ingressKey: 'provider-1' })).toThrow('IDEMPOTENCY_CONFLICT');
  });
  test('admission failure commits no orphan input', () => {
    expect(() => store.acceptInput({ scope, text: 'second' }, 1)).toThrow('QUEUE_FULL');
    expect(store.get('SELECT COUNT(*) AS n FROM conversation_inputs')!.n).toBe(1);
  });
  test('one active agent session decision; interruption fences uncommitted commands but keeps receipts', () => {
    const task = spawn();
    const receipt = { decisionId: ctx.decisionId, epoch: ctx.epoch, inputIds: [ctx.inputId] };
    expect(() => decisions.begin(ctx.conversationId, 'user', [ctx.inputId])).toThrow('AGENT_BUSY');
    decisions.interrupt(receipt);
    expect(spawn()).toEqual(task);
    ctx.actionId = 'late'; expect(spawn).toThrow('STALE_DECISION');
    decisions.releaseInterrupted(receipt, false);
    expect(store.task(task.taskId)!.state).toBe('queued');
    expect(decisions.begin(ctx.conversationId, 'user', [ctx.inputId]).epoch).toBeGreaterThan(ctx.epoch);
  });
  test('status and controls cannot cross conversations or elevate source permissions', () => {
    const a = spawn();
    expect(() => tasks.status(ctx.conversationId, 'intruder')).toThrow('ACCESS_DENIED');
    const other = store.acceptInput({ scope: { ...scope, agentSessionId: 'other' }, text: 'Other' });
    expect(() => tasks.status(other.conversationId, 'user', a.taskId)).toThrow('ACCESS_DENIED');
    expect(() => tasks.spawn({ ...ctx, actionId: 'denied', execute: false }, { title: 'Denied', instructions: 'Denied', targetProfile: 'default-worker' })).toThrow('EXECUTION_DENIED');
    expect(tasks.cancel({ ...ctx, actionId: 'cancel', execute: false }, a.taskId).state).toBe('cancelled');
    expect(tasks.claim(a.taskId)).toBeUndefined();
  });
  test('when_ready revision prevents premature completion; old attempt is fenced', () => {
    const task = spawn(), a = tasks.claim(task.taskId)!;
    expect(tasks.claim(task.taskId)).toBeUndefined();
    tasks.started(a.attemptId, a.generation);
    const updated = tasks.update({ ...ctx, actionId: 'update' }, task.taskId, 1, 'Also add regression test', 'when_ready');
    expect(updated.revision).toBe(2); expect(updated.appliedRevision).toBe(1);
    expect(tasks.finish(a.attemptId, a.generation, { type: 'completed', result: { summary: 'revision 1', artifactIds: [] } }).state).toBe('queued');
    const b = tasks.claim(task.taskId)!; tasks.started(b.attemptId, b.generation);
    expect(() => tasks.finish(a.attemptId, a.generation, { type: 'failed' })).toThrow('STALE_ATTEMPT');
    expect(tasks.finish(b.attemptId, b.generation, { type: 'completed', result: { summary: 'revision 2', artifactIds: [] } }).state).toBe('completed');
  });
  test('cancel during startup prevents running; only acknowledgment yields cancelled', () => {
    const task = spawn(), a = tasks.claim(task.taskId)!;
    expect(tasks.cancel({ ...ctx, actionId: 'cancel' }, task.taskId).state).toBe('cancel_requested');
    expect(() => tasks.started(a.attemptId, a.generation)).toThrow('STATE_CONFLICT');
    expect(tasks.finish(a.attemptId, a.generation, { type: 'stopped' }).state).toBe('cancelled');
  });
  test('completion that wins cancel race reports completed; late events cannot change it', () => {
    const task = spawn(), a = tasks.claim(task.taskId)!; tasks.started(a.attemptId, a.generation);
    tasks.cancel({ ...ctx, actionId: 'cancel' }, task.taskId);
    expect(tasks.finish(a.attemptId, a.generation, { type: 'completed', result: { summary: 'done', artifactIds: [] } }).state).toBe('completed');
    expect(() => tasks.finish(a.attemptId, a.generation, { type: 'stopped' })).toThrow('STALE_ATTEMPT');
  });
  test('questions retain slot until true end and stale answers do not start another attempt', () => {
    const task = spawn(), a = tasks.claim(task.taskId)!; tasks.started(a.attemptId, a.generation);
    const q = tasks.requestInput(a.attemptId, a.generation, 'Which target?');
    expect(q.activeAttemptId).toBe(a.attemptId);
    expect(tasks.finish(a.attemptId, a.generation, { type: 'completed', result: { summary: 'waiting', artifactIds: [] } }).state).toBe('waiting_input');
    expect(store.task(task.taskId)!.activeAttemptId).toBeUndefined();
    tasks.update({ ...ctx, actionId: 'update' }, task.taskId, 1, 'Use staging', 'when_ready');
    expect(() => tasks.answer({ ...ctx, actionId: 'answer' }, task.taskId, q.pendingQuestion!.questionId, 'Production')).toThrow('STALE_QUESTION');
  });
  test('recovery retains queued tasks and marks ambiguous running effects for reconciliation', () => {
    const task = spawn(), a = tasks.claim(task.taskId)!; tasks.started(a.attemptId, a.generation);
    ctx.actionId = 'queued'; const queued = spawn();
    expect(recoverOrchestration(store).uncertainTasks).toBe(1);
    expect(store.task(task.taskId)!.state).toBe('needs_reconciliation');
    expect(store.task(queued.taskId)!.state).toBe('queued');
    expect(() => tasks.finish(a.attemptId, a.generation, { type: 'completed', result: { summary: 'late', artifactIds: [] } })).toThrow('STALE_ATTEMPT');
  });
  test('worker report retries return the committed receipt; changed reports conflict', () => {
    const task = spawn(), a = tasks.claim(task.taskId)!; tasks.started(a.attemptId, a.generation);
    tasks.progress(a.attemptId, a.generation, 'Testing', 'report-1');
    const version = store.task(task.taskId)!.stateVersion;
    tasks.progress(a.attemptId, a.generation, 'Testing', 'report-1');
    expect(store.task(task.taskId)!.stateVersion).toBe(version);
    const question = tasks.requestInput(a.attemptId, a.generation, 'Which environment?', 'question-1');
    expect(tasks.requestInput(a.attemptId, a.generation, 'Which environment?', 'question-1')).toEqual(question);
    expect(() => tasks.requestInput(a.attemptId, a.generation, 'A different question', 'question-1')).toThrow('IDEMPOTENCY_CONFLICT');
  });
  test('only an explicit evidenced reconciliation permits another attempt after unknown effects', () => {
    const task = spawn(), a = tasks.claim(task.taskId)!; tasks.started(a.attemptId, a.generation);
    recoverOrchestration(store);
    expect(tasks.claim(task.taskId)).toBeUndefined();
    expect(() => tasks.reconcile(task.taskId, 'queued', '')).toThrow();
    expect(tasks.reconcile(task.taskId, 'queued', 'Verified old process absent and fixture worktree has no external effects.').state).toBe('queued');
    const next = tasks.claim(task.taskId)!;
    expect(next.generation).toBe(a.generation + 1);
    expect(() => tasks.progress(a.attemptId, a.generation, 'Late')).toThrow('STALE_ATTEMPT');
  });
});
