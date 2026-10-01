import {EventEmitter} from 'events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {randomUUID} from 'crypto';
import {AgentOrchestrationRuntime} from '../../../src/orchestration/runtime';
import {SessionStore} from '../../../src/session/store';
import {HistoryDB} from '../../../src/history/db';
import type {SessionProcess} from '../../../src/session/process';
import type {AgentConfig,GatewayConfig} from '../../../src/types';
import {UNREADABLE_DISPLAY_NOTICE} from '../../../src/orchestration/speech';

test.each(['committed','reconnected','screen-fresh','screen-changed','screen-recorded','screen-unavailable','screen-user','screen-owner','screen-stopped','uncommitted','historical','ordinary','ordinary-answer','ordinary-spawn','ordinary-no-command','ordinary-wrong-owner','ordinary-worker','ordinary-historical','ordinary-malformed','nonempty','malformed','user-took-control'])(
 'control reply uses durable current-turn evidence before suppressing an empty reply: %s',async mode=>{
 const ordinary=mode.startsWith('ordinary');
 const committed=mode==='committed'||mode==='reconnected'||mode.startsWith('screen-')||['ordinary','ordinary-answer','ordinary-spawn'].includes(mode);
 const root=mkdtempSync(join(tmpdir(),'control-reply-')),dir=join(root,'a'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
 const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a'),sid=randomUUID();
 await sessions.ensureApiSession('a','chat',sid);
 let taskId='',conversationId='',inferenceCalls=0;
 const runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{
  createAgentSession:async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter,prompt:string,images:unknown[]=[]){
   inferenceCalls++;
   expect(profile.claudeEffort).toBe(ordinary?undefined:'low');
   if(committed&&!ordinary){expect(prompt).not.toContain('prior-ax-tree-marker');expect(prompt).toContain(taskId);}
   if(mode==='screen-fresh'){expect(prompt).toContain('fresh-control-marker');expect(prompt).toContain('computer-control:');expect(images).toHaveLength(1);}
   else if(mode.startsWith('screen-')){expect(prompt).not.toContain('fresh-control-marker');expect(images).toHaveLength(0);}
   const current=runtime.store.get("SELECT id FROM conversation_decisions WHERE conversation_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",conversationId)!;
   // P1-9: the user takes control back while this agent control turn is in flight.
   if(mode==='user-took-control'){const t=runtime.store.task(taskId)!;t.automationController='user';runtime.store.transaction(()=>runtime.store.saveTask(t,t.stateVersion));}
   if(!['uncommitted','ordinary-no-command','user-took-control'].includes(mode))runtime.store.run('INSERT INTO task_commands VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),taskId,conversationId,mode==='ordinary-wrong-owner'?'someone-else':'owner',mode.endsWith('historical')?'earlier-decision':current.id,mode==='ordinary-answer'?'answer':mode==='ordinary-spawn'?'spawn':'update','fixture','{}',Date.now());
   this.emit('output',JSON.stringify({type:'system',subtype:'init',tools:[]}));
   this.emit('output',JSON.stringify({type:'result',result:mode==='nonempty'?'{"display_text":"Need the departure date."}':mode.endsWith('malformed')?'{"display_text":':'{"display_text":""}'}));
  }}) as unknown as SessionProcess,releaseAgentSession:async()=>{},
 });
 const scope={agentId:'a',agentSessionId:sid,source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
 try{
  const input=runtime.store.acceptInput({scope,text:'Search'}),decision=runtime.decisions.begin(input.conversationId,'owner',[input.inputId]);conversationId=input.conversationId;
  const task=runtime.tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'},{title:'Search',instructions:'Search',targetProfile:'default-worker'});taskId=task.taskId;
  const attempt=runtime.tasks.claim(task.taskId)!;
  runtime.tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'Step settled',artifactIds:[]}});
  const settled=runtime.store.task(taskId)!;
  runtime.store.transaction(()=>{if(mode.startsWith('screen-'))settled.gatewayDispatch={requestId:'screen-request',submittedAt:Date.now()};settled.state='waiting_input';settled.automationController='agent';settled.gatewayTarget={adapter:'computer',sessionId:'device',name:'Computer'};if(mode==='ordinary-worker')settled.gatewayTarget=undefined;settled.computerReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1};runtime.store.saveTask(settled,settled.stateVersion);runtime.store.run('UPDATE notifications SET task_state_version=? WHERE task_id=?',settled.stateVersion,taskId);});
  runtime.decisions.finish(decision,'Working');
  // The seed turn may have assigned the notification; make this report pending.
  runtime.store.run("UPDATE notifications SET status='pending',decision_id=NULL WHERE task_id=?",taskId);
  const notification=runtime.store.get('SELECT id FROM notifications WHERE task_id=?',taskId)!;
  if(mode==='reconnected')for(const status of ['disconnected','connected'] as const){const current=runtime.store.task(taskId)!;current.computerConnection=status;runtime.store.transaction(()=>runtime.store.saveTask(current,current.stateVersion));}
  if(committed)(runtime as any).computerAdapter={promptEvidence:()=>({observedAt:1,state:{generation:'prior',text:['prior-ax-tree-marker']}}),close:async()=>{}};
  if(mode.startsWith('screen-'))(runtime as any).computerAdapter={close:async()=>{},computerEvidence:async(_task:unknown,_mode:unknown,signal:AbortSignal)=>{
   if(mode==='screen-stopped'){setImmediate(()=>runtime.stopResponse(sid));return await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
   if(mode==='screen-unavailable')throw Error('COMPUTER_SCREENSHOT_UNAVAILABLE');
   if(['screen-changed','screen-user','screen-owner'].includes(mode)){
    const current=runtime.store.task(taskId)!;
    if(mode==='screen-changed')current.revision++;
    if(mode==='screen-user')current.automationController='user';
    if(mode==='screen-owner')current.ownerPrincipalId='different-owner';
    runtime.store.transaction(()=>runtime.store.saveTask(current,current.stateVersion));
   }
   return {recordedOnly:mode==='screen-recorded',requestId:'screen-request',snapshot:{observedAt:Date.now(),state:{generation:'fresh',text:['fresh-control-marker']}},screenshot:{type:'image',mimeType:'image/jpeg',data:'/9j/AA==',generation:'fresh',capturedAt:Date.now()}};
  }};
  const heard=jest.fn(),seen=jest.fn(),unsubscribe=runtime.subscribeVoiceResults(sid,'owner',heard);
  const reply=await runtime.send({scope,text:'Continue control',storeUserMessage:ordinary,...(!ordinary?{ingressKey:'notification:'+notification.id}:{})},{execute:false,writeMemory:false},{timeoutMs:3000,onText:seen});
  unsubscribe();
  expect(inferenceCalls).toBe(mode==='screen-stopped'?0:1);
  expect(reply).toBe(mode==='screen-stopped'?'Response stopped.':committed||mode==='user-took-control'?'':mode==='nonempty'?'Need the departure date.':UNREADABLE_DISPLAY_NOTICE);
  if(committed){expect(heard).not.toHaveBeenCalled();expect(seen).not.toHaveBeenCalled();expect(runtime.store.all("SELECT event_id FROM conversation_events WHERE type='response.schema_unstructured'")).toHaveLength(0);}
 }finally{await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});
