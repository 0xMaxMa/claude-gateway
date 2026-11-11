import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
import {agentGoalRunParked,parkedGoalRunNote,parkedRoundCapped,PARKED_WAKE_LIMIT} from '../../../src/orchestration/tasks/automation-session';
import {observedEffect,openSatisfied} from '../../../src/automation/computer-policy';
import {computerOutcomeText,computerRoundDone} from '../../../src/automation/computer-outcome';
import {parseComputerSteps} from '../../../src/automation/computer-steps';
import type {ComputerState} from '../../../src/automation/computer-use';
import type {ComputerTaskReport,WorkerOutcome} from '../../../src/orchestration/types';
import recorded from '../../fixtures/computer/notion-219625e5.json';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({runComputerUse:jest.fn()}));
jest.mock('../../../src/automation/computer-steps',()=>({...jest.requireActual('../../../src/automation/computer-steps'),runComputerSteps:jest.fn()}));
const {runComputerUse}=require('../../../src/automation/computer-use');
const {runComputerSteps}=require('../../../src/automation/computer-steps');

// Pod-jinawong r15 (6c8a2185), task 219625e5, live voice: "เปิด Notion แล้วเขียนบทความอะไรก็ได้ให้หน่อย".
// - rev 1, the agent's goal with the article it wrote: step mode split the user's words instead, into "เปิด Notion"
//   and "เขียนบทความอะไรก็ได้ให้หน่อย". Notion was already in front, so the open changed nothing: STEP_NO_EFFECT.
// - The parked wake told the agent to send "only the next step" "without fields or inputs": it sent
//   "press \"New page\" in the Notion sidebar" (rev 2), which reached that goal after 6 actions and completed the
//   whole task, ending the device session. The article was never typed; four blank pages were left behind.
const user=recorded.user.text,goal=recorded.rev1.instructions;
const article=goal.slice(goal.indexOf('Title:'));
const body=article.split('\n').filter(line=>line.trim()&&!line.startsWith('Title:')&&line!=='Body:');

test('the recorded run: two steps from the user\'s words, STEP_NO_EFFECT, then the partial command completed the task',()=>{
 expect(recorded.user.modality).toBe('live_voice');
 expect(parseComputerSteps(user)).toEqual([recorded.rev1.report.stepRun.stoppedStep,...recorded.rev1.report.stepRun.remaining]);
 // None of the steps carries the article.
 for(const step of parseComputerSteps(user)!)expect(body.some(line=>step.includes(line))).toBe(false);
 expect(recorded.rev1.report).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,stepRun:{completed:0,stopReason:'STEP_NO_EFFECT',stoppedAt:1}});
 expect(recorded.rev1.report.trace.find(e=>e.phase==='observed'&&e.action==='open')).toMatchObject({changed:false,reason:'STEP_NO_EFFECT'});
 expect(recorded.rev2).toMatchObject({instructions:'press "New page" in the Notion sidebar',outcomeType:'completed',report:{status:'succeeded',reason:'GOAL_REACHED',steps:6,accessReleased:true}});
 expect(recorded.rev2.finalNewPage).toEqual({AXButton:4,AXRow:4});
 expect(body.length).toBeGreaterThanOrEqual(5);
});

