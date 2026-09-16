import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { DeliveryOutbox } from '../../../src/orchestration/delivery';
import { TaskQuestions } from '../../../src/orchestration/task-questions';
import { ConversationScope } from '../../../src/orchestration/types';

function fixture(store: OrchestrationStore, session = 'session', source: ConversationScope['source'] = 'telegram') {
  const tasks = new TaskService(store), decisions = new DecisionService(store);
  const scope = { agentId: 'a', agentSessionId: session, source, accountId: 'a', chatId: '10', threadKey: '', principalId: 'owner' };
  const input = store.acceptInput({ scope, text: 'Prepare the change', capabilities: {execute:true,writeMemory:false} });
  const decision = decisions.begin(input.conversationId, scope.principalId, [input.inputId]);
  const task = tasks.spawn({...input,...decision,principalId:scope.principalId,actionId:'spawn-'+session,execute:true,writeMemory:false},
    {title:'Prepare release',instructions:'Prepare change and ask for the target',targetProfile:'default-worker'});
  const attempt = tasks.claim(task.taskId)!;
  tasks.started(attempt.attemptId, attempt.generation);
  tasks.requestInput(attempt.attemptId, attempt.generation, 'Which target should I use?');
  decisions.finish(decision, 'Preparing the change.');
  const question = store.task(task.taskId)!.pendingQuestion!;
  const sender = jest.fn(async () => ({state:'delivered' as const,providerId:'message-'+Math.random()}));
  const delivery = new DeliveryOutbox(store,sender), publish = jest.fn();
  const controls = new TaskQuestions(store,tasks,decisions,(...args)=>delivery.enqueue(...args),publish,()=>600000);
  controls.tick();
  const controlScope = {channel:scope.source,chatId:scope.chatId,thread:'',sessionId:session,principalId:scope.principalId};
  const begin = (text='Please explain', user=true) => {
    const receipt=store.acceptInput({scope,text,storeUserMessage:user});
    const d=decisions.begin(receipt.conversationId,scope.principalId,[receipt.inputId]);
    return {...receipt,...d,principalId:scope.principalId,execute:false,writeMemory:false,actionId:'action-'+receipt.inputId};
  };
  const ask = () => {
    const context=begin();
    controls.manage(context,{action:'ask',question_ids:[question.questionId],text:'Which target would you like me to use?'});
    decisions.finish(context,'Here is the explanation.');controls.flushPrompts();
    return context;
  };
  return {tasks,decisions,task,attempt,scope,question,controls,controlScope,delivery,publish,sender,begin,ask};
}

test('tick registers questions but does not send boilerplate, buttons or timed reminders',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try {const f=fixture(store);f.controls.tick(Date.now()+86400000);
  expect(f.publish).not.toHaveBeenCalled();expect(store.all('SELECT * FROM task_question_messages')).toEqual([]);
  expect(f.controls.initialReviews([])).toHaveLength(1);
  f.controls.reviewed(f.task.conversationId);expect(f.controls.initialReviews([])).toHaveLength(0);
 }finally{store.close();}
});

test('pending result notifications do not suppress the first question review',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store);
  store.run('INSERT INTO notifications(id,conversation_id,task_id,task_state_version,originating_binding_id) VALUES(?,?,?,?,?)',
   randomUUID(),f.task.conversationId,f.task.taskId,999,store.get('SELECT binding_id FROM task_questions WHERE question_id=?',f.question.questionId)!.binding_id);
  expect(f.controls.initialReviews([])).toHaveLength(1);
  expect(store.get("SELECT COUNT(*) n FROM notifications WHERE status='pending'")!.n).toBe(1);
 }finally{store.close();}
});

