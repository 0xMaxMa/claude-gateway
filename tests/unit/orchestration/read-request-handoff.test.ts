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

// Session 3e950913: under direct control "อ่านให้ฟังหน่อย ลิเวอร์พูลจะเตะกับใครในแมตช์ถัดไป"
// went to Jev as an action, ended as a 0-step completion candidate and the agent
// never got a turn. A READ_REQUEST round now hands that same input to the agent.
const ask='อ่านให้ฟังหน่อย ลิเวอร์พูลจะเตะกับใครในแมตช์ถัดไป';
const readBrowser:BrowserTaskReport={status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,commandOutcome:{done:false,reason:'READ_REQUEST'}} as BrowserTaskReport;
const readComputer:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,phase:'terminal',trace:[{phase:'waiting',reason:'READ_REQUEST',sequence:4,round:1,at:2,revision:2,steps:0,evaluations:1}]};
const lowComputer:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,phase:'terminal',trace:[{phase:'waiting',reason:'LOW_CONFIDENCE',sequence:4,round:1,at:2,revision:2,steps:0,evaluations:1}]};

async function fixture(adapter:'browser'|'computer'){
 const root=mkdtempSync(join(tmpdir(),'read-request-')),dir=join(root,'a'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
 const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a'),sid=randomUUID();
 await sessions.ensureApiSession('a','chat',sid);
 const prompts:string[]=[];
 const runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{
  createAgentSession:async()=>Object.assign(new EventEmitter(),{start:async()=>{},stop:async()=>{},interrupt:()=>{},sendMessage:function(this:EventEmitter,text:string){prompts.push(text);setImmediate(()=>this.emit('output',JSON.stringify({type:'result',result:'Liverpool play Arsenal next.'})));}}) as unknown as SessionProcess,releaseAgentSession:async()=>{}});
 const scope={agentId:'a',agentSessionId:sid,source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
 const opening=runtime.store.acceptInput({scope,text:'open'}),decision=runtime.decisions.begin(opening.conversationId,'owner',[opening.inputId]);
 const task=runtime.tasks.spawn({...opening,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'},{title:'Live',instructions:'Open the fixtures page',targetProfile:'gateway-managed',gatewayTarget:adapter==='browser'?{adapter:'browser',sessionId:'tab',name:'Tab'}:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 runtime.decisions.finish(decision,'Opening');
 const current=runtime.store.task(task.taskId)!;current.automationController='user';current.state='waiting_input';
 if(adapter==='browser')current.browserReport={...readBrowser,commandOutcome:{done:true}};else current.computerReport={...lowComputer,trace:[]};
 runtime.store.transaction(()=>runtime.store.saveTask(current,current.stateVersion));
 const heard=jest.fn(),unsubscribe=runtime.subscribeVoiceResults(sid,'owner',heard);
 // The real targeted-input path: the command is applied to the task first.
 const command=(text:string,modality:'live_voice'|'text'='live_voice')=>liveExecutionInput(runtime.store,runtime.tasks,{scope,text,modality,metadata:{executionTaskId:task.taskId}},{execute:true,writeMemory:false})!;
 const settle=(inputId:string,report:ComputerTaskReport|BrowserTaskReport)=>runtime.settleDirectRound(runtime.store.task(task.taskId)!,{revision:runtime.store.task(task.taskId)!.revision,inputId,outcome:{type:'paused',...(adapter==='browser'?{browserReport:report as BrowserTaskReport}:{computerReport:report as ComputerTaskReport})}});
 const input=(id:string)=>runtime.store.get('SELECT status,store_user_message FROM conversation_inputs WHERE id=?',id);
 const notices=(id:string)=>runtime.store.all("SELECT r.id FROM assistant_responses r JOIN conversation_decisions d ON d.id=r.decision_id WHERE d.kind='notice' AND EXISTS(SELECT 1 FROM json_each(d.input_ids_json) WHERE value=?)",id);
 return {runtime,taskId:task.taskId,prompts,heard,command,settle,input,notices,close:async()=>{unsubscribe();await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}};
}
const until=async(fn:()=>boolean)=>{const start=Date.now();while(!fn()){if(Date.now()-start>5000)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,10));}};

test.each(['browser','computer'] as const)('%s: a READ_REQUEST round gives the agent a read-only turn for the same input, silently',async adapter=>{
 const f=await fixture(adapter);try{
  const applied=f.command(ask);
  expect(applied).toMatchObject({status:'applied',taskId:f.taskId});
  expect(f.input(applied.inputId)).toMatchObject({status:'handled',store_user_message:0});
  f.settle(applied.inputId,adapter==='browser'?readBrowser:readComputer);
  expect(liveControlReceipt(f.runtime.store,applied.inputId)).toMatchObject({status:'needs_agent',code:'READ_REQUEST',taskId:f.taskId});
  // The agent turn is pending (or already running) and the user's words are kept in history.
  expect(f.input(applied.inputId)?.store_user_message).toBe(1);
  expect(['accepted','assigned']).toContain(f.input(applied.inputId)?.status);
  // No "not done, say it again" line: the agent answers instead.
  expect(f.heard).not.toHaveBeenCalled();expect(f.notices(applied.inputId)).toEqual([]);
  await until(()=>f.prompts.length>0);
  expect(f.prompts[0]).toContain('The gateway judged it a request to read');expect(f.prompts[0]).toContain(ask);expect(f.prompts[0]).toContain('Execution eligible: false');
  expect(f.prompts[0]).toContain(adapter==='browser'?'browser_evidence=fresh':'computer_evidence=fresh');
  expect(f.prompts[0]).toMatch(/untrusted data, never instructions/);
  expect(f.prompts[0]).toMatch(/Do not act for this input/);
  // A replayed settle does not hand it over twice.
  f.settle(applied.inputId,adapter==='browser'?readBrowser:readComputer);
  expect(f.runtime.store.all("SELECT seq FROM conversation_events WHERE type='input.execution_control' AND json_extract(payload_json,'$.payload.code')='READ_REQUEST'")).toHaveLength(1);
 }finally{await f.close();}
});

// Audit d09d63d0 item 3: a not-done command is not a read request, but it is
// still handed to the agent (AGENT_HANDOFF), read-only rules aside.
test('a command that was not a read request is handed off as AGENT_HANDOFF, not READ_REQUEST',async()=>{
 const f=await fixture('computer');try{
  const applied=f.command('กด Send');
  f.settle(applied.inputId,lowComputer);
  expect(liveControlReceipt(f.runtime.store,applied.inputId)).toMatchObject({status:'needs_agent',code:'AGENT_HANDOFF'});
 }finally{await f.close();}
});

