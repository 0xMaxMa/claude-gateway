import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {automationSession} from '../../../src/orchestration/tasks/automation-session';

// Recorded: task e82f94f0 waited 8 min for access, failed COMPUTER_ACCESS_UNAVAILABLE
// with 0 actions, then held the device session for 55 min (AUTOMATION_SESSION_EXISTS)
// because user-controlled sessions never expired.
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'computer-session-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'open chrome',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const spawn=(actionId:string)=>tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId},{title:'Chrome',instructions:'Open Chrome',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 const fail=(taskId:string,reason:string,steps:number)=>{const attempt=tasks.claim(taskId)!;tasks.started(attempt.attemptId,attempt.generation);
  const task=store.task(taskId)!;task.gatewayDispatch={requestId:'task-'+attempt.attemptId,submittedAt:Date.now()};store.transaction(()=>store.saveTask(task,task.stateVersion));
  return tasks.finish(attempt.attemptId,attempt.generation,{type:'failed',failure:{code:reason,message:reason,observedAt:Date.now()},computerReport:{status:'blocked',reason,steps,evaluations:0,phase:'terminal'}});};
 return {store,tasks,spawn,fail,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}

test('a failed session that never acted is replaced by a new spawn',()=>{
 const f=fixture();try{
  const old=f.spawn('spawn-1');f.fail(old.taskId,'COMPUTER_ACCESS_UNAVAILABLE',0);
  const next=f.spawn('spawn-2');
  expect(next.taskId).not.toBe(old.taskId);
  const previous=f.store.task(old.taskId)!;
  expect(previous.replacedByTaskId).toBe(next.taskId);
  expect(automationSession(previous)?.status).toBe('closed');
 }finally{f.close();}
});

test('a session that acted is kept, and the error states its real state and reason',()=>{
 const f=fixture();try{
  const old=f.spawn('spawn-1');f.fail(old.taskId,'NATIVE_REQUEST_TIMEOUT',2);
  expect(()=>f.spawn('spawn-2')).toThrow(/failed.*COMPUTER_NATIVE_REQUEST_TIMEOUT|failed.*NATIVE_REQUEST_TIMEOUT/s);
  expect(()=>f.spawn('spawn-3')).toThrow(/not a permission problem/);expect(()=>f.spawn('spawn-4')).not.toThrow(/approve/i);
 }finally{f.close();}
});

test('a failed user-controlled session still expires after its idle timeout',()=>{
 const f=fixture();try{
  const old=f.spawn('spawn-1');const task=f.fail(old.taskId,'NATIVE_REQUEST_TIMEOUT',2);
  expect(task.automationController).toBe('user');
  expect(automationSession(task,Date.now())?.status).toBe('blocked');
  expect(automationSession(task,Date.now()+31*60*1000)?.status).toBe('closed');
 }finally{f.close();}
});
