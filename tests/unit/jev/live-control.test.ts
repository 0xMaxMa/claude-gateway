import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {BrowserTaskAdapter} from '../../../src/orchestration/gateway-tasks/browser';
import {GatewayTaskController} from '../../../src/orchestration/gateway-tasks/controller';
import {BrowserExecutionContext,BrowserExecutionResult} from '../../../src/jev/browser-contract';

function fixture(unknown=false){
 const root=mkdtempSync(join(tmpdir(),'live-control-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'Book flight',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const context={...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'};
 const calls:BrowserExecutionContext[]=[];
 const run=async(c:BrowserExecutionContext):Promise<BrowserExecutionResult>=>{
  calls.push(c);
  if(calls.length>1)return {status:'succeeded',reason:'VERIFIED',steps:0,evaluations:1};
  await new Promise<void>(resolve=>{if(c.interruptSignal!.aborted)resolve();else c.interruptSignal!.addEventListener('abort',()=>resolve(),{once:true});});
  return {status:unknown?'needs_verification':'cancelled',reason:unknown?'OUTCOME_UNKNOWN':'REVISION_SUPERSEDED',steps:1,evaluations:1,lastAction:{operationId:'op',operation:'page_click',outcome:unknown?'unknown':'confirmed'}};
 };
 const binding={version:1 as const,id:'target',name:'Browser',principalId:'u',conversationId:accepted.conversationId,run};
 const adapter=new BrowserTaskAdapter({agentId:'a',root:join(root,'receipts'),allowed:()=>true,bindings:()=>[binding],evaluate:jest.fn()});
 const controller=new GatewayTaskController(tasks,new Map([['browser',adapter]]));
 const task=tasks.spawn(context,{title:'Flight',instructions:'Two adults and three children to London',targetProfile:'gateway-managed',gatewayTarget:adapter.resolve({adapter:'browser',session_id:'target',start_url:'https://example.com'},context)});
 const pump=async()=>{for(let i=0;i<10;i++){await controller.tick();await new Promise(setImmediate);}};
 const control=(action:'pause'|'resume'|'revise',text?:string)=>{
  const command={id:randomUUID(),action,expectedRevision:store.task(task.taskId)!.revision,...(text?{text}:{})};
  const updated=tasks.controlByUser(accepted.conversationId,'u',task.taskId,command);controller.signalControl(updated);return command;
 };
 return {store,tasks,task,accepted,context,calls,pump,control,close:async()=>{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('direct correction interrupts reasoning, preserves task identity and resumes without navigating again',async()=>{
 const f=fixture();try{
  await f.pump();expect(f.calls).toHaveLength(1);
  const command=f.control('revise','Use Manchester instead');
  expect(f.calls[0].interruptSignal!.aborted).toBe(true);
  expect(f.calls[0].signal.aborted).toBe(false);
  expect(f.tasks.controlByUser(f.accepted.conversationId,'u',f.task.taskId,command).revision).toBe(2);
  expect(()=>f.tasks.controlByUser(f.accepted.conversationId,'u',f.task.taskId,{...command,text:'different'})).toThrow('IDEMPOTENCY_CONFLICT');
  await f.pump();expect(f.calls).toHaveLength(2);
  expect(f.calls[1].goal).toContain('Two adults and three children');expect(f.calls[1].goal).toContain('Use Manchester instead');
  expect(f.calls[1].goal.indexOf('Use Manchester instead')).toBeLessThan(f.calls[1].goal.indexOf('Two adults and three children'));
  expect(f.tasks.status(f.accepted.conversationId,'u',f.task.taskId)[0].currentInstructions).toBe(f.calls[1].goal);
  expect(f.tasks.status(f.accepted.conversationId,'u')[0].currentInstructions).toBe(f.calls[1].goal);
  expect(f.calls[1].startUrl).toBeUndefined();
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'completed',revision:2,executionControl:{phase:'applied'}});
 }finally{await f.close();}
});

test('pause settles old attempt and stays paused until explicit resume',async()=>{
 const f=fixture();try{
  await f.pump();f.control('pause');await f.pump();
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'waiting_input',executionControl:{phase:'paused'}});
  expect(f.calls).toHaveLength(1);
  f.control('resume');await f.pump();expect(f.calls).toHaveLength(2);
  expect(f.store.task(f.task.taskId)!.state).toBe('completed');
 }finally{await f.close();}
});