test.each(['telegram','discord','line','slack','whatsapp','api'] as const)('%s question reply is context, never an automatic answer',async source=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store,'session',source);f.ask();await f.delivery.tick();
  const message=store.get('SELECT provider_message_id FROM deliveries')!;
  const input={scope:f.scope,text:'Can you try another approach?',metadata:{repliedMessageId:String(message.provider_message_id)}};
  expect(f.controls.matches(input)).toBe(false);
  expect(f.controls.replyContext(input)).toEqual([expect.objectContaining({question_id:f.question.questionId,task_id:f.task.taskId})]);
  expect(store.task(f.task.taskId)!.state).toBe('waiting_input');
  expect(f.controls.replyContext({...input,scope:{...input.scope,chatId:'other'}})).toEqual([]);
  expect(()=>f.controls.replyContext({...input,scope:{...input.scope,principalId:'other'}})).toThrow();
 }finally{store.close();}
});

test('natural question is sent once after ordinary response completes, without controls',async()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store),context=f.begin(),args={action:'ask',question_ids:[f.question.questionId],text:'Which environment should I use?'};
  f.controls.manage(context,args);f.controls.manage(context,args);f.controls.tick();expect(f.publish).not.toHaveBeenCalled();
  f.decisions.finish(context,'Your unrelated question is answered.');f.controls.tick();f.controls.tick();
  expect(f.publish).toHaveBeenCalledTimes(1);expect(f.publish.mock.calls[0][2]).toBe(args.text);
  await f.delivery.tick();expect(f.sender).toHaveBeenCalledTimes(1);
  expect(f.sender.mock.calls[0]).not.toContain('Remind in 1 hour');
  expect(store.all("SELECT generated_text FROM assistant_responses WHERE generated_text!='' ORDER BY rowid").map(r=>r.generated_text)).toEqual(['Preparing the change.','Your unrelated question is answered.',args.text]);
 }finally{store.close();}
});

test('reminders require both elapsed cooldown and enough new user messages; discussion renews cooldown',async()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store);f.ask();await f.delivery.tick();const asked=f.controls.context(f.task.conversationId,'owner')[0];
  expect(f.controls.context(f.task.conversationId,'owner',asked.nextReminderAt+1)[0].eligibleToAsk).toBe(false);
  for(let i=0;i<3;i++){const c=f.begin('Another topic');store.run('UPDATE conversation_inputs SET created_at=? WHERE id=?',asked.lastAskedAt+1+i,c.inputId);f.decisions.finish(c,'Reply');}
  expect(f.controls.context(f.task.conversationId,'owner',asked.nextReminderAt-1)[0].eligibleToAsk).toBe(false);
  expect(f.controls.context(f.task.conversationId,'owner',asked.nextReminderAt+1)[0].eligibleToAsk).toBe(true);
  const c=f.begin('What are my options?');f.controls.manage(c,{action:'discuss',question_ids:[f.question.questionId]});f.decisions.finish(c,'Options');
  expect(f.controls.context(f.task.conversationId,'owner')[0].eligibleToAsk).toBe(false);
  expect(store.task(f.task.taskId)!.state).toBe('waiting_input');
 }finally{store.close();}
});

test.each(['defer','mute'] as const)('%s preference survives restart and cannot answer the task',action=>{
 const root=mkdtempSync(join(tmpdir(),'questions-')),path=join(root,'db');let store=new OrchestrationStore(path,'a');
 try{const f=fixture(store);f.ask();const c=f.begin('Later please');f.controls.manage(c,{action,question_ids:[f.question.questionId]});f.decisions.finish(c,'Understood');
  store.close();store=new OrchestrationStore(path,'a');
  const q=new TaskQuestions(store,new TaskService(store),new DecisionService(store),jest.fn(),jest.fn(),()=>600000);
  expect(q.context(f.task.conversationId,'owner')[0].eligibleToAsk).toBe(false);
  expect(store.task(f.task.taskId)!.state).toBe('waiting_input');
  expect(q.context(f.task.conversationId,'owner')[0].muted).toBe(action==='mute');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('agent question actions retain ownership, epoch and user-input fences',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store),foreign=fixture(store,'other'),c=f.begin();
  expect(()=>f.controls.manage(c,{action:'ask',question_ids:[foreign.question.questionId],text:'Question'})).toThrow('STALE_QUESTION');
  expect(()=>f.controls.manage({...c,principalId:'other'},{action:'ask',question_ids:[f.question.questionId],text:'Question'})).toThrow();
  f.decisions.finish(c,'Done');expect(()=>f.controls.manage(c,{action:'mute',question_ids:[f.question.questionId]})).toThrow('STALE_DECISION');
  const review=f.begin('Review',false);expect(()=>f.controls.manage(review,{action:'mute',question_ids:[f.question.questionId]})).toThrow('USER_INPUT_REQUIRED');
 }finally{store.close();}
});

