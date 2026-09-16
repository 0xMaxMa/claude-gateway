import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import { SessionProcess } from '../../../src/session/process';
import { AgentRunner } from '../../../src/agent/runner';

async function fixture() {
 const root=mkdtempSync(join(tmpdir(),'question-runtime-')),dir=join(root,'a'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]},orchestration:{conversation:{semanticIntake:true}}} as AgentConfig;
 const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
 const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a'),sid=randomUUID();
 await sessions.ensureApiSession('a','chat',sid);
 const createAgentSession=jest.fn();
 const runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{createAgentSession,releaseAgentSession:async()=>{}});
 const scope={agentId:'a',agentSessionId:sid,source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
 const input=runtime.store.acceptInput({scope,text:'Prepare deployment',capabilities:{execute:true,writeMemory:false}}),decision=runtime.decisions.begin(input.conversationId,'owner',[input.inputId]);
 const task=runtime.tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'}, {title:'Deploy',instructions:'Ask which target',targetProfile:'default-worker'});
 const attempt=runtime.tasks.claim(task.taskId)!;runtime.tasks.started(attempt.attemptId,attempt.generation);
 runtime.tasks.requestInput(attempt.attemptId,attempt.generation,'Which environment?');runtime.decisions.finish(decision,'Preparing');
 runtime.questionControls.tick();
 const question=runtime.store.task(task.taskId)!.pendingQuestion!;
 return {runtime,scope,question,task,createAgentSession,close:async()=>{await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}};
}

test('explicit answer is saved and streamed once while another model turn is active',async()=>{
 const f=await fixture();
 try{
  const seen=jest.fn();f.runtime.subscribeText(f.scope.agentSessionId,'owner',seen);
  const active=(f.runtime as any).active as Map<string,unknown>;
  active.set(f.scope.agentSessionId,{stopping:false});
  const input={scope:f.scope,text:`/task_question ${f.question.questionId} answer staging`,ingressKey:'answer-message'};
  expect(await f.runtime.send(input,{execute:true,writeMemory:false},{timeoutMs:1000})).toContain('Answer received');
  expect(f.createAgentSession).not.toHaveBeenCalled();
  expect(seen).toHaveBeenCalledTimes(1);
  const submitted=f.runtime.submitInput(input,{execute:true,writeMemory:false});
  expect(await submitted.response).toContain('Answer received');
  expect(seen).toHaveBeenCalledTimes(1);
  expect(f.runtime.tasks.revision(f.task.taskId,2).answers).toHaveLength(1);
  expect(f.runtime.store.get("SELECT COUNT(*) n FROM conversation_inputs WHERE status='accepted'")!.n).toBe(0);
  active.delete(f.scope.agentSessionId);
 }finally{(f.runtime as any).active.clear();await f.close();}
});

test('API task answer flushes its user history before returning without a model turn',async()=>{
 const f=await fixture();
 try{
  await f.runtime.flushHistory();
  const runner=Object.create(AgentRunner.prototype) as any;
  runner.agentConfig={orchestration:{enabled:true}};
  runner.getOrchestration=async()=>f.runtime;
  await runner.answerApiTask(f.scope.agentSessionId,'owner',f.task.taskId,f.question.questionId,'staging');
  expect(f.runtime.tasks.revision(f.task.taskId,2).answers?.[0].text).toBe('staging');
  expect(f.runtime.store.get("SELECT COUNT(*) n FROM history_operations WHERE state='pending'")!.n).toBe(0);
  expect(f.createAgentSession).not.toHaveBeenCalled();
 }finally{await f.close();}
});

test.each(['text','live_voice'] as const)('natural %s answer still goes through model task matching, without new-task acknowledgement gate',async modality=>{
 const f=await fixture();
 try{
  let ticketScope:any;
  const issue=f.runtime.bridge.issue.bind(f.runtime.bridge);
  jest.spyOn(f.runtime.bridge,'issue').mockImplementation((scope,...args)=>{ticketScope=scope;return issue(scope,...args);});
  const newTaskAttempt=jest.fn();
  f.createAgentSession.mockImplementation(async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){
    const emitter=this;
    void(async()=>{
      emitter.emit('output',JSON.stringify({type:'system',subtype:'init',tools:[]}));
      try { await ticketScope.beforeMutation('task_spawn',{task_id:f.task.taskId}); }
      catch(error){newTaskAttempt(error);}
      await ticketScope.beforeMutation('task_answer',{task_id:f.task.taskId,question_id:f.question.questionId,answer:'staging'});
      f.runtime.tasks.answer({...ticketScope.context,actionId:'interpreted-answer'},f.task.taskId,f.question.questionId,'staging');
      emitter.emit('output',JSON.stringify({type:'result',result:'Answer saved.'}));
    })().catch(error=>emitter.emit('error',error));
  }}) as unknown as SessionProcess);
  expect(await f.runtime.send({scope:f.scope,text:'Use staging please',modality},{execute:true,writeMemory:false},{timeoutMs:5000})).toBe('Answer saved.');
  expect(f.createAgentSession).toHaveBeenCalledTimes(1);
  expect(newTaskAttempt).toHaveBeenCalledWith(expect.objectContaining({code:'ACKNOWLEDGEMENT_REQUIRED'}));
  expect(f.runtime.tasks.revision(f.task.taskId,2).answers?.[0].text).toBe('staging');
 }finally{await f.close();}
});

