import {randomUUID} from 'node:crypto';
import { BrowserTaskAdapter } from '../../../src/orchestration/gateway-tasks/browser';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { WorkerScheduler } from '../../../src/orchestration/tasks/scheduler';
import { GatewayRequestNotSentError, GatewayTaskController, GatewayTaskAdapter } from '../../../src/orchestration/gateway-tasks/controller';
import { SafemodeTaskAdapter } from '../../../src/orchestration/gateway-tasks/safemode';
import { recoverOrchestration } from '../../../src/orchestration/recovery';
import { CommandContext, WorkerOutcome } from '../../../src/orchestration/types';
import { SafemodeStore, atomicJson } from '../../../src/safemode/store';

let directory:string, store:OrchestrationStore,tasks:TaskService,context:CommandContext;
let adapter:GatewayTaskAdapter,controller:GatewayTaskController;
let outcome:WorkerOutcome|'running'|'pending';
const target={adapter:'safemode',sessionId:'11111111-1111-4111-8111-111111111111',name:'astra2'};
let sequence=0;
function spawn(prior?:string) {return tasks.spawn({...context,actionId:`spawn-${++sequence}`},{title:'Inspect astra2',instructions:'Inspect the authorized error',targetProfile:'gateway-managed',gatewayTarget:target,continueTaskId:prior});}
function open(){store=new OrchestrationStore(join(directory,'db'),'operator');tasks=new TaskService(store,{tasks:{workspaceMode:'host'}});}
beforeEach(()=>{
 directory=mkdtempSync(join(tmpdir(),'gateway-tasks-'));open();
 const input=store.acceptInput({scope:{agentId:'operator',agentSessionId:'chat',source:'api',accountId:'owner',principalId:'owner',chatId:'chat',threadKey:''},text:'Inspect astra2'});
 context={...input,...new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]),principalId:'owner',execute:true,writeMemory:false,actionId:''};
 outcome='running';adapter={name:'safemode',discover:jest.fn(),resolve:()=>target,submit:jest.fn(async()=>{}),inspect:jest.fn(async()=>outcome),cancel:jest.fn(async()=>{outcome={type:'stopped'};})};
 controller=new GatewayTaskController(tasks,new Map([['safemode',adapter]]));
});
afterEach(async()=>{await controller.close();store.close();rmSync(directory,{recursive:true,force:true});});
test('external work is never started by WorkerScheduler, preserves dependencies, and reports completion once',async()=>{
 const first=spawn(),second=spawn(first.taskId);const start=jest.fn();const scheduler=new WorkerScheduler(tasks,{start});
 await scheduler.tick();expect(start).not.toHaveBeenCalled();
 await controller.tick();expect(adapter.submit).toHaveBeenCalledTimes(1);expect(store.task(first.taskId)?.state).toBe('running');expect(store.task(second.taskId)?.state).toBe('queued');
 expect(store.all('SELECT * FROM worker_pool')).toHaveLength(0);
 outcome={type:'completed',result:{summary:'Full diagnostic response',artifactIds:[]}};
 await controller.tick();await controller.tick();
 expect(store.task(first.taskId)?.result?.summary).toBe('Full diagnostic response');
 expect(store.task(second.taskId)?.state).toBe('completed');expect(adapter.submit).toHaveBeenCalledTimes(2);
 expect(store.all('SELECT * FROM notifications')).toHaveLength(2);await scheduler.close();
});
test('restart resumes inspection without resending or stopping the external request',async()=>{
 const task=spawn();await controller.tick();const requestId=store.task(task.taskId)?.gatewayDispatch?.requestId;
 await controller.close();expect(adapter.cancel).not.toHaveBeenCalled();store.close();open();recoverOrchestration(store);
 controller=new GatewayTaskController(tasks,new Map([['safemode',adapter]]));
 outcome={type:'completed',result:{summary:'After restart',artifactIds:[]}};await controller.tick();
 expect(adapter.submit).toHaveBeenCalledTimes(1);expect(store.task(task.taskId)?.gatewayDispatch?.requestId).toBe(requestId);
 expect(store.task(task.taskId)?.state).toBe('completed');expect(store.all('SELECT * FROM notifications')).toHaveLength(1);
});
test('unconfirmed dispatch is never replayed even after recovery',async()=>{
 const task=spawn();outcome='pending';await controller.tick();
 const saved=store.task(task.taskId)!;saved.gatewayDispatch!.submittedAt=Date.now()-130000;store.transaction(()=>store.saveTask(saved,saved.stateVersion));
 await controller.close();recoverOrchestration(store);controller=new GatewayTaskController(tasks,new Map([['safemode',adapter]]));await controller.tick();
 expect(adapter.submit).toHaveBeenCalledTimes(1);expect(store.task(task.taskId)?.state).toBe('needs_reconciliation');
});
test('cancellation uses the recorded request and is not handled by worker cleanup',async()=>{
 const task=spawn();await controller.tick();tasks.cancelByUser(task.conversationId,'owner',task.taskId);
 const cleanup=jest.fn();const scheduler=new WorkerScheduler(tasks,{start:jest.fn(),cleanup});await scheduler.tick();expect(cleanup).not.toHaveBeenCalled();
 await controller.tick();expect(adapter.cancel).toHaveBeenCalledWith(expect.objectContaining({taskId:task.taskId}),store.task(task.taskId)?.gatewayDispatch?.requestId);
 expect(store.task(task.taskId)?.state).toBe('cancelled');await scheduler.close();
});
test('active managed requests accept a durable revision and dispatch it in the same task only after settling',async()=>{
 const task=spawn();await controller.tick();
 const updated=tasks.update({...context,actionId:'amend'},task.taskId,1,'Continue the same goal with new instructions','when_ready');
 expect(updated.revision).toBe(2);expect(updated.state).toBe('running');await controller.tick();expect(adapter.submit).toHaveBeenCalledTimes(1);
 outcome={type:'completed',result:{summary:'First request done',artifactIds:[]}};
 await controller.tick();expect(store.task(task.taskId)?.state).toBe('queued');await controller.tick();
 expect(adapter.submit).toHaveBeenCalledTimes(2);expect(adapter.submit).toHaveBeenLastCalledWith(expect.objectContaining({taskId:task.taskId,revision:2}),expect.any(String),'Continue the same goal with new instructions',undefined,false,undefined);
 expect(store.all('SELECT id FROM tasks')).toHaveLength(1);
});
test('finished managed tasks reopen by revision, while cancellation and uncertainty stay fenced',async()=>{
 const task=spawn();await controller.tick();outcome={type:'failed',failure:{code:'TEST_STOP',message:'Stopped',observedAt:Date.now()}};await controller.tick();
 const next=tasks.update({...context,actionId:'continue'},task.taskId,1,'Continue from the current state','when_ready');expect(next.state).toBe('queued');expect(next.failure).toBeUndefined();
 expect(()=>tasks.update({...context,actionId:'stale'},task.taskId,1,'stale','when_ready')).toThrow('REVISION_CONFLICT');
 outcome={type:'unknown',failure:{code:'UNKNOWN',message:'unknown',observedAt:Date.now()}};await controller.tick();
 expect(()=>tasks.update({...context,actionId:'unsafe'},task.taskId,store.task(task.taskId)!.revision,'Continue','when_ready')).toThrow('STATE_CONFLICT');
});
test('readiness does not dispatch busy targets; revocation before dispatch fails without side effects',async()=>{
 adapter.ready=()=>false;const task=spawn();await controller.tick();expect(adapter.submit).not.toHaveBeenCalled();
 adapter.ready=()=>{throw new Error('Access revoked');};await controller.tick();
 expect(store.task(task.taskId)?.state).toBe('failed');expect(adapter.submit).not.toHaveBeenCalled();
});
test('safemode discovery is live-authorized and results are isolated by request, independent of output.log',async()=>{
 const root=join(directory,'safemode'),id=target.sessionId,dir=join(root,id);mkdirSync(join(dir,'requests'),{recursive:true});
 atomicJson(join(dir,'session.json'),{id,name:'astra2',cli:'codex',nativeSessionId:id,createdAt:new Date().toISOString()});
 new SafemodeStore(root).assign(id,'operator');
 let allowed=false;const safe=new SafemodeTaskAdapter('operator',()=>allowed,()=>new SafemodeStore(root));
 expect(()=>safe.discover()).toThrow('SAFEMODE_AGENT_NOT_ALLOWED');allowed=true;
 expect(safe.discover('astra2')).toMatchObject({sessions:[{id,name:'astra2',cli:'codex',status:'idle'}]});
 expect(safe.resolve({adapter:'safemode',session_id:'astra2',no_bootstrap:true})).toMatchObject({sessionId:id,noBootstrap:true});
 const task=spawn();atomicJson(join(dir,'requests','A.json'),{id:'A',status:'completed',result:'Result A'});atomicJson(join(dir,'requests','B.json'),{id:'B',status:'completed',result:'Result B'});writeFileSync(join(dir,'output.log'),'Result B latest');
 expect(await safe.inspect(task,'A')).toEqual({type:'completed',result:{summary:'Result A',artifactIds:[]}});
 expect(await safe.inspect(task,'B')).toEqual({type:'completed',result:{summary:'Result B',artifactIds:[]}});
 allowed=false;expect(()=>safe.discover()).toThrow();expect(await safe.inspect(task,'A')).toMatchObject({type:'completed'});
 const local=new SafemodeStore(root),owner=local.acquire(id,'interactive');
 try {atomicJson(join(dir,'requests','C.json'),{id:'C',status:'running',ownerToken:'older-owner'});await expect(safe.cancel(task,'C')).rejects.toThrow('SAFEMODE_OWNER_CHANGED');expect(local.owner(id)?.token).toBe(owner.token);}
 finally{local.release(id,owner);}
});

