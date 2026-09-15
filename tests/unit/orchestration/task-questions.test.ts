import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { DeliveryOutbox } from '../../../src/orchestration/delivery';
import { TaskQuestions } from '../../../src/orchestration/task-questions';
import { pendingReports } from '../../../src/orchestration/notification-mailbox';

function fixture(store: OrchestrationStore, session = 'session', questionText = 'Which target should I use?', source: 'telegram' | 'slack' = 'telegram') {
  const tasks = new TaskService(store), decisions = new DecisionService(store);
  const scope = { agentId: 'a', agentSessionId: session, source, accountId: 'a', chatId: '10', threadKey: '', principalId: 'telegram:10' };
  const input = store.acceptInput({ scope, text: 'Prepare the change', capabilities: {execute:true,writeMemory:false} });
  const decision = decisions.begin(input.conversationId, scope.principalId, [input.inputId]);
  const task = tasks.spawn({...input,...decision,principalId:scope.principalId,actionId:'spawn-'+session,execute:true,writeMemory:false},
    {title:'Prepare release',instructions:'Prepare change and ask for the target',targetProfile:'default-worker'});
  const attempt = tasks.claim(task.taskId)!;
  tasks.started(attempt.attemptId, attempt.generation);
  tasks.requestInput(attempt.attemptId, attempt.generation, questionText);
  decisions.finish(decision, 'Preparing the change.');
  const question = store.task(task.taskId)!.pendingQuestion!;
  const sender = jest.fn(async () => ({state:'delivered' as const,providerId:'message-'+Math.random()}));
  const delivery = new DeliveryOutbox(store,sender);
  const publish = jest.fn();
  const controls = new TaskQuestions(store,tasks,decisions,(...args)=>delivery.enqueue(...args),publish,()=>600000);
  const controlScope = {channel:scope.source,chatId:scope.chatId,thread:'',sessionId:session,principalId:scope.principalId};
  return {tasks,decisions,task,attempt,scope,question,controls,controlScope,delivery,publish,sender};
}

test('question is standalone and full length, without waiting for unrelated inference',async()=>{
  const store=new OrchestrationStore(':memory:','a');
  try {
    const question='Which target? '+ 'x'.repeat(3900),f=fixture(store,'session',question);
    const next=store.acceptInput({scope:f.scope,text:'A different question'});
    f.decisions.begin(next.conversationId,f.scope.principalId,[next.inputId]);
    f.controls.tick();
    const message=store.get('SELECT r.* FROM assistant_responses r JOIN task_question_messages m ON m.response_id=r.id')!;
    expect(message.generated_text).toContain(question);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(store.get("SELECT COUNT(*) n FROM notifications WHERE status='pending'")!.n).toBe(0);
    await f.delivery.tick();
    const chunks=store.all('SELECT * FROM deliveries WHERE response_id=? ORDER BY rowid',message.id);
    expect(chunks.length).toBeGreaterThan(1);
    for(const row of chunks)expect(row.state).toBe('delivered');
    f.controls.tick(); expect(f.publish).toHaveBeenCalledTimes(1);
    expect(pendingReports(store,[],[],true)).toEqual([]);
  } finally {store.close();}
});

test('reply binds to exact question among concurrent tasks, saves once, and cancels reminders',async()=>{
  const store=new OrchestrationStore(':memory:','a');
  try {
    const f=fixture(store),other=fixture(store,'other');
    f.controls.tick(); await f.delivery.tick();
    const delivery=store.get(`SELECT d.* FROM deliveries d JOIN task_question_messages m ON m.response_id=d.response_id WHERE m.question_id=?`,f.question.questionId)!;
    const input={scope:f.scope,text:'Use staging',metadata:{repliedMessageId:String(delivery.provider_message_id)},capabilities:{execute:true,writeMemory:false}};
    const accepted=store.acceptInput(input);
    expect(f.controls.answerReply(input,accepted.inputId)?.text).toContain('Answer received');
    expect(f.tasks.revision(f.task.taskId,2).answers).toHaveLength(1);
    expect(store.task(other.task.taskId)!.pendingQuestion).toBeDefined();
    expect(store.get('SELECT closed FROM task_questions WHERE question_id=?',f.question.questionId)!.closed).toBe(1);
    f.controls.answerReply(input,accepted.inputId);
    expect(f.tasks.revision(f.task.taskId,2).answers).toHaveLength(1);
    f.controls.tick(Date.now()+86400000);
    expect(store.get('SELECT COUNT(*) n FROM task_question_messages WHERE question_id=?',f.question.questionId)!.n).toBe(1);
    expect(f.controls.matches({...input,scope:{...f.scope,agentSessionId:'other'}})).toBe(false);
  } finally {store.close();}
});

