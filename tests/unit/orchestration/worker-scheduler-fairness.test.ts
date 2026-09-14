import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { WorkerScheduler } from '../../../src/orchestration/tasks/scheduler';
import { WorkerOutcome } from '../../../src/orchestration/types';

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
