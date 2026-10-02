import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OrchestrationStore,AcceptInput} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {liveExecutionInput} from '../../../src/orchestration/live-execution-input';

for(const modality of ['text','live_voice'] as const)test(`${modality} correction applies once and records one canonical input and resumes idle rounds without an agent`,()=>{
 const root=mkdtempSync(join(tmpdir(),'live-input-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store),decisions=new DecisionService(store);
 try{
  const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'},capabilities={execute:true,writeMemory:false};
  const accepted=store.acceptInput({scope,text:'Book flights',capabilities});
  const decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
  const task=tasks.spawn({...accepted,...decision,principalId:'u',...capabilities,actionId:'spawn'},{title:'Flights',instructions:'Two adults, three children, London',targetProfile:'gateway-managed',gatewayTarget:{adapter:'browser',sessionId:'target',name:'Browser'}});
  const input:AcceptInput={scope,text:'Manchester instead',modality:modality==='live_voice'?modality:undefined,ingressKey:randomUUID(),metadata:{executionTaskId:task.taskId}};
  const first=liveExecutionInput(store,tasks,input,capabilities)!;
  const retry=liveExecutionInput(store,tasks,input,capabilities)!;
  expect(store.get('SELECT store_user_message FROM conversation_inputs WHERE id=?',first.inputId)!.store_user_message).toBe(0);
  expect(retry.inputId).toBe(first.inputId);expect(retry.reused).toBe(true);
  expect(store.task(task.taskId)!.revision).toBe(2);
  expect(store.get('SELECT status FROM conversation_inputs WHERE id=?',first.inputId)!.status).toBe('handled');
  expect(tasks.revision(task.taskId,2).instructions).toContain('Two adults, three children');
  expect(store.get("SELECT COUNT(*) AS n FROM assistant_responses WHERE state='completed'")!.n).toBe(0);
  const settled=store.task(task.taskId)!;
  store.transaction(()=>{settled.state='completed';settled.executionControl=undefined;store.saveTask(settled,settled.stateVersion);});
  const nextGoal=liveExecutionInput(store,tasks,{...input,text:'Now inspect the results',ingressKey:randomUUID()},capabilities)!;
  expect(nextGoal).toMatchObject({status:'applied',revision:3,taskId:task.taskId});
  expect(store.task(task.taskId)!.revision).toBe(3);
  expect(tasks.revision(task.taskId,3).instructions).not.toContain('Book flights');
  expect(tasks.revision(task.taskId,3).instructions).not.toContain('Two adults');
  expect(store.get('SELECT status FROM conversation_inputs WHERE id=?',nextGoal.inputId)!.status).toBe('handled');
  const other=liveExecutionInput(store,tasks,{...input,scope:{...scope,agentSessionId:'other',chatId:'other'},ingressKey:randomUUID()},capabilities)!;
  expect(other.task).toBeUndefined();expect(store.task(task.taskId)!.revision).toBe(3);
  const denied=liveExecutionInput(store,tasks,{...input,ingressKey:randomUUID()},{execute:false,writeMemory:false})!;
  expect(denied.task).toBeUndefined();expect(store.task(task.taskId)!.revision).toBe(3);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

// Audit d09d63d0 item 2 (session a2f5a205): with a FIELD_TEXT_REQUIRED question
// pending, "เข้า Facebook" was swallowed as STATE_CONFLICT and became a message to
// the agent. The owner's new command supersedes the question and runs.
describe('a new direct command supersedes a pending question or a failed round',()=>{
 function fixture(adapter:'computer'|'browser'){
  const root=mkdtempSync(join(tmpdir(),'live-supersede-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store),decisions=new DecisionService(store);
  const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'},capabilities={execute:true,writeMemory:false};
  const accepted=store.acceptInput({scope,text:'open',capabilities});
  const decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
  const task=tasks.spawn({...accepted,...decision,principalId:'u',...capabilities,actionId:'spawn'},{title:'Live',instructions:'Open',targetProfile:'gateway-managed',gatewayTarget:{adapter,sessionId:'t',name:'T'}});
  const set=(patch:Record<string,unknown>)=>{const t=store.task(task.taskId)!;Object.assign(t,patch);delete t.activeAttemptId;store.transaction(()=>store.saveTask(t,t.stateVersion));};
  const send=(text:string)=>liveExecutionInput(store,tasks,{scope,text,modality:'live_voice',ingressKey:randomUUID(),metadata:{executionTaskId:task.taskId}},capabilities)!;
  return {store,task,set,send,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
 }
 test.each(['computer','browser'] as const)('%s: a pending FIELD_TEXT_REQUIRED question is closed and the command runs',adapter=>{
  const f=fixture(adapter);try{
   const report={status:'blocked',reason:'FIELD_TEXT_REQUIRED',steps:0,evaluations:1};
   f.set({state:'waiting_input',automationController:'user',...(adapter==='computer'?{computerReport:report}:{browserReport:report}),pendingQuestion:{questionId:randomUUID(),text:'What should be typed in Search?',revision:1}});
   const r=f.send('เข้า Facebook');
   expect(r).toMatchObject({status:'applied',revision:2});
   const t=f.store.task(f.task.taskId)!;
   expect(t.pendingQuestion).toBeUndefined();expect(t.state).toBe('queued');
   expect(f.store.get('SELECT store_user_message FROM conversation_inputs WHERE id=?',r.inputId)!.store_user_message).toBe(0);
  }finally{f.close();}
 });
 test.each(['ADAPTER_TIMEOUT','JEV_INVALID_RESPONSE','TIMEOUT','CANCELLED'])('a round that failed with %s takes the next command',reason=>{
  const f=fixture('computer');try{
   f.set({state:'failed',automationController:'user',computerReport:{status:'blocked',reason,steps:0,evaluations:1}});
   expect(f.send('เข้า Yahoo')).toMatchObject({status:'applied',revision:2});
  }finally{f.close();}
 });
 test.each([['computer',{computerReport:{status:'blocked',reason:'OUTCOME_UNKNOWN',steps:1}}],['browser',{browserReport:{status:'blocked',reason:'NO_PROGRESS',steps:1,evaluations:1,lastAction:{operationId:'op',operation:'CLICK',outcome:'unknown'}}}]] as const)('%s: an action whose result is unknown is never superseded',(adapter,patch)=>{
  const f=fixture(adapter);try{
   f.set({state:'failed',automationController:'user',...patch});
   expect(f.send('กด Send')).toMatchObject({status:'needs_agent',code:'STATE_CONFLICT'});
  }finally{f.close();}
 });
});
