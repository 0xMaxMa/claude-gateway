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

async function fixture(source: 'api'|'telegram'|'discord'|'line'|'slack' = 'api') {
 const root=mkdtempSync(join(tmpdir(),'question-runtime-')),dir=join(root,'a'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]},orchestration:{conversation:{semanticIntake:true}}} as AgentConfig;
 const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
 const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a'),sid=randomUUID();
 await sessions.ensureApiSession('a','chat',sid);
 const createAgentSession=jest.fn();
 const runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{createAgentSession,releaseAgentSession:async()=>{}});
 const scope={agentId:'a',agentSessionId:sid,source,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
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


test.each((['api','telegram','discord','line','slack'] as const).flatMap(source => (['absent','pending','failed'] as const).filter(audioState=>source!=='api'||audioState==='absent').map(audioState=>({source,audioState}))))('acknowledgement permits dispatch on $source with $audioState audio',async ({source,audioState})=>{
 const f=await fixture(source);
 try{
  (f.runtime as any).config.voice.enabled=true;
  (f.runtime as any).config.voice.notes.replyWithVoice=true;
  f.runtime.store.setChannelVoiceMode(source,f.scope.chatId,'','on');
  // Reproduce suppressed audio (e.g. quota/policy or a detached live player).
  jest.spyOn((f.runtime as any).delivery,'enqueueSpeech').mockImplementation((...args: unknown[])=>{
   if(audioState!=='absent') f.runtime.store.run('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?)',randomUUID(),String(args[0]),null,String(args[1]),'speech',audioState,null,'{}',null,Date.now());
  });
  (f.runtime as any).delivery.send=jest.fn(async()=>({state:'delivered'}));
  let scope:any;
  const issue=f.runtime.bridge.issue.bind(f.runtime.bridge);
  jest.spyOn(f.runtime.bridge,'issue').mockImplementation((value,...args)=>{scope=value;return issue(value,...args);});
  const dispatched=jest.fn();
  f.createAgentSession.mockImplementation(async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){
   const emitter=this;
   void(async()=>{
    await scope.onIntake({mode:'ready',acknowledgement:'I will inspect the PR.'});
    await scope.beforeMutation('task_spawn',{});
    const task=f.runtime.tasks.spawn({...scope.context,actionId:'new-review'},{title:'Inspect PR',instructions:'Inspect read-only',targetProfile:'default-worker'});
    dispatched(task);
    emitter.emit('output',JSON.stringify({type:'result',result:'Work started.'}));
   })().catch(error=>emitter.emit('error',error));
  }}) as unknown as SessionProcess);
  await f.runtime.send({scope:f.scope,text:'Inspect the PR',modality:source==='api'?'live_voice':'text'},{execute:true,writeMemory:false},{timeoutMs:5000});
  expect(dispatched).toHaveBeenCalledTimes(1);
  if(source!=='api'){
   expect((f.runtime as any).delivery.enqueueSpeech).toHaveBeenCalled();
   if(audioState!=='absent')expect(f.runtime.store.get("SELECT state FROM deliveries WHERE modality='speech'")!.state).toBe(audioState);
  }
  expect(f.runtime.store.get("SELECT COUNT(*) n FROM task_commands WHERE action_id='new-review'")!.n).toBe(1);
 }finally{await f.close();}
});

test('failed task dispatch cannot finish with a false promise of background work',async()=>{
 const f=await fixture();
 try{
  let scope:any;
  const issue=f.runtime.bridge.issue.bind(f.runtime.bridge);
  jest.spyOn(f.runtime.bridge,'issue').mockImplementation((value,...args)=>{scope=value;return issue(value,...args);});
  f.createAgentSession.mockImplementation(async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){
   const emitter=this;
   void(async()=>{
    await scope.onIntake({mode:'ready',acknowledgement:'I will inspect it.'});
    await scope.beforeMutation('task_spawn',{});
    try { f.runtime.tasks.spawn({...scope.context,actionId:'bad-spawn'},{title:'',instructions:'',targetProfile:'default-worker'}); } catch {}
    emitter.emit('output',JSON.stringify({type:'result',result:'I am working on it and will report back.'}));
   })().catch(error=>emitter.emit('error',error));
  }}) as unknown as SessionProcess);
  expect(await f.runtime.send({scope:f.scope,text:'Inspect it'},{execute:true,writeMemory:false},{timeoutMs:5000})).toBe('The requested task was not started or updated. Please try again.');
  expect(f.runtime.store.get("SELECT action_id FROM task_commands WHERE action_id='bad-spawn'")).toBeUndefined();
 }finally{await f.close();}
});