test('independent requests to the same target cannot race before its owner file appears',async()=>{
 const first=spawn(),second=spawn();await controller.tick();expect(adapter.submit).toHaveBeenCalledTimes(1);
 expect(store.task(first.taskId)?.gatewayDispatch).toBeDefined();expect(store.task(second.taskId)?.gatewayDispatch).toBeUndefined();
 expect(store.task(second.taskId)?.state).toBe('queued');expect(store.task(second.taskId)?.activeAttemptId).toBeUndefined();
 outcome={type:'completed',result:{summary:'first done',artifactIds:[]}};await controller.tick();expect(adapter.submit).toHaveBeenCalledTimes(2);
});

test('busy targets stay amendable in the queue and leave capacity for an unrelated worker',async()=>{
 tasks.configure({tasks:{workspaceMode:'host',maxConcurrentPerAgent:1,maxConcurrentPerConversation:1}});
 adapter.ready=()=>false;
 const waiting=spawn();await controller.tick();
 expect(store.task(waiting.taskId)).toMatchObject({state:'queued'});
 expect(store.task(waiting.taskId)?.activeAttemptId).toBeUndefined();
 const edited=tasks.update({...context,actionId:'amend-waiting'},waiting.taskId,1,'Latest authorized instructions','when_ready');
 expect(edited.revision).toBe(2);
 const other=tasks.spawn({...context,actionId:'unrelated-worker'},{title:'Unrelated',instructions:'Do other work',targetProfile:'default-worker'});
 const attempt=tasks.claim(other.taskId);expect(attempt).toBeDefined();
 tasks.finish(attempt!.attemptId,attempt!.generation,{type:'completed',result:{summary:'Done',artifactIds:[]}});
 adapter.ready=()=>true;await controller.tick();
 expect(adapter.submit).toHaveBeenCalledWith(expect.objectContaining({taskId:waiting.taskId}),expect.any(String),'Latest authorized instructions',undefined,false,undefined);
});

