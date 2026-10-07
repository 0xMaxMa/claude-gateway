import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {acceptsDirectCommand,automationSession} from '../../../src/orchestration/tasks/automation-session';
import type {WorkerOutcome} from '../../../src/orchestration/types';

// Pod 2.0.16: the agent spawned "open YouTube in Chrome"; Chrome showed YouTube,
// yet the task sat in waiting_input as "Controlling" with the Mac "Being controlled",
// and the agent never heard back (waiting_input is not notified for user control).
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'computer-goal-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'เปิด youtube',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'YouTube',instructions:'open YouTube in Chrome',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 const finish=(outcome:WorkerOutcome)=>{const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
  const current=store.task(task.taskId)!;current.gatewayDispatch={requestId:'task-'+attempt.attemptId,submittedAt:Date.now()};store.transaction(()=>store.saveTask(current,current.stateVersion));
  return tasks.finish(attempt.attemptId,attempt.generation,outcome);};
 const notified=()=>store.all('SELECT id FROM notifications WHERE task_id=?',task.taskId).length;
 return {store,task,finish,notified,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
const report={steps:3,evaluations:0,phase:'terminal',lastAction:{kind:'key',key:'enter'}};

test('a reached goal with released access completes, closes the session and notifies the agent',()=>{
 const f=fixture();try{
  expect(f.task.automationController).toBe('user');
  const done=f.finish({type:'completed',result:{summary:'Computer goal reached: Done: 3 actions.',artifactIds:[]},computerReport:{...report,status:'succeeded',reason:'GOAL_REACHED',accessReleased:true}});
  expect(done.state).toBe('completed');
  expect(automationSession(done)).toMatchObject({status:'closed',closedReason:'agent'});
  expect(acceptsDirectCommand(done)).toBe(false);
  expect(f.notified()).toBe(1);
  // Saved and re-read: the closed session survives syncAutomationSession.
  expect(f.store.task(f.task.taskId)!.automationSession?.status).toBe('closed');
 }finally{f.close();}
});

test('a reached goal whose access was not released completes and notifies, but keeps the session for a stop',()=>{
 const f=fixture();try{
  const done=f.finish({type:'completed',result:{summary:'Computer goal reached.',artifactIds:[]},computerReport:{...report,status:'succeeded',reason:'GOAL_REACHED'}});
  expect(done.state).toBe('completed');expect(automationSession(done)?.status).toBe('idle');
  expect(f.notified()).toBe(1);
 }finally{f.close();}
});

test('a goal out of steps fails with COMPUTER_STEP_LIMIT and notifies the agent',()=>{
 const f=fixture();try{
  const stopped=f.finish({type:'failed',failure:{code:'COMPUTER_STEP_LIMIT',message:'Computer goal not finished',observedAt:Date.now()},computerReport:{...report,status:'blocked',reason:'STEP_LIMIT'}});
  expect(stopped.state).toBe('failed');expect(stopped.failure?.code).toBe('COMPUTER_STEP_LIMIT');
  expect(f.notified()).toBe(1);
  expect(automationSession(stopped)?.status).not.toBe('closed');
 }finally{f.close();}
});

test('a real blocker (confirmation question) still waits for the user, unchanged',()=>{
 const f=fixture();try{
  const waiting=f.finish({type:'paused',computerReport:{...report,steps:1,status:'needs_input',reason:'COMMAND_WAITING_INPUT',trace:[{phase:'waiting',reason:'CONFIRMATION_REQUIRED',sequence:1,round:1,at:1,revision:1,steps:1,evaluations:1}]}});
  expect(waiting.state).toBe('waiting_input');expect(automationSession(waiting)?.status).toBe('idle');
  expect(f.notified()).toBe(0);
 }finally{f.close();}
});
