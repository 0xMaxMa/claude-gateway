import {EventEmitter} from 'events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {GatewayTaskController,type GatewayTaskAdapter} from '../../../src/orchestration/gateway-tasks/controller';
import {AgentOrchestrationRuntime} from '../../../src/orchestration/runtime';
import {SessionStore} from '../../../src/session/store';
import {HistoryDB} from '../../../src/history/db';
import type {SessionProcess} from '../../../src/session/process';
import type {AgentConfig,GatewayConfig} from '../../../src/types';
import type {ComputerTaskReport,WorkerOutcome} from '../../../src/orchestration/types';

// Session 35bd8aff: ten live_voice direct commands, five ended "Not done"
// (LOW_CONFIDENCE / NO_SUPPORTED_ACTION), yet assistant_responses held only
// three rows: runtime.ts returns text '' once a direct command is queued, so
// the voice user heard nothing and repeated "ห้า". Reports are recorded shapes.
const low:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,phase:'terminal',
 trace:[{phase:'decided',confidence:0.45,sequence:3,round:1,at:1,revision:9,steps:0,evaluations:1},{phase:'waiting',reason:'LOW_CONFIDENCE',sequence:4,round:1,at:2,revision:9,steps:0,evaluations:1}]};
const unsupported:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,phase:'terminal',trace:[{phase:'waiting',reason:'NO_SUPPORTED_ACTION',sequence:4,round:1,at:2,revision:3,steps:0,evaluations:1}]};
const pressed:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:0,phase:'terminal',lastAction:{kind:'press',label:'5',role:'AXButton'}};
const clarify={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0,phase:'terminal',clarification:'ห้า หรือ ห้าสิบ?',trace:[{phase:'waiting',reason:'NUMBER_AMBIGUOUS',sequence:2,round:1,at:2,revision:7,steps:0,evaluations:0}]} as ComputerTaskReport;

