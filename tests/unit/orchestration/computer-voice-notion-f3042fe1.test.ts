import {randomUUID} from 'node:crypto';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {liveControlReceipt,liveExecutionInput} from '../../../src/orchestration/live-execution-input';
import {pendingReports} from '../../../src/orchestration/notification-mailbox';
import {agentGoalRun,agentRoundEnded,awaitingDeviceAccess} from '../../../src/orchestration/tasks/automation-session';
import {literalTextAllowed} from '../../../src/automation/vision-decider';
import {AgentRunner} from '../../../src/agent/runner';
import type {ComputerTaskReport,WorkerOutcome} from '../../../src/orchestration/types';
import recorded from '../../fixtures/computer/notion-f3042fe1.json';

// Pod-jinawong r14 (2.1.12 + #667 + #671), task f3042fe1 "write a story into Notion", with live voice on:
// - rev 1 carried the title and an 812-character story as computerInputs. Words heard 7 s in, while the round still
//   waited for device access, paused it (rev 2) before it acted: COMPUTER_EXECUTION_INTERRUPTED.
// - "ไม่เอา ไม่" then ran as a direct command (rev 3, NO_SUPPORTED_ACTION) and dropped the inputs; the agent asked the
//   user, and the reply "เอา ฝากนะ ทำไงอะ" ran as another literal command (rev 4, UNCLEAR).
// - The agent's handoff command (rev 5) resent the goal without the story (handoffs could carry no inputs); the vision
//   fallback typed the title and refused the story three times (VISION_TEXT_NOT_IN_GOAL).
// - Its failure notification (270629b6) stayed pending: only revision 1 counted as the agent's own run.
const goal=recorded.goal,inputs=recorded.computerInputs,story=inputs[1].text;

