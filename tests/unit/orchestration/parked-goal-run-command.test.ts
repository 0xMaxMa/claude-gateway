import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {parkedGoalRunNote} from '../../../src/orchestration/tasks/automation-session';
import type {ComputerTaskReport,WorkerOutcome} from '../../../src/orchestration/types';

// Pod-jinawong, task c449e48d: the agent's goal run "open Terminal, type `which htop`,
// press Enter" typed into Terminal, the Mac could not read the text back
// (TEXT_VALUE_UNCONFIRMED), the step run stopped before Enter and parked. The agent
// was notified (agentGoalRunParked), but its task_update was refused with
// USER_CONTROLS_AUTOMATION, so nothing could press Enter.
const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'parked-goal-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope,text:'เปิด Terminal แล้วพิมพ์ `which htop` แล้วกด Enter',capabilities:{execute:true,writeMemory:false}});
 const decisions=new DecisionService(store),decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
 const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'htop',instructions:'1. open Terminal\n2. type `which htop`\n3. press Enter',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 decisions.finish(decision,'Opening Terminal.');
 const finish=(outcome:WorkerOutcome)=>{const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);
  const current=store.task(task.taskId)!;current.gatewayDispatch={requestId:'task-'+attempt.attemptId,submittedAt:Date.now()};store.transaction(()=>store.saveTask(current,current.stateVersion));
  return tasks.finish(attempt.attemptId,attempt.generation,outcome);};
 const notices=()=>store.all('SELECT id FROM notifications WHERE task_id=? ORDER BY task_state_version',task.taskId).map(row=>String(row.id));
 // A turn for an input: the mailbox's notification input (execute off) or a user input.
 const turn=(text:string,options:{notice?:string;execute?:boolean}={})=>{
  const input=store.acceptInput({scope,text,capabilities:{execute:options.execute??false,writeMemory:false},...(options.notice?{ingressKey:`notification:${options.notice}`,storeUserMessage:false}:{})});
  const d=decisions.begin(input.conversationId,'u',[input.inputId]);
  return {context:(actionId=randomUUID())=>({...input,...d,principalId:'u',execute:options.execute??false,writeMemory:false,actionId}),done:()=>decisions.finish(d,'')};
 };
 const code=(fn:()=>unknown)=>{try{fn();return 'ok';}catch(error){return (error as {code?:string}).code;}};
 return {store,tasks,task,finish,notices,turn,code,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
const unconfirmedTyping:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal',
 trace:[{phase:'acting',action:'type',ref:'c0',outcome:'unknown',reason:'TEXT_VALUE_UNCONFIRMED',sequence:7,round:2,at:2,revision:1,steps:1,evaluations:1}],
 stepRun:{total:3,completed:1,stopReason:'OUTCOME_UNKNOWN',stoppedAt:2,stoppedStep:'type `which htop`',remaining:['type `which htop`','press Enter']}};
const parked=(report:ComputerTaskReport=unconfirmedTyping):WorkerOutcome=>({type:'paused',computerReport:report});

test('c449e48d: the notified agent sends key enter once, as the next direct command, after an unconfirmed type',()=>{
 const f=fixture();try{
  const waiting=f.finish(parked());
  expect(waiting).toMatchObject({state:'waiting_input',automationController:'user',revision:1});
  const [notice]=f.notices();expect(notice).toBeDefined();
  // The note says the typing was not confirmed, forbids claiming or replaying it, and lists what remains.
  const note=parkedGoalRunNote(waiting);
  expect(note).toContain('NOT confirmed');expect(note).toMatch(/never type that text again/);
  expect(note).toContain('computer_evidence=fresh');
  expect(note).toContain('stopped at step 2 "type `which htop`" (OUTCOME_UNKNOWN)');
  expect(note).toContain('"press Enter"');
  const t=f.turn('report',{notice});
  const sent=f.tasks.update(t.context(),f.task.taskId,1,'key enter','when_ready');
  expect(sent).toMatchObject({revision:2,state:'queued',automationController:'user',executionControl:{action:'revise',agentHandoff:true,revision:2}});
  expect(f.tasks.revision(f.task.taskId,2)).toMatchObject({instructions:'key enter',directCommand:true,agentHandoffInputId:t.context().inputId});
  // Never twice for the same notification.
  expect(f.code(()=>f.tasks.update(t.context(),f.task.taskId,2,'key enter','when_ready'))).toBe('AGENT_HANDOFF_USED');
  expect(f.store.task(f.task.taskId)!.revision).toBe(2);
 }finally{f.close();}
});

