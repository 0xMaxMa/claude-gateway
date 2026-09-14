import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskControls } from '../../../src/orchestration/task-controls';

test('task browser paginates active work, reads progress and cancels only the scoped task',()=>{
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),controls=new TaskControls(store,tasks);
 try{
  expect(controls.list('empty','owner')).toMatchObject({total:0,tasks:[]});
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'},text:'work'});
  const decision=new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);
  const spawned=Array.from({length:12},(_,i)=>tasks.spawn({...input,...decision,principalId:'owner',actionId:'task-'+i,execute:true,writeMemory:false},{title:'Task '+i,instructions:'Secret worker instructions',targetProfile:'default-worker'}));
  const task=spawned[0],attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);tasks.progress(attempt.attemptId,attempt.generation,'Checking tests');
  expect(controls.list('s','owner')).toMatchObject({total:12,pages:2});expect(controls.list('s','owner',1).tasks).toHaveLength(2);
  expect(controls.detail('s','owner',task.taskId)).toMatchObject({state:'running',progress:'Checking tests',canStop:true});
  expect(JSON.stringify(controls.detail('s','owner',task.taskId))).not.toContain('Secret');
  expect(store.task(task.taskId)!.state).toBe('running');
  expect(()=>controls.list('s','intruder')).toThrow('ACCESS_DENIED');
  expect(()=>controls.detail('other','owner',task.taskId)).toThrow('ACCESS_DENIED');
  expect(()=>controls.cancel('s','intruder',task.taskId)).toThrow('ACCESS_DENIED');
  expect(()=>controls.cancel('other','owner',task.taskId)).toThrow('ACCESS_DENIED');
  expect(controls.cancel('s','owner',task.taskId)).toMatchObject({state:'cancel_requested',canStop:false});
  expect(store.task(spawned[1].taskId)!.state).toBe('queued');
  controls.cancel('s','owner',spawned[1].taskId);expect(controls.list('s','owner').total).toBe(11);
  for(const t of spawned.slice(2))controls.cancel('s','owner',t.taskId);
  expect(controls.list('s','owner',1)).toMatchObject({page:0,total:1});
  expect(controls.detail('s','owner',spawned[1].taskId)).toMatchObject({state:'cancelled',canStop:false});
  expect(()=>controls.list('s','owner',-1)).toThrow();
  tasks.finish(attempt.attemptId,attempt.generation,{type:'stopped',failure:{code:'WORKER_STOPPED',message:'Interrupted',observedAt:Date.now()}});
  expect(controls.detail('s','owner',task.taskId)).toMatchObject({state:'cancelled',failure:undefined,cancellation:{requestedBy:'user'}});
  expect(controls.detail('s','owner',task.taskId).progress).not.toContain('WORKER_STOPPED');
  expect(controls.detail('s','owner',task.taskId).progress).toContain('Cancelled by user');
  expect(store.get('SELECT status FROM notifications WHERE task_id=?',task.taskId)).toMatchObject({status:'pending'});
 }finally{store.close();}
});

test('execution telemetry is scoped, does not manufacture Updated activity, and is fenced after cancellation',()=>{
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),controls=new TaskControls(store,tasks);
 try {
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'},text:'work'});
  const decision=new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);
  const task=tasks.spawn({...input,...decision,principalId:'owner',actionId:'spawn',execute:true,writeMemory:false},{title:'Tests',instructions:'Work',targetProfile:'media-worker'});
  const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
  const before=store.task(task.taskId)!;
  const observation={attemptId:attempt.attemptId,observedAt:Date.now()+60000,lastActivityAt:before.updatedAt,lastProgressAt:before.updatedAt,phase:'idle',quiet:true,activeTools:['Bash'],status:'waiting_for_tool' as const,process:{observedAt:Date.now()+60000,available:true,processCount:3,cpuTicksDelta:0}};
  tasks.observeExecution(attempt.attemptId,attempt.generation,observation);
  expect(controls.detail('s','owner',task.taskId)).toMatchObject({updatedAt:before.updatedAt,execution:observation,canStop:true});
  expect(controls.detail('s','owner',task.taskId).progress).toContain('Waiting for tool');
  expect(tasks.status(input.conversationId,'owner',task.taskId)[0].execution).toEqual(observation);
  expect(()=>tasks.status(input.conversationId,'intruder',task.taskId)).toThrow('ACCESS_DENIED');
  controls.cancel('s','owner',task.taskId);
  tasks.observeExecution(attempt.attemptId,attempt.generation,{...observation,lastActivityAt:Date.now()+120000});
  expect(store.task(task.taskId)!.execution).toEqual(observation);
 } finally {store.close();}
});

test('elapsed starts on first claim, survives progress updates, and freezes on cancellation',()=>{
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),controls=new TaskControls(store,tasks);
 let now=1000;const clock=jest.spyOn(Date,'now').mockImplementation(()=>now);
 try {
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'},text:'work'});
  const decision=new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);
  const task=tasks.spawn({...input,...decision,principalId:'owner',actionId:'elapsed',execute:true,writeMemory:false},{title:'Work',instructions:'Work',targetProfile:'media-worker'});
  expect(controls.detail('s','owner',task.taskId).startedAt).toBeUndefined();
  now=61000;const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
  now=100000;tasks.progress(attempt.attemptId,attempt.generation,'Still working');
  expect(controls.detail('s','owner',task.taskId)).toMatchObject({startedAt:61000,finishedAt:undefined});
  controls.cancel('s','owner',task.taskId);
  now=161000;tasks.finish(attempt.attemptId,attempt.generation,{type:'stopped',failure:{code:'WORKER_STOPPED',message:'Stopped',observedAt:now}});
  now=250000;
  expect(controls.detail('s','owner',task.taskId)).toMatchObject({startedAt:61000,finishedAt:161000});
 } finally {clock.mockRestore();store.close();}
});
