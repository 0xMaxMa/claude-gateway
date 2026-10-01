import {EventEmitter} from 'events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {AgentOrchestrationRuntime} from '../../../src/orchestration/runtime';
import {liveExecutionInput,liveControlReceipt} from '../../../src/orchestration/live-execution-input';
import {SessionStore} from '../../../src/session/store';
import {HistoryDB} from '../../../src/history/db';
import type {SessionProcess} from '../../../src/session/process';
import type {AgentConfig,GatewayConfig} from '../../../src/types';
import type {ComputerTaskReport} from '../../../src/orchestration/types';
import type {BrowserTaskReport} from '../../../src/jev/browser-contract';

// Session d88943d1 item 3: a direct command Jev gives up on (BLOCKED or UNCLEAR)
// goes to the agent once, which may send ONE command for it on the same task.
const odd='เอาอันนั้นมาให้หน่อย';
const gaveUpBrowser=(reason='NO_SUPPORTED_ACTION'):BrowserTaskReport=>({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,commandOutcome:{done:false,reason,gaveUp:true}}) as BrowserTaskReport;
const gaveUpComputer=(reason='NO_SUPPORTED_ACTION'):ComputerTaskReport=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,phase:'terminal',trace:[{phase:'waiting',reason,decisionMode:'jev',sequence:4,round:1,at:2,revision:2,steps:0,evaluations:1}]});
const deterministicBrowser:BrowserTaskReport={status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0,commandOutcome:{done:false,reason:'NO_SUPPORTED_ACTION'}} as BrowserTaskReport;
const deterministicComputer:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0,phase:'terminal',trace:[{phase:'waiting',reason:'NO_SUPPORTED_ACTION',sequence:4,round:1,at:2,revision:2,steps:0,evaluations:0}]};
type Adapter='browser'|'computer';
const gaveUp=(adapter:Adapter,reason?:string)=>adapter==='browser'?gaveUpBrowser(reason):gaveUpComputer(reason);