test('uncertain mutation blocks correction and cannot be resumed or replayed',async()=>{
 const f=fixture(true);try{
  await f.pump();f.control('revise','Use Manchester');await f.pump();
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'needs_reconciliation',executionControl:{phase:'blocked'}});
  expect(()=>f.control('resume')).toThrow('STATE_CONFLICT');expect(f.calls).toHaveLength(1);
 }finally{await f.close();}
});

test('controls reject other principals and stale revisions before changing work',async()=>{
 const f=fixture();try{
  const command={id:randomUUID(),action:'pause' as const,expectedRevision:1};
  expect(()=>f.tasks.controlByUser(f.accepted.conversationId,'other',f.task.taskId,command)).toThrow();
  expect(()=>f.tasks.controlByUser(f.accepted.conversationId,'u',f.task.taskId,{...command,expectedRevision:2})).toThrow('REVISION_CONFLICT');
  expect(f.store.task(f.task.taskId)!.revision).toBe(1);
 }finally{await f.close();}
});

test('newer correction replaces a pending pause without losing prior corrections',async()=>{
 const f=fixture();try{
  await f.pump();f.control('pause');f.control('revise','Destination Manchester');f.control('revise','Keep all three children');await f.pump();
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1].goal).toContain('Destination Manchester');expect(f.calls[1].goal).toContain('Keep all three children');
  expect(f.calls[1].goal.indexOf('Keep all three children')).toBeLessThan(f.calls[1].goal.indexOf('Destination Manchester'));
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'completed',revision:4});
 }finally{await f.close();}
});

test('queued pause never dispatches until resumed',async()=>{
 const f=fixture();try{
  f.control('pause');await f.pump();expect(f.calls).toHaveLength(0);
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'waiting_input',executionControl:{phase:'paused'}});
 }finally{await f.close();}
});

test.each([false,true])('known stopped browser accepts a correction, unknown outcome stays fenced (%s)',async unknown=>{
 const f=fixture();try{
  const task=f.store.task(f.task.taskId)!;
  task.state='failed';task.browserReport={status:'blocked',reason:unknown?'OUTCOME_UNKNOWN':'NO_PROGRESS',steps:1,evaluations:1,lastAction:{operationId:'op',operation:'TYPE_TEXT',outcome:unknown?'unknown':'confirmed'}};
  f.store.transaction(()=>f.store.saveTask(task,task.stateVersion));
  if(unknown)expect(()=>f.control('revise','Use the supplied airport code')).toThrow('STATE_CONFLICT');
  else{
   f.tasks.controlByUser(f.accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:1,text:'Use the supplied airport code'});
   expect(f.store.task(task.taskId)).toMatchObject({state:'queued',revision:2});
   expect(f.store.task(task.taskId)?.browserReport).toBeUndefined();
  }
 }finally{await f.close();}
});

test('direct correction can recover a known stopped computer task but cannot recover uncertain effects',async()=>{
 for(const reason of ['NO_SUPPORTED_ACTION','ACTION_BUDGET','OUTCOME_UNKNOWN','COMPUTER_EXECUTION_INTERRUPTED']){
  const f=fixture();try{const task=f.store.task(f.task.taskId)!;task.gatewayTarget={...task.gatewayTarget!,adapter:'computer'};task.state='failed';task.computerReport={status:'blocked',reason,steps:1};f.store.transaction(()=>f.store.saveTask(task,task.stateVersion));
   const apply=()=>f.tasks.controlByUser(f.accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:task.revision,text:'Use the search field instead'});
   if(['NO_SUPPORTED_ACTION','ACTION_BUDGET'].includes(reason)){expect(apply()).toMatchObject({taskId:task.taskId,state:'queued',revision:2});}else expect(apply).toThrow('STATE_CONFLICT');
  }finally{await f.close();}
 }
});


