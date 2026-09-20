import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { CHECKPOINT_HOOK } from '../../../src/orchestration/tasks/checkpoint-hook';
import { observeToolRepetition } from '../../../src/orchestration/tasks/tool-repetition';
import { timingTotals } from '../../../src/orchestration/tasks/timing';
import { runtimeProfileArgs } from '../../../src/session/runtime-profile';
import type { ExecutionObservation } from '../../../src/orchestration/execution-observation';

function setup() {
 const store=new OrchestrationStore(':memory:','a'), tasks=new TaskService(store,{tasks:{progressStaleMs:1000,progressNotifyCooldownMs:1000,repeatedToolThreshold:3}}),decisions=new DecisionService(store);
 const scope={agentId:'a',agentSessionId:'s',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'};
 const input=store.acceptInput({scope,text:'Inspect the document, do not publish it.'}),decision=decisions.begin(input.conversationId,'u',[input.inputId]);
 const ctx={...input,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'};
 const task=tasks.spawn(ctx,{title:'Inspect',instructions:'Inspect document. Do not publish.',targetProfile:'default-worker'}),attempt=tasks.claim(task.taskId)!;
 tasks.started(attempt.attemptId,attempt.generation,{pid:1,startedAt:Date.now(),instanceId:'test'});
 return {store,tasks,decisions,scope,input,decision,ctx,task,attempt};
}
function observation(attemptId:string, now:number):ExecutionObservation {return {attemptId,observedAt:now,lastProgressAt:now,lastActivityAt:now,phase:'tool',activeTools:['Read'],quiet:false,status:'process_activity',process:{available:true,observedAt:now,processCount:1,cpuTicksDelta:1000}};}
test('same attempt takes an updated brief only after boundary acknowledgement; no replay on completion',()=>{
 const x=setup();try {
 x.tasks.update({...x.ctx,actionId:'update'},x.task.taskId,1,'Inspect document and its appendix. Do not publish.','when_ready');
 const args={sessionId:x.attempt.sessionId};
 expect(x.tasks.checkpoint(x.attempt.attemptId,x.attempt.generation,{sessionId:'unrelated'})).toEqual({});
 const pending=x.tasks.checkpoint(x.attempt.attemptId,x.attempt.generation,args);
 expect(pending.directive).toContain('appendix');expect(x.store.task(x.task.taskId)?.appliedRevision).toBe(1);
 expect(x.tasks.checkpoint(x.attempt.attemptId,x.attempt.generation,args)).toEqual(pending);
 x.tasks.checkpoint(x.attempt.attemptId,x.attempt.generation,{...args,ackRevision:2});
 expect(x.tasks.checkpoint(x.attempt.attemptId,x.attempt.generation,args)).toEqual({});
 expect(x.store.attempt(x.attempt.attemptId)?.revision).toBe(2);
 expect(x.tasks.finish(x.attempt.attemptId,x.attempt.generation,{type:'completed',result:{summary:'Reviewed appendix.',artifactIds:[]}}).state).toBe('completed');
 expect(()=>x.tasks.checkpoint(x.attempt.attemptId,x.attempt.generation,args)).toThrow('STALE_ATTEMPT');
 }finally{x.store.close();}
});
test('new revision arriving while an earlier revision is acknowledged stays pending',()=>{
 const x=setup();try{
 x.tasks.update({...x.ctx,actionId:'u2'},x.task.taskId,1,'Second','when_ready');
 x.tasks.update({...x.ctx,actionId:'u3'},x.task.taskId,2,'Third','when_ready');
 expect(x.tasks.checkpoint(x.attempt.attemptId,x.attempt.generation,{sessionId:x.attempt.sessionId,ackRevision:2})).toMatchObject({revision:3});
 }finally{x.store.close();}
});
test('busy process without a new report wakes agent with throttled advisory; no termination',()=>{
 const clock=jest.spyOn(Date,'now').mockReturnValue(10000),x=setup();try {
 clock.mockReturnValue(12000);x.tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,12000));
 expect(x.store.task(x.task.taskId)).toMatchObject({state:'running',supervision:{reason:'stale_progress'}});
 expect(x.store.all('SELECT * FROM notifications')).toHaveLength(1);
 clock.mockReturnValue(12500);x.tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,12500));
 expect(x.store.all('SELECT * FROM notifications')).toHaveLength(1);
 x.tasks.progress(x.attempt.attemptId,1,'Verified the appendix exists.');
 clock.mockReturnValue(12900);x.tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,12900));
 expect(x.store.all('SELECT * FROM notifications')).toHaveLength(1);
 }finally{x.store.close();clock.mockRestore();}
});
test('supervision can append scoped advice, not replace goal, spawn new work, or steer unrelated tasks',()=>{
 const x=setup();try{
 x.tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,Date.now()+2000));
 x.decisions.finish(x.decision,'Working');
 const n=x.store.get('SELECT id FROM notifications')!;
 const follow=x.store.acceptInput({scope:x.scope,text:'Report progress',storeUserMessage:false,ingressKey:'notification:'+n.id,capabilities:{execute:false,writeMemory:false}});
 const d=x.decisions.begin(follow.conversationId,'u',[follow.inputId]);
 const ctx={...x.ctx,...follow,...d,execute:false,actionId:'guide'};
 // A worker report arrives after notification assignment, before the advice.
 x.tasks.progress(x.attempt.attemptId,1,'Verified the document structure.');
 const changed=x.tasks.update(ctx,x.task.taskId,1,'Try checking the appendix index first.','when_ready');
 const rev=x.tasks.revision(changed.taskId,changed.revision);
 expect(rev.instructions).toBe('Inspect document. Do not publish.');expect(rev.guidance).toContain('index');expect(rev.originatingInputId).toBe(x.input.inputId);
 expect(()=>x.tasks.spawn({...ctx,actionId:'no-spawn'},{title:'new',instructions:'new',targetProfile:'default-worker'})).toThrow('EXECUTION_DENIED');
 expect(()=>x.tasks.update({...ctx,actionId:'no-more'},x.task.taskId,2,'Again','when_ready')).toThrow('EXECUTION_DENIED');
 }finally{x.store.close();}
});
test('only repeated input AND output count, not changing results or duplicate event delivery',()=>{
 const report=jest.fn(),observe=observeToolRepetition(report);
 function call(id:string,result:string){observe(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Read',input:{path:'private'}}]}}));observe(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:result}]}}));}
 call('a','one');call('b','two');call('c','one');
 expect(report.mock.calls[0][0]).not.toBe(report.mock.calls[1][0]);expect(report.mock.calls[0][0]).toBe(report.mock.calls[2][0]);expect(report.mock.calls[0][0]).not.toContain('private');
 const x=setup();try{
 x.tasks.observeToolResult(x.attempt.attemptId,1,'same','a');x.tasks.observeToolResult(x.attempt.attemptId,1,'same','a');x.tasks.observeToolResult(x.attempt.attemptId,1,'same','b');
 expect(x.store.task(x.task.taskId)?.supervision).toBeUndefined();
 x.tasks.observeToolResult(x.attempt.attemptId,1,'same','c');expect(x.store.task(x.task.taskId)).toMatchObject({state:'running',supervision:{reason:'repeated_tools'}});
 }finally{x.store.close();}
});
test('elapsed separates tool time, working, and user wait across attempts and freezes at finish',()=>{
 const clock=jest.spyOn(Date,'now').mockReturnValue(10000),x=setup();try{
 clock.mockReturnValue(12000);x.tasks.observeToolBoundary(x.attempt.attemptId,1,['Read']);
 clock.mockReturnValue(15000);x.tasks.observeToolBoundary(x.attempt.attemptId,1,[]);
 clock.mockReturnValue(16000);x.tasks.requestInput(x.attempt.attemptId,1,'Which page?');
 clock.mockReturnValue(26000);expect(timingTotals(x.store.task(x.task.taskId)!)).toMatchObject({working:3000,tool:3000,input:10000});
 x.tasks.finish(x.attempt.attemptId,1,{type:'completed',result:{summary:'Need page',artifactIds:[]}});
 clock.mockReturnValue(36000);expect(timingTotals(x.store.task(x.task.taskId)!)).toMatchObject({input:20000});
 }finally{x.store.close();clock.mockRestore();}
});
test('container internal hook does not enable host tools or external settings',()=>{
 const args=runtimeProfileArgs({role:'worker',containerExecution:true,overlay:'',mcpConfigPath:'/tmp/mcp.json',checkpointCommand:'node /tmp/checkpoint.cjs /tmp/ticket.json'},[]);
 expect(args[args.indexOf('--setting-sources')+1]).toBe('');expect(args[args.indexOf('--tools')+1]).not.toBe('default');
 expect(JSON.parse(args[args.indexOf('--settings')+1]).hooks.PostToolUse).toHaveLength(1);
});
test('actual hook process injects update and acknowledges via authenticated bridge; next boundary is silent',async()=>{
 const x=setup(),root=mkdtempSync(join(tmpdir(),'checkpoint-')),bridge=new TaskBridge(x.tasks);
 try{
 await bridge.start();const ticket=bridge.issue({role:'worker',attemptId:x.attempt.attemptId,generation:1},root,root);
 x.tasks.update({...x.ctx,actionId:'update'},x.task.taskId,1,'Read appendix. No publish.','when_ready');
 const hook=join(root,'run.cjs');writeFileSync(hook,CHECKPOINT_HOOK);
 const run=(event:string)=>new Promise<string>((resolve,reject)=>{
  const child=execFile(process.execPath,[hook,join(root,'ticket.json')],(error,stdout)=>error?reject(error):resolve(stdout));
  child.stdin!.end(JSON.stringify({hook_event_name:event,session_id:x.attempt.sessionId}));
 });
 expect(JSON.parse(await run('PostToolUse')).hookSpecificOutput.additionalContext).toContain('Read appendix');
 expect(x.store.task(x.task.taskId)?.appliedRevision).toBe(2);expect(await run('PostToolUse')).toBe('');
 x.tasks.update({...x.ctx,actionId:'last'},x.task.taskId,2,'Read final appendix.','when_ready');
 expect(JSON.parse(await run('Stop'))).toMatchObject({decision:'block'});
 ticket.revoke();expect(await run('PostToolUse')).toBe('');
 }finally{await bridge.close();x.store.close();rmSync(root,{recursive:true,force:true});}
});

test('internal checks stay every five minutes despite fresh progress and service recreation',()=>{
 const clock=jest.spyOn(Date,'now').mockReturnValue(10000),x=setup();
 let tasks=new TaskService(x.store,{tasks:{progressStaleMs:1000,progressNotifyCooldownMs:300000}});
 try {
 let now=10000;
 for(const [index,minutes] of [5,5,5,5,5].entries()) {
   now+=minutes*60000;
   clock.mockReturnValue(now-1);tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,now-1));
   expect(x.store.all('SELECT * FROM notifications')).toHaveLength(index);
   clock.mockReturnValue(now);tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,now));
   expect(x.store.all('SELECT * FROM notifications')).toHaveLength(index+1);
   tasks.progress(x.attempt.attemptId,1,'Checked another section.');
   tasks=new TaskService(x.store,{tasks:{progressStaleMs:1000,progressNotifyCooldownMs:300000}});
 }
 } finally {x.store.close();clock.mockRestore();}
});