test('reply consultation reaches the agent and can defer a question without answering the worker',async()=>{
 const f=await fixture();
 try{
  const message=f.runtime.decisions.notice(f.task.conversationId,'Which environment?',false);
  f.runtime.store.run('INSERT INTO task_question_messages VALUES(?,?)',message,f.question.questionId);
  let ticketScope:any;
  const issue=f.runtime.bridge.issue.bind(f.runtime.bridge);
  jest.spyOn(f.runtime.bridge,'issue').mockImplementation((scope,...args)=>{ticketScope=scope;return issue(scope,...args);});
  f.createAgentSession.mockImplementation(async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter,prompt:string){
    expect(prompt).toContain('Reply-to question context (not consent)');expect(prompt).toContain(f.question.questionId);
    ticketScope.onQuestion({...ticketScope.context,actionId:'defer-discussion'},{action:'defer',question_ids:[f.question.questionId]});
    this.emit('output',JSON.stringify({type:'result',result:'We can discuss the options first.'}));
  }}) as unknown as SessionProcess);
  const answer=await f.runtime.send({scope:f.scope,text:'Can we discuss alternatives later?',metadata:{repliedMessageId:message}},{execute:true,writeMemory:false},{timeoutMs:5000});
  expect(answer).toBe('We can discuss the options first.');
  expect(f.runtime.store.task(f.task.taskId)!.state).toBe('waiting_input');
  expect(f.runtime.store.task(f.task.taskId)!.revision).toBe(1);
  expect(f.runtime.questionControls.context(f.task.conversationId,'owner')[0].eligibleToAsk).toBe(false);
 }finally{await f.close();}
});

test('initial internal question review emits only the separately staged natural question',async()=>{
 const f=await fixture();
 try{
  (f.runtime as any).config.conversation.notificationPolicy='next_user_turn';
  const lateNotification=randomUUID();
  const begin=f.runtime.decisions.begin.bind(f.runtime.decisions);
  jest.spyOn(f.runtime.decisions,'begin').mockImplementationOnce((...args)=>{
    // Arrives after initialReviews chose this conversation but before begin.
    f.runtime.store.run('INSERT INTO notifications(id,conversation_id,task_id,task_state_version,originating_binding_id) VALUES(?,?,?,?,?)',lateNotification,f.task.conversationId,f.task.taskId,999,f.runtime.store.get('SELECT binding_id FROM task_questions WHERE question_id=?',f.question.questionId)!.binding_id);
    return begin(...args);
  });
  let ticketScope:any;
  const issue=f.runtime.bridge.issue.bind(f.runtime.bridge);
  jest.spyOn(f.runtime.bridge,'issue').mockImplementation((scope,...args)=>{ticketScope=scope;return issue(scope,...args);});
  f.createAgentSession.mockImplementation(async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){
    ticketScope.onQuestion({...ticketScope.context,actionId:'ask-natural'},{action:'ask',question_ids:[f.question.questionId],text:'Which environment should I use for the deployment?'});
    this.emit('output',JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text:'Duplicate question that must not appear'}}}));
    this.emit('output',JSON.stringify({type:'result',result:'Duplicate question that must not appear'}));
  }}) as unknown as SessionProcess);
  const seen=jest.fn();f.runtime.subscribeText(f.scope.agentSessionId,'owner',seen);
  (f.runtime as any).pumpMailbox();
  const until=Date.now()+5000;while(!seen.mock.calls.length&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  expect(seen.mock.calls.map(call=>call[0].text)).toEqual(['Which environment should I use for the deployment?']);
  expect(f.runtime.store.get('SELECT status,decision_id FROM notifications WHERE id=?',lateNotification)).toMatchObject({status:'pending',decision_id:null});
  expect(f.runtime.store.task(f.task.taskId)!.state).toBe('waiting_input');
 }finally{await f.close();}
});