test('snooze and mute survive reopen, reminders back off, replaced questions invalidate old controls',async()=>{
 const root=mkdtempSync(join(tmpdir(),'task-question-')),file=join(root,'db');
 let store=new OrchestrationStore(file,'a');
 try {
   const f=fixture(store);const now=Date.now();f.controls.tick(now);await f.delivery.tick();
   f.controls.tick(now+599999);expect(f.publish).toHaveBeenCalledTimes(1);
   f.controls.tick(now+600000);expect(f.publish).toHaveBeenCalledTimes(2);await f.delivery.tick();
   expect(store.get('SELECT next_reminder_at FROM task_questions')!.next_reminder_at).toBe(now+2400000);
   f.controls.handle(f.controlScope,`/orch q:${f.question.questionId}:snooze`);
   store.close();store=new OrchestrationStore(file,'a');
   const delivery=new DeliveryOutbox(store,async()=>({state:'delivered'}));
   const publish=jest.fn();const controls=new TaskQuestions(store,new TaskService(store),new DecisionService(store),(...args)=>delivery.enqueue(...args),publish,()=>600000);
   controls.tick(now+1800000);expect(publish).not.toHaveBeenCalled();
   controls.handle(f.controlScope,`/task_question ${f.question.questionId} mute`);
   controls.tick(now+86400000);expect(publish).not.toHaveBeenCalled();
   const task=store.task(f.task.taskId)!;task.pendingQuestion={...task.pendingQuestion!,questionId:'00000000-0000-0000-0000-000000000001'};store.transaction(()=>store.saveTask(task,task.stateVersion));
   controls.tick();expect(publish).toHaveBeenCalledTimes(1);
   expect(()=>controls.handle(f.controlScope,`/orch q:${f.question.questionId}:snooze`)).toThrow('STALE_QUESTION');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('no repeated sends while delivery is pending; cancelled task stops pending question delivery',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store),now=Date.now();f.controls.tick(now);f.controls.tick(now+86400000);expect(f.publish).toHaveBeenCalledTimes(1);
   f.tasks.cancelByUser(f.task.conversationId,f.scope.principalId,f.task.taskId);f.controls.tick(now+86400000);
   expect(store.get("SELECT COUNT(*) n FROM deliveries WHERE state='pending'")!.n).toBe(0);
 }finally{store.close();}
});

test.each(['session','principal','channel','thread','chat'])('question controls enforce %s scope',kind=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store);f.controls.tick();const scope={...f.controlScope};
   const field={session:'sessionId',principal:'principalId',channel:'channel',thread:'thread',chat:'chatId'}[kind]!;Object.assign(scope,{[field]:'other'});
   expect(()=>f.controls.handle(scope,`/task_question ${f.question.questionId} answer yes`)).toThrow();
   expect(store.task(f.task.taskId)!.state).toBe('waiting_input');
 }finally{store.close();}
});

test('worker exit and event retention cannot requeue an already presented question as a model report',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store);f.tasks.finish(f.attempt.attemptId,f.attempt.generation,{type:'completed',result:{summary:'Waiting for target',artifactIds:[]}});
   store.run('DELETE FROM conversation_events');
   f.controls.tick();
   expect(store.get("SELECT COUNT(*) n FROM notifications WHERE status='pending'")!.n).toBe(0);
   expect(f.publish).toHaveBeenCalledTimes(1);
 }finally{store.close();}
});