test('an assigned old alert cannot advise after a newer alert supersedes it',()=>{
 const clock=jest.spyOn(Date,'now').mockReturnValue(10000),x=setup();try {
 clock.mockReturnValue(12000);x.tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,12000));
 x.decisions.finish(x.decision,'Working');
 const n=x.store.get('SELECT id FROM notifications')!;
 const follow=x.store.acceptInput({scope:x.scope,text:'Report progress',storeUserMessage:false,ingressKey:'notification:'+n.id,capabilities:{execute:false,writeMemory:false}});
 const d=x.decisions.begin(follow.conversationId,'u',[follow.inputId]);
 clock.mockReturnValue(15000);x.tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,15000));
 expect(()=>x.tasks.update({...x.ctx,...follow,...d,execute:false,actionId:'stale-advice'},x.task.taskId,1,'Advice','when_ready')).toThrow('EXECUTION_DENIED');
 }finally{x.store.close();clock.mockRestore();}
});

test('new worker evidence expires old advisory text without discarding the task brief',()=>{
 const x=setup();try{
 x.tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,Date.now()+2000));
 x.decisions.finish(x.decision,'Working');
 const n=x.store.get('SELECT id FROM notifications')!;
 const follow=x.store.acceptInput({scope:x.scope,text:'Report progress',storeUserMessage:false,ingressKey:'notification:'+n.id,capabilities:{execute:false,writeMemory:false}});
 const d=x.decisions.begin(follow.conversationId,'u',[follow.inputId]);
 x.tasks.update({...x.ctx,...follow,...d,execute:false,actionId:'old'},x.task.taskId,1,'Keep the obsolete workaround.','when_ready');
 const cp={phase:'verify',evidenceVersion:'v2',nextAction:'Check F1',checks:[],findings:[{id:'F1',status:'resolved',summary:'Removed workaround'}]};
 x.tasks.progress(x.attempt.attemptId,1,'Removed workaround','cp1',cp);
 const response=x.tasks.checkpoint(x.attempt.attemptId,1,{sessionId:x.attempt.sessionId});
 expect(response.directiveKind).toBe('advice');
 expect(response.directive).not.toContain('Keep the obsolete');
 expect(response.directive).toContain('superseded');
 expect(response.directive).toContain('Do not publish.');
 expect(response.directive).toContain('v2');
 const saved=x.store.task(x.task.taskId)!.workflow!;
 x.tasks.progress(x.attempt.attemptId,1,'Removed workaround','cp1',cp);
 expect(x.store.task(x.task.taskId)!.workflow).toEqual(saved);
 expect(()=>x.tasks.progress(x.attempt.attemptId,1,'Removed workaround','cp1',{...cp,evidenceVersion:'v3'})).toThrow();
 }finally{x.store.close();}
});
test('actual Stop hook acknowledges monitoring advice without blocking completion',async()=>{
 const x=setup(),root=mkdtempSync(join(tmpdir(),'advice-stop-')),bridge=new TaskBridge(x.tasks);
 try{
 await bridge.start();bridge.issue({role:'worker',attemptId:x.attempt.attemptId,generation:1},root,root);
 x.tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,Date.now()+2000));
 x.decisions.finish(x.decision,'Working');
 const n=x.store.get('SELECT id FROM notifications')!;
 const follow=x.store.acceptInput({scope:x.scope,text:'Report progress',storeUserMessage:false,ingressKey:'notification:'+n.id,capabilities:{execute:false,writeMemory:false}});
 const d=x.decisions.begin(follow.conversationId,'u',[follow.inputId]);
 x.tasks.update({...x.ctx,...follow,...d,execute:false,actionId:'advice'},x.task.taskId,1,'Check latest evidence and finish.','when_ready');
 const hook=join(root,'run.cjs');writeFileSync(hook,CHECKPOINT_HOOK);
 const stdout=await new Promise<string>((resolve,reject)=>{
 const child=execFile(process.execPath,[hook,join(root,'ticket.json')],(e,out)=>e?reject(e):resolve(out));
 child.stdin!.end(JSON.stringify({hook_event_name:'Stop',session_id:x.attempt.sessionId}));
 });
 expect(stdout).toBe('');expect(x.store.task(x.task.taskId)?.appliedRevision).toBe(2);
 expect(x.tasks.finish(x.attempt.attemptId,1,{type:'completed',result:{summary:'Done',artifactIds:[]}}).state).toBe('completed');
 }finally{await bridge.close();x.store.close();rmSync(root,{recursive:true,force:true});}
});

