import { EventEmitter } from 'events';
import { AgentRunner } from '../../../src/agent/runner';
import { TurnStreamRegistry } from '../../../src/agent/turn-stream';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentOrchestrationRuntime, AgentOrchestrationHost } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import * as catalog from '../../../src/voice/providers/voice-catalog';
import { WorkerDriver } from '../../../src/orchestration/tasks/scheduler';

test('materials survive a silent turn; complete instruction acknowledges before work and does not wait for the timer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'semantic-intake-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a/workspace'), description: 'fixture', env: '',
    claude: { model: 'fixture', extraFlags: [] }, orchestration: { conversation: { semanticIntake: true, intakeWaitMs: 60000 } } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  let turn = 0, action = 0;
  const order: string[] = [], failures: unknown[] = [];
  let runtime: AgentOrchestrationRuntime;
  const host: AgentOrchestrationHost = {
    createAgentSession: async (_id, profile) => {
      const config = JSON.parse(readFileSync(profile.mcpConfigPath, 'utf8'));
      const ticket = JSON.parse(readFileSync(config.mcpServers.gateway.env.GATEWAY_ORCHESTRATION_TICKET_FILE, 'utf8'));
      const call = async (tool: string, args: unknown) => {
        const response = await fetch(ticket.url, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool, args, action_id: `action-${++action}` }) });
        return response.json() as Promise<Record<string, unknown>>;
      };
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = text => { void (async () => {
        if (++turn === 1) {
          expect(await call('conversation_intake', {mode:'wait', preparation:'The material is a quarterly report.', clarification:'What should I check in this report?'})).toEqual({waiting:true,prepared:true});
          process.emit('output', JSON.stringify({type:'result',result:''}));
        } else {
          expect(text).toContain('quarterly report');
          const spawn = {title:'Review the report',instructions:'Review the original quarterly report.',target_profile:'default-worker'};
          expect(await call('task_spawn', spawn)).toMatchObject({error:'ACKNOWLEDGEMENT_REQUIRED'});
          const ack = await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing the report now.'});
          expect(ack).not.toHaveProperty('error');
          expect(ack.acknowledged).toBe(true);
          expect(order).toContain('ack');
          const task = await call('task_spawn',spawn);
          expect(task.error).toBeUndefined();
          expect(task.taskId).toBeTruthy();
          order.push('task');
          process.emit('output',JSON.stringify({type:'result',result:'Work started.'}));
        }
      })().catch(error => { failures.push(error); process.emit('output',JSON.stringify({type:'result',result:'fixture failed'})); }); };
      return process;
    }, releaseAgentSession: async () => {},
  };
  const worker: WorkerDriver = {start:jest.fn()};
  runtime = await AgentOrchestrationRuntime.open(agent,gateway,root,sessions,history,host,worker);
  const scope = {agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'key',chatId:'c',threadKey:'',principalId:'p'};
  try {
    expect(await runtime.send({scope,text:'Here is the quarterly report.'},{execute:true,writeMemory:false},{timeoutMs:2000})).toBe('');
    expect((await sessions.loadSession('a','s')).map(message=>message.role)).toEqual(['user']);
    const started = Date.now();
    const result = await runtime.send({scope,text:'Please review it.'},{execute:true,writeMemory:false},{timeoutMs:2000,onText:text=>{if(text.includes('reviewing'))order.push('ack');}});
    expect(failures).toEqual([]);
    expect(result).toBe('I am reviewing the report now.');
    expect(Date.now()-started).toBeLessThan(2000);
    expect(order).toEqual(['ack','task']);
    const messages=await sessions.loadSession('a','s');
    expect(messages.map(message=>message.role)).toEqual(['user','user','assistant']);
    expect(messages.slice(-1).map(message=>message.content)).toEqual(['I am reviewing the report now.']);
  } finally { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root,'a'); rmSync(root,{recursive:true,force:true}); }
});