test.each(['answer','cancel','interrupt'] as const)('%s before presentation discards the staged question',action=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store),c=f.begin();f.controls.manage(c,{action:'ask',question_ids:[f.question.questionId],text:'Which target?'});
  if(action==='answer')f.tasks.answerByUser(f.task.conversationId,'owner',f.task.taskId,f.question.questionId,'staging');
  if(action==='cancel')f.tasks.cancelByUser(f.task.conversationId,'owner',f.task.taskId);
  if(action==='interrupt'){f.decisions.interrupt(c);f.decisions.finish(c,'','interrupted');}else f.decisions.finish(c,'Done');
  f.controls.tick();expect(f.publish).not.toHaveBeenCalled();expect(store.get('SELECT state FROM task_question_prompts')!.state).toBe('cancelled');
 }finally{store.close();}
});

test('explicit answer command is still available and fences foreign questions',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store);expect(()=>f.controls.handle({...f.controlScope,principalId:'other'},`/task_question ${f.question.questionId} answer yes`)).toThrow();
  f.controls.handle(f.controlScope,`/task_question ${f.question.questionId} answer staging`);
  expect(f.tasks.revision(f.task.taskId,2).answers?.[0].text).toBe('staging');
 }finally{store.close();}
});

test('Slack reply normalizes the exact thread while remaining ordinary conversation',async()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store,'s','slack');f.ask();await f.delivery.tick();
  const id=String(store.get('SELECT provider_message_id FROM deliveries')!.provider_message_id);
  const input={scope:{...f.scope,threadKey:id},text:'Why?',metadata:{repliedMessageId:id}};
  const normalized=f.controls.normalizeReply(input);expect(normalized.scope.threadKey).toBe('');
  expect(f.controls.replyContext(normalized)).toHaveLength(1);expect(f.controls.matches(normalized)).toBe(false);
  expect(f.controls.normalizeReply({...input,scope:{...input.scope,accountId:'other'}}).scope.threadKey).toBe(id);
 }finally{store.close();}
});

test('old one-question message schema upgrades without losing mappings',()=>{
 const root=mkdtempSync(join(tmpdir(),'questions-upgrade-')),path=join(root,'db');let store=new OrchestrationStore(path,'a');
 try{const f=fixture(store);f.ask();const before=store.all('SELECT * FROM task_question_messages');store.close();
  const db=new DatabaseSync(path);db.exec(`DROP INDEX task_question_messages_question; ALTER TABLE task_question_messages RENAME TO old;
   CREATE TABLE task_question_messages(response_id TEXT PRIMARY KEY REFERENCES assistant_responses(id),question_id TEXT NOT NULL REFERENCES task_questions(question_id));
   INSERT INTO task_question_messages SELECT * FROM old; DROP TABLE old;`);db.close();
  store=new OrchestrationStore(path,'a');expect(store.all('SELECT * FROM task_question_messages')).toEqual(before);
  expect(store.all('PRAGMA table_info(task_question_messages)').find(r=>r.name==='question_id')!.pk).toBe(2);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('several pending questions share one natural message and retain every reply association',async()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store),c=f.begin('Prepare another change');
  const second=f.tasks.spawn({...c,execute:true,actionId:c.actionId+'spawn'},{title:'Second change',instructions:'Ask for scope',targetProfile:'default-worker'});
  const attempt=f.tasks.claim(second.taskId)!;f.tasks.started(attempt.attemptId,attempt.generation);f.tasks.requestInput(attempt.attemptId,attempt.generation,'Which scope?');
  f.controls.tick();const q=store.task(second.taskId)!.pendingQuestion!;
  f.controls.manage(c,{action:'ask',question_ids:[f.question.questionId,q.questionId],text:'Which target for the release, and which scope for the second change?'});
  f.decisions.finish(c,'Ready to discuss.');f.controls.tick();await f.delivery.tick();
  expect(f.publish).toHaveBeenCalledTimes(1);
  const id=String(store.get('SELECT provider_message_id FROM deliveries')!.provider_message_id);
  const reply={scope:f.scope,text:'Can you explain the second one?',metadata:{repliedMessageId:id}};
  expect(f.controls.replyContext(reply).map(r=>r.question_id).sort()).toEqual([f.question.questionId,q.questionId].sort());
  expect(f.controls.matches(reply)).toBe(false);
 }finally{store.close();}
});