test('a queued busy target can be cancelled without dispatch or an execution attempt',async()=>{
 adapter.ready=()=>false;const task=spawn();await controller.tick();
 tasks.cancelByUser(task.conversationId,'owner',task.taskId);await controller.tick();
 expect(store.task(task.taskId)?.state).toBe('cancelled');
 expect(store.all('SELECT * FROM task_attempts WHERE task_id=?',task.taskId)).toHaveLength(0);
 expect(adapter.submit).not.toHaveBeenCalled();expect(adapter.cancel).not.toHaveBeenCalled();
});

test.each(['headless', 'interactive'] as const)('dead %s safemode owner fails visibly without dispatch or lock deletion', async mode => {
  const root = join(directory, 'safemode'), id = target.sessionId, dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  atomicJson(join(dir, 'session.json'), { id, name: 'fixture', cli: 'codex', nativeSessionId: id, createdAt: new Date().toISOString() });
  const local = new SafemodeStore(root); local.assign(id, 'operator');
  const owner = { pid: 2147483647, childPid: 2147483646, token: 'exited-owner', mode };
  atomicJson(join(dir, 'owner.json'), owner);
  const safe = new SafemodeTaskAdapter('operator', () => true, () => new SafemodeStore(root));
  const submit = jest.spyOn(safe, 'submit');
  await controller.close(); controller = new GatewayTaskController(tasks, new Map([['safemode', safe]]));
  const task = spawn();
  await controller.tick(); await controller.tick();
  expect(store.task(task.taskId)).toMatchObject({ state: 'failed', failure: { code: 'SAFEMODE_RECOVERY_REQUIRED' } });
  expect(store.task(task.taskId)?.gatewayDispatch).toBeUndefined();
  expect(submit).not.toHaveBeenCalled();
  expect(local.owner(id)).toEqual(owner);
  expect(store.all('SELECT * FROM notifications')).toHaveLength(1);
});

test('a live native child still keeps the safemode target busy when its supervisor exited', () => {
  const root = join(directory, 'safemode'), id = target.sessionId, dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  atomicJson(join(dir, 'session.json'), { id, name: 'fixture', cli: 'codex', nativeSessionId: id, createdAt: new Date().toISOString() });
  const local = new SafemodeStore(root); local.assign(id, 'operator');
  atomicJson(join(dir, 'owner.json'), { pid: 2147483647, childPid: process.pid, token: 'live-child', mode: 'headless' });
  const safe = new SafemodeTaskAdapter('operator', () => true, () => new SafemodeStore(root));
  expect(safe.ready(store.task(spawn().taskId)!)).toBe(false);
});