test('atomic composition rolls back failed commands and outer failures without weakening default transaction guard',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{
   store.compose(()=>{
     store.enqueue('fixture','outer',{});
     expect(()=>store.transaction(()=>{store.enqueue('fixture','inner',{});throw Error('failure');})).toThrow('failure');
   });
   expect(store.all('SELECT dedup_key FROM outbox')).toEqual([{dedup_key:'outer'}]);
   expect(()=>store.compose(()=>{store.transaction(()=>store.enqueue('fixture','nested',{}));throw Error('outer failure');})).toThrow('outer failure');
   expect(store.all('SELECT dedup_key FROM outbox')).toEqual([{dedup_key:'outer'}]);
   expect(()=>store.transaction(()=>store.transaction(()=>{}))).toThrow('NESTED_TRANSACTION');
   expect(()=>store.compose(()=>store.transaction(()=>Promise.resolve()))).toThrow('ASYNC_TRANSACTION');
 }finally{store.close();}
});

test.each(['mute','snooze','answer yes'])('%s immediately cancels a queued reminder before another delivery tick',async action=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store),now=Date.now();f.controls.tick(now);await f.delivery.tick();
   f.controls.tick(now+600000);expect(store.get("SELECT COUNT(*) n FROM deliveries WHERE state='pending'")!.n).toBe(1);
   f.controls.handle(f.controlScope,`/task_question ${f.question.questionId} ${action}`);
   expect(store.get("SELECT COUNT(*) n FROM deliveries WHERE state='pending'")!.n).toBe(0);
   await f.delivery.tick();expect(f.sender).toHaveBeenCalledTimes(1);
 }finally{store.close();}
});

test('a Slack reply thread maps only to its exact top-level question in the same account/session',async()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store,'s','Which environment?','slack');f.controls.tick();await f.delivery.tick();
   const message=store.get('SELECT provider_message_id FROM deliveries')!.provider_message_id as string;
   const input={scope:{...f.scope,threadKey:message},text:'staging',metadata:{repliedMessageId:message},capabilities:{execute:true,writeMemory:false}};
   const normalized=f.controls.normalizeReply(input);expect(normalized.scope.threadKey).toBe('');
   expect(f.controls.normalizeReply({...input,scope:{...input.scope,accountId:'other'}}).scope.threadKey).toBe(message);
   expect(f.controls.normalizeReply({...input,scope:{...input.scope,agentSessionId:'other'}}).scope.threadKey).toBe(message);
   expect(f.controls.handle({...f.controlScope,thread:message},`/orch q:${f.question.questionId}:snooze`)?.text).toContain('snoozed');
   const accepted=store.acceptInput(normalized);f.controls.answerReply(normalized,accepted.inputId);
   expect(store.task(f.task.taskId)!.pendingQuestion).toBeUndefined();
   const followup=f.controls.normalizeReply({...input,text:'How long will it take?',ingressKey:'new-message'});
   expect(followup.scope.threadKey).toBe('');
   expect(f.controls.matches(followup)).toBe(false);
 }finally{store.close();}
});

test.each(['mute','snooze','answer staging'])('in-flight delivery page does not resurrect a question after %s',async action=>{
 const store=new OrchestrationStore(':memory:','a');
 try{
  const f=fixture(store),now=Date.now();f.controls.tick(now);await f.delivery.tick();
  const binding=store.get('SELECT binding_id FROM task_questions WHERE question_id=?',f.question.questionId)!;
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const sent:string[]=[];
  const outbox=new DeliveryOutbox(store,async(_binding,text)=>{sent.push(text);if(text==='Earlier message')await gate;return {state:'delivered',providerId:'sent-'+sent.length};});
  const earlier=f.decisions.notice(f.task.conversationId,'Earlier message',false);
  store.transaction(()=>outbox.enqueue(earlier,String(binding.binding_id),'Earlier message'));
  f.controls.tick(now+600000);
  const sending=outbox.tick();
  expect(sent).toEqual(['Earlier message']);
  f.controls.handle(f.controlScope,`/task_question ${f.question.questionId} ${action}`);
  release();await sending;
  expect(sent).toEqual(['Earlier message']);
 }finally{store.close();}
});