describe('the adapter',()=>{
 function adapter(){
  const root=mkdtempSync(join(tmpdir(),'notion-219625e5-'));runComputerUse.mockReset();runComputerSteps.mockReset();
  const callTool=jest.fn(async({name}:{name:string})=>({content:[{type:'text',text:name==='computer_end_session'?'{"state":"stopped"}':'{"state":"approved"}'}]}));
  jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
  const connectors={get:()=>({connectorId:'c',scope:{device_id:'d',grant_id:'g'}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
  const a=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true,stepMode:()=>true,userSteps:()=>user});
  const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
  const run=async(t:any,request:string,text:string)=>{await a.submit(t,request,text);for(let i=0;i<50;i++){const outcome=await a.inspect(t,request);if(typeof outcome==='object')return outcome as any;await new Promise(r=>setImmediate(r));}throw Error('not settled');};
  const ended=()=>callTool.mock.calls.filter(([c]:any)=>c.name==='computer_end_session');
  return {task,run,ended,close:async()=>{await a.close();rmSync(root,{recursive:true,force:true});}};
 }

 test('A: rev 1 runs the agent\'s goal, article included, as one goal; the user\'s words are not split',async()=>{
  const f=adapter();try{
   runComputerUse.mockImplementationOnce(async()=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1}));
   await f.run(f.task,'r1',goal);
   expect(runComputerSteps).not.toHaveBeenCalled();
   const input=runComputerUse.mock.calls[0][0];
   expect(input).toMatchObject({goal,sessionStart:true,runToGoal:true});
   // Text a run may type comes verbatim from its goal (or prepared inputs): every line of the article is there.
   for(const line of body)expect(input.goal.includes(line)).toBe(true);
  }finally{await f.close();}
 });

 test('D: the agent\'s "press New page" that reached its goal parks for the agent and keeps the session',async()=>{
  const f=adapter();try{
   const r2=recorded.rev2.report;
   runComputerUse.mockImplementationOnce(async()=>({status:r2.status,reason:r2.reason,steps:r2.steps,evaluations:r2.evaluations,lastAction:r2.lastAction}));
   const outcome=await f.run({...f.task,revision:2,executionControl:{revision:2,agentHandoff:true}},'r2',recorded.rev2.instructions);
   expect(runComputerUse.mock.calls[0][0]).toMatchObject({agentCommand:true,runToGoal:true,goal:recorded.rev2.instructions});
   expect(outcome.type).toBe('paused');expect(outcome.result).toBeUndefined();
   expect(outcome.computerReport).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:6,evaluations:12});
   expect(outcome.computerReport.accessReleased).toBeUndefined();expect(f.ended()).toHaveLength(0);
   expect(outcome.computerReport.trace.at(-1)).toMatchObject({phase:'waiting',reason:'GOAL_REACHED'});
   expect(computerOutcomeText(outcome.computerReport)).toBe('Done after 6 actions. Last: clicked "New page". The assistant checks what is left of the task.');
   expect(computerRoundDone(outcome.computerReport)).toBe(false);
   // The user's own command still completes the task on its goal and ends the device session.
   runComputerUse.mockImplementationOnce(async()=>({status:'succeeded',reason:'GOAL_REACHED',steps:1,evaluations:1}));
   expect((await f.run({...f.task,revision:3,executionControl:{revision:3}},'r3','open Notes')).type).toBe('completed');
   expect(f.ended()).toHaveLength(1);
  }finally{await f.close();}
 });
});

test('B: the recorded open of Notion, already in front, satisfies its step',()=>{
 const before=recorded.rev1.before as unknown as ComputerState,after=recorded.rev1.after as unknown as ComputerState;
 const open={kind:'open',app_id:'notion.id'};
 expect(observedEffect(before,after,open)).toBe(false);
 expect(openSatisfied(after,open)).toBe(true);
});

