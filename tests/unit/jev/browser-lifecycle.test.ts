import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {BrowserTaskAdapter} from '../../../src/orchestration/gateway-tasks/browser';
import {GatewayTaskController} from '../../../src/orchestration/gateway-tasks/controller';
import {BrowserExecutionContext,BrowserExecutionResult} from '../../../src/jev/browser-contract';
import {JevService} from '../../../src/jev/service';
test('field question, authenticated answer and fresh dispatch preserve exact user text',async()=>{
 const root=mkdtempSync(join(tmpdir(),'browser-lifecycle-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'Fill form',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const context={...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'};
 let executions=0;
 const run=jest.fn(async(c:BrowserExecutionContext):Promise<BrowserExecutionResult>=>{
  executions++;
  if(executions===1)return {status:'blocked',reason:'FIELD_TEXT_REQUIRED',steps:0,evaluations:1,fieldRequest:{ref:'old-ref',label:'Name',reason:'missing'}};
  expect(c.fields).toEqual([{label:'Name',text:'ส้ม'}]);
  return {status:'succeeded',reason:'VERIFIED',steps:1,evaluations:2};
 });
 const adapter=new BrowserTaskAdapter({agentId:'a',root:join(root,'receipts'),allowed:()=>true,bindings:()=>[binding],evaluate:jest.fn(),
  onNeedsInput:(t,q)=>{const attempt=store.attempt(t.activeAttemptId!)!;if(store.task(t.taskId)!.state==='starting')tasks.started(attempt.attemptId,attempt.generation);tasks.requestInput(attempt.attemptId,attempt.generation,q);return true;}});
 const binding={version:1 as const,id:'target',name:'Browser',principalId:'u',conversationId:accepted.conversationId,run};
 const controller=new GatewayTaskController(tasks,new Map([['browser',adapter]]));
 try{
  const task=tasks.spawn(context,{title:'Fill name',instructions:'Fill name',targetProfile:'gateway-managed',gatewayTarget:adapter.resolve({adapter:'browser',session_id:'target'},context)});
  for(let i=0;i<10;i++){await controller.tick();await new Promise(setImmediate);}
  const waiting=store.task(task.taskId)!;expect(waiting.state).toBe('waiting_input');expect(waiting.activeAttemptId).toBeUndefined();
  expect(()=>tasks.answerByUser(accepted.conversationId,'other',task.taskId,waiting.pendingQuestion!.questionId,'bad')).toThrow();
  expect(()=>tasks.answerByUser(accepted.conversationId,'u',task.taskId,waiting.pendingQuestion!.questionId,'x'.repeat(2001))).toThrow('BROWSER_FIELD_VALUE_TOO_LONG');
  expect(store.task(task.taskId)!.pendingQuestion!.questionId).toBe(waiting.pendingQuestion!.questionId);
  tasks.answerByUser(accepted.conversationId,'u',task.taskId,waiting.pendingQuestion!.questionId,'ส้ม');
  for(let i=0;i<10;i++){await controller.tick();await new Promise(setImmediate);}
  expect(store.task(task.taskId)!.state).toBe('completed');expect(run).toHaveBeenCalledTimes(2);
 }finally{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('revoked execution fence rejects evaluation waiting for credentials before dispatch',async()=>{
 const root=mkdtempSync(join(tmpdir(),'browser-fence-'));let allowed=true;let release!:()=>void;
 const fetcher=jest.fn();const service=new JevService({getConfig:()=>({enabled:true,provider:'typesafe',model:'jev'}),
  resolveConnection:()=>new Promise(resolve=>{release=()=>resolve({baseUrl:'https://provider.example',apiKey:'fixture'});}),fetch:fetcher});
 const binding={version:1 as const,id:'target',name:'Browser',principalId:'u',conversationId:'c',run:async(c:BrowserExecutionContext)=>{
  await c.evaluate({state:'private',questions:{x:{type:'noul',instructions:'test'}}},c.signal);
  return {status:'succeeded' as const,reason:'VERIFIED',steps:0,evaluations:1};
 }};
 const adapter=new BrowserTaskAdapter({agentId:'a',root,allowed:()=>allowed,bindings:()=>[binding],evaluate:(_task,request,signal,authorized)=>service.evaluate(request,{principalId:'u',consumer:'browser',signal,authorize:authorized})});
 const task={agentId:'a',taskId:'task',ownerPrincipalId:'u',conversationId:'c',gatewayTarget:{adapter:'browser',sessionId:'target',name:'Browser'}} as any;
 try{await adapter.submit(task,'r','goal');await new Promise(setImmediate);allowed=false;release();for(let i=0;i<10;i++)await new Promise(setImmediate);expect(fetcher).not.toHaveBeenCalled();expect(await adapter.inspect(task,'r')).toMatchObject({type:'unknown'});}
 finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});