test('any other input, including the user\'s own executing turn, is still refused with USER_CONTROLS_AUTOMATION',()=>{
 const f=fixture();try{
  f.finish(parked());
  // Each turn ends before the next input starts one.
  const refused=(t:ReturnType<typeof f.turn>)=>{try{return f.code(()=>f.tasks.update(t.context(),f.task.taskId,1,'key enter','when_ready'));}finally{t.done();}};
  expect(refused(f.turn('hello'))).toBe('USER_CONTROLS_AUTOMATION');
  expect(refused(f.turn('press enter',{execute:true}))).toBe('USER_CONTROLS_AUTOMATION');
  // A notification input for another task authorizes nothing here.
  expect(refused(f.turn('report',{notice:randomUUID()}))).toBe('USER_CONTROLS_AUTOMATION');
  expect(f.store.task(f.task.taskId)!.revision).toBe(1);
 }finally{f.close();}
});

test('a notice for an older state_version is refused: the run changed since',()=>{
 const f=fixture();try{
  f.finish(parked());
  const [notice]=f.notices(),t=f.turn('report',{notice});
  const current=f.store.task(f.task.taskId)!;f.store.transaction(()=>f.store.saveTask(current,current.stateVersion));
  expect(f.code(()=>f.tasks.update(t.context(),f.task.taskId,1,'key enter','when_ready'))).toBe('STATE_CONFLICT');
  expect(f.store.task(f.task.taskId)!.revision).toBe(1);
 }finally{f.close();}
});

test('the one command gains no extra authority: plain when_ready on the current revision only',()=>{
 const f=fixture();try{
  f.finish(parked());
  const [notice]=f.notices(),t=f.turn('report',{notice});
  expect(f.code(()=>f.tasks.update(t.context(),f.task.taskId,1,'key enter','interrupt_and_resume'))).toBe('INVALID_INPUT');
  expect(f.code(()=>f.tasks.update(t.context(),f.task.taskId,1,'type it','when_ready',undefined,[{application:'Terminal',label:'shell',text:'which htop'}]))).toBe('INVALID_INPUT');
  expect(f.code(()=>f.tasks.update(t.context(),f.task.taskId,0,'key enter','when_ready'))).toBe('REVISION_CONFLICT');
  expect(f.store.task(f.task.taskId)!.revision).toBe(1);
 }finally{f.close();}
});

test('a user pause after the notice wins: the notice no longer authorizes a command',()=>{
 const f=fixture();try{
  f.finish(parked());
  const [notice]=f.notices(),t=f.turn('report',{notice});
  f.tasks.controlByUser(f.store.task(f.task.taskId)!.conversationId,'u',f.task.taskId,{id:randomUUID(),action:'pause',expectedRevision:1});
  expect(f.code(()=>f.tasks.update(t.context(),f.task.taskId,2,'key enter','when_ready'))).toBe('STATE_CONFLICT');
  expect(f.store.task(f.task.taskId)!.executionControl).toMatchObject({action:'pause',phase:'paused'});
 }finally{f.close();}
});

test.each([
 ['a missing field value',{...unconfirmedTyping,trace:[],fieldRequest:{label:'shell',reason:'missing' as const}}],
 ['a confirmation question',{...unconfirmedTyping,trace:[{phase:'waiting' as const,reason:'CONFIRMATION_REQUIRED',sequence:1,round:1,at:1,revision:1,steps:1,evaluations:1}]}],
])('%s: no notice and no command',(_name,report)=>{
 const f=fixture();try{
  f.finish(parked(report as ComputerTaskReport));
  expect(f.notices()).toEqual([]);
  expect(f.code(()=>f.tasks.update(f.turn('hello').context(),f.task.taskId,1,'key enter','when_ready'))).toBe('USER_CONTROLS_AUTOMATION');
 }finally{f.close();}
});

