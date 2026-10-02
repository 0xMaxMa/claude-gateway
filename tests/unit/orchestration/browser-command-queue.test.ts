import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import type {WorkerOutcome} from '../../../src/orchestration/types';
import {automationSession} from '../../../src/orchestration/tasks/automation-session';
import type {BrowserTaskReport} from '../../../src/jev/browser-contract';

// Remote Browser gets the same direct-command guarantees as Computer Use:
// FIFO verbatim queue, per-command outcome text and replacement of a session
// that never acted.
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'browser-queue-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'Use my browser tab',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const context={...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'};
 const spawn=(actionId='spawn')=>tasks.spawn({...context,actionId},{title:'Browser',instructions:'Open the tab',targetProfile:'gateway-managed',gatewayTarget:{adapter:'browser',sessionId:'tab',name:'Tab'}});
 const task=spawn();
 const send=(text:string)=>tasks.controlByUser(accepted.conversationId,'u',task.taskId,{id:randomUUID(),action:'revise',expectedRevision:store.task(task.taskId)!.revision,text});
 const run=()=>{const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);return attempt;};
 const report=(patch:Partial<BrowserTaskReport>={}):BrowserTaskReport=>({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:0,lastAction:{operationId:randomUUID(),operation:'SCROLL_DOWN',outcome:'confirmed'},commandOutcome:{done:true,action:{kind:'scroll',direction:'down'}},...patch});
 const settle=(attempt:{attemptId:string;generation:number},outcome:WorkerOutcome={type:'paused',browserReport:report()})=>tasks.finish(attempt.attemptId,attempt.generation,outcome);
 const instructions=()=>store.all('SELECT payload_json FROM task_revisions WHERE task_id=? ORDER BY revision',task.taskId).map(row=>JSON.parse(String(row.payload_json)).instructions as string).slice(1);
 return {store,tasks,task,spawn,send,run,settle,report,instructions,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}

test('browser direct commands typed while a round runs are queued FIFO and delivered verbatim',()=>{
 const f=fixture();try{
  f.settle(f.run());f.send('scroll ลง');
  let attempt=f.run();
  expect(f.send('กลับ').state).toBe('running');
  expect(f.send('ค้นหา แมว').state).toBe('running');
  expect(f.store.task(f.task.taskId)!.queuedCommands?.map(c=>c.text)).toEqual(['กลับ','ค้นหา แมว']);
  f.settle(attempt);
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'queued',revision:3});
  attempt=f.run();f.settle(attempt);attempt=f.run();f.settle(attempt);
  expect(f.instructions()).toEqual(['scroll ลง','กลับ','ค้นหา แมว']);
  expect(f.instructions().some(text=>text.includes('Latest user correction'))).toBe(false);
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'waiting_input'});
 }finally{f.close();}
});

test('each settled browser command reports Done or Not done with a hint',()=>{
 const f=fixture();try{
  f.settle(f.run());
  expect(f.store.task(f.task.taskId)!.latestProgress?.text).toBe('Done: scrolled down. Send the next command.');
  f.send('ไปข้างหน้า');
  f.settle(f.run(),{type:'paused',browserReport:f.report({steps:0,lastAction:undefined,commandOutcome:{done:false,reason:'HISTORY_UNAVAILABLE',action:{kind:'history',direction:'forward'}}})});
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'waiting_input',latestProgress:{text:'Not done: there is no page to go forward to in this tab.'}});
 }finally{f.close();}
});

test('a browser session that failed before any tab action is replaced by a new spawn',()=>{
 const f=fixture();try{
  f.settle(f.run(),{type:'failed',failure:{code:'BROWSER_NO_SUPPORTED_ACTION',message:'x',observedAt:Date.now()},browserReport:{status:'blocked',reason:'NO_SUPPORTED_ACTION',steps:0,evaluations:1}});
  const replacement=f.spawn('spawn-2');
  expect(replacement.taskId).not.toBe(f.task.taskId);
  expect(automationSession(f.store.task(f.task.taskId)!)?.status).toBe('closed');
  expect(f.store.all("SELECT seq FROM conversation_events WHERE type='task.session_replaced'")).toHaveLength(1);
 }finally{f.close();}
});

test('a browser session that acted is not silently replaced',()=>{
 const f=fixture();try{
  f.settle(f.run(),{type:'failed',failure:{code:'BROWSER_NO_PROGRESS',message:'x',observedAt:Date.now()},browserReport:{status:'blocked',reason:'NO_PROGRESS',steps:1,evaluations:1,lastConfirmedAction:{operationId:randomUUID(),operation:'CLICK',outcome:'confirmed'}}});
  expect(()=>f.spawn('spawn-2')).toThrow(/already has task/);
 }finally{f.close();}
});

test('a browser step run reports its step summary as the outcome line',()=>{
 const f=fixture();try{
  f.settle(f.run(),{type:'paused',browserReport:f.report({steps:2,commandOutcome:undefined,stepRun:{total:3,completed:3,stopReason:'ALL_STEPS_DONE',remaining:[],unverifiedSteps:[2,3],notes:['Step 1: stayed in the approved tab (no new tab is opened).']}})});
  expect(f.store.task(f.task.taskId)).toMatchObject({state:'waiting_input',latestProgress:{text:'3/3 steps done. Step 1: stayed in the approved tab (no new tab is opened). No visible change after step 2, 3.'}});
 }finally{f.close();}
});
