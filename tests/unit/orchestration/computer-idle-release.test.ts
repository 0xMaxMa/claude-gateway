import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {TaskControls} from '../../../src/orchestration/task-controls';
import {GatewayTaskController,DEVICE_IDLE_RELEASE_MS,type GatewayTaskAdapter} from '../../../src/orchestration/gateway-tasks/controller';
import {AUTOMATION_IDLE_TIMEOUT_MS,automationSession,computerAccess,computerDevice} from '../../../src/orchestration/tasks/automation-session';
import type {TaskSnapshot} from '../../../src/orchestration/types';

// Pod-jinawong, getpod-app Windows: "[Computer Use] เปิด Chrome" opened Chrome, the round
// settled waiting for the next command, and the PC kept showing "Being controlled": nothing
// ended the device session of an idle round, and a user-driven session never expired.
const PAUSED={type:'paused' as const,computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal'}};

function fixture(endSession:()=>Promise<boolean|undefined>=async()=>true){
 const root=mkdtempSync(join(tmpdir(),'computer-idle-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'open chrome',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'Chrome',instructions:'Open Chrome',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'pc',name:'PC'}});
 const outcomes=new Map<string,any>(),submitted:string[]=[],cancelled:string[]=[];
 const adapter:GatewayTaskAdapter={name:'computer',discover:()=>({}),resolve:()=>({adapter:'computer',sessionId:'pc',name:'PC'}),
  submit:async(_t,requestId)=>{submitted.push(requestId);outcomes.set(requestId,PAUSED);},
  inspect:async(_t,requestId)=>outcomes.get(requestId)??'running',
  cancel:async(_t,requestId)=>{cancelled.push(requestId);outcomes.set(requestId,{type:'stopped'});},
  endSession:jest.fn(async()=>endSession())};
 const controller=new GatewayTaskController(tasks,new Map([['computer',adapter]]));
 const get=()=>store.task(task.taskId)!;
 const edit=(change:(t:TaskSnapshot)=>void)=>{const t=get();store.transaction(()=>{change(t);store.saveTask(t,t.stateVersion);});};
 const idleFor=(ms:number)=>edit(t=>{t.automationSession!.idleSince=Date.now()-ms;});
 const send=(text:string)=>tasks.controlByUser(accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:get().revision,text});
 return {store,tasks,controller,adapter,accepted,get,edit,idleFor,send,submitted,cancelled,ended:()=>jest.mocked(adapter.endSession!).mock.calls.length,
  close:async()=>{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('a settled round releases the device after 90 s idle, not before, and only once',async()=>{
 const f=fixture();try{
  await f.controller.tick();await f.controller.tick();
  expect(f.get().state).toBe('waiting_input');
  f.idleFor(DEVICE_IDLE_RELEASE_MS-1000);await f.controller.tick();
  expect(f.ended()).toBe(0);
  f.idleFor(DEVICE_IDLE_RELEASE_MS+1000);await f.controller.tick();
  expect(f.ended()).toBe(1);
  expect(jest.mocked(f.adapter.endSession!).mock.calls[0][1]).toBe(f.get().gatewayDispatch!.requestId);
  expect(f.get().computerAccessReleased).toMatchObject({requestId:f.get().gatewayDispatch!.requestId});
  // accessReleased is recorded: later ticks and a gateway restart do not end it again.
  for(let i=0;i<3;i++)await f.controller.tick();
  const restarted=new GatewayTaskController(f.tasks,new Map([['computer',f.adapter]]));await restarted.tick();await restarted.close();
  expect(f.ended()).toBe(1);
  // The task and its automation session stay open for the next command.
  expect(f.get().state).toBe('waiting_input');expect(automationSession(f.get())?.status).toBe('idle');
  const view=new TaskControls(f.store,f.tasks).list('s','u',0,10).tasks[0];
  expect(view.progress).toContain('Device access released while idle');
 }finally{await f.close();}
});

test('the next command after a release runs a new round, which is eligible for its own release',async()=>{
 const f=fixture();try{
  await f.controller.tick();await f.controller.tick();
  f.idleFor(DEVICE_IDLE_RELEASE_MS+1000);await f.controller.tick();expect(f.ended()).toBe(1);
  f.send('Open youtube.com');await f.controller.tick();await f.controller.tick();
  // The new round is dispatched (the adapter asks the device for access again, see the adapter test).
  expect(f.submitted).toHaveLength(2);expect(f.get().state).toBe('waiting_input');
  expect(f.get().gatewayDispatch!.requestId).toBe(f.submitted[1]);
  expect(f.get().computerAccessReleased?.requestId).toBe(f.submitted[0]);
  const view=new TaskControls(f.store,f.tasks).list('s','u',0,10).tasks[0];
  expect(view.progress).not.toContain('Device access released while idle');
  f.idleFor(DEVICE_IDLE_RELEASE_MS+1000);await f.controller.tick();
  expect(f.ended()).toBe(2);expect(f.get().computerAccessReleased?.requestId).toBe(f.submitted[1]);
 }finally{await f.close();}
});

test.each<[string,(t:TaskSnapshot)=>void]>([
 ['a yes/no confirmation is pending',t=>{t.computerReport={...t.computerReport!,lastAction:{kind:'press',label:'Delete',blocked:true,confirm:true} as any};}],
 ['a confirmation is in the trace',t=>{t.computerReport={...t.computerReport!,trace:[{phase:'waiting',reason:'CONFIRMATION_REQUIRED'} as any]};}],
 ['a field value is requested',t=>{t.computerReport={...t.computerReport!,fieldRequest:{label:'Password',reason:'missing'}};}],
 ['an action is unconfirmed',t=>{t.computerReport={...t.computerReport!,status:'needs_reconciliation'};}],
 ['the access prompt is pending on the device',t=>{t.computerConnection='waiting_access';}],
 ['the access prompt timed out unanswered',t=>{t.state='failed';t.failure={code:'COMPUTER_ACCESS_TIMEOUT',message:'x',observedAt:Date.now()};}],
])('no release while %s',async(_name,change)=>{
 const f=fixture();try{
  await f.controller.tick();await f.controller.tick();
  f.edit(change);f.idleFor(DEVICE_IDLE_RELEASE_MS*3);
  await f.controller.tick();await f.controller.tick();
  expect(f.ended()).toBe(0);expect(f.get().computerAccessReleased).toBeUndefined();
 }finally{await f.close();}
});

test('no release while the round still runs or needs reconciliation',async()=>{
 const f=fixture();try{
  f.adapter.submit=async(_t,requestId)=>{f.submitted.push(requestId);};
  await f.controller.tick();await f.controller.tick();
  expect(f.get().state).toBe('running');
  await f.controller.tick();expect(f.ended()).toBe(0);
  f.adapter.inspect=async()=>({type:'unknown',failure:{code:'COMPUTER_OUTCOME_UNKNOWN',message:'x',observedAt:Date.now()}});
  await f.controller.tick();expect(f.get().state).toBe('needs_reconciliation');
  f.idleFor(DEVICE_IDLE_RELEASE_MS*3);await f.controller.tick();
  expect(f.ended()).toBe(0);
 }finally{await f.close();}
});

test('a release the adapter defers (device still in use) is not recorded and is tried again',async()=>{
 let answer:boolean|undefined;
 const f=fixture(async()=>answer);try{
  await f.controller.tick();await f.controller.tick();
  f.idleFor(DEVICE_IDLE_RELEASE_MS+1000);await f.controller.tick();
  expect(f.ended()).toBe(1);expect(f.get().computerAccessReleased).toBeUndefined();
  // Retried after the 5 s check interval, not on every 1 s tick.
  await f.controller.tick();expect(f.ended()).toBe(1);
  (f.controller as any).releaseAfter.clear();answer=true;await f.controller.tick();
  expect(f.ended()).toBe(2);expect(f.get().computerAccessReleased).toBeDefined();
 }finally{await f.close();}
});

test.each([['user','a save'],['agent','a save'],['user','no save'],['agent','no save']] as const)('30 min idle (controller=%s, expiry seen by %s) closes the session and ends the device session',async(controller,path)=>{
 const f=fixture(async()=>undefined);try{
  await f.controller.tick();await f.controller.tick();
  f.edit(t=>{t.automationController=controller;});
  if(path==='a save'){
   // Any save after the timeout (here the idle stamp itself) records the expiry and the revocation.
   f.idleFor(AUTOMATION_IDLE_TIMEOUT_MS+1000);
   expect(f.get().automationSession).toMatchObject({status:'closed',closedReason:'idle_timeout'});
   expect(f.get().computerRevocation?.requestId).toBe(f.submitted[0]);
  }else{
   // Nothing saves the task: the controller records the expiry it derives.
   f.store.run("UPDATE tasks SET snapshot_json=json_set(snapshot_json,'$.automationSession.idleSince',?) WHERE id=?",Date.now()-AUTOMATION_IDLE_TIMEOUT_MS-1000,f.get().taskId);
   expect(f.get().automationSession?.status).toBe('idle');expect(f.get().computerRevocation).toBeUndefined();
  }
  for(let i=0;i<3;i++)await f.controller.tick();
  // adapter.cancel → computer_end_session once, then the revocation is settled; the round keeps its state.
  expect(f.cancelled).toEqual([f.submitted[0]]);
  expect(f.get().automationSession).toMatchObject({status:'closed',closedReason:'idle_timeout'});
  expect(f.get().computerRevocation).toBeUndefined();expect(f.get().state).toBe('waiting_input');
  expect(f.ended()).toBe(0);
 }finally{await f.close();}
});

// Pod-jinawong, getpod-app Windows (DESKTOP-MINVS33): after the idle release the task card still
// counted "1 active task" and said "Access stopped" about "the Mac". The card reads computerAccess.
test('the task card reads computerAccess: released while idle, cleared by the next round, stopped by the owner',async()=>{
 const f=fixture();try{
  await f.controller.tick();await f.controller.tick();
  const view=()=>new TaskControls(f.store,f.tasks).list('s','u',0,10).tasks[0] as any;
  expect(computerAccess(f.get())).toBeUndefined();expect(view().computerAccess).toBeUndefined();
  f.idleFor(DEVICE_IDLE_RELEASE_MS+1000);await f.controller.tick();
  expect(computerAccess(f.get())).toBe('released');expect(view().computerAccess).toBe('released');
  expect(view().computerDevice).toBe('PC');
  // A follow-up continues the same task: its new round is live work again.
  f.send('Open youtube.com');
  expect(computerAccess(f.get())).toBeUndefined();
  await f.controller.tick();await f.controller.tick();
  expect(f.get().state).toBe('waiting_input');expect(computerAccess(f.get())).toBeUndefined();
  f.tasks.cancelByUser(f.accepted.conversationId,'u',f.get().taskId);
  expect(computerAccess(f.get())).toBe('stopped');expect(view().computerAccess).toBe('stopped');
 }finally{await f.close();}
});

test('an idle-timeout close and an agent close are neither released nor stopped by the owner',async()=>{
 const f=fixture(async()=>undefined);try{
  await f.controller.tick();await f.controller.tick();
  f.idleFor(AUTOMATION_IDLE_TIMEOUT_MS+1000);
  expect(computerAccess(f.get())).toBeUndefined();
 }finally{await f.close();}
});

test('computerDevice is the device label of a computer target only',()=>{
 expect(computerDevice({gatewayTarget:{adapter:'computer',sessionId:'x',name:'Computer Use · DESKTOP-MINVS33'}})).toBe('DESKTOP-MINVS33');
 expect(computerDevice({gatewayTarget:{adapter:'browser',sessionId:'x',name:'Chrome'}})).toBeUndefined();
 expect(computerDevice({})).toBeUndefined();
});
