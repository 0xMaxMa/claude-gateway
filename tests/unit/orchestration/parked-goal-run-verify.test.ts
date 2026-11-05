import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {agentGoalRunParked,automationSession,parkedGoalRunNote} from '../../../src/orchestration/tasks/automation-session';
import {ANSWERED_FROM_SCREEN,computerOutcomeText} from '../../../src/automation/computer-outcome';
import type {ComputerTaskReport,WorkerOutcome} from '../../../src/orchestration/types';

// Pod-jinawong, task 59e5ce4f: "เปิด Chrome เปิด Steam แล้วเลือกมาซักเกมให้ผม". Step 2 opened Steam, but
// Windows could not confirm it (OUTCOME_UNKNOWN), so the agent's goal run parked and woke the agent.
// The agent answered from the screen (Resident Evil 4), but verify_computer accepted only
// needs_verification: the task stayed "Waiting for input" until the 30 min expiry.
const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'};
function fixture(adapter:'computer'|'browser'='computer'){
 const root=mkdtempSync(join(tmpdir(),'parked-verify-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope,text:'เปิด Chrome เปิด Steam แล้วเลือกมาซักเกมให้ผม',capabilities:{execute:true,writeMemory:false}});
 const decisions=new DecisionService(store),decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
 const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'Steam',instructions:'open Chrome and Steam',targetProfile:'gateway-managed',gatewayTarget:{adapter,sessionId:'pc',name:'Computer Use · DESKTOP-1'}});
 decisions.finish(decision,'Opening Chrome and Steam.');
 let requestId='';
 const finish=(outcome:WorkerOutcome)=>{const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
  const current=store.task(task.taskId)!;requestId='task-'+attempt.attemptId;current.gatewayDispatch={requestId,submittedAt:Date.now()};store.transaction(()=>store.saveTask(current,current.stateVersion));
  return tasks.finish(attempt.attemptId,attempt.generation,outcome);};
 const notices=()=>store.all('SELECT id FROM notifications WHERE task_id=? ORDER BY task_state_version',task.taskId).map(row=>String(row.id));
 // A turn for an input: the mailbox's notification input (execute off) or a user input. Every pending notice is assigned to it.
 const turn=(text:string,options:{notice?:string;execute?:boolean}={})=>{
  const input=store.acceptInput({scope,text,capabilities:{execute:options.execute??false,writeMemory:false},...(options.notice?{ingressKey:`notification:${options.notice}`,storeUserMessage:false}:{})});
  const d=decisions.begin(input.conversationId,'u',[input.inputId]);
  return {context:(actionId=randomUUID())=>({...input,...d,principalId:'u',execute:options.execute??false,writeMemory:false,actionId}),done:()=>decisions.finish(d,'')};
 };
 const code=(fn:()=>unknown)=>{try{fn();return 'ok';}catch(error){return (error as {code?:string}).code;}};
 const bump=()=>{const current=store.task(task.taskId)!;current.computerConnection='connected';store.transaction(()=>store.saveTask(current,current.stateVersion));};
 return {store,tasks,task,finish,notices,turn,code,bump,requestId:()=>requestId,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
// The recorded round: step 1 done, step 2 opened steam.exe, the window never confirmed it.
const steamUnknown:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:2,evaluations:2,phase:'terminal',
 lastAction:{kind:'open',appId:'steam.exe'},
 trace:[{phase:'acting',action:'open',outcome:'unknown',reason:'APPLICATION_LAUNCH_UNCONFIRMED',sequence:9,round:2,at:2,revision:1,steps:2,evaluations:2}] as any,
 stepRun:{total:2,completed:1,stopReason:'OUTCOME_UNKNOWN',stoppedAt:2,stoppedStep:'เลือกมาซักเกมให้ผม',remaining:['เลือกมาซักเกมให้ผม']}};
const parked=(report:ComputerTaskReport=steamUnknown):WorkerOutcome=>({type:'paused',computerReport:report});

describe('verify_computer closes the agent\'s own parked goal run',()=>{
 test('59e5ce4f: the notified agent verifies from fresh evidence; the task completes and the device session ends',()=>{
  const f=fixture();try{
   const waiting=f.finish(parked());
   expect(agentGoalRunParked(waiting)).toBe(true);
   const [notice]=f.notices();expect(notice).toBeDefined();
   const t=f.turn('report',{notice});const check=jest.fn();
   const done=f.tasks.verifyComputer(t.context(),f.task.taskId,1,f.requestId(),'ev-1','Steam library is open; recommended Resident Evil 4.',check);
   expect(check).toHaveBeenCalledTimes(1);
   expect(done).toMatchObject({state:'completed',computerReport:{status:'succeeded',reason:'PARENT_VERIFIED'},automationSession:{status:'closed',closedReason:'agent'},
    computerRevocation:{requestId:f.requestId()},latestProgress:{text:ANSWERED_FROM_SCREEN}});
   expect(done.result?.summary).toContain('Resident Evil 4');
   // The card closes: no open session, so the next request on this PC spawns a fresh task.
   expect(automationSession(done)?.status).toBe('closed');
   expect(f.store.all("SELECT type FROM conversation_events WHERE type='computer.parent_verified'")).toHaveLength(1);
  }finally{f.close();}
 });
 test('a later connection or idle-release save does not revoke the notice: it still describes this round',()=>{
  const f=fixture();try{
   f.finish(parked());const [notice]=f.notices();f.bump();f.bump();
   const t=f.turn('report',{notice});
   expect(f.tasks.verifyComputer(t.context(),f.task.taskId,1,f.requestId(),'ev-1','Steam is open.',()=>{}).state).toBe('completed');
  }finally{f.close();}
 });
 test('the user\'s own executing turn may verify it too',()=>{
  const f=fixture();try{
   f.finish(parked());
   const t=f.turn('เสร็จยัง',{execute:true});
   expect(f.tasks.verifyComputer(t.context(),f.task.taskId,1,f.requestId(),'ev-1','Steam is open.',()=>{}).state).toBe('completed');
  }finally{f.close();}
 });
 test('fresh evidence is still required: a stale or changed evidence check leaves the task waiting',()=>{
  const f=fixture();try{
   f.finish(parked());const [notice]=f.notices();const t=f.turn('report',{notice});
   expect(()=>f.tasks.verifyComputer(t.context(),f.task.taskId,1,f.requestId(),'ev-old','Steam is open.',()=>{throw Error('COMPUTER_EVIDENCE_CHANGED');})).toThrow('COMPUTER_EVIDENCE_CHANGED');
   expect(f.store.task(f.task.taskId)).toMatchObject({state:'waiting_input',computerReport:{reason:'COMMAND_WAITING_INPUT'}});
  }finally{f.close();}
 });
 test('matrix: refused when not parked, from a non-notified turn, or for another round',()=>{
  const f=fixture();try{
   f.finish(parked());
   // The notice was handled by an earlier turn; a later turn without it and without execute is refused.
   const [notice]=f.notices();f.turn('report',{notice}).done();
   const other=f.turn('hello');
   expect(f.code(()=>f.tasks.verifyComputer(other.context(),f.task.taskId,1,f.requestId(),'ev','x',()=>{}))).toBe('EXECUTION_DENIED');other.done();
   const t=f.turn('report',{execute:true});
   expect(f.code(()=>f.tasks.verifyComputer(t.context(),f.task.taskId,1,'task-other','ev','x',()=>{}))).toBe('COMPUTER_VERIFICATION_UNAVAILABLE');
   expect(f.code(()=>f.tasks.verifyComputer(t.context(),f.task.taskId,2,f.requestId(),'ev','x',()=>{}))).toBe('COMPUTER_VERIFICATION_UNAVAILABLE');
  }finally{f.close();}
  // Not parked: the run asked the owner yes or no before a high-impact action.
  const g=fixture();try{
   const asked=g.finish(parked({...steamUnknown,lastAction:{kind:'press',label:'Purchase',confirm:{label:'Purchase'}} as any}));
   expect(agentGoalRunParked(asked)).toBe(false);
   const t=g.turn('ok',{execute:true});
   expect(g.code(()=>g.tasks.verifyComputer(t.context(),g.task.taskId,1,g.requestId(),'ev','x',()=>{}))).toBe('COMPUTER_VERIFICATION_UNAVAILABLE');
  }finally{g.close();}
 });
 test('needs_verification keeps its old path: verified, and the session is not closed by it',()=>{
  const f=fixture();try{
   // An agent-controlled round: not the agent's own parked goal run.
   const current=f.store.task(f.task.taskId)!;current.automationController='agent';f.store.transaction(()=>f.store.saveTask(current,current.stateVersion));
   const waiting=f.finish(parked({status:'needs_verification',reason:'COMPLETION_CANDIDATE',steps:1,evaluations:1,phase:'terminal'} as ComputerTaskReport));
   expect(agentGoalRunParked(waiting)).toBe(false);
   const t=f.turn('report',{execute:true});
   const done=f.tasks.verifyComputer(t.context(),waiting.taskId,1,f.requestId(),'ev','visible',()=>{});
   expect(done.state).toBe('completed');
   expect(done.computerRevocation).toBeUndefined();
  }finally{f.close();}
 });
});

describe('verify_browser closes a parked browser goal run, never an unknown action',()=>{
 const browserParked=(outcome:'confirmed'|'unknown'):WorkerOutcome=>({type:'paused',browserReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,
  lastAction:{operationId:'op',operation:'CLICK',outcome}} as any});
 test('confirmed last action: verified, completed and closed',()=>{
  const f=fixture('browser');try{
   const waiting=f.finish(browserParked('confirmed'));
   expect(agentGoalRunParked(waiting)).toBe(true);
   const [notice]=f.notices();const t=f.turn('report',{notice});
   const done=f.tasks.verifyBrowser(t.context(),f.task.taskId,1,f.requestId(),'ev','The store page is open.',()=>{});
   expect(done).toMatchObject({state:'completed',browserReport:{reason:'PARENT_VERIFIED'},automationSession:{status:'closed'},latestProgress:{text:ANSWERED_FROM_SCREEN}});
   expect(done.computerRevocation).toBeUndefined();
  }finally{f.close();}
 });
 test('an action with an unknown outcome is never confirmed this way',()=>{
  const f=fixture('browser');try{
   f.finish(browserParked('unknown'));
   const t=f.turn('report',{execute:true});
   expect(f.code(()=>f.tasks.verifyBrowser(t.context(),f.task.taskId,1,f.requestId(),'ev','x',()=>{}))).toBe('BROWSER_VERIFICATION_UNAVAILABLE');
  }finally{f.close();}
 });
});

