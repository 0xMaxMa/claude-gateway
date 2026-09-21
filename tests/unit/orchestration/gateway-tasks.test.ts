import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { WorkerScheduler } from '../../../src/orchestration/tasks/scheduler';
import { GatewayTaskController, GatewayTaskAdapter } from '../../../src/orchestration/gateway-tasks/controller';
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
test('already sent requests reject amendments instead of silently discarding them',async()=>{
 const task=spawn();await controller.tick();expect(()=>tasks.update({...context,actionId:'amend'},task.taskId,1,'different work','when_ready')).toThrow('already sent');
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
 expect(adapter.submit).toHaveBeenCalledWith(expect.objectContaining({taskId:waiting.taskId}),expect.any(String),'Latest authorized instructions');
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
