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
 return {store,tasks,task,accepted,calls,pump,control,close:async()=>{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}};
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
