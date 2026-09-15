import { ConversationIntake } from '../../../src/orchestration/conversation-intake';
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

test.each([true,false])('authenticated task answers persist provenance and fence an active attempt (%s)',active=>{
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),controls=new TaskControls(store,tasks);
 try {
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'},text:'work'});
  const decisions=new DecisionService(store),decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
  const task=tasks.spawn({...input,...decision,principalId:'owner',actionId:'answer-task',execute:true,writeMemory:false},{title:'Work',instructions:'Work',targetProfile:'media-worker'});
  const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
  const questionId=tasks.requestInput(attempt.attemptId,attempt.generation,'Which option?').pendingQuestion!.questionId;
  if(!active)tasks.finish(attempt.attemptId,attempt.generation,{type:'stopped'});
  expect(controls.detail('s','owner',task.taskId)).toMatchObject({questionId,question:'Which option?'});
  expect(()=>controls.answer('s','intruder',task.taskId,questionId,'Option A')).toThrow('ACCESS_DENIED');
  expect(()=>controls.answer('other','owner',task.taskId,questionId,'Option A')).toThrow('ACCESS_DENIED');
  expect(()=>controls.answer('s','owner',task.taskId,'stale','Option A')).toThrow('STALE_QUESTION');
  expect(controls.answer('s','owner',task.taskId,questionId,'Option A')).toMatchObject({state:active?'interrupting':'queued',questionId:undefined});
  const answered=store.task(task.taskId)!,revision=tasks.revision(task.taskId,answered.revision);
  expect(revision.answers).toEqual([{questionId,text:'Option A',inputId:revision.originatingInputId}]);
  expect(revision.originatingInputId).not.toBe(input.inputId);
  expect(store.get('SELECT text,principal_id,status FROM conversation_inputs WHERE id=?',revision.originatingInputId)).toEqual({text:'Option A',principal_id:'owner',status:'handled'});
  expect(store.all('SELECT id FROM conversation_decisions')).toHaveLength(1);
  expect(store.get('SELECT operation_id FROM history_operations WHERE input_id=?',revision.originatingInputId)).toBeDefined();
  store.run('DELETE FROM conversation_events'); // Normal retention must not erase answer idempotency.
  controls.answer('s','owner',task.taskId,questionId,'Option A');
  expect(store.task(task.taskId)!.revision).toBe(answered.revision);
  expect(store.all('SELECT id FROM conversation_inputs')).toHaveLength(2);
  expect(()=>controls.answer('s','owner',task.taskId,questionId,'Option B')).toThrow('IDEMPOTENCY_CONFLICT');
  store.run('INSERT INTO conversation_members VALUES(?,?,?)',input.conversationId,'another-member','member');
  expect(()=>controls.answer('s','another-member',task.taskId,questionId,'Option A')).toThrow('STALE_QUESTION');
  if(active){
   expect(tasks.claim(task.taskId)).toBeUndefined();
   tasks.finish(attempt.attemptId,attempt.generation,{type:'stopped'});
  }
  expect(tasks.claim(task.taskId)!.revision).toBe(answered.revision);
 }finally{store.close();}
});

test('task answers reuse a trusted accepted input and deny absent execution authority',()=>{
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),controls=new TaskControls(store,tasks);
 try {
  const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'};
  const input=store.acceptInput({scope,text:'work'}),decision=new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);
  const task=tasks.spawn({...input,...decision,principalId:'owner',actionId:'answer-task',execute:true,writeMemory:false},{title:'Work',instructions:'Work',targetProfile:'media-worker'});
  const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
  const questionId=tasks.requestInput(attempt.attemptId,attempt.generation,'Which option?').pendingQuestion!.questionId;
  const waiting=store.task(task.taskId)!;
  waiting.capabilities.execute=false;store.run('UPDATE tasks SET snapshot_json=? WHERE id=?',JSON.stringify(waiting),task.taskId);
  expect(()=>controls.answer('s','owner',task.taskId,questionId,'Option A')).toThrow('EXECUTION_DENIED');
  waiting.capabilities.execute=true;store.run('UPDATE tasks SET snapshot_json=? WHERE id=?',JSON.stringify(waiting),task.taskId);
  const denied=store.acceptInput({scope,text:'Option A',capabilities:{execute:false,writeMemory:false}});
  expect(()=>controls.answer('s','owner',task.taskId,questionId,'Option A',denied.inputId)).toThrow('EXECUTION_DENIED');
  const reply=store.acceptInput({scope,text:`/task_question ${task.taskId} ${questionId} Option A`,capabilities:{execute:true,writeMemory:false}});
  controls.answer('s','owner',task.taskId,questionId,'Option A',reply.inputId);
  expect(tasks.revision(task.taskId,2).originatingInputId).toBe(reply.inputId);
  expect(store.get('SELECT status FROM conversation_inputs WHERE id=?',reply.inputId)).toEqual({status:'handled'});
  expect(store.get("SELECT state FROM outbox WHERE dedup_key=?",`input:${reply.inputId}`)).toEqual({state:'completed'});
  controls.answer('s','owner',task.taskId,questionId,'Option A',reply.inputId);
  expect(store.all('SELECT id FROM conversation_inputs')).toHaveLength(3);
  expect(store.all('SELECT id FROM conversation_decisions')).toHaveLength(1);
 }finally{store.close();}
});

test.each(['direct','model'])('%s answers clear only older preparation for the same task and binding',route=>{
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),intake=new ConversationIntake(store);
 try {
  const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'};
  const input=store.acceptInput({scope,text:'work'}),decision=new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);
  const context={...input,...decision,principalId:'owner',execute:true,writeMemory:false};
  for(const preparation of ['matching','other-task','newer','other-binding']) {
   const task=tasks.spawn({...context,actionId:`spawn-${preparation}`},{title:'Work',instructions:'Work',targetProfile:'media-worker'});
   const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
   const questionId=tasks.requestInput(attempt.attemptId,attempt.generation,'Which option?').pendingQuestion!.questionId;
   store.run('DELETE FROM conversation_intake');
   intake.choose({...context,actionId:'prepare'},{mode:'update',task_id:task.taskId,acknowledgement:'Updating the task'});
   if(preparation==='other-task')store.run("UPDATE conversation_intake SET data_json=json_set(data_json,'$.task_id','another-task')");
   if(preparation==='newer')store.run('UPDATE conversation_intake SET latest_input_seq=100000');
   if(preparation==='other-binding')store.run("UPDATE conversation_intake SET binding_id='another-binding'");
   if(route==='direct')tasks.answerByUser(input.conversationId,'owner',task.taskId,questionId,'Option A');
   else tasks.answer({...context,actionId:`answer-${preparation}`},task.taskId,questionId,'Option A');
   expect(Boolean(store.get('SELECT * FROM conversation_intake'))).toBe(preparation!=='matching');
   tasks.finish(attempt.attemptId,attempt.generation,{type:'stopped'});
   tasks.cancelByUser(input.conversationId,'owner',task.taskId);
  }
 }finally{store.close();}
});
