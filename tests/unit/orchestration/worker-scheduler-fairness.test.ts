import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { WorkerScheduler } from '../../../src/orchestration/tasks/scheduler';
import { WorkerOutcome } from '../../../src/orchestration/types';
import { ProcessCapacity } from '../../../src/orchestration/capacity';

test('blocked continuations filling the first page do not starve another conversation', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const decisions = new DecisionService(store);
  const tasks = new TaskService(store, {tasks:{maxQueuedPerAgent:200,maxQueuedPerConversation:150}});
  const context = (sessionId: string) => {
    const input = store.acceptInput({scope:{agentId:'a',agentSessionId:sessionId,source:'api',accountId:'key',chatId:sessionId,threadKey:'',principalId:'p'},text:'Work'});
    return {...input,...decisions.begin(input.conversationId,'p',[input.inputId]),principalId:'p',execute:true,writeMemory:false};
  };
  let finish: ((outcome: WorkerOutcome) => void) | undefined;
  const started: string[] = [];
  const scheduler = new WorkerScheduler(tasks, {start:async task => {
    started.push(task.taskId);
    return {accepted:Promise.resolve(),result:new Promise<WorkerOutcome>(resolve=>{finish=resolve;}),stop:async()=>{finish?.({type:'stopped'});}};
  }});
  try {
    const blocked = context('blocked');
    const create = (actionId:string, continueTaskId?:string) => tasks.spawn({...blocked,actionId}, {title:'Work',instructions:'Do the work',targetProfile:'default-worker',continueTaskId});
    const predecessor = create('predecessor');
    tasks.claim(predecessor.taskId);
    for (let i=0;i<100;i++) create(`dependent-${i}`,predecessor.taskId);
    decisions.finish(blocked,'Queued');
    const healthy = context('healthy');
    const task = tasks.spawn({...healthy,actionId:'independent'}, {title:'Independent',instructions:'Do independent work',targetProfile:'default-worker'});
    decisions.finish(healthy,'Queued');
    store.run('UPDATE tasks SET created_at=1000 WHERE conversation_id=?',blocked.conversationId);
    store.run('UPDATE tasks SET created_at=2000 WHERE id=?',task.taskId);
    await scheduler.tick();
    expect(started).toEqual([task.taskId]);
  } finally {await scheduler.close();store.close();}
});

// Review of #591 (M2): the gateway-wide worker limit counted a parent that waits for its
// subagent, so with every slot held the subagent never started and the tree stalled; the
// scheduler also stopped at the first task refused a slot, before reaching the subagent.
test('a subagent gets a worker slot while its parent holds one, even with the gateway full', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const decisions = new DecisionService(store);
  const tasks = new TaskService(store, {tasks:{workspaceMode:'host',maxConcurrentPerAgent:10,maxConcurrentPerConversation:10}}, '/tmp');
  const capacity = new ProcessCapacity(3, 1);
  const input = store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'key',chatId:'s',threadKey:'',principalId:'p'},text:'Work'});
  const context = {...input,...decisions.begin(input.conversationId,'p',[input.inputId]),principalId:'p',execute:true,writeMemory:false};
  const started: string[] = [];
  const scheduler = new WorkerScheduler(tasks, {
    reserve: taskId => capacity.acquireWorker('a', taskId, true, tasks.ancestorIds(taskId)),
    start: async task => {
      started.push(task.taskId);
      let finish!: (outcome: WorkerOutcome) => void;
      return {accepted:Promise.resolve(),result:new Promise<WorkerOutcome>(resolve=>{finish=resolve;}),stop:async()=>{finish({type:'stopped'});}};
    },
  });
  try {
    const parent = tasks.spawn({...context,actionId:'parent'}, {title:'Parent',instructions:'Use pstack',targetProfile:'default-worker'});
    const attempt = tasks.claim(parent.taskId)!; tasks.started(attempt.attemptId, attempt.generation);
    capacity.acquireWorker('a', parent.taskId); capacity.acquireWorker('a', 'another-agents-task');
    const waiting = tasks.spawn({...context,actionId:'waiting'}, {title:'Waiting',instructions:'Other work',targetProfile:'default-worker'});
    const child = tasks.spawnSubagent(attempt.attemptId, attempt.generation, 'child', {title:'Review',instructions:'Review it'});
    decisions.finish(context,'Queued');
    store.run('UPDATE tasks SET created_at=1000 WHERE id=?', waiting.taskId);
    store.run('UPDATE tasks SET created_at=2000 WHERE id=?', child.taskId);
    await scheduler.tick();
    expect(started).toEqual([child.taskId]);
    // The allowance is the parent's own slot: a second subagent waits like any other task.
    expect(capacity.acquireWorker('a', 'sibling', true, [parent.taskId])).toBeUndefined();
  } finally {await scheduler.close();store.close();}
});