function fixture(){
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),decisions=new DecisionService(store);
 const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'};
 const opening=store.acceptInput({scope,text:'write a short story into Notion',capabilities:{execute:true,writeMemory:false}});
 const spawned=decisions.begin(opening.conversationId,'u',[opening.inputId]);
 const taskId=tasks.spawn({...opening,...spawned,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},
  {title:'Story in Notion',instructions:goal,targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Computer Use · Mac'},computerInputs:inputs}).taskId;
 decisions.finish(spawned,'Writing it in Notion.');
 const conversationId=opening.conversationId,task=()=>store.task(taskId)!;
 const save=(change:(t:ReturnType<typeof task>)=>void)=>{const t=task();change(t);store.transaction(()=>store.saveTask(t,t.stateVersion));};
 // The runner's own voice methods, on this store (AgentRunner.getOrchestration is the only thing they use).
 const runtime={store,tasks,taskControls:{detail:(_s:string,_p:string,id:string)=>({taskId:id})},controlTask:(_s:string,p:string,id:string,c:any)=>tasks.controlByUser(conversationId,p,id,c)};
 const self={getOrchestration:async()=>runtime};
 const pause=(stop=false)=>(AgentRunner.prototype.pauseVoiceExecution as any).call(self,'s','u',taskId,stop) as Promise<string|undefined>;
 // Whether words heard now are classified first (the voice router asks taskSpeechKind, the model, only then).
 const acting=(pauseId?:string)=>(AgentRunner.prototype.voiceTaskActing as any).call(self,'s','u',taskId,pauseId) as Promise<boolean>;
 const voice=(text:string,voiceStop=false)=>liveExecutionInput(store,tasks,{scope,text,modality:'live_voice',metadata:{executionTaskId:taskId,...(voiceStop?{voiceStop:true}:{})}},{execute:true,writeMemory:false})!;
 const run=()=>{const attempt=tasks.claim(taskId)!;tasks.started(attempt.attemptId,attempt.generation);return attempt;};
 const finish=(attempt:{attemptId:string;generation:number},outcome:WorkerOutcome)=>tasks.finish(attempt.attemptId,attempt.generation,outcome);
 // The agent's turn for an input: its tool calls run inside that decision.
 const turn=<T>(inputId:string,act:(context:any)=>T,followUp?:'asks_user')=>{
  const decision=decisions.begin(conversationId,'u',[inputId]);
  try{return act({conversationId,inputId,...decision,principalId:'u',execute:true,writeMemory:false,actionId:randomUUID()});}
  finally{decisions.finish(decision,'Reply','completed',undefined,true,followUp);}
 };
 return {store,tasks,taskId,task,save,pause,acting,voice,run,finish,turn,close:()=>store.close()};
}
const revisionOf=(f:ReturnType<typeof fixture>,revision=f.task().revision)=>f.tasks.revision(f.taskId,revision);

test('the recorded run: rev 1 waited for access, rev 3/4 were the two transcripts, rev 5 failed on the story',()=>{
 expect(recorded.rev1).toMatchObject({accessWait:{phase:'awaiting_access',reason:'OWNER_APPROVAL_REQUIRED'},computerConnection:'waiting_access',outcome:{failure:{code:'COMPUTER_EXECUTION_INTERRUPTED'}}});
 expect(recorded.voice.map(v=>v.atMs)).toEqual([7000,26291,54281]);
 expect(recorded.rev3.outcome.computerReport.trace.find(e=>e.phase==='waiting')?.reason).toBe('NO_SUPPORTED_ACTION');
 expect(recorded.rev4.outcome.computerReport.trace.find(e=>e.phase==='waiting')?.reason).toBe('UNCLEAR');
 expect(recorded.rev5.outcome.computerReport).toMatchObject({status:'blocked',reason:'VISION_TEXT_NOT_IN_GOAL',steps:7,evaluations:15});
 expect(recorded.rev5.outcome.computerReport.trace.filter(e=>e.reason==='VISION_TEXT_NOT_IN_GOAL'&&e.phase==='decided')).toHaveLength(3);
 expect(story).toHaveLength(812);
});

test('rev 1: words during the access wait do not pause it; once it acts they do; a stop pauses it even while it waits',async()=>{
 const f=fixture();try{
  f.run();f.save(t=>{t.computerReport=recorded.rev1.accessWait as ComputerTaskReport;t.computerConnection='waiting_access';});
  expect(awaitingDeviceAccess(f.task())).toBe(true);
  expect(await f.pause()).toBeUndefined();
  expect(f.task()).toMatchObject({state:'running',revision:1});expect(f.task().executionControl).toBeUndefined();
  // Before the first report a device that has not granted access waits too.
  f.save(t=>{delete t.computerReport;});
  expect(await f.pause()).toBeUndefined();
  // Words heard while it waits are classified before they reach it (a no is a stop, filler is noise).
  expect(await f.acting()).toBe(true);
  // An explicit stop pauses even here.
  const stopped=await f.pause(true);
  expect(stopped).toEqual(expect.any(String));
  expect(f.task()).toMatchObject({state:'interrupting',executionControl:{id:stopped,action:'pause'}});
 }finally{f.close();}
 const g=fixture();try{
  // Access granted, the round acts: the provisional pause on first words applies as before.
  g.run();g.save(t=>{t.computerReport={status:'running',reason:'acting',steps:1,evaluations:2,phase:'acting'} as ComputerTaskReport;t.computerConnection='connected';});
  expect(awaitingDeviceAccess(g.task())).toBe(false);
  expect(await g.pause()).toEqual(expect.any(String));
 }finally{g.close();}
});

test('the replay end to end: no noise revise, the reply goes to the agent, the story survives, the failure wakes the agent',async()=>{
 const f=fixture();try{
  // rev 1 acts; words pause it (provisional), and the final transcript is "ไม่เอา ไม่".
  const first=f.run();f.save(t=>{t.computerReport={status:'running',reason:'acting',steps:1,evaluations:2,phase:'acting'} as ComputerTaskReport;t.computerConnection='connected';});
  const pauseId=(await f.pause())!;
  // r14 ran the final words as revision 3 of the task. Now they are classified first; the model declares a short no a
  // stop (the voice router sends it with voiceStop): the task stays paused and the agent gets the words.
  expect(await f.acting(pauseId)).toBe(true);
  const stop=f.voice('ไม่เอา ไม่',true);
  expect(stop).toMatchObject({status:'needs_agent',code:'VOICE_STOP',taskId:f.taskId,revision:2});
  expect(f.task().revision).toBe(2);
  expect(revisionOf(f).instructions).toBe(goal);
  f.finish(first,recorded.rev1.outcome as unknown as WorkerOutcome);
  expect(f.task()).toMatchObject({state:'waiting_input',executionControl:{id:pauseId,action:'pause',phase:'paused'}});
  // Words of this speech are still classified against the round it paused; anything later is not.
  expect(await f.acting(pauseId)).toBe(true);expect(await f.acting()).toBe(false);
  // The agent reads the stop and asks the user whether to go on.
  f.turn(stop.inputId,()=>undefined,'asks_user');
  // rev 4: nothing acts, so the reply is not classified; it answers the agent, not the task: no literal command ran.
  expect(await f.acting()).toBe(false);
  const reply=f.voice('เอา ฝากนะ ทำไงอะ');
  expect(reply).toMatchObject({status:'needs_agent',code:'AGENT_QUESTION',taskId:f.taskId,revision:2});
  expect(f.task().revision).toBe(2);
  expect(liveControlReceipt(f.store,reply.inputId)?.code).toBe('AGENT_QUESTION');
  // rev 5: the agent's one command resends the goal; the story prepared for that goal is reattached.
  const sent=f.turn(reply.inputId,context=>{
   const task=f.tasks.update(context,f.taskId,2,goal,'when_ready');
   let second:unknown;try{f.tasks.update({...context,actionId:randomUUID()},f.taskId,task.revision,'scroll down','when_ready');}catch(error){second=(error as {code?:string}).code;}
   return {task,second};
  });
  expect(sent.second).toBe('AGENT_HANDOFF_USED');
  expect(sent.task).toMatchObject({revision:3,state:'queued',automationController:'user',executionControl:{action:'revise',agentHandoff:true}});
  expect(revisionOf(f,3)).toMatchObject({instructions:goal,agentHandoffInputId:reply.inputId,computerInputs:inputs});
  // The vision fallback may now type the prepared story; r14 checked the goal text alone.
  expect(literalTextAllowed(story,{goal,preparedInputs:revisionOf(f,3).computerInputs},'notion.id')).toBe(true);
  expect(literalTextAllowed(story,{goal},'notion.id')).toBe(false);
  expect(literalTextAllowed(inputs[0].text,{goal},'notion.id')).toBe(true);
  // The agent's command fails (rev 5's recorded outcome): its notification wakes the agent to report it.
  const fifth=f.run();
  f.finish(fifth,recorded.rev5.outcome as unknown as WorkerOutcome);
  const ended=f.task();
  expect(ended).toMatchObject({state:'failed',revision:3,automationController:'user'});
  expect(agentGoalRun(ended)).toBe(false);expect(agentRoundEnded(ended)).toBe(true);
  const notice=f.store.get('SELECT id FROM notifications WHERE task_id=? AND task_state_version=?',f.taskId,ended.stateVersion);
  expect(notice).toBeDefined();
  expect(pendingReports(f.store,[],[],true).map(r=>r.notification_id)).toContain(notice!.id);
 }finally{f.close();}
});

test('the user\'s own failed command still waits for the user, and a reply to the task\'s own question still goes to the task',async()=>{
 const f=fixture();try{
  const first=f.run();
  f.finish(first,{type:'paused',computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal'}});
  // The user's own command (not the agent's) fails: no unprompted wake, as before.
  const own=f.voice('open Notion and type the title');
  expect(own).toMatchObject({status:'applied'});
  f.finish(f.run(),{type:'failed',failure:{code:'COMPUTER_VISION_TEXT_NOT_IN_GOAL',message:'x',observedAt:1},computerReport:{status:'blocked',reason:'VISION_TEXT_NOT_IN_GOAL',steps:1,evaluations:1,phase:'terminal'}});
  expect(agentRoundEnded(f.task())).toBe(false);
  expect(pendingReports(f.store,[],[],true)).toHaveLength(0);
  // A new command for the same goal text reattaches its inputs; another command does not get them.
  expect(f.voice(goal)).toMatchObject({status:'applied'});
  expect(revisionOf(f).computerInputs).toEqual(inputs);
  f.finish(f.run(),{type:'paused',computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal',lastAction:{kind:'press',label:'Buy',confirm:true}} as ComputerTaskReport});
  // The agent relayed the task's confirmation question, but the yes must reach the task itself.
  f.store.transaction(()=>f.store.appendEvent(f.task().conversationId,'response.completed',{responseId:randomUUID(),followUp:'asks_user'}));
  expect(f.voice('yes go ahead')).toMatchObject({status:'applied'});
  expect(revisionOf(f).computerInputs).toBeUndefined();
 }finally{f.close();}
});