test('V2: the controller hands each settled round its own command input, also when a queued command starts next',async()=>{
 const root=mkdtempSync(join(tmpdir(),'voice-round-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store);
 const accepted=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',chatId:'c',threadKey:'',principalId:'u'},text:'calc',capabilities:{execute:true,writeMemory:false}});
 const decision=new DecisionService(store).begin(accepted.conversationId,'u',[accepted.inputId]);
 const task=tasks.spawn({...accepted,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'},{title:'Calc',instructions:'Open Calculator',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
 const outcomes=new Map<string,WorkerOutcome>();const requests:string[]=[];
 const adapter:GatewayTaskAdapter={name:'computer',discover:()=>({}),resolve:()=>({adapter:'computer',sessionId:'mac',name:'Mac'}),cancel:async()=>{},
  submit:async(_t,requestId)=>{requests.push(requestId);},inspect:async(_t,requestId)=>outcomes.get(requestId)??'running'};
 const rounds:Array<{revision:number;inputId?:string;reason?:string}>=[];
 const controller=new (GatewayTaskController as any)(tasks,new Map([['computer',adapter]]),undefined,(_task:unknown,round:any)=>rounds.push({revision:round.revision,inputId:round.inputId,reason:round.outcome.computerReport?.trace?.at(-1)?.reason})) as GatewayTaskController;
 const send=(id:string,text:string)=>tasks.controlByUser(accepted.conversationId,'u',task.taskId,{id,action:'revise',expectedRevision:store.task(task.taskId)!.revision,text});
 try{
  await controller.tick();outcomes.set(requests[0],{type:'paused',computerReport:pressed});await controller.tick();
  const five=randomUUID(),zero=randomUUID();
  send(five,'ห้า');await controller.tick();send(zero,'ศูนย์');
  outcomes.set(requests[1],{type:'paused',computerReport:low});await controller.tick();
  expect(rounds).toEqual([{revision:1,inputId:undefined,reason:undefined},{revision:2,inputId:five,reason:'LOW_CONFIDENCE'}]);
 }finally{await controller.close();store.close();rmSync(root,{recursive:true,force:true});}
});

describe('V2: spoken outcome for live_voice direct commands',()=>{
 async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'voice-outcome-')),dir=join(root,'a'),workspace=join(dir,'workspace');
  mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
  const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
  const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
  const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a'),sid=randomUUID();
  await sessions.ensureApiSession('a','chat',sid);
  const runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{
   createAgentSession:async()=>Object.assign(new EventEmitter(),{start:async()=>{},stop:async()=>{},sendMessage:()=>{throw Error('no agent turn expected');}}) as unknown as SessionProcess,releaseAgentSession:async()=>{}});
  const scope={agentId:'a',agentSessionId:sid,source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
  const opening=runtime.store.acceptInput({scope,text:'เปิดเครื่องคิดเลข'}),decision=runtime.decisions.begin(opening.conversationId,'owner',[opening.inputId]);
  const task=runtime.tasks.spawn({...opening,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'},{title:'Calculator',instructions:'Open Calculator',targetProfile:'gateway-managed',gatewayTarget:{adapter:'computer',sessionId:'mac',name:'Mac'}});
  runtime.decisions.finish(decision,'Opening');
  const current=runtime.store.task(task.taskId)!;current.automationController='user';current.state='waiting_input';
  runtime.store.transaction(()=>runtime.store.saveTask(current,current.stateVersion));
  const heard=jest.fn(),unsubscribe=runtime.subscribeVoiceResults(sid,'owner',heard);
  const command=(text:string,modality?:'live_voice')=>runtime.store.acceptInput({scope,text,storeUserMessage:false,...(modality?{modality}:{}),capabilities:{execute:true,writeMemory:false}}).inputId;
  const settle=(inputId:string,computerReport:ComputerTaskReport)=>(runtime as any).speakDirectOutcome?.(runtime.store.task(task.taskId)!,{revision:2,inputId,outcome:{type:'paused',computerReport}});
  const notices=(inputId:string)=>runtime.store.all("SELECT r.generated_text FROM assistant_responses r JOIN conversation_decisions d ON d.id=r.decision_id WHERE d.kind='notice' AND EXISTS(SELECT 1 FROM json_each(d.input_ids_json) WHERE value=?)",inputId).map(r=>String(r.generated_text));
  return {runtime,heard,command,settle,notices,close:async()=>{unsubscribe();await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}};
 }
 test('a LOW_CONFIDENCE voice command produces exactly one short Thai voice message',async()=>{
  const f=await fixture();try{
   const input=f.command('ห้า','live_voice');
   f.settle(input,low);f.settle(input,low);
   expect(f.heard).toHaveBeenCalledTimes(1);
   expect(f.heard.mock.calls[0][0]).toMatchObject({spoken:'ไม่แน่ใจว่า ห้า คือปุ่มไหน ลองพูดใหม่อีกครั้ง',speechOnly:true});
   // L2: history keeps a generic line; the user's words are only spoken back.
   expect(f.notices(input)).toEqual(['ไม่แน่ใจว่า คำสั่งนี้ คือปุ่มไหน ลองพูดใหม่อีกครั้ง']);
   expect(f.heard.mock.calls[0][0].text).toBe('ไม่แน่ใจว่า คำสั่งนี้ คือปุ่มไหน ลองพูดใหม่อีกครั้ง');
  }finally{await f.close();}
 });
 test('NO_SUPPORTED_ACTION and a number clarification are spoken too',async()=>{
  const f=await fixture();try{
   f.settle(f.command('บัว','live_voice'),unsupported);
   f.settle(f.command('ห้า ห้าสิบ','live_voice'),clarify);
   expect(f.heard.mock.calls.map(c=>c[0].spoken)).toEqual(['ไม่เจอปุ่ม บัว บนหน้าจอ','ห้า หรือ ห้าสิบ?']);
  }finally{await f.close();}
 });
 test('H1: an unresolved receipt is never spoken as "not done, say it again"',async()=>{
  // Relay timed out after the press may have landed; repeating would show 55.
  const unknown:ComputerTaskReport={status:'needs_reconciliation',reason:'OUTCOME_UNKNOWN',steps:0,evaluations:0,phase:'terminal',
   trace:[{phase:'acted',outcome:'unknown',operationId:'op',sequence:3,round:1,at:2,revision:4,steps:0,evaluations:0}],lastAction:{kind:'press',label:'5',sequence:['5','0'],planned:3}} as ComputerTaskReport;
  const f=await fixture();try{
   f.settle(f.command('ห้า','live_voice'),unknown);
   f.settle(f.command('five','live_voice'),unknown);
   expect(f.heard.mock.calls.map(c=>c[0].spoken)).toEqual(['ไม่แน่ใจว่า ห้า ทำไปแล้วหรือยัง ดูหน้าจอก่อนสั่งใหม่','Not sure whether five ran. Check the screen before saying it again.']);
  }finally{await f.close();}
 });
 test('a successful voice command stays silent',async()=>{
  const f=await fixture();try{
   const input=f.command('ห้า','live_voice');f.settle(input,pressed);
   expect(f.heard).not.toHaveBeenCalled();expect(f.notices(input)).toEqual([]);
  }finally{await f.close();}
 });
 test('a typed command that fails adds no chat notice and no speech',async()=>{
  const f=await fixture();try{
   const input=f.command('ห้า');f.settle(input,low);
   expect(f.heard).not.toHaveBeenCalled();expect(f.notices(input)).toEqual([]);
  }finally{await f.close();}
 });
});