test('browser stale-budget rejection releases capacity and accepts the next command on the same task',async()=>{
 await controller.close();
 const run=jest.fn(async(c:any)=>{const op='550e8400-e29b-41d4-a716-446655440000';c.beforeMutation(op,'page_click');return {status:'blocked' as const,reason:'STALE_RETRY_BUDGET',steps:2,evaluations:4,lastAction:{operationId:op,operation:'CLICK',outcome:'not_executed' as const}};});
 const browser=new BrowserTaskAdapter({agentId:'operator',root:join(directory,'browser'),allowed:()=>true,bindings:()=>[binding],evaluate:jest.fn()});
 const binding={version:1 as const,id:'tab',name:'Tab',principalId:'owner',conversationId:context.conversationId,run};
 controller=new GatewayTaskController(tasks,new Map([['browser',browser]]));
 const command={title:'Inspect browser',instructions:'Read authorized page',targetProfile:'gateway-managed',gatewayTarget:{adapter:'browser',sessionId:'tab',name:'Tab'}};
 const first=tasks.spawn({...context,actionId:'browser-first'},command);
 expect(()=>tasks.spawn({...context,actionId:'browser-second'},command)).toThrow('This device session already has task');
 for(let i=0;i<8;i++){await controller.tick();await new Promise(setImmediate);}
 expect(store.task(first.taskId)?.state).toBe('failed');expect(store.task(first.taskId)?.activeAttemptId).toBeUndefined();
 tasks.controlByUser(context.conversationId,'owner',first.taskId,{id:randomUUID(),action:'revise',expectedRevision:1,text:'Inspect the next result'});
 for(let i=0;i<8;i++){await controller.tick();await new Promise(setImmediate);}
 expect(store.task(first.taskId)?.state).toBe('failed');expect(run).toHaveBeenCalledTimes(2);
});

test('managed revisions survive restart without replaying the current request',async()=>{
 const t=spawn();await controller.tick();tasks.update({...context,actionId:'revise-before-restart'},t.taskId,1,'Revised goal','when_ready');
 await controller.close();store.close();open();recoverOrchestration(store);controller=new GatewayTaskController(tasks,new Map([['safemode',adapter]]));
 await controller.tick();expect(adapter.submit).toHaveBeenCalledTimes(1);
 outcome={type:'completed',result:{summary:'Old request finished',artifactIds:[]}};
 await controller.tick();await controller.tick();expect(adapter.submit).toHaveBeenCalledTimes(2);expect(store.task(t.taskId)?.revision).toBe(2);
});
test('managed follow-up rejects another principal, notifications, and cancelled work',async()=>{
 const t=spawn();
 expect(()=>tasks.update({...context,principalId:'other',actionId:'cross-owner'},t.taskId,1,'Changed','when_ready')).toThrow();
 expect(()=>tasks.update({...context,execute:false,actionId:'notification'},t.taskId,1,'Changed','when_ready')).toThrow();
 tasks.cancelByUser(t.conversationId,'owner',t.taskId);
 expect(()=>tasks.update({...context,actionId:'after-cancel'},t.taskId,1,'Changed','when_ready')).toThrow('TASK_TERMINAL');
});