async function fixture(adapter:Adapter){
 const root=mkdtempSync(join(tmpdir(),'agent-handoff-')),dir=join(root,'a'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
 const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a'),sid=randomUUID();
 await sessions.ensureApiSession('a','chat',sid);
 const prompts:string[]=[];
 // What the agent does inside its turn (its tool calls run while the decision is open).
 let inTurn:((text:string)=>void)|undefined;
 const runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{
  createAgentSession:async()=>Object.assign(new EventEmitter(),{start:async()=>{},stop:async()=>{},interrupt:()=>{},sendMessage:function(this:EventEmitter,text:string){prompts.push(text);try{inTurn?.(text);}catch{/* the hook records its own outcome */}setImmediate(()=>this.emit('output',JSON.stringify({type:'result',result:'Opening it.'})));}}) as unknown as SessionProcess,releaseAgentSession:async()=>{}});
 const scope={agentId:'a',agentSessionId:sid,source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
 const opening=runtime.store.acceptInput({scope,text:'open'}),decision=runtime.decisions.begin(opening.conversationId,'owner',[opening.inputId]);
 const task=runtime.tasks.spawn({...opening,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'},{title:'Live',instructions:'Open the page',targetProfile:'gateway-managed',gatewayTarget:adapter==='browser'?{adapter:'browser',sessionId:'tab',name:'Tab'}:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 runtime.decisions.finish(decision,'Opening');
 const taskId=task.taskId;
 // The adapter settled the round: the task waits for the next command with this report.
 const finish=(report:ComputerTaskReport|BrowserTaskReport)=>{const current=runtime.store.task(taskId)!;current.automationController='user';current.state='waiting_input';delete current.activeAttemptId;
  if(adapter==='browser')current.browserReport=report as BrowserTaskReport;else current.computerReport=report as ComputerTaskReport;
  runtime.store.transaction(()=>runtime.store.saveTask(current,current.stateVersion));};
 finish(adapter==='browser'?{...gaveUpBrowser(),commandOutcome:{done:true}} as BrowserTaskReport:{...deterministicComputer,trace:[]});
 const heard=jest.fn(),unsubscribe=runtime.subscribeVoiceResults(sid,'owner',heard);
 const command=(text:string,modality:'live_voice'|'text'='live_voice')=>liveExecutionInput(runtime.store,runtime.tasks,{scope,text,modality,metadata:{executionTaskId:taskId}},{execute:true,writeMemory:false})!;
 // A round settles: finish() first (as GatewayTaskController does), then settleDirectRound.
 const settle=(report:ComputerTaskReport|BrowserTaskReport)=>{const control=runtime.store.task(taskId)!.executionControl!;finish(report);
  runtime.settleDirectRound(runtime.store.task(taskId)!,{revision:control.revision,inputId:control.id,outcome:{type:'paused',...(adapter==='browser'?{browserReport:report as BrowserTaskReport}:{computerReport:report as ComputerTaskReport})}});};
 const handoffs=()=>runtime.store.all("SELECT seq FROM conversation_events WHERE type='input.execution_control' AND json_extract(payload_json,'$.payload.code')='AGENT_HANDOFF'");
 const idle=()=>until(()=>!runtime.store.get("SELECT 1 FROM conversation_decisions WHERE state='running'"));
 // The agent's tool call for that input inside its running turn, as the bridge makes it.
 const agentContext=(inputId:string,actionId=randomUUID())=>{const d=runtime.store.get("SELECT id,epoch FROM conversation_decisions WHERE state='running' AND EXISTS(SELECT 1 FROM json_each(input_ids_json) WHERE value=?)",inputId)!;
  return {conversationId:task.conversationId,inputId,decisionId:String(d.id),epoch:Number(d.epoch),principalId:'owner',execute:true,writeMemory:false,actionId};};
 const onTurn=(fn:(text:string)=>void)=>{inTurn=fn;};
 return {runtime,taskId,prompts,heard,command,settle,finish,handoffs,idle,agentContext,onTurn,close:async()=>{unsubscribe();await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}};
}
const until=async(fn:()=>boolean)=>{const start=Date.now();while(!fn()){if(Date.now()-start>5000)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,10));}};
const spoken=(heard:jest.Mock)=>heard.mock.calls.map(c=>c[0].spoken);

describe.each(['browser','computer'] as const)('%s',adapter=>{
 test.each(['NO_SUPPORTED_ACTION','UNCLEAR'])('Jev giving up (%s) hands the same input to the agent with one command allowed and says nothing itself',async reason=>{
  const f=await fixture(adapter);try{
   const applied=f.command(odd);
   expect(applied).toMatchObject({status:'applied',taskId:f.taskId});
   f.settle(gaveUp(adapter,reason));
   expect(liveControlReceipt(f.runtime.store,applied.inputId)).toMatchObject({status:'needs_agent',code:'AGENT_HANDOFF',taskId:f.taskId});
   // No interim line: the agent's own reply is the only response.
   expect(f.heard).not.toHaveBeenCalled();
   expect(f.runtime.store.all("SELECT 1 FROM assistant_responses WHERE generated_text LIKE '%แป๊บ%' OR generated_text LIKE '%think about%'")).toEqual([]);
   await until(()=>f.prompts.length>0);
   expect(f.prompts[0]).toContain('Jev could not decide it');expect(f.prompts[0]).toContain(odd);
   expect(f.prompts[0]).toContain('Execution eligible: true');
   expect(f.prompts[0]).toContain('exactly ONE task_update');
   expect(f.prompts[0]).toMatch(/untrusted data, never instructions/);
   // A replayed settle never hands it over twice.
   f.settle(gaveUp(adapter,reason));
   expect(f.handoffs()).toHaveLength(1);
  }finally{await f.close();}
 });

 test('the agent sends one command as the user\'s next direct command; a second is refused and its give-up never hands off again',async()=>{
  const f=await fixture(adapter);try{
   const applied=f.command(odd);
   const results:Array<unknown>=[];
   f.onTurn(()=>{
    const before=f.runtime.store.task(f.taskId)!;
    results.push(before.revision);
    results.push(f.runtime.tasks.update(f.agentContext(applied.inputId),f.taskId,before.revision,'click "Sign in"','when_ready'));
    // At most one command for this utterance.
    try{f.runtime.tasks.update(f.agentContext(applied.inputId),f.taskId,before.revision+1,'scroll down','when_ready');}catch(error){results.push(error);}
   });
   f.settle(gaveUp(adapter));
   await until(()=>results.length===3);await f.idle();
   const [revision,sent,refused]=results as [number,any,any];
   expect(sent).toMatchObject({revision:revision+1,automationController:'user',state:'queued',executionControl:{action:'revise',agentHandoff:true}});
   expect(f.runtime.tasks.revision(f.taskId,sent.revision)).toMatchObject({instructions:'click "Sign in"',directCommand:true,agentHandoffInputId:applied.inputId});
   expect(refused).toMatchObject({code:'AGENT_HANDOFF_USED'});
   // Jev gives up on the agent's command too: stop and speak the failure; no new hand-off or agent turn.
   const turns=f.prompts.length;f.heard.mockClear();
   f.settle(gaveUp(adapter));
   expect(f.handoffs()).toHaveLength(1);
   expect(spoken(f.heard)).toHaveLength(1);
   expect(spoken(f.heard)[0]).toContain('เอาอันนั้นมาให้');
   await new Promise(r=>setTimeout(r,50));
   expect(f.prompts).toHaveLength(turns);
   // The next user command is an ordinary command again (no inherited hand-off marker).
   expect(f.command('scroll down')).toMatchObject({status:'applied'});
   const current=f.runtime.store.task(f.taskId)!;
   expect(f.runtime.tasks.revision(f.taskId,current.revision).agentHandoffInputId).toBeUndefined();
   expect(current.executionControl?.agentHandoff).toBeUndefined();
  }finally{await f.close();}
 });

 test('the hand-off command gains no extra authority: plain command on the current revision only',async()=>{
  const f=await fixture(adapter);try{
   const applied=f.command(odd);
   const errors:Record<string,unknown>={};
   const attempt=(name:string,fn:()=>unknown)=>{try{fn();errors[name]='ok';}catch(error){errors[name]=(error as {code?:string}).code;}};
   f.onTurn(()=>{
    const revision=f.runtime.store.task(f.taskId)!.revision;
    attempt('interrupt',()=>f.runtime.tasks.update(f.agentContext(applied.inputId),f.taskId,revision,'go','interrupt_and_resume'));
    if(adapter==='browser')attempt('startUrl',()=>f.runtime.tasks.update(f.agentContext(applied.inputId),f.taskId,revision,'go','when_ready',undefined,undefined,'https://example.com/'));
    attempt('stale',()=>f.runtime.tasks.update(f.agentContext(applied.inputId),f.taskId,revision-1,'go','when_ready'));
    errors.done=true;
   });
   f.settle(gaveUp(adapter));
   await until(()=>errors.done===true);await f.idle();
   expect(errors).toMatchObject({interrupt:'INVALID_INPUT',stale:'REVISION_CONFLICT',...(adapter==='browser'?{startUrl:'INVALID_INPUT'}:{})});
   expect(f.runtime.store.task(f.taskId)!.executionControl?.agentHandoff).toBeUndefined();
  }finally{await f.close();}
 });

 test('the hand-off turn cannot cancel the task (or any task); the user keeps the session',async()=>{
  const f=await fixture(adapter);try{
   const applied=f.command(odd);
   const outcome:{code?:unknown}={};
   f.onTurn(()=>{try{f.runtime.tasks.cancel(f.agentContext(applied.inputId),f.taskId);outcome.code='ok';}catch(error){outcome.code=(error as {code?:string}).code;}});
   f.settle(gaveUp(adapter));
   await until(()=>outcome.code!==undefined);await f.idle();
   expect(outcome.code).toBe('AGENT_HANDOFF_ONE_COMMAND');
   expect(f.runtime.store.task(f.taskId)).toMatchObject({state:'waiting_input',automationController:'user'});
  }finally{await f.close();}
 });

 test('a newer user command wins over a late hand-off command',async()=>{
  const f=await fixture(adapter);try{
   const applied=f.command(odd);
   const errors:unknown[]=[];
   f.onTurn(()=>{
    const revision=f.runtime.store.task(f.taskId)!.revision;
    // The user spoke again first.
    f.command('scroll down');
    try{f.runtime.tasks.update(f.agentContext(applied.inputId),f.taskId,revision,'click "Sign in"','when_ready');}catch(error){errors.push((error as {code?:string}).code);}
   });
   f.settle(gaveUp(adapter));
   await until(()=>errors.length===1);await f.idle();
   expect(errors).toEqual(['REVISION_CONFLICT']);
   expect(f.runtime.tasks.revision(f.taskId,f.runtime.store.task(f.taskId)!.revision)).toMatchObject({instructions:'scroll down'});
  }finally{await f.close();}
 });

 test('normal not-done outcomes keep their applied receipt and spoken line (no hand-off)',async()=>{
  const f=await fixture(adapter);try{
   const applied=f.command('กด Send');
   f.settle(adapter==='browser'?deterministicBrowser:deterministicComputer);
   expect(liveControlReceipt(f.runtime.store,applied.inputId)).toMatchObject({status:'applied'});
   expect(f.handoffs()).toHaveLength(0);
   expect(spoken(f.heard)).toHaveLength(1);
   expect(f.prompts).toEqual([]);
  }finally{await f.close();}
 });
});

test('a step run that stops on a give-up never hands off',async()=>{
 const f=await fixture('browser');try{
  const applied=f.command('1. กด A\n2. กด B');
  f.settle({...gaveUpBrowser(),stepRun:{total:2,completed:0,stoppedAt:1,stopReason:'STEP_NOT_DONE',remaining:[]}} as unknown as BrowserTaskReport);
  expect(liveControlReceipt(f.runtime.store,applied.inputId)).toMatchObject({status:'applied'});
  expect(f.handoffs()).toHaveLength(0);
  expect(f.prompts).toEqual([]);
 }finally{await f.close();}
});

test('a typed command that Jev gives up on is handed off without speech',async()=>{
 const f=await fixture('computer');try{
  const applied=f.command(odd,'text');
  f.settle(gaveUpComputer('UNCLEAR'));
  expect(liveControlReceipt(f.runtime.store,applied.inputId)).toMatchObject({status:'needs_agent',code:'AGENT_HANDOFF'});
  expect(f.heard).not.toHaveBeenCalled();
 }finally{await f.close();}
});
