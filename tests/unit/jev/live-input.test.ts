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

// Sessions b01a566f and a4b9ee81: the web client posted each live-voice
// transcript again as a typed message 0.25–1.7s later, so every command ran twice.
describe('voice transcript echo',()=>{
 function fixture(){
  const root=mkdtempSync(join(tmpdir(),'live-echo-')),store=new OrchestrationStore(join(root,'db'),'a'),tasks=new TaskService(store),decisions=new DecisionService(store);
  const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'},capabilities={execute:true,writeMemory:false};
  const accepted=store.acceptInput({scope,text:'Open YouTube',capabilities});
  const decision=decisions.begin(accepted.conversationId,'u',[accepted.inputId]);
  const task=tasks.spawn({...accepted,...decision,principalId:'u',...capabilities,actionId:'spawn'},{title:'YouTube',instructions:'Open YouTube',targetProfile:'gateway-managed',gatewayTarget:{adapter:'browser',sessionId:'target',name:'Browser'}});
  const send=(text:string,modality?:'live_voice',promptContext='')=>liveExecutionInput(store,tasks,{scope,text,...(modality?{modality}:{}),ingressKey:randomUUID(),
   metadata:{executionTaskId:task.taskId,...(modality?{}:{clientMessageId:randomUUID(),promptContext})}},capabilities)!;
  // A command either revises the task or waits in its queue.
  const runs=()=>{const t=store.task(task.taskId)!;return t.revision+(t.queuedCommands?.length??0);};
  return {store,task,send,runs,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
 }
 test('the typed echo of a voice command is acknowledged once and does not revise the task again',()=>{
  const f=fixture();try{
   const voice=f.send('ที่คลิปแรกเลยครับ','live_voice');
   expect(voice).toMatchObject({status:'applied',revision:2});
   const echo=f.send('ที่คลิปแรกเลยครับ.');
   expect(echo).toMatchObject({status:'applied',code:'DUPLICATE_VOICE_ECHO',revision:2});
   expect(echo.task).toBeUndefined();
   expect(f.runs()).toBe(2);
   expect(f.store.get('SELECT status FROM conversation_inputs WHERE id=?',echo.inputId)!.status).toBe('handled');
   // The echo arriving first is the same pair.
   f.send('เลื่อนลง');expect(f.send('เลื่อนลง','live_voice').code).toBe('DUPLICATE_VOICE_ECHO');
   expect(f.runs()).toBe(3);
  }finally{f.close();}
 });
 test('a repeated command, a different command, or a late echo still runs',()=>{
  const f=fixture();try{
   f.send('เลื่อนลง','live_voice');expect(f.send('เลื่อนลง','live_voice').code).toBeUndefined();
   expect(f.runs()).toBe(3);
   expect(f.send('เลื่อนขึ้น').code).toBeUndefined();expect(f.send('กด tab','live_voice').code).toBeUndefined();
   expect(f.runs()).toBe(5);
   const voice=f.send('กด enter','live_voice');
   f.store.run('UPDATE conversation_inputs SET created_at=created_at-2500 WHERE id=?',voice.inputId);
   expect(f.send('กด enter').code).toBeUndefined();
   expect(f.runs()).toBe(7);
   // Typed text with image/video options is its own message.
   f.send('เลื่อนลง','live_voice');expect(f.send('เลื่อนลง',undefined,'Image size 1024').code).toBeUndefined();
   expect(f.runs()).toBe(9);
  }finally{f.close();}
 });
});
