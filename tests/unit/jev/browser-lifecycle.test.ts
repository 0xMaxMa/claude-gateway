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
test('parent can confirm only a fresh scoped completion candidate with durable idempotence',async()=>{
 const root=mkdtempSync(join(tmpdir(),'browser-verify-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'Fill form',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const context={...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'};
 const binding={version:1 as const,id:'target',name:'Browser',principalId:'u',conversationId:accepted.conversationId,
  run:async()=>({status:'needs_verification' as const,reason:'COMPLETION_CANDIDATE',steps:1,evaluations:2}),
  inspect:async()=>({observedAt:Date.now(),observation:{generation:'g',elements:[{label:'Name',value:'ส้ม'}]}})};
 const adapter=new BrowserTaskAdapter({agentId:'a',root:join(root,'receipts'),allowed:()=>true,bindings:()=>[binding],evaluate:jest.fn()});
 const controller=new GatewayTaskController(tasks,new Map([['browser',adapter]]));
 try{
  const task=tasks.spawn(context,{title:'Fill name',instructions:'Fill name',targetProfile:'gateway-managed',gatewayTarget:adapter.resolve({adapter:'browser',session_id:'target'},context)});
  for(let i=0;i<10;i++){await controller.tick();await new Promise(setImmediate);}
  const waiting=store.task(task.taskId)!;expect(waiting.state).toBe('needs_reconciliation');
  const proof=await adapter.evidence(waiting,true),check=()=>adapter.verifyEvidence(waiting,proof.requestId,proof.evidenceId!);
  const confirm={...context,actionId:'verify'};
  expect(()=>tasks.verifyBrowser({...confirm,principalId:'other'},task.taskId,waiting.revision,proof.requestId,proof.evidenceId!,'Name matches',check)).toThrow();
  expect(()=>tasks.verifyBrowser(confirm,task.taskId,waiting.revision+1,proof.requestId,proof.evidenceId!,'Name matches',check)).toThrow();
  const done=tasks.verifyBrowser(confirm,task.taskId,waiting.revision,proof.requestId,proof.evidenceId!,'Name field shows ส้ม',check);
  expect(done.state).toBe('completed');expect(done.activeAttemptId).toBeUndefined();expect(done.browserReport?.verification?.source).toBe('parent');
  expect(tasks.verifyBrowser(confirm,task.taskId,waiting.revision,proof.requestId,proof.evidenceId!,'Name field shows ส้ม',()=>{throw Error('must not reverify');})).toEqual(done);
 }finally{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('explicit continuation settles a legacy pre-input rejection and makes one fresh attempt on the same task',async()=>{
 const root=mkdtempSync(join(tmpdir(),'browser-continue-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store),decisions=new DecisionService(store);
 const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'},capabilities={execute:true,writeMemory:false};
 const accepted=store.acceptInput({scope,text:'Fill outbound and return date',capabilities}),decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
 const context={...accepted,...decision,principalId:'u',...capabilities,actionId:'spawn'};
 const operationId='2bc8e680-dae0-45a1-8e2f-e74b680562df';let runs=0;
 const binding={version:1 as const,id:'target',name:'Browser',principalId:'u',conversationId:accepted.conversationId,run:async(c:BrowserExecutionContext):Promise<BrowserExecutionResult>=>{
  if(++runs>1){expect(c.startUrl).toBeUndefined();expect(c.goal).toContain('return date');return {status:'succeeded',reason:'VERIFIED',steps:1,evaluations:2};}
  c.beforeMutation!(operationId,'page_type');
  c.trace!({version:1,sequence:1,at:Date.now(),phase:'action',operationId,operation:'TYPE_TEXT',outcome:'unknown',cause:'STALE_OBSERVATION'});
  return {status:'blocked',reason:'OUTCOME_UNKNOWN',steps:0,evaluations:1,lastAction:{operationId,operation:'TYPE_TEXT',outcome:'unknown'}};
 },inspect:async()=>({observedAt:Date.now(),observation:{generation:'fresh',elements:[]},operationStatus:{id:operationId,state:'unknown'}})};
 const adapter=new BrowserTaskAdapter({agentId:'a',root:join(root,'receipts'),allowed:()=>true,bindings:()=>[binding],evaluate:jest.fn()});
 const controller=new GatewayTaskController(tasks,new Map([['browser',adapter]]));
 const pump=async()=>{for(let i=0;i<10;i++){await controller.tick();await new Promise(setImmediate);}};
 try{
  const t=tasks.spawn(context,{title:'Dates',instructions:'Fill outbound and return date',targetProfile:'gateway-managed',gatewayTarget:{adapter:'browser',sessionId:'target',name:'Browser',startUrl:'https://fixture.test'}});
  decisions.finish(decision,'Started');await pump();
  const stopped=store.task(t.taskId)!;expect(stopped.state).toBe('needs_reconciliation');
  const proof=await adapter.evidence(stopped,true);
  const input=store.acceptInput({scope,text:'Continue from the current page',capabilities}),next=decisions.begin(input.conversationId,'u',[input.inputId]);
  const command={...input,...next,principalId:'u',...capabilities,actionId:'continue'};
  expect(()=>tasks.reconcileBrowser({...command,execute:false},t.taskId,1,proof.requestId,proof.evidenceId!,'Fill return date',()=>adapter.reconcileEvidence(stopped,proof.requestId,proof.evidenceId!))).toThrow();
  const queued=tasks.reconcileBrowser(command,t.taskId,1,proof.requestId,proof.evidenceId!,'Keep outbound date; fill return date',()=>adapter.reconcileEvidence(stopped,proof.requestId,proof.evidenceId!));
  expect(queued).toMatchObject({taskId:t.taskId,state:'queued',revision:2});
  expect(tasks.reconcileBrowser(command,t.taskId,1,proof.requestId,proof.evidenceId!,'Keep outbound date; fill return date',()=>{throw Error('rechecked');})).toMatchObject({revision:2});
  await pump();expect(runs).toBe(2);expect(store.task(t.taskId)?.state).toBe('completed');
 }finally{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
});
