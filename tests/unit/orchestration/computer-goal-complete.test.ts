import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {acceptsDirectCommand,automationSession} from '../../../src/orchestration/tasks/automation-session';
import type {WorkerOutcome} from '../../../src/orchestration/types';
import {pendingReports} from '../../../src/orchestration/notification-mailbox';

// Pod 2.0.16: the agent spawned "open YouTube in Chrome"; Chrome showed YouTube,
// yet the task sat in waiting_input as "Controlling" with the Mac "Being controlled",
// and the agent never heard back (waiting_input is not notified for user control).
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'computer-goal-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'เปิด youtube',capabilities:{execute:true,writeMemory:false}});
 const decisions=new DecisionService(store),decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
 const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'YouTube',instructions:'open YouTube in Chrome',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 // The agent's spawning turn ends; its task runs on.
 decisions.finish(decision,'Opening YouTube.');
 const finish=(outcome:WorkerOutcome)=>{const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
  const current=store.task(task.taskId)!;current.gatewayDispatch={requestId:'task-'+attempt.attemptId,submittedAt:Date.now()};store.transaction(()=>store.saveTask(current,current.stateVersion));
  return tasks.finish(attempt.attemptId,attempt.generation,outcome);};
 const notified=()=>store.all('SELECT id FROM notifications WHERE task_id=?',task.taskId).length;
 // Delivered: the mailbox would start an agent turn for it (not just a stored row).
 const delivered=()=>pendingReports(store,[],[],true).filter((row:any)=>store.get('SELECT task_id FROM notifications WHERE id=?',row.notification_id)?.task_id===task.taskId).length;
 return {store,task,tasks,finish,notified,delivered,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
const report={steps:3,evaluations:0,phase:'terminal',lastAction:{kind:'key',key:'enter'}};

test('a reached goal with released access completes, closes the session and notifies the agent',()=>{
 const f=fixture();try{
  expect(f.task.automationController).toBe('user');
  const done=f.finish({type:'completed',result:{summary:'Computer goal reached: Done: 3 actions.',artifactIds:[]},computerReport:{...report,status:'succeeded',reason:'GOAL_REACHED',accessReleased:true}});
  expect(done.state).toBe('completed');
  expect(automationSession(done)).toMatchObject({status:'closed',closedReason:'agent'});
  expect(acceptsDirectCommand(done)).toBe(false);
  expect(f.notified()).toBe(1);expect(f.delivered()).toBe(1);
  // Saved and re-read: the closed session survives syncAutomationSession.
  expect(f.store.task(f.task.taskId)!.automationSession?.status).toBe('closed');
 }finally{f.close();}
});

test('a reached goal whose access was not released completes and notifies, but keeps the session for a stop',()=>{
 const f=fixture();try{
  const done=f.finish({type:'completed',result:{summary:'Computer goal reached.',artifactIds:[]},computerReport:{...report,status:'succeeded',reason:'GOAL_REACHED'}});
  expect(done.state).toBe('completed');expect(automationSession(done)?.status).toBe('idle');
  expect(f.notified()).toBe(1);expect(f.delivered()).toBe(1);
 }finally{f.close();}
});

test('a goal out of steps fails with COMPUTER_STEP_LIMIT and notifies the agent',()=>{
 const f=fixture();try{
  const stopped=f.finish({type:'failed',failure:{code:'COMPUTER_STEP_LIMIT',message:'Computer goal not finished',observedAt:Date.now()},computerReport:{...report,status:'blocked',reason:'STEP_LIMIT'}});
  expect(stopped.state).toBe('failed');expect(stopped.failure?.code).toBe('COMPUTER_STEP_LIMIT');
  expect(f.notified()).toBe(1);expect(f.delivered()).toBe(1);
  expect(automationSession(stopped)?.status).not.toBe('closed');
    // The device grant is untouched, so the owner's next command still reaches the Mac.
    expect(acceptsDirectCommand(stopped)).toBe(true);
 }finally{f.close();}
});

test('a real blocker (confirmation question) still waits for the user, unchanged',()=>{
 const f=fixture();try{
  const waiting=f.finish({type:'paused',computerReport:{...report,steps:1,status:'needs_input',reason:'COMMAND_WAITING_INPUT',trace:[{phase:'waiting',reason:'CONFIRMATION_REQUIRED',sequence:1,round:1,at:1,revision:1,steps:1,evaluations:1}]}});
  expect(waiting.state).toBe('waiting_input');expect(automationSession(waiting)?.status).toBe('idle');
  expect(f.notified()).toBe(0);
 }finally{f.close();}
});

// Pod-jinawong 2.0.17, task d3f019c3: the goal failed (COMPUTER_UNSUPPORTED_ACTION);
// its notification stayed pending, the agent never answered and the chat looked hung.
test('a failed agent goal run reaches the agent although the user controls the session',()=>{
 const f=fixture();try{
  const failed=f.finish({type:'failed',failure:{code:'COMPUTER_UNSUPPORTED_ACTION',message:'Computer work stopped: UNSUPPORTED_ACTION.',observedAt:Date.now()},computerReport:{...report,steps:1,status:'blocked',reason:'UNSUPPORTED_ACTION'}});
  expect(failed.state).toBe('failed');expect(failed.automationController).toBe('user');
  expect(f.notified()).toBe(1);expect(f.delivered()).toBe(1);
 }finally{f.close();}
});

test('a failed round of the user\'s own command stays silent (no behavior change)',()=>{
 const f=fixture();try{
  f.finish({type:'paused',computerReport:{...report,steps:0,status:'needs_input',reason:'COMMAND_WAITING_INPUT'}});
  f.tasks.controlByUser(f.task.conversationId,'u',f.task.taskId,{id:'00000000-0000-4000-8000-000000000001',action:'revise',expectedRevision:1,text:'click search'});
  expect(f.store.task(f.task.taskId)!.revision).toBe(2);
  f.finish({type:'failed',failure:{code:'COMPUTER_UNSUPPORTED_ACTION',message:'Computer work stopped: UNSUPPORTED_ACTION.',observedAt:Date.now()},computerReport:{...report,steps:1,status:'blocked',reason:'UNSUPPORTED_ACTION'}});
  expect(f.delivered()).toBe(0);
 }finally{f.close();}
});