test('queued presentation survives restart, while deferred first questions do not wake the agent',()=>{
 const root=mkdtempSync(join(tmpdir(),'question-present-')),path=join(root,'db');let store=new OrchestrationStore(path,'a');
 try{const f=fixture(store),c=f.begin();f.controls.manage(c,{action:'ask',question_ids:[f.question.questionId],text:'Which target?'});f.decisions.finish(c,'Reply');store.close();
  store=new OrchestrationStore(path,'a');const publish=jest.fn();
  const q=new TaskQuestions(store,new TaskService(store),new DecisionService(store),jest.fn(),publish,()=>600000);
  q.tick();q.tick();expect(publish).toHaveBeenCalledTimes(1);
  const other=fixture(store,'other'),choice=other.begin('Leave it until later');other.controls.manage(choice,{action:'defer',question_ids:[other.question.questionId]});other.decisions.finish(choice,'Okay');
  expect(other.controls.initialReviews([]).some(r=>r.id===other.task.conversationId)).toBe(false);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
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


test.each(['session','principal','channel','thread','chat'])('question controls enforce %s scope',kind=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store);f.controls.tick();const scope={...f.controlScope};
   const field={session:'sessionId',principal:'principalId',channel:'channel',thread:'thread',chat:'chatId'}[kind]!;Object.assign(scope,{[field]:'other'});
   expect(()=>f.controls.handle(scope,`/task_question ${f.question.questionId} answer yes`)).toThrow();
   expect(store.task(f.task.taskId)!.state).toBe('waiting_input');
 }finally{store.close();}
});


test('cancelling an undelivered combined message keeps the other first question eligible',()=>{
 const store=new OrchestrationStore(':memory:','a');
 try{const f=fixture(store),c=f.begin('Prepare another change');
  const second=f.tasks.spawn({...c,execute:true,actionId:c.actionId+'spawn'},{title:'Second change',instructions:'Ask for scope',targetProfile:'default-worker'});
  const attempt=f.tasks.claim(second.taskId)!;f.tasks.started(attempt.attemptId,attempt.generation);f.tasks.requestInput(attempt.attemptId,attempt.generation,'Which scope?');
  f.controls.tick();const q=store.task(second.taskId)!.pendingQuestion!;
  f.controls.manage(c,{action:'ask',question_ids:[f.question.questionId,q.questionId],text:'Which target and scope?'});
  f.decisions.finish(c,'Ready');f.controls.tick();
  f.tasks.answerByUser(f.task.conversationId,'owner',f.task.taskId,f.question.questionId,'staging');
  f.controls.tick();
  expect(f.controls.context(f.task.conversationId,'owner')).toEqual([expect.objectContaining({questionId:q.questionId,askedCount:0,eligibleToAsk:true})]);
  expect(f.controls.initialReviews([])).toHaveLength(1);
 }finally{store.close();}
});
