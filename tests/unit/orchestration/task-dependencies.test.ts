import { TaskControls } from '../../../src/orchestration/task-controls';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService, SpawnTask } from '../../../src/orchestration/tasks/service';
import { CommandContext } from '../../../src/orchestration/types';
import { WorkerScheduler } from '../../../src/orchestration/tasks/scheduler';

let store: OrchestrationStore, tasks: TaskService, context: CommandContext, directory: string, sequence: number;
const config = {tasks: {workspaceMode: 'host' as const, maxConcurrentPerAgent: 10, maxConcurrentPerConversation: 10}};
function input(text: string) {
  if (context && store.get("SELECT id FROM conversation_decisions WHERE id=? AND state='running'",context.decisionId)) new DecisionService(store).finish({...context,inputIds:[context.inputId]},'Queued');
  const receipt = store.acceptInput({scope:{agentId:'a',agentSessionId:'chat',source:'api',accountId:'owner',principalId:'owner',chatId:'chat',threadKey:''},text});
  const decision = new DecisionService(store).begin(receipt.conversationId,'owner',[receipt.inputId]);
  context = {...receipt,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:''};
}
function spawn(prior?: string, extra: Partial<SpawnTask> = {}) {
  return tasks.spawn({...context,actionId:`command-${++sequence}`}, {title:'step',instructions:'Execute the authorized step using the predecessor result. No merge.',targetProfile:'default-worker',continueTaskId:prior,...extra});
}
beforeEach(() => {
  context=undefined as unknown as CommandContext;
  directory=mkdtempSync(join(tmpdir(),'task-dependencies-')); sequence=0;
  store=new OrchestrationStore(join(directory,'test.db'),'a');tasks=new TaskService(store,config);input('review then implement then review');
});
afterEach(() => {store.close();rmSync(directory,{recursive:true,force:true});});

test('three persisted steps survive restart and execute in dependency order without another agent decision', async () => {
  const first=spawn(), second=spawn(first.taskId), third=spawn(second.taskId);
  store.close();store=new OrchestrationStore(join(directory,'test.db'),'a');tasks=new TaskService(store,config);
  const started: string[]=[];
  const scheduler=new WorkerScheduler(tasks,{start:async task => {
    started.push(task.taskId);
    if(task.continueTaskId) expect(store.task(task.continueTaskId)?.state).toBe('completed');
    return {accepted:Promise.resolve(),result:Promise.resolve({type:'completed',result:{summary:`Result ${task.taskId}`,artifactIds:[]}}),stop:async()=>{}};
  }});
  for(let i=0;i<5;i++){await scheduler.tick();await new Promise(resolve=>setImmediate(resolve));}
  expect(started).toEqual([first.taskId,second.taskId,third.taskId]);
  expect(store.task(third.taskId)?.state).toBe('completed');
  expect(store.all('SELECT * FROM conversation_decisions')).toHaveLength(1);
});

test.each(['failed','stopped'] as const)('a %s predecessor prevents every dependent step from starting and records notifications once', outcome => {
  const first=spawn(), second=spawn(first.taskId), third=spawn(second.taskId);
  const attempt=tasks.claim(first.taskId)!;
  tasks.finish(attempt.attemptId,attempt.generation,{type:outcome});
  expect(tasks.claim(second.taskId)).toBeUndefined();expect(tasks.claim(third.taskId)).toBeUndefined();
  for(const task of [second,third]) {
    expect(store.task(task.taskId)).toMatchObject({state:'failed',failure:{code:'TASK_DEPENDENCY_FAILED'}});
    expect(store.all('SELECT * FROM task_attempts WHERE task_id=?',task.taskId)).toHaveLength(0);
    tasks.claim(task.taskId);
    expect(store.all('SELECT * FROM notifications WHERE task_id=?',task.taskId)).toHaveLength(1);
  }
});

test('cancelled predecessor blocks its dependents; explicit recovery can still run', () => {
  const first=spawn(), next=spawn(first.taskId);
  tasks.cancelByUser(first.conversationId,'owner',first.taskId);
  expect(tasks.claim(next.taskId)).toBeUndefined();
  const recovery=spawn(next.taskId,{continuationPolicy:'after_terminal'});
  expect(tasks.claim(recovery.taskId)).toBeDefined();
});

test('uncertain predecessor cannot release dependent work or recovery', () => {
  const first=spawn(), attempt=tasks.claim(first.taskId)!;
  tasks.finish(attempt.attemptId,attempt.generation,{type:'unknown'});
  expect(tasks.claim(spawn(first.taskId).taskId)).toBeUndefined();
  expect(tasks.claim(spawn(first.taskId,{continuationPolicy:'after_terminal'}).taskId)).toBeUndefined();
});

test('follow-up inputs persist while earlier task runs; revised queued instructions are applied', () => {
  const first=spawn(), attempt=tasks.claim(first.taskId)!;
  input('After the review implement it');const next=spawn(first.taskId);
  input('Include tests and do not merge');
  tasks.update({...context,actionId:'revise'},next.taskId,1,'Implement predecessor findings, test, do not merge','when_ready');
  expect(tasks.claim(next.taskId)).toBeUndefined();
  tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'Review findings',artifactIds:[]}});
  const followup=tasks.claim(next.taskId)!;
  expect(followup.revision).toBe(2);
  expect(tasks.revision(next.taskId,2).instructions).toContain('do not merge');
});

test('notification capabilities cannot queue continuations and receipts remain idempotent', () => {
  const first=spawn();const command={title:'next',instructions:'next',targetProfile:'default-worker',continueTaskId:first.taskId};
  const ctx={...context,actionId:'stable'};
  const next=tasks.spawn(ctx,command);
  expect(tasks.spawn(ctx,command).taskId).toBe(next.taskId);
  expect(()=>tasks.spawn({...ctx,actionId:'notification',execute:false},command)).toThrow('EXECUTION_DENIED');
  expect(()=>spawn(undefined,{continuationPolicy:'after_terminal'})).toThrow('INVALID_INPUT');
  expect(()=>spawn(first.taskId,{continuationPolicy:'invalid' as never})).toThrow('INVALID_INPUT');
});

test('pre-upgrade continuations retain terminal-only behavior', () => {
  const first=spawn(),next=spawn(first.taskId),attempt=tasks.claim(first.taskId)!;
  delete next.continuationPolicy;store.transaction(()=>store.saveTask(next,next.stateVersion));
  tasks.finish(attempt.attemptId,attempt.generation,{type:'failed'});
  expect(tasks.claim(next.taskId)).toBeDefined();
});


test('task detail hides runtime queue notices after starting without losing worker progress', () => {
 const first=spawn(),second=spawn(first.taskId),controls=new TaskControls(store,tasks);
 expect(controls.detail('chat','owner',second.taskId).progressText).toContain('Queued after task');
 const prior=tasks.claim(first.taskId)!;
 tasks.finish(prior.attemptId,prior.generation,{type:'completed',result:{summary:'Done',artifactIds:[]}});
 const current=tasks.claim(second.taskId)!;tasks.started(current.attemptId,current.generation);
 expect(controls.detail('chat','owner',second.taskId).progressText).toBe('');
 expect(controls.detail('chat','owner',second.taskId).progress).toBeUndefined();
 expect(store.task(second.taskId)?.latestProgress?.text).toContain('Queued after task');
 tasks.progress(current.attemptId,current.generation,'Reviewing changes');
 expect(controls.detail('chat','owner',second.taskId).progressText).toBe('Reviewing changes');
});