test('undelivered text acknowledgement still blocks new work',async()=>{
 const f=await fixture('telegram');
 try{
  (f.runtime as any).delivery.send=jest.fn(async()=>({state:'failed',code:'TEST_FAILURE'}));
  let scope:any;const failures:unknown[]=[];
  const issue=f.runtime.bridge.issue.bind(f.runtime.bridge);
  jest.spyOn(f.runtime.bridge,'issue').mockImplementation((value,...args)=>{scope=value;return issue(value,...args);});
  f.createAgentSession.mockImplementation(async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){
   const emitter=this;
   void(async()=>{
    try{await scope.onIntake({mode:'ready',acknowledgement:'I will inspect it.'});}catch(error){failures.push(error);}
    try{await scope.beforeMutation('task_spawn',{});}catch(error){failures.push(error);}
    emitter.emit('output',JSON.stringify({type:'result',result:'I am working on it.'}));
   })().catch(error=>emitter.emit('error',error));
  }}) as unknown as SessionProcess);
  const result=await f.runtime.send({scope:f.scope,text:'Inspect it'},{execute:true,writeMemory:false},{timeoutMs:5000});
  expect(failures).toEqual([expect.objectContaining({code:'ACKNOWLEDGEMENT_DELIVERY_PENDING'}),expect.objectContaining({code:'ACKNOWLEDGEMENT_REQUIRED'})]);
  expect(result).toContain('not started or updated');
 }finally{await f.close();}
});

test.each(['live playback failure','earlier pending speech','partial dispatch','recovered receipt','corrected retry','conflicting replay'] as const)('%s does not silently lose requested work',async scenario=>{
 const f=await fixture(scenario==='earlier pending speech'?'telegram':'api');
 let release=()=>{};let pending:Promise<void>|undefined;
 try{
  (f.runtime as any).config.voice.enabled=true;
  (f.runtime as any).config.voice.notes.replyWithVoice=true;
  if(scenario==='live playback failure') f.runtime.subscribeVoiceResults(f.scope.agentSessionId,'owner',()=>{throw new Error('Playback unavailable');});
  const delivery=(f.runtime as any).delivery;
  if(scenario==='earlier pending speech'){
   let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
   const blocked=new Promise<void>(resolve=>{release=resolve;});
   delivery.send=jest.fn(async(_binding:unknown,_text:unknown,_id:unknown,_file:unknown,speech:unknown)=>{if(speech){entered();await blocked;}return {state:'delivered'};});
   const notice=f.runtime.decisions.notice(f.task.conversationId,'Older response',true);
   const binding=f.runtime.store.get('SELECT id FROM conversation_bindings WHERE conversation_id=?',f.task.conversationId)!.id;
   f.runtime.store.transaction(()=>delivery.enqueueSpeech(notice,binding,{provider:'elevenlabs',model:'fixture',voiceId:'fixture',text:'Older speech'}));
   pending=delivery.tick();await started;
  }else delivery.send=jest.fn(async()=>({state:'delivered'}));
  let scope:any;const issue=f.runtime.bridge.issue.bind(f.runtime.bridge);
  jest.spyOn(f.runtime.bridge,'issue').mockImplementation((value,...args)=>{scope=value;return issue(value,...args);});
  f.createAgentSession.mockImplementation(async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){
   const emitter=this;
   void(async()=>{
    await scope.onIntake({mode:'ready',acknowledgement:'I will run the checks.'});
    await scope.beforeMutation('task_spawn',{},'successful-check');
    f.runtime.tasks.spawn({...scope.context,actionId:'successful-check'},{title:'Check',instructions:'Inspect read-only',targetProfile:'default-worker'});
    if(scenario==='conflicting replay'){
     await scope.beforeMutation('task_spawn',{},'successful-check');
     scope.onMutationResult('successful-check',false);
    }
    if(scenario==='recovered receipt'){
     // Recovery can return an existing committed receipt under a new action ID.
     await scope.beforeMutation('task_spawn',{},'recovered-action');
     scope.onMutationResult('recovered-action',true);
    }
    if(scenario==='partial dispatch'||scenario==='corrected retry'){
     await scope.beforeMutation('task_spawn',{},'failed-check');
     try{f.runtime.tasks.spawn({...scope.context,actionId:'failed-check'},{title:'',instructions:'',targetProfile:'default-worker'});}catch{}
    }
    if(scenario==='corrected retry'){
     await scope.beforeMutation('task_spawn',{},'corrected-check');
     f.runtime.tasks.spawn({...scope.context,actionId:'corrected-check'},{title:'Corrected check',instructions:'Inspect read-only',targetProfile:'default-worker'});
    }
    emitter.emit('output',JSON.stringify({type:'result',result:'I am working on all checks.'}));
   })().catch(error=>emitter.emit('error',error));
  }}) as unknown as SessionProcess);
  const result=await f.runtime.send({scope:f.scope,text:'Run the checks',modality:'live_voice'},{execute:true,writeMemory:false},{timeoutMs:5000});
  expect(f.runtime.store.get("SELECT action_id FROM task_commands WHERE action_id='successful-check'")).toBeDefined();
  if(scenario==='earlier pending speech'){
   await Promise.all([delivery.tickText(),delivery.tickText(),delivery.tickText()]);
   const ids=delivery.send.mock.calls.map((call:unknown[])=>call[2]);
   expect(new Set(ids).size).toBe(ids.length);
  }
  if(scenario==='partial dispatch'||scenario==='corrected retry'||scenario==='conflicting replay')expect(result).toContain('Some task commands were rejected');
  if(scenario==='recovered receipt'||scenario==='corrected retry')expect(result).not.toMatch(/not started|not.*updated/);
  if(scenario==='live playback failure')expect(f.runtime.store.get("SELECT COUNT(*) n FROM conversation_events WHERE type='response.speech_failed'")!.n).toBeGreaterThan(0);
 }finally{release();await pending;await f.close();}
});