function missingBrowserField() {
 const task=tasks.spawn({...context,actionId:`field-${++sequence}`},{title:'Flight search',instructions:'Find flights to Osaka',targetProfile:'gateway-managed',gatewayTarget:{...target,adapter:'browser'}});
 const attempt=tasks.claim(task.taskId)!; tasks.started(attempt.attemptId,attempt.generation);
 const waiting=tasks.requestInput(attempt.attemptId,attempt.generation,'Where to?');
 tasks.finish(attempt.attemptId,attempt.generation,{type:'paused',browserReport:{contractVersion:1,status:'blocked',reason:'FIELD_TEXT_REQUIRED',steps:0,evaluations:1,fieldRequest:{ref:'e1',label:'Where to?',reason:'missing'}}});
 store.run("UPDATE notifications SET status='assigned',decision_id=? WHERE task_id=?",context.decisionId,task.taskId);
 return {taskId:task.taskId,questionId:waiting.pendingQuestion!.questionId};
}
test('assigned browser notification answers a missing field in the same authorized task',()=>{
 const q=missingBrowserField(); const ctx={...context,execute:false,actionId:'field-answer'};
 const answered=tasks.answer(ctx,q.taskId,q.questionId,'Osaka, Japan');
 expect(answered.state).toBe('queued');expect(answered.revision).toBe(2);
 expect(tasks.revision(q.taskId,2).answers).toEqual(expect.arrayContaining([expect.objectContaining({text:'Osaka, Japan',browserFieldLabel:'Where to?'})]));
 expect(tasks.answer(ctx,q.taskId,q.questionId,'Osaka, Japan').revision).toBe(2);
});
test.each(['unassigned','other-owner','non-browser','non-field','ambiguous','revoked','old-question'])(
 'notification cannot answer browser field with %s authority', reason=>{
 const q=missingBrowserField(); const task=store.task(q.taskId)!;
 if(reason==='unassigned')store.run("UPDATE notifications SET status='pending' WHERE task_id=?",q.taskId);
 if(reason==='other-owner')task.ownerPrincipalId='another-user';
 if(reason==='non-browser')task.gatewayTarget!.adapter='safemode';
 if(reason==='non-field')task.browserReport!.reason='CONSENT_REQUIRED';
 if(reason==='ambiguous')task.browserReport!.fieldRequest!.reason='ambiguous';
 if(reason==='revoked')task.capabilities.execute=false;
 if(reason==='old-question'){task.pendingQuestion!.questionId='new-question';q.questionId='new-question';}
 store.transaction(()=>store.saveTask(task,task.stateVersion));
 expect(()=>tasks.answer({...context,execute:false,actionId:'denied-field'},q.taskId,q.questionId,'Osaka')).toThrow('EXECUTION_DENIED');
 expect(store.task(q.taskId)!.revision).toBe(1);
});

function missingComputerField() {
 const q=missingBrowserField();const task=store.task(q.taskId)!;
 task.gatewayTarget!.adapter='computer';delete task.browserReport;
 task.computerReport={status:'blocked',reason:'FIELD_TEXT_REQUIRED',steps:0,fieldRequest:{label:'Note text',reason:'missing'}};
 store.transaction(()=>store.saveTask(task,task.stateVersion));
 return q;
}
test('assigned computer notification answers only its authorized missing field',()=>{
 const q=missingComputerField();
 const answer=tasks.answer({...context,execute:false,actionId:'computer-field'},q.taskId,q.questionId,'Approved note');
 expect(answer.state).toBe('queued');expect(answer.revision).toBe(2);
 expect(tasks.revision(q.taskId,2).answers).toEqual(expect.arrayContaining([expect.objectContaining({text:'Approved note'})]));
});
test.each(['unassigned','other-owner','non-field','no-label','revoked'])(
 'computer field answer rejects %s',reason=>{
 const q=missingComputerField(),task=store.task(q.taskId)!;
 if(reason==='unassigned')store.run("UPDATE notifications SET status='pending' WHERE task_id=?",q.taskId);
 if(reason==='other-owner')task.ownerPrincipalId='another-user';
 if(reason==='non-field')task.computerReport!.reason='CONSENT_REQUIRED';
 if(reason==='no-label')delete task.computerReport!.fieldRequest;
 if(reason==='revoked')task.capabilities.execute=false;
 store.transaction(()=>store.saveTask(task,task.stateVersion));
 expect(()=>tasks.answer({...context,execute:false,actionId:'denied-computer-field'},q.taskId,q.questionId,'Note')).toThrow('EXECUTION_DENIED');
 expect(store.task(q.taskId)!.revision).toBe(1);
});

test('an early managed field answer waits for its existing attempt to settle',()=>{
 const q=missingBrowserField(); const task=store.task(q.taskId)!;
 // Restore the still-settling attempt to reproduce answer/finish ordering.
 const attempt=JSON.parse(String(store.get('SELECT payload_json FROM task_attempts WHERE task_id=?',q.taskId)!.payload_json));
 attempt.state='running';task.activeAttemptId=attempt.attemptId;
 store.transaction(()=>{store.saveAttempt(attempt);store.saveTask(task,task.stateVersion);});
 const answered=tasks.answer({...context,execute:false,actionId:'early-field'},q.taskId,q.questionId,'Osaka');
 expect(answered.state).toBe('running');expect(tasks.claim(q.taskId)).toBeUndefined();
 tasks.finish(attempt.attemptId,attempt.generation,{type:'paused'});
 expect(store.task(q.taskId)!.state).toBe('queued');expect(store.task(q.taskId)!.activeAttemptId).toBeUndefined();
});