test('completed rounds remain idle, continue on the same task without navigating, and explicit end fences further work',async()=>{
 const f=fixture();try{
  await f.pump();f.control('revise','Use Manchester');await f.pump();
  const completed=f.store.task(f.task.taskId)!;
  expect(completed.automationSession).toMatchObject({status:'idle',idleTimeoutMs:1800000});
  expect(completed.activeAttemptId).toBeUndefined();
  const next=f.tasks.update({...f.context,actionId:'next-goal'},completed.taskId,completed.revision,'Read the visible flight results, without repeating the search','when_ready');
  expect(next).toMatchObject({taskId:completed.taskId,state:'queued',automationSession:{status:'active'}});
  await f.pump();expect(f.calls).toHaveLength(3);expect(f.calls[2].startUrl).toBeUndefined();
  expect(f.calls[2].goal).toBe('Read the visible flight results, without repeating the search');
  expect(f.store.task(completed.taskId)?.automationSession?.status).toBe('idle');
  expect(f.store.all('SELECT id FROM tasks')).toHaveLength(1);
  const ended=f.tasks.cancelByUser(f.accepted.conversationId,'u',completed.taskId);
  expect(ended).toMatchObject({state:'completed',automationSession:{status:'closed',closedReason:'user'}});
  expect(()=>f.tasks.update({...f.context,actionId:'after-end'},ended.taskId,ended.revision,'Continue','when_ready')).toThrow('This automation session was ended or expired');
  await f.pump();expect(f.calls).toHaveLength(3);
 }finally{await f.close();}
});
test('idle timeout survives reads and blocks resuming without running inference',async()=>{
 const f=fixture();try{
  await f.pump();f.control('revise','Use Manchester');await f.pump();
  const t=f.store.task(f.task.taskId)!;
  f.store.transaction(()=>{t.automationSession!.idleSince=Date.now()-1800001;f.store.saveTask(t,t.stateVersion);});
  expect(f.tasks.status(f.accepted.conversationId,'u',t.taskId)[0].automationSession).toMatchObject({status:'closed',closedReason:'idle_timeout'});
  expect(()=>f.tasks.update({...f.context,actionId:'expired'},t.taskId,t.revision,'Continue','when_ready')).toThrow('This automation session was ended or expired');
  await f.pump();expect(f.calls).toHaveLength(2);
 }finally{await f.close();}
});
test('an open automation session rejects a duplicate spawn and names its existing task',async()=>{
 const f=fixture();try{
  expect(()=>f.tasks.spawn({...f.context,actionId:'duplicate'},{title:'Another goal',instructions:'Read current page',targetProfile:'gateway-managed',gatewayTarget:f.task.gatewayTarget})).toThrow(f.task.taskId);
  expect(f.store.all('SELECT id FROM tasks')).toHaveLength(1);
 }finally{await f.close();}
});

test('receipt recovery cannot requeue an expired uncertain automation session',async()=>{
 const f=fixture(true);try{
  await f.pump();f.control('revise','Use Manchester');await f.pump();
  const t=f.store.task(f.task.taskId)!;
  f.store.transaction(()=>{t.automationSession!.idleSince=Date.now()-1800001;f.store.saveTask(t,t.stateVersion);});
  expect(()=>f.tasks.reconcile(t.taskId,'queued','Late settled receipt')).toThrow('AUTOMATION_SESSION_CLOSED');
  await f.pump();expect(f.calls).toHaveLength(1);
  expect(f.store.task(t.taskId)?.state).toBe('needs_reconciliation');
 }finally{await f.close();}
});