describe('the parked-run note tells the agent how to close the run',()=>{
 test('computer: verify_computer with the fresh evidence IDs, before replying, no device action',()=>{
  const f=fixture();try{
   const note=parkedGoalRunNote(f.finish(parked()));
   expect(note).toContain('First inspect task_status with computer_evidence=fresh.');
   expect(note).toContain('If that fresh evidence shows the goal is done, including a choice, answer or summary the user asked for that you can give from the screen, close the task before you reply: call task_update mode=verify_computer on this task with expected revision 1 and the expected_request_id and evidence_id from that fresh evidence');
   expect(note).toContain('That completes the task and ends the device session; it sends no device action. Then answer the user from that evidence.');
   // The unconfirmed step is still never claimed or replayed.
   expect(note).toContain('NOT confirmed');
  }finally{f.close();}
 });
 test('browser: verify_browser with browser_evidence=fresh',()=>{
  const f=fixture('browser');try{
   const note=parkedGoalRunNote(f.finish({type:'paused',browserReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1} as any}));
   expect(note).toContain('browser_evidence=fresh');expect(note).toContain('task_update mode=verify_browser');
  }finally{f.close();}
 });
});

describe('step-run card copy',()=>{
 test('59e5ce4f, handed off: plain words, the possibly-run step is not "Not run", codes on the Details line',()=>{
  const text=computerOutcomeText(steamUnknown,{handedOff:true});
  expect(text).toBe("1/2 steps done. Step 2 couldn't be confirmed: steam.exe may have opened, but this computer didn't confirm it. The assistant is checking the screen.\nDetails: OUTCOME_UNKNOWN");
  expect(text).not.toContain('Not run');
 });
 test('not handed off: the owner is told to check the screen; later steps are "Not started"',()=>{
  const report={...steamUnknown,lastAction:{kind:'press',label:'OK'},stepRun:{total:3,completed:1,stopReason:'OUTCOME_UNKNOWN',stoppedAt:2,stoppedStep:'press OK',remaining:['press OK','scroll down'],detail:'APPLICATION_LAUNCH_UNCONFIRMED'}} as ComputerTaskReport;
  expect(computerOutcomeText(report)).toBe("1/3 steps done. Step 2 couldn't be confirmed: its last action may have run, but this computer didn't confirm it. Check the screen before sending it again. Not started: \"scroll down\".\nDetails: OUTCOME_UNKNOWN · APPLICATION_LAUNCH_UNCONFIRMED");
 });
 test('a step that needs a decision is handed to the assistant',()=>{
  const report={...steamUnknown,stepRun:{total:2,completed:1,stopReason:'STEP_NOT_EXECUTED',detail:'NO_SUPPORTED_ACTION',stoppedAt:2,stoppedStep:'เลือกมาซักเกมให้ผม',remaining:['เลือกมาซักเกมให้ผม'],doneParts:[]}} as ComputerTaskReport;
  expect(computerOutcomeText(report,{handedOff:true})).toBe('1/2 steps done. Step 2 needs a decision — handing it to the assistant…\nDetails: STEP_NOT_EXECUTED · NO_SUPPORTED_ACTION');
  // Without a hand-off the hint stays in plain words.
  expect(computerOutcomeText(report)).toMatch(/^1\/2 steps done\. Stopped at step 2 "เลือกมาซักเกมให้ผม": no visible control matches this command\./);
 });
 test('the parked round\'s card line says the assistant is checking',()=>{
  const f=fixture();try{
   expect(f.finish(parked()).latestProgress?.text).toContain('The assistant is checking the screen.');
  }finally{f.close();}
 });
});

describe('task_spawn run_as_goal',()=>{
 test('is recorded for the spawn revision of a browser or computer task, and refused elsewhere',()=>{
  const root=mkdtempSync(join(tmpdir(),'run-as-goal-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
  try{
   const accepted=store.acceptInput({scope,text:'เปิด Steam แล้วเลือกเกมให้ผม',capabilities:{execute:true,writeMemory:false}});
   const decisions=new DecisionService(store),decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
   const context=(actionId:string)=>({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId});
   const task=tasks.spawn(context('a1'),{title:'Steam',instructions:'open Steam',runAsGoal:true,targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'pc',name:'PC'}});
   expect(task.runAsGoal).toEqual({revision:1});
   expect(()=>tasks.spawn(context('a2'),{title:'w',instructions:'x',runAsGoal:true,targetProfile:'default-worker'})).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));
   expect(()=>tasks.spawn(context('a3'),{title:'w',instructions:'x',runAsGoal:'yes' as any,targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'pc2',name:'PC'}})).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
 });
});