function stoppedBrowser(reason='LOW_TARGET_CONFIDENCE') {
 const task=tasks.spawn({...context,actionId:`recover-${++sequence}`},{title:'Flight search',instructions:'Find authorized flights to Osaka',targetProfile:'gateway-managed',gatewayTarget:{...target,adapter:'browser'}});
 stopBrowser(task.taskId,reason);return task.taskId;
}
function stopBrowser(taskId:string,reason:string) {
 const attempt=tasks.claim(taskId)!;tasks.started(attempt.attemptId,attempt.generation);
 tasks.finish(attempt.attemptId,attempt.generation,{type:'failed',failure:{code:'BROWSER_'+reason,message:'Stopped',observedAt:Date.now()},browserReport:{contractVersion:1,status:'blocked',reason,steps:0,evaluations:1}});
 store.run("UPDATE notifications SET status='assigned',decision_id=? WHERE task_id=?",context.decisionId,taskId);
}
test.each(['LOW_TARGET_CONFIDENCE','OBSERVATION_TRUNCATED','NO_PROGRESS','NO_SUPPORTED_ACTION'])('assigned browser notification replans %s in the same task without replacing authorization',reason=>{
 const id=stoppedBrowser(reason);
 const updated=tasks.update({...context,execute:false,actionId:'recover'},id,1,'Fill destination first; retain passenger requirements','when_ready');
 expect(updated.state).toBe('queued');expect(updated.initiatingInputId).toBe(context.inputId);
 const revision=tasks.revision(id,2);expect(revision.instructions).toBe('Find authorized flights to Osaka');
 expect(revision.guidance).toContain('Fill destination');expect(revision.browserRecoveryCount).toBe(1);
 expect(revision.originatingInputId).toBe(context.inputId);
});
test.each(['unassigned','other-owner','unknown','provider','cancelled','revoked'])(
 'browser recovery rejects %s',reason=>{
 const id=stoppedBrowser(),task=store.task(id)!;
 if(reason==='unassigned')store.run("UPDATE notifications SET status='pending' WHERE task_id=?",id);
 if(reason==='other-owner')task.ownerPrincipalId='other';
 if(reason==='unknown')task.browserReport!.lastAction={operation:'CLICK',operationId:'unknown',outcome:'unknown'};
 if(reason==='provider')task.browserReport!.providerFailure={code:'OUTCOME_UNKNOWN'};
 if(reason==='cancelled')task.state='cancelled';
 if(reason==='revoked')task.capabilities.execute=false;
 store.transaction(()=>store.saveTask(task,task.stateVersion));
 // Keep the notification current so the test exercises the specific guard.
 store.run('UPDATE notifications SET task_state_version=? WHERE task_id=?',task.stateVersion,id);
 expect(()=>tasks.update({...context,execute:false,actionId:'no-recovery'},id,1,'Try again','when_ready')).toThrow();
 expect(store.task(id)!.revision).toBe(1);
});
test('browser recovery is bounded across repeated notification decisions',()=>{
 const id=stoppedBrowser();
 for(let i=0;i<3;i++){
  tasks.update({...context,execute:false,actionId:`recover-${i}`},id,i+1,`Different plan ${i}`,'when_ready');
  stopBrowser(id,'LOW_TARGET_CONFIDENCE');
 }
 expect(()=>tasks.update({...context,execute:false,actionId:'over-budget'},id,4,'Another plan','when_ready')).toThrow('Inspect the evidence');
});
test.each([false,true])('notification verifies only known completion evidence (unknown=%s)',unknown=>{
 const task=tasks.spawn({...context,actionId:'verify-spawn'},{title:'Search',instructions:'Find flights',targetProfile:'gateway-managed',gatewayTarget:{...target,adapter:'browser'}});
 const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
 const current=store.task(task.taskId)!;current.gatewayDispatch={requestId:'request',submittedAt:Date.now()};
 store.transaction(()=>store.saveTask(current,current.stateVersion));
 tasks.finish(attempt.attemptId,attempt.generation,{type:'unknown',browserReport:{contractVersion:1,status:'needs_verification',reason:unknown?'OUTCOME_UNKNOWN':'COMPLETION_CANDIDATE',steps:1,evaluations:1,...(unknown?{lastAction:{operation:'CLICK',operationId:'click',outcome:'unknown' as const}}:{})}});
 store.run("UPDATE notifications SET status='assigned',decision_id=? WHERE task_id=?",context.decisionId,task.taskId);
 const check=jest.fn();const verify=()=>tasks.verifyBrowser({...context,execute:false,actionId:'verify'},task.taskId,1,'request','fresh-evidence','Observed the requested results',check);
 if(unknown){expect(verify).toThrow('BROWSER_VERIFICATION_UNAVAILABLE');expect(check).not.toHaveBeenCalled();}
 else{expect(verify().state).toBe('completed');expect(check).toHaveBeenCalledTimes(1);}
});
test('browser controller dispatches parent guidance with the original goal',async()=>{
 const id=stoppedBrowser();tasks.update({...context,execute:false,actionId:'guided'},id,1,'Fill destination first','when_ready');
 await controller.close();controller=new GatewayTaskController(tasks,new Map([['browser',{...adapter,name:'browser'}]]));
 await controller.tick();
 expect(adapter.submit).toHaveBeenCalledWith(expect.objectContaining({taskId:id}),expect.any(String),expect.stringMatching(/Find authorized flights to Osaka[\s\S]*Fill destination first/),undefined,false,undefined);
});