test('failed optional speech notice does not block an already delivered acknowledgement',async()=>{
 const f=await fixture('telegram');
 try{
  (f.runtime as any).config.voice.enabled=true;
  (f.runtime as any).config.voice.notes.replyWithVoice=true;
  f.runtime.store.setChannelVoiceMode('telegram',f.scope.chatId,'','on');
  const delivery=(f.runtime as any).delivery;
  delivery.send=jest.fn(async(_binding:unknown,text:string,_id:unknown,_file:unknown,speech:unknown)=>speech
   ? {state:'failed',code:'VOICE_PROVIDER_ERROR_HTTP_429',speechSynthesisFailed:true}
   : text.startsWith('Voice rate limit') ? {state:'failed',code:'NOTICE_FAILED'} : {state:'delivered'});
  let scope:any;const failures:unknown[]=[];
  const issue=f.runtime.bridge.issue.bind(f.runtime.bridge);
  jest.spyOn(f.runtime.bridge,'issue').mockImplementation((value,...args)=>{scope=value;return issue(value,...args);});
  f.createAgentSession.mockImplementation(async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){
   const emitter=this;
   void(async()=>{
    try{await scope.onIntake({mode:'ready',acknowledgement:'I will inspect it.'});}catch(error){failures.push(error);}
    try{
     await scope.beforeMutation('task_spawn',{},'requested-check');
     f.runtime.tasks.spawn({...scope.context,actionId:'requested-check'},{title:'Check',instructions:'Inspect read-only',targetProfile:'default-worker'});
    }catch(error){failures.push(error);}
    emitter.emit('output',JSON.stringify({type:'result',result:'I am working on it.'}));
   })().catch(error=>emitter.emit('error',error));
  }}) as unknown as SessionProcess);
  await f.runtime.send({scope:f.scope,text:'Inspect it'},{execute:true,writeMemory:false},{timeoutMs:5000});
  expect(f.runtime.store.get("SELECT state FROM deliveries WHERE delivered_text='I will inspect it.'")!.state).toBe('delivered');
  expect(failures).toEqual([]);
  await delivery.tick();
  expect(f.runtime.store.get("SELECT action_id FROM task_commands WHERE action_id='requested-check'")).toBeDefined();
  expect(f.runtime.store.get("SELECT state FROM deliveries WHERE delivered_text LIKE 'Voice rate limit%'")!.state).toBe('failed');
 }finally{await f.close();}
});