test('a confirmed stop names no unconfirmed action',()=>{
 const note=parkedGoalRunNote({taskId:'t',revision:1,gatewayTarget:{adapter:'computer',sessionId:'m',name:'M'},
  computerReport:{...unconfirmedTyping,trace:[],stepRun:{total:2,completed:2,stopReason:'ALL_STEPS_DONE',remaining:[]}}} as never);
 expect(note).not.toContain('NOT confirmed');expect(note).toContain('Step run: 2 of 2 steps done.');
});

// The report pump builds the notification turn: the parked note reaches the agent,
// and its task_update on that turn is accepted (the real ingress key and decision).
test('runtime: the parked notice turn carries the note and its one task_update is accepted',async()=>{
 const {EventEmitter}=await import('events');
 const {mkdirSync,writeFileSync}=await import('node:fs');
 const {AgentOrchestrationRuntime}=await import('../../../src/orchestration/runtime');
 const {SessionStore}=await import('../../../src/session/store');
 const {HistoryDB}=await import('../../../src/history/db');
 const root=mkdtempSync(join(tmpdir(),'parked-goal-rt-')),dir=join(root,'a'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as never;
 const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a'),sid=randomUUID();
 await sessions.ensureApiSession('a','chat',sid);
 const prompts:string[]=[],results:unknown[]=[];let inTurn:(()=>void)|undefined;
 const runtime=await AgentOrchestrationRuntime.open(agent,{gateway:{orchestration:true,headless:true},agents:[agent]} as never,dir,sessions,history,{
  createAgentSession:async()=>Object.assign(new EventEmitter(),{start:async()=>{},stop:async()=>{},interrupt:()=>{},sendMessage:function(this:InstanceType<typeof EventEmitter>,text:string){prompts.push(text);try{inTurn?.();}catch(error){results.push(error);}setImmediate(()=>this.emit('output',JSON.stringify({type:'result',result:''})));}}) as never,releaseAgentSession:async()=>{}});
 try{
  const rs={...scope,agentSessionId:sid,chatId:'chat',accountId:'owner',principalId:'owner'};
  const opening=runtime.store.acceptInput({scope:rs,text:'open'}),decision=runtime.decisions.begin(opening.conversationId,'owner',[opening.inputId]);
  const task=runtime.tasks.spawn({...opening,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'},{title:'htop',instructions:'1. open Terminal\n2. type `which htop`\n3. press Enter',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
  runtime.decisions.finish(decision,'Opening');
  inTurn=()=>{
   const input=runtime.store.get("SELECT id FROM conversation_inputs WHERE json_extract(ingress_json,'$.ingressKey') LIKE 'notification:%' ORDER BY input_seq DESC LIMIT 1")!;
   const d=runtime.store.get("SELECT id,epoch FROM conversation_decisions WHERE state='running'")!;
   results.push(runtime.tasks.update({conversationId:task.conversationId,inputId:String(input.id),decisionId:String(d.id),epoch:Number(d.epoch),principalId:'owner',execute:false,writeMemory:false,actionId:randomUUID()},task.taskId,1,'key enter','when_ready'));
  };
  const attempt=runtime.tasks.claim(task.taskId)!;runtime.tasks.started(attempt.attemptId,attempt.generation);
  runtime.tasks.finish(attempt.attemptId,attempt.generation,parked());
  (runtime as unknown as {pumpMailbox():void}).pumpMailbox();
  const start=Date.now();while(!results.length){if(Date.now()-start>5000)throw Error('no notice turn');await new Promise(r=>setTimeout(r,10));}
  expect(prompts.at(-1)).toContain('NOT confirmed');expect(prompts.at(-1)).toContain('"press Enter"');
  expect(results[0]).toMatchObject({revision:2,executionControl:{agentHandoff:true}});
 }finally{await runtime.close();(history as never as {db:{close():void}}).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});