test.each(['valid','unassigned','other-owner','unknown','provider','cancelled','revoked'])('parent verification after a confidence stop: %s',reason=>{
 const id=stoppedBrowser(),task=store.task(id)!;
 task.gatewayDispatch={requestId:'request',submittedAt:Date.now()};
 if(reason==='other-owner')task.ownerPrincipalId='other';
 if(reason==='unknown')task.browserReport!.lastAction={operation:'CLICK',operationId:'unknown',outcome:'unknown'};
 if(reason==='provider')task.browserReport!.providerFailure={code:'OUTCOME_UNKNOWN'};
 if(reason==='cancelled')task.state='cancelled';
 if(reason==='revoked')task.capabilities.execute=false;
 store.transaction(()=>store.saveTask(task,task.stateVersion));
 store.run('UPDATE notifications SET task_state_version=? WHERE task_id=?',task.stateVersion,id);
 if(reason==='unassigned')store.run("UPDATE notifications SET status='pending' WHERE task_id=?",id);
 const check=jest.fn();
 const verify=()=>tasks.verifyBrowser({...context,execute:false,actionId:'verify-stop'},id,1,'request','evidence','Fresh evidence proves the authorized goal',check);
 if(reason==='valid'){expect(verify().state).toBe('completed');expect(check).toHaveBeenCalledTimes(1);}
 else{expect(verify).toThrow();expect(check).not.toHaveBeenCalled();}
});

test('cancelling an unknown attempt with an unresolved receipt leaves Stopping for reconciliation',async()=>{
 const task=spawn();outcome={type:'unknown',failure:{code:'OUTCOME_UNKNOWN',message:'Inspect first',observedAt:Date.now()}};
 await controller.tick();expect(store.task(task.taskId)?.state).toBe('needs_reconciliation');
 adapter.cancel=jest.fn(async()=>{});
 tasks.cancelByUser(task.conversationId,'owner',task.taskId);await controller.tick();
 expect(store.task(task.taskId)?.state).toBe('needs_reconciliation');
 expect(store.task(task.taskId)?.failure?.code).toBe('CLEANUP_UNCONFIRMED');
 expect(store.task(task.taskId)?.activeAttemptId).toBeTruthy();
 expect(adapter.submit).toHaveBeenCalledTimes(1);
});

test('cancel a finished read-only completion candidate after restart releases its task',async()=>{
 await controller.close();
 const bindings:import('../../../src/orchestration/gateway-tasks/browser').BrowserTaskBinding[]=[{version:1,id:'tab',name:'Tab',principalId:'owner',conversationId:context.conversationId,run:async()=>({status:'needs_verification',reason:'COMPLETION_CANDIDATE',steps:0,evaluations:1})}];
 const browser=new BrowserTaskAdapter({agentId:'operator',root:join(directory,'browser'),allowed:()=>true,evaluate:jest.fn(),bindings:()=>bindings});
 controller=new GatewayTaskController(tasks,new Map([['browser',browser]]));
 const task=tasks.spawn({...context,actionId:'browser-spawn'},{title:'Read results',instructions:'Read the open page',targetProfile:'gateway-managed',gatewayTarget:{adapter:'browser',sessionId:'tab',name:'Tab'}});
 await controller.tick();await new Promise(setImmediate);await controller.tick();
 expect(store.task(task.taskId)?.state).toBe('needs_reconciliation');
 await controller.close();store.close();open();recoverOrchestration(store);
 const restored=new BrowserTaskAdapter({agentId:'operator',root:join(directory,'browser'),allowed:()=>false,evaluate:jest.fn(),bindings:()=>[]});
 controller=new GatewayTaskController(tasks,new Map([['browser',restored]]));
 tasks.cancelByUser(task.conversationId,'owner',task.taskId);await controller.tick();
 expect(store.task(task.taskId)?.state).toBe('cancelled');
 expect(store.task(task.taskId)?.activeAttemptId).toBeUndefined();
});

