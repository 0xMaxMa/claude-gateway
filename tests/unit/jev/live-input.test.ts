import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OrchestrationStore,AcceptInput} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {DecisionService} from '../../../src/orchestration/decisions';
import {liveExecutionInput,handDirectCommandToAgent} from '../../../src/orchestration/live-execution-input';

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
 // Session a2f5a205: with a pending question the voice copy got needs_agent, and the
 // typed echo got it too, so both became user messages and the agent got two turns.
 const asking=(f:ReturnType<typeof fixture>)=>{const t=f.store.task(f.task.taskId)!;t.state='waiting_input';t.pendingQuestion={id:randomUUID(),text:'Which field?',code:'FIELD_TEXT_REQUIRED'} as never;
  f.store.transaction(()=>f.store.saveTask(t,t.stateVersion));};
 const userMessage=(f:ReturnType<typeof fixture>,inputId:string)=>f.store.get('SELECT store_user_message FROM conversation_inputs WHERE id=?',inputId)!.store_user_message;
 test('the typed echo of a voice command that went to the agent is deduped: no second user message',()=>{
  const f=fixture();try{
   asking(f);
   const voice=f.send('เปลี่ยนไปเข้า Facebook','live_voice');
   expect(voice.status).toBe('needs_agent');expect(userMessage(f,voice.inputId)).toBe(1);
   const echo=f.send('เปลี่ยนไปเข้า Facebook');
   expect(echo).toMatchObject({status:'applied',code:'DUPLICATE_VOICE_ECHO'});
   expect(userMessage(f,echo.inputId)).toBe(0);
   expect(f.store.get('SELECT status FROM conversation_inputs WHERE id=?',echo.inputId)!.status).toBe('handled');
   // Said again after the window: a new message for the agent.
   f.store.run('UPDATE conversation_inputs SET created_at=created_at-2500 WHERE id IN (?,?)',voice.inputId,echo.inputId);
   const again=f.send('เปลี่ยนไปเข้า Facebook','live_voice');
   expect(again.code).not.toBe('DUPLICATE_VOICE_ECHO');expect(userMessage(f,again.inputId)).toBe(1);
   // A different typed message right after is its own message.
   const other=f.send('เข้า Yahoo');
   expect(other.code).not.toBe('DUPLICATE_VOICE_ECHO');expect(userMessage(f,other.inputId)).toBe(1);
  }finally{f.close();}
 });
 test('the typed echo is deduped after the session closed too',()=>{
  const f=fixture();try{
   const t=f.store.task(f.task.taskId)!;t.automationSession={status:'closed',idleTimeoutMs:1,closedAt:Date.now(),closedReason:'user'} as never;
   f.store.transaction(()=>f.store.saveTask(t,t.stateVersion));
   const voice=f.send('select ที่ Cell C7','live_voice');
   expect(voice).toMatchObject({status:'needs_agent',code:'AUTOMATION_SESSION_CLOSED'});
   const echo=f.send('select ที่ Cell C7');
   expect(echo).toMatchObject({status:'applied',code:'DUPLICATE_VOICE_ECHO'});
   expect(userMessage(f,echo.inputId)).toBe(0);
  }finally{f.close();}
 });
 test('a hand-off of an older command recorded in between does not hide the voice copy',()=>{
  const f=fixture();try{
   const older=f.send('อ่านให้ฟังหน่อย','live_voice');
   f.store.run('UPDATE conversation_inputs SET created_at=created_at-2500 WHERE id=?',older.inputId);
   const voice=f.send('เลื่อนลง','live_voice');
   expect(handDirectCommandToAgent(f.store,f.store.task(f.task.taskId)!,older.inputId,older.revision!,'READ_REQUEST')).toBe(true);
   expect(f.send('เลื่อนลง').code).toBe('DUPLICATE_VOICE_ECHO');
   expect(f.store.task(f.task.taskId)!.revision).toBe(voice.revision);
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