type Call = (tool: string, args: Record<string, unknown>) => Promise<any>;
async function fixture(script: (call: Call, text: string, turn: number) => Promise<void | string>, options: {source?: 'api'|'telegram'|'discord'|'line'|'slack'; voice?:boolean} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'intake-flow-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = {id:'a',workspace:join(root,'a/workspace'),description:'fixture',env:'',claude:{model:'fixture',extraFlags:[]},
    orchestration:{conversation:{semanticIntake:true,intakeWaitMs:2000,notificationPolicy:'next_user_turn'}}};
  if(options.voice)agent.voice={enabled:true,tts:{provider:'elevenlabs',model:'eleven_flash_v2_5',voiceId:'fixture'},stt:{provider:'elevenlabs',model:'scribe_v2_realtime'},notes:{enabled:true,provider:'elevenlabs',model:'scribe_v2'}};
  const gateway = {gateway:{orchestration:true,headless:true,logDir:join(root,'logs'),timezone:'UTC'},agents:[agent]} as GatewayConfig;
  let turn = 0, action = 0;
  const failures: unknown[] = [];
  const host: AgentOrchestrationHost = {createAgentSession:async (_id,profile)=>{
    const config=JSON.parse(readFileSync(profile.mcpConfigPath,'utf8'));
    const ticket=JSON.parse(readFileSync(config.mcpServers.gateway.env.GATEWAY_ORCHESTRATION_TICKET_FILE,'utf8'));
    const call:Call=async(tool,args)=>{
      const response=await fetch(ticket.url,{method:'POST',headers:{Authorization:`Bearer ${ticket.token}`,'Content-Type':'application/json'},body:JSON.stringify({tool,args,action_id:`${++action}`})});
      return response.json();
    };
    const process=new EventEmitter() as SessionProcess;
    process.start=async()=>{};process.stop=async()=>{};
    process.sendMessage=text=>{void script(call,text,++turn).then(result=>process.emit('output',JSON.stringify({type:'result',result:result??''})),error=>{
      failures.push(error);process.emit('output',JSON.stringify({type:'result',result:'fixture failed'}));
    });};
    return process;
  },releaseAgentSession:async()=>{}};
  const worker:WorkerDriver={start:async()=>{
    let complete!:(value:{type:'stopped'})=>void;
    return {accepted:Promise.resolve(),result:new Promise(resolve=>{complete=resolve;}),stop:async()=>{complete({type:'stopped'});}};
  }};
  const runtime=await AgentOrchestrationRuntime.open(agent,gateway,root,sessions,history,host,worker);
  const scope={agentId:'a',agentSessionId:'s',source:options.source??'api',accountId:'key',chatId:'c',threadKey:'',principalId:'p'};
  return {runtime,scope,failures,sessions,agent,
    send:(text:string)=>runtime.send({scope,text},{execute:true,writeMemory:false},{timeoutMs:3000}),
    close:async()=>{await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});},
  };
}
const spawnArgs={title:'Review material',instructions:'Review material and preserve the user constraints.',target_profile:'default-worker'};