test('known pre-dispatch failures release work, while ambiguous dispatch errors remain fenced',async()=>{
 const first=spawn();jest.mocked(adapter.submit).mockRejectedValueOnce(new GatewayRequestNotSentError('COMPUTER_TARGET_UNAVAILABLE'));
 await controller.tick();expect(store.task(first.taskId)?.state).toBe('failed');expect(store.task(first.taskId)?.failure?.code).toBe('GATEWAY_REQUEST_DENIED');
 const second=spawn();jest.mocked(adapter.submit).mockRejectedValueOnce(Error('transport disconnected'));
 await controller.tick();expect(store.task(second.taskId)?.state).toBe('needs_reconciliation');
});
test('computer field metadata exists before its question notification is assigned',()=>{
 const task=tasks.spawn({...context,actionId:'computer-field'},{title:'Search',instructions:'Find macOS',targetProfile:'gateway-managed',gatewayTarget:{...target,adapter:'computer'}});
 const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
 const report={status:'needs_input',reason:'FIELD_TEXT_REQUIRED',steps:0,fieldRequest:{label:'Search',application:'com.apple.AppStore',windowTitle:'App Store',role:'AXTextField',reason:'missing' as const}};
 const waiting=tasks.requestInput(attempt.attemptId,attempt.generation,'Search text?',undefined,report);
 expect(store.task(task.taskId)?.computerReport).toEqual(report);
 store.run("UPDATE notifications SET status='assigned',decision_id=? WHERE task_id=?",context.decisionId,task.taskId);
 tasks.answer({...context,execute:false,actionId:'computer-answer'},task.taskId,waiting.pendingQuestion!.questionId,'macOS');
 expect(tasks.revision(task.taskId,2).answers).toEqual(expect.arrayContaining([expect.objectContaining({text:'macOS',computerFieldLabel:'Search',computerApplication:'com.apple.AppStore',computerFieldRole:'AXTextField',computerWindowTitle:'App Store'})]));
});

test('recorded recovery queues a new inspection without replaying the old dispatch and survives a controller restart',async()=>{
 const task=spawn();outcome={type:'unknown',failure:{code:'OUTCOME_UNKNOWN',message:'unknown',observedAt:Date.now()}};await controller.tick();
 const old=store.task(task.taskId)!.gatewayDispatch!.requestId;
 await controller.close();controller=new GatewayTaskController(tasks,new Map([['safemode',adapter]]));
 adapter.recover=jest.fn(async()=>({state:'queued' as const,evidence:'Recorded operation completed; observe again'}));
 await controller.tick();expect(store.task(task.taskId)?.state).toBe('queued');expect(store.task(task.taskId)?.gatewayDispatch).toBeUndefined();
 outcome='running';await controller.tick();expect(store.task(task.taskId)?.gatewayDispatch?.requestId).not.toBe(old);expect(adapter.submit).toHaveBeenCalledTimes(2);
});
test('owner review closes an unknown task without dispatching another operation',async()=>{
 const task=spawn();outcome={type:'unknown',failure:{code:'OUTCOME_UNKNOWN',message:'unknown',observedAt:Date.now()}};await controller.tick();
 adapter.recover=jest.fn(async()=>({state:'cancelled' as const,evidence:'Owner reviewed and stopped old work'}));
 await controller.tick();await controller.tick();expect(store.task(task.taskId)?.state).toBe('cancelled');expect(adapter.submit).toHaveBeenCalledTimes(1);
});

test('a slow recovery probe does not block dispatch to another target',async()=>{
 const first=spawn();outcome={type:'unknown',failure:{code:'OUTCOME_UNKNOWN',message:'unknown',observedAt:Date.now()}};await controller.tick();
 let resolve!:()=>void;adapter.recover=()=>new Promise(r=>{resolve=()=>r(undefined);});outcome='running';
 const other=tasks.spawn({...context,actionId:'other-target'},{title:'Other target',instructions:'Inspect the other authorized target',targetProfile:'gateway-managed',gatewayTarget:{...target,sessionId:'22222222-2222-4222-8222-222222222222'}});
 await controller.tick();expect(store.task(first.taskId)?.state).toBe('needs_reconciliation');expect(store.task(other.taskId)?.state).toBe('running');resolve();
});

test('recovery cooldown lets later unknown tasks get inspected instead of starving behind the first two',async()=>{
 const ids:string[]=[];outcome={type:'unknown',failure:{code:'OUTCOME_UNKNOWN',message:'unknown',observedAt:Date.now()}};
 for(let i=0;i<3;i++){
  const task=tasks.spawn({...context,actionId:'recovery-fair-'+i},{title:'Recover '+i,instructions:'Inspect target',targetProfile:'gateway-managed',gatewayTarget:{...target,sessionId:'target-'+i}});await controller.tick();ids.push(task.taskId);
 }
 adapter.recover=jest.fn(async()=>undefined);await controller.tick();await new Promise(setImmediate);await controller.tick();
 expect(new Set(jest.mocked(adapter.recover).mock.calls.map(c=>c[0].taskId))).toEqual(new Set(ids));
});