describe('C and D: the agent continues with the rest of the goal and its text, and only it closes the task',()=>{
 const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'};
 function fixture(){
  const root=mkdtempSync(join(tmpdir(),'notion-219625e5-db-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
  const accepted=store.acceptInput({scope,text:user,capabilities:{execute:true,writeMemory:false}});
  const decisions=new DecisionService(store),decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
  const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'Open Notion and write an article',instructions:goal,targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Computer Use · Mac'}});
  decisions.finish(decision,'Opening Notion.');
  const finish=(outcome:WorkerOutcome)=>{const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
   const current=store.task(task.taskId)!;current.gatewayDispatch={requestId:'task-'+attempt.attemptId,submittedAt:Date.now()};store.transaction(()=>store.saveTask(current,current.stateVersion));
   return tasks.finish(attempt.attemptId,attempt.generation,outcome);};
  const notices=()=>store.all('SELECT id FROM notifications WHERE task_id=? ORDER BY task_state_version',task.taskId).map(row=>String(row.id));
  const turn=(notice:string)=>{
   const input=store.acceptInput({scope,text:'report',capabilities:{execute:false,writeMemory:false},ingressKey:`notification:${notice}`,storeUserMessage:false});
   const d=decisions.begin(input.conversationId,'u',[input.inputId]);
   return {context:(actionId=randomUUID())=>({...input,...d,principalId:'u',execute:false,writeMemory:false,actionId}),done:()=>decisions.finish(d,'')};
  };
  const code=(fn:()=>unknown)=>{try{fn();return 'ok';}catch(error){return (error as {code?:string}).code;}};
  return {store,tasks,task,finish,notices,turn,code,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
 }
 // What the adapter now reports for an agent command that reached its own goal (see D above).
 const commandReached:ComputerTaskReport={...(recorded.rev2.report as unknown as ComputerTaskReport),status:'needs_input',reason:'COMMAND_WAITING_INPUT',accessReleased:undefined,
  trace:[{phase:'acted',action:'press',outcome:'completed',sequence:1,round:1,at:1,revision:2,steps:6,evaluations:12},{phase:'waiting',reason:'GOAL_REACHED',sequence:2,round:1,at:2,revision:2,steps:6,evaluations:12}]};
 const inputs=[{application:'notion.id',label:'Page body',text:body.join('\n')}];
 const rest='create a new page in Notion, type the title, then type the article body';

 test('the parked wake asks for the whole rest of the goal with its text, and the command carries the article',()=>{
  const f=fixture();try{
   const waiting=f.finish({type:'paused',computerReport:recorded.rev1.report as unknown as ComputerTaskReport});
   expect(waiting).toMatchObject({state:'waiting_input',revision:1});expect(agentGoalRunParked(waiting)).toBe(true);
   const note=parkedGoalRunNote(waiting);
   expect(note).toContain('one plain command for the whole rest of the goal, with any text it must type in computer_inputs');
   expect(note).toContain('every remaining step and the exact text to type, as that one command, never a single click');
   expect(note).not.toContain('only the next step');expect(note).not.toContain('without fields or inputs');
   expect(note).toContain('stopped at step 1 "เปิด Notion" (STEP_NO_EFFECT)');
   const [notice]=f.notices(),t=f.turn(notice);
   const sent=f.tasks.update(t.context(),f.task.taskId,1,rest,'when_ready',undefined,inputs);
   expect(sent).toMatchObject({revision:2,state:'queued',agentCommands:1,executionControl:{agentHandoff:true,revision:2}});
   expect(f.tasks.revision(f.task.taskId,2)).toMatchObject({instructions:rest,computerInputs:inputs,directCommand:true});
  }finally{f.close();}
 });

 test('a reached agent command parks and wakes the agent; it closes the task with verify_computer',()=>{
  const f=fixture();try{
   f.finish({type:'paused',computerReport:recorded.rev1.report as unknown as ComputerTaskReport});
   const [first]=f.notices(),t1=f.turn(first);
   f.tasks.update(t1.context(),f.task.taskId,1,rest,'when_ready',undefined,inputs);t1.done();
   const parked=f.finish({type:'paused',computerReport:commandReached});
   // r15 completed the task here. Now it waits, and the agent is woken to check the whole task.
   expect(parked).toMatchObject({state:'waiting_input',revision:2,agentCommands:1});
   expect(agentGoalRunParked(parked)).toBe(true);
   const note=parkedGoalRunNote(parked);
   expect(note).toContain('Your previous command for this task reached its own goal (judged from the screen, not verified), which does not complete the task "Open Notion and write an article"');
   const second=f.notices().at(-1)!;expect(second).not.toBe(first);
   // Fresh evidence shows the article in place: the agent closes the task itself.
   const t2=f.turn(second);
   const closed=f.tasks.verifyComputer(t2.context(),f.task.taskId,2,parked.gatewayDispatch!.requestId,'evidence-1','The page shows the title and all five points.',()=>{});
   expect(closed).toMatchObject({state:'completed',computerReport:{status:'succeeded',reason:'PARENT_VERIFIED'}});
  }finally{f.close();}
 });

 test('the wakes stop at PARKED_WAKE_LIMIT: past it the agent sends no more commands',()=>{
  const f=fixture();try{
   f.finish({type:'paused',computerReport:recorded.rev1.report as unknown as ComputerTaskReport});
   let revision=1;
   for(let sent=1;sent<=PARKED_WAKE_LIMIT;sent++){
    const t=f.turn(f.notices().at(-1)!);
    expect(f.code(()=>f.tasks.update(t.context(),f.task.taskId,revision,rest,'when_ready',undefined,inputs))).toBe('ok');t.done();
    revision++;
    const parked=f.finish({type:'paused',computerReport:{...commandReached,trace:commandReached.trace!.map(e=>({...e,revision}))}});
    expect(parked).toMatchObject({state:'waiting_input',revision,agentCommands:sent});
    expect(agentGoalRunParked(parked)).toBe(sent<PARKED_WAKE_LIMIT);expect(parkedRoundCapped(parked)).toBe(sent===PARKED_WAKE_LIMIT);
   }
   // Capped: no parked notice is issued for a further command (the runtime wakes the agent once, report-only, to tell
   // the user what is left), and the task waits for the user.
   expect(f.notices()).toHaveLength(PARKED_WAKE_LIMIT);
   expect(f.store.task(f.task.taskId)).toMatchObject({state:'waiting_input',revision:PARKED_WAKE_LIMIT+1});
  }finally{f.close();}
 });
});