test('an amendment acknowledges and updates the same task; duplicate spawn is rejected',async()=>{
  let taskId='';
  const f=await fixture(async(call,_text,turn)=>{
    if(turn===1){
      expect((await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing it.'})).acknowledged).toBe(true);
      taskId=(await call('task_spawn',spawnArgs)).taskId;
      expect(taskId).toBeTruthy();
    }else{
      const ack=await call('conversation_intake',{mode:'update',task_id:taskId,acknowledgement:'I will include the appendix in the review.'});
      expect(ack.acknowledged).toBe(true);
      expect(await call('conversation_intake',{mode:'update',task_id:taskId,acknowledgement:'Duplicate receipt'})).toEqual(ack);
      expect(await call('task_spawn',spawnArgs)).toEqual({error:'INTAKE_TASK_MISMATCH'});
      const updated=await call('task_update',{task_id:taskId,expected_revision:1,instruction:'Review the report AND its appendix, preserving all prior constraints.',mode:'when_ready'});
      expect(updated.revision).toBe(2);
    }
  });
  try{
    await f.send('Review this');await f.send('Include the appendix too');
    expect(f.failures).toEqual([]);
    expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(1);
    expect(f.runtime.tasks.revision(taskId,2).instructions).toContain('appendix');
    expect((await f.sessions.loadSession('a','s')).filter(m=>m.role==='assistant').map(m=>m.content)).toEqual([
      'I am reviewing it.',
      'I will include the appendix in the review.',
      'Some task commands were rejected. Other commands succeeded; please check /tasks for the current task status.',
    ]);
  }finally{await f.close();}
});

test('voice acknowledgement requests audio but pending playback does not block task creation',async()=>{
  const order:string[]=[];
  let releaseAudio!:()=>void;
  const audioReady=new Promise<void>(resolve=>{releaseAudio=resolve;});
  let audioPlayback:Promise<void>|undefined;
  const f=await fixture(async(call)=>{
    const ack=call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing the report.'});
    // Wait for the text receipt; voice emission is deliberately still pending.
    while(!order.includes('speech-request'))await new Promise(resolve=>setTimeout(resolve,1));
    expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(0);
    const task=call('task_spawn',spawnArgs);
    expect((await ack).acknowledged).toBe(true);
    expect((await task).taskId).toBeTruthy();
    order.push('task');
  });
  const unsubscribe=f.runtime.subscribeVoiceResults('s','p',result=>{
    order.push('speech-request');
    audioPlayback=audioReady.then(()=>{
      order.push('audio');
      f.runtime.recordPlayback(result.responseId,'p',{generation:'fixture',epoch:1,generatedSamples:160,playedSamples:0},'streaming');
    });
  });
  try{
    expect(await f.send('Review the report')).toBe('I am reviewing the report.');
    expect(f.failures).toEqual([]);
    expect(order).toEqual(['speech-request','task']);
    expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(1);
    releaseAudio();await audioPlayback;
    expect(order).toEqual(['speech-request','task','audio']);
  }finally{releaseAudio();await audioPlayback;unsubscribe();await f.close();}
});

test('new input arriving while reading defers stale execution and preserves the original instruction',async()=>{
  let received!:()=>void, continueReading!:()=>void;
  const firstRead=new Promise<void>(resolve=>{received=resolve;}), release=new Promise<void>(resolve=>{continueReading=resolve;});
  const f=await fixture(async(call,text,turn)=>{
    if(turn===1){
      received();await release;
      expect((await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing the report.'})).deferred).toBe(true);
      expect(await call('task_spawn',spawnArgs)).toEqual({error:'NEW_INPUT_PENDING'});
    }else{
      expect(text).toContain('Review the report');expect(text).toContain('Include appendix');
      expect((await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing the report and appendix.'})).acknowledged).toBe(true);
      expect((await call('task_spawn',spawnArgs)).taskId).toBeTruthy();
    }
  });
  try{
    const first=f.runtime.submitInput({scope:f.scope,text:'Review the report'},{execute:true,writeMemory:false});
    await firstRead;
    const second=f.runtime.submitInput({scope:f.scope,text:'Include appendix'},{execute:true,writeMemory:false});
    continueReading();
    expect(await first.response).toBe('');
    expect(await second.response).toBe('I am reviewing the report and appendix.');
    expect(f.failures).toEqual([]);
    expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(1);
    expect((await f.sessions.loadSession('a','s')).map(m=>m.role)).toEqual(['user','user','assistant']);
  }finally{continueReading();await f.close();}
});


test.each(['telegram','discord','line','slack'] as const)('%s delivers text then voice before task creation',async source=>{
  const voices=jest.spyOn(catalog,'voiceChoices').mockResolvedValue([]);
  const order:string[]=[];
  const f=await fixture(async call=>{
    expect((await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing this.'})).acknowledged).toBe(true);
    expect(order).toEqual(['text','speech']);
    expect((await call('task_spawn',spawnArgs)).taskId).toBeTruthy();order.push('task');
  },{source,voice:true});
  f.runtime.store.setChannelVoiceMode(source,'c','','on');
  (f.runtime as any).delivery.send=async(_binding:any,_text:string,_id:string,_file:any,speech:any)=>{
    order.push(speech?'speech':'text');return {state:'delivered',providerId:'fixture'};
  };
  try{await f.send('Review this');expect(f.failures).toEqual([]);expect(order).toEqual(['text','speech','task']);}
  finally{await f.close();voices.mockRestore();}
});

test('explicit cancellation can fence existing work before acknowledgement',async()=>{
  let taskId='';
  const f=await fixture(async(call,_text,turn)=>{
    if(turn===1){
      await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing this.'});taskId=(await call('task_spawn',spawnArgs)).taskId;
    }else{
      const cancelled=await call('task_cancel',{task_id:taskId});
      expect(cancelled.error).toBeUndefined();expect(['cancelled','cancel_requested']).toContain(cancelled.state);
      expect((await call('conversation_intake',{mode:'ready',acknowledgement:'I have requested the stop.'})).acknowledged).toBe(true);
    }
  });
  try{await f.send('Review this');await f.send('Stop this task');expect(f.failures).toEqual([]);}
  finally{await f.close();}
});


test('an acknowledgement-only task turn keeps previous worker reports pending', async () => {
  const f = await fixture(async call => {
    expect((await call('conversation_intake', {mode:'ready', acknowledgement:'I am checking the new request.'})).acknowledged).toBe(true);
    expect((await call('task_spawn', spawnArgs)).taskId).toBeTruthy();
  });
  try {
    const input = f.runtime.store.acceptInput({scope:f.scope, text:'Previous request'});
    const decision = f.runtime.decisions.begin(input.conversationId,'p',[input.inputId]);
    const task = f.runtime.tasks.spawn({...input,...decision,principalId:'p',execute:true,writeMemory:false,actionId:'previous'},spawnTask());
    f.runtime.decisions.finish(decision,'Working');
    const attempt = f.runtime.tasks.claim(task.taskId)!;
    f.runtime.tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'Important previous result',artifactIds:[]}});
    await f.send('Check another request');
    expect(f.failures).toEqual([]);
    expect(f.runtime.store.get('SELECT status,decision_id FROM notifications WHERE task_id=?',task.taskId)).toMatchObject({status:'pending',decision_id:null});
    const report = f.runtime.store.acceptInput({scope:f.scope,text:'Report previous results',storeUserMessage:false});
    const reporting = f.runtime.decisions.begin(report.conversationId,'p',[report.inputId]);
    expect(JSON.stringify(f.runtime.tasks.context(report.conversationId,'p',reporting.decisionId))).toContain('Important previous result');
    f.runtime.decisions.finish(reporting,'Important previous result');
  } finally { await f.close(); }
});
function spawnTask() { return {title:'Previous task',instructions:'Complete the previous request',targetProfile:'default-worker'}; }

test('a direct answer consumes prior materials without requiring another intake call', async () => {
  const f = await fixture(async (call, text, turn) => {
    if (turn === 1) {
      await call('conversation_intake',{mode:'wait',preparation:'Unique prepared report context',clarification:'What should I check?'});
    } else if (turn === 2) {
      expect(text).toContain('Unique prepared report context');
      return 'The report has two sections.';
    }
  });
  try {
    await f.send('Here is a report');
    await f.send('How many sections does it have?');
    expect(f.failures).toEqual([]);
    expect(f.runtime.store.get('SELECT COUNT(*) n FROM conversation_intake')!.n).toBe(0);
  } finally { await f.close(); }
});


test('web continuation of a channel chat streams the acknowledgement before the task receipt', async () => {
  const chunks: string[] = [];
  let taskStarted = false;
  const f = await fixture(async (call, _text, turn) => {
    if (turn === 1) return 'Hello';
    const ack = await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing the report.'});
    expect(ack.acknowledged).toBe(true);
    expect(chunks.join('')).toBe('I am reviewing the report.');
    expect((await call('task_spawn',spawnArgs)).taskId).toBeTruthy();
    taskStarted = true;
  },{source:'telegram'});
  (f.runtime as any).delivery.send=async()=>({state:'delivered',providerId:'fixture'});
  const runner = Object.assign(Object.create(AgentRunner.prototype), {
    agentConfig:{...f.agent,orchestration:{...f.agent.orchestration,enabled:true,channels:['telegram']}},
    sessionStore:f.sessions,orchestration:f.runtime,turnStreams:new TurnStreamRegistry(),
  });
  try {
    await f.send('Hello');
    let done!:()=>void;
    const completed = new Promise<void>(resolve=>{done=resolve;});
    await runner.sendMessageToSession('c','telegram','s','Review the report',undefined,{
      onChunk:(event:any)=>{if(event.type==='text_delta')chunks.push(event.text);},
      onDone:()=>done(),onError:()=>done(),
    },{timeoutMs:3000,principalId:'web-user',allowTools:true});
    await completed;
    expect(f.failures).toEqual([]);
    expect(taskStarted).toBe(true);
    expect(chunks.join('')).toBe('I am reviewing the report.');
  } finally { await f.close(); }
});

test('activity orders a completed answer after its earlier acknowledgement', async () => {
 const f=await fixture(async call=>{
  await call('conversation_intake',{mode:'ready',acknowledgement:'I am checking the supplied material.'});
  return 'The supplied material has two sections.';
 });
 try {
  await f.send('Check the supplied material');
  expect(f.failures).toEqual([]);
  const rows=f.runtime.activity('s','p').responses;
  expect(rows.map(r=>r.text)).toEqual(['I am checking the supplied material.','The supplied material has two sections.']);
  expect(Number(rows[1].createdAt)).toBeGreaterThanOrEqual(Number(rows[0].createdAt));
 }finally{await f.close();}
});

test.each([false,true])('corrected skill/profile dispatch preserves unrelated failures: %s', async extraFailure => {
 const f=await fixture(async call=>{
  await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing the material.'});
  expect(await call('task_spawn',{...spawnArgs,skill_name:'fixture',skill_args:''})).toMatchObject({error:'INVALID_INPUT'});
  expect((await call('task_spawn',spawnArgs)).taskId).toBeTruthy();
  if(extraFailure)expect(await call('task_spawn',{...spawnArgs,title:'A different assignment',skill_name:'fixture'})).toMatchObject({error:'INVALID_INPUT'});
  return 'Work started.';
 });
 try {
  const result=await f.send('Review the material');
  expect(f.failures).toEqual([]);
  expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(1);
  if(extraFailure)expect(result).toContain('Some task commands were rejected');
  else expect(result).toBe('I am reviewing the material.'); // Return the delivered acknowledgement, not a second warning.
 } finally {await f.close();}
});

 test('explicit retry reference links a corrected brief through the real bridge',async()=>{
  const f=await fixture(async call=>{
   await call('conversation_intake',{mode:'ready',acknowledgement:'I am checking it.'});
   const rejected=await call('task_spawn',{...spawnArgs,skill_name:'fixture'});
   expect(rejected.error).toBe('INVALID_INPUT');expect(typeof rejected.retry_of).toBe('string');
   const accepted=await call('task_spawn',{...spawnArgs,instructions:'Corrected brief for the same authorized work',retry_of:rejected.retry_of});
   expect(accepted.taskId).toBeTruthy();return 'Started.';
  });
  try{expect(await f.send('Check it')).toBe('I am checking it.');expect(f.failures).toEqual([]);}finally{await f.close();}
 });

test.each([false, true])('deferred dispatch survives a casual reply or is explicitly cancelled: %s', async cancel => {
 let ready!:()=>void, release!:()=>void, recovered!:()=>void;
 const reading = new Promise<void>(resolve=>{ready=resolve;});
 const resume = new Promise<void>(resolve=>{release=resolve;});
 const recovery = new Promise<void>(resolve=>{recovered=resolve;});
 const f = await fixture(async (call, text, turn) => {
  if (turn === 1) {
   ready(); await resume;
   expect((await call('conversation_intake',{mode:'ready',acknowledgement:'I will review it.',preparation:'Authorized report review is not queued yet'})).deferred).toBe(true);
   expect(await call('task_spawn',spawnArgs)).toEqual({error:'NEW_INPUT_PENDING'});
  } else if (turn === 2) {
   expect(text).toContain('"deferredDispatch":true');
   if (cancel) {
    expect(await call('conversation_intake',{mode:'resolve',resolution:'The user cancelled the pending review.'})).toEqual({resolved:true});
    return 'Cancelled.';
   }
   return 'Understood.';
  } else {
   expect(turn).toBe(3);
   expect(text).toContain('"deferredDispatch":true');
   expect(text).toContain('Authorized report review is not queued yet');
   await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing it now.'});
   expect((await call('task_spawn',spawnArgs)).taskId).toBeTruthy();
   recovered();
  }
 });
 try {
  const first=f.runtime.submitInput({scope:f.scope,text:'Review the report'},{execute:true,writeMemory:false});
  await reading;
  const second=f.runtime.submitInput({scope:f.scope,text:cancel?'Cancel the review':'I will wait'},{execute:true,writeMemory:false});
  release(); await first.response; await second.response;
  if (!cancel) await Promise.race([recovery,new Promise((_,reject)=>{setTimeout(()=>reject(new Error('No reconciliation turn')),2000).unref();})]);
  for(let i=0;i<100 && f.runtime.store.get('SELECT count(*) n FROM conversation_intake')!.n;i++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(f.failures).toEqual([]);
  expect(f.runtime.store.get('SELECT count(*) n FROM conversation_intake')!.n).toBe(0);
  expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(cancel?0:1);
  expect(f.runtime.store.get("SELECT count(*) n FROM conversation_inputs WHERE store_user_message=0 AND ingress_json LIKE '%intake-recovery:%'")!.n).toBe(cancel?0:1);
 } finally {release();await f.close();}
});

test('a rejected continuation spawn followed by the intended update has no false warning',async()=>{
 let taskId='';
 const f=await fixture(async(call,_text,turn)=>{
  if(turn===1){
   await call('conversation_intake',{mode:'ready',acknowledgement:'I am reviewing it.'});
   taskId=(await call('task_spawn',spawnArgs)).taskId;
  }else{
   await call('conversation_intake',{mode:'update',task_id:taskId,acknowledgement:'I will include the appendix.'});
   expect(await call('task_spawn',{...spawnArgs,continue_task_id:taskId})).toEqual({error:'INTAKE_TASK_MISMATCH'});
   expect((await call('task_update',{task_id:taskId,expected_revision:1,instruction:'Review the report and appendix.',mode:'when_ready'})).revision).toBe(2);
  }
 });
 try{
  await f.send('Review this');
  expect(await f.send('Include appendix')).toBe('I will include the appendix.');
  expect(f.failures).toEqual([]);
 }finally{await f.close();}
});

test('reconciliation is bounded if the model only replies again',async()=>{
 let ready!:()=>void,release!:()=>void,reconciled!:()=>void;
 const reading=new Promise<void>(resolve=>{ready=resolve;});
 const resume=new Promise<void>(resolve=>{release=resolve;});
 const recovery=new Promise<void>(resolve=>{reconciled=resolve;});
 let turns=0;
 const f=await fixture(async(call,_text,turn)=>{
  turns=turn;
  if(turn===1){
   ready();await resume;
   expect((await call('conversation_intake',{mode:'ready',acknowledgement:'I will review it.'})).deferred).toBe(true);
  }else if(turn===3)reconciled();
  return 'Understood.';
 });
 try{
  const first=f.runtime.submitInput({scope:f.scope,text:'Review this'},{execute:true,writeMemory:false});
  await reading;
  const second=f.runtime.submitInput({scope:f.scope,text:'I will wait'},{execute:true,writeMemory:false});
  release();await first.response;await second.response;
  await recovery;
  await new Promise(resolve=>setTimeout(resolve,100));
  expect(f.failures).toEqual([]);
  expect(turns).toBe(3);
  expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(0);
  expect(JSON.parse(String(f.runtime.store.get('SELECT data_json FROM conversation_intake')!.data_json)).deferredDispatch).toBe(true);
 }finally{release();await f.close();}
});