test('a later advisory cannot conceal an unacknowledged user amendment at Stop',()=>{
 const x=setup();try{
 x.tasks.update({...x.ctx,actionId:'user-change'},x.task.taskId,1,'Also inspect the attachment.','when_ready');
 x.tasks.observeExecution(x.attempt.attemptId,1,observation(x.attempt.attemptId,Date.now()+2000));
 x.decisions.finish(x.decision,'Working');
 const n=x.store.get('SELECT id FROM notifications')!;
 const follow=x.store.acceptInput({scope:x.scope,text:'Report progress',storeUserMessage:false,ingressKey:'notification:'+n.id,capabilities:{execute:false,writeMemory:false}});
 const d=x.decisions.begin(follow.conversationId,'u',[follow.inputId]);
 x.tasks.update({...x.ctx,...follow,...d,execute:false,actionId:'advice'},x.task.taskId,2,'Summarize when done.','when_ready');
 const pending=x.tasks.checkpoint(x.attempt.attemptId,1,{sessionId:x.attempt.sessionId});
 expect(pending.directiveKind).toBe('assignment');expect(pending.directive).toContain('Also inspect the attachment');
 }finally{x.store.close();}
});

test.each([true,false])('unresolved structured blocker=%s is reflected in terminal state and full result',blocked=>{
 const x=setup();try{
 x.tasks.progress(x.attempt.attemptId,x.attempt.generation,'Checked capability', 'progress-block', {phase:blocked?'blocked':'complete',evidenceVersion:'v1',nextAction:'Report',checks:[],findings:[{id:'capability',status:blocked?'open':'resolved',summary:'Required capability unavailable'}]});
 const result=x.tasks.finish(x.attempt.attemptId,x.attempt.generation,{type:'completed',result:{summary:'Full findings retained',artifactIds:[]}});
 expect(result.state).toBe(blocked?'failed':'completed');expect(result.result?.summary).toBe('Full findings retained');
 if(blocked)expect(result.failure?.code).toBe('WORKER_BLOCKED');
 }finally{x.store.close();}
});
