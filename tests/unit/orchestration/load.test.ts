import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { WorkerScheduler, WorkerHandle } from '../../../src/orchestration/tasks/scheduler';
import { ProcessCapacity } from '../../../src/orchestration/capacity';

test('100-task saturation preserves agent session capacity and drains accepted work while queued cancellation stays responsive', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const tasks = new TaskService(store, { tasks: { maxQueuedPerConversation: 100, maxQueuedPerAgent: 100 } }), decisions = new DecisionService(store);
  const scope = { agentId: 'a', agentSessionId: 'p', source: 'api' as const, accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'owner' };
  const input = store.acceptInput({ scope, text: 'Queue work' }), decision = decisions.begin(input.conversationId, 'owner', [input.inputId]);
  const context = { ...input, ...decision, principalId: 'owner', execute: true, writeMemory: false };
  const command = { title: 'fixture', instructions: 'fixture', targetProfile: 'default-worker' };
  for (let i = 0; i < 100; i++) tasks.spawn({ ...context, actionId: `spawn:${i}` }, command);
  expect(() => tasks.spawn({ ...context, actionId: 'overflow' }, command)).toThrow('QUEUE_FULL');
  decisions.finish(decision, 'Queued.');
  const capacity = new ProcessCapacity(3, 1), legacy = capacity.acquire('legacy')!;
  let active = 0, peak = 0;
  const errors: unknown[] = [];
  const scheduler = new WorkerScheduler(tasks, {
    reserve: () => capacity.acquire('worker'),
    start: async () => {
      active++; peak = Math.max(peak, active);
      let stop!: () => void;
      const result: WorkerHandle['result'] = new Promise(resolve => {
        const timer = setTimeout(() => resolve({ type: 'completed', result: { summary: 'done', artifactIds: [] } }), 10);
        stop = () => { clearTimeout(timer); resolve({ type: 'stopped' }); };
      }).finally(() => { active--; }) as WorkerHandle['result'];
      return { accepted: Promise.resolve(), result, stop: async () => stop() };
    },
  }, error => errors.push(error));
  try {
    scheduler.start(); await scheduler.tick();
    const agentSession = capacity.acquire('agent'); expect(agentSession).toBeDefined();
    legacy();
    const next = store.acceptInput({ scope, text: 'Cancel queued work and drain' });
    const control = decisions.begin(input.conversationId, 'owner', [next.inputId]);
    store.run("UPDATE conversations SET status='draining'");
    expect(() => tasks.spawn({ ...context, ...control, inputId: next.inputId, actionId: 'new-after-drain' }, command)).toThrow('DRAINING');
    for (const row of store.all("SELECT id FROM tasks WHERE state='queued' LIMIT 50")) tasks.cancel({ ...context, ...control, inputId: next.inputId, actionId: `cancel:${row.id}` }, String(row.id));
    decisions.finish(control, 'Queued tasks cancelled; active tasks continue.'); agentSession?.();
    const deadline = Date.now() + 5000;
    while (store.get("SELECT id FROM tasks WHERE state NOT IN ('completed','cancelled') LIMIT 1") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.get("SELECT COUNT(*) n FROM tasks WHERE state='completed'")!.n).toBe(50);
    expect(store.get("SELECT COUNT(*) n FROM tasks WHERE state='cancelled'")!.n).toBe(50);
    expect(peak).toBeLessThanOrEqual(2); expect(errors).toEqual([]);
  } finally { legacy(); await scheduler.close(); store.close(); }
}, 10000);

test.each(['shutdown','start_error','result_error'] as const)('worker %s evidence survives into Agent snapshots and notifications',async mode=>{
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),decisions=new DecisionService(store);
 const scope={agentId:'a',agentSessionId:'p',source:'api' as const,accountId:'key',chatId:'chat',threadKey:'',principalId:'owner'};
 const input=store.acceptInput({scope,text:'work'}),decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
 const task=tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'}, {title:'issue',instructions:'inspect',targetProfile:'default-worker'});
 const scheduler=new WorkerScheduler(tasks,{start:async()=>{
  if(mode==='start_error')throw Object.assign(Error('Workspace unavailable'),{code:'WORKSPACE_FAILED'});
  let finish!:(value:{type:'stopped'})=>void;
  const result:WorkerHandle['result']=mode==='result_error'?Promise.reject(Object.assign(Error('Provider failed'),{code:'INFERENCE_FAILED'})):new Promise(resolve=>{finish=resolve;});
  return {accepted:Promise.resolve(),result,stop:async()=>{finish?.({type:'stopped'});}};
 }});
 try {
  await scheduler.tick();
  // Allow driver admission/result handling before asking for shutdown.
  for(let i=0;i<6;i++)await Promise.resolve();
  await scheduler.close();
  const snapshot=tasks.status(input.conversationId,'owner',task.taskId)[0];
  expect(snapshot.failure?.code).toBe(mode==='shutdown'?'GATEWAY_SHUTDOWN':mode==='start_error'?'WORKSPACE_FAILED':'INFERENCE_FAILED');
  expect(snapshot.failure?.message).toBeTruthy();
  expect(store.get('SELECT id FROM notifications WHERE task_id=?',task.taskId)).toBeDefined();
  const attempt=JSON.parse(String(store.get('SELECT payload_json FROM task_attempts WHERE task_id=?',task.taskId)?.payload_json));
  expect(attempt.failure).toEqual(snapshot.failure);
  if(mode==='result_error')expect(snapshot.state).toBe('needs_reconciliation');
 }finally{await scheduler.close();store.close();}
});
