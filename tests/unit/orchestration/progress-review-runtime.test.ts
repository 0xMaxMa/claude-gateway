import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

test.each([false,true])('internal reviews gate all text and voice (%s), consume quiet alerts, and retain final results',async(withVoice)=>{
 const root=mkdtempSync(join(tmpdir(),'progress-review-')),dir=join(root,'a'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
 const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a'),sid=randomUUID();
 await sessions.ensureApiSession('a','chat',sid);
 const overlays:string[]=[],prompts:string[]=[];
 let output={notify_user:false,display_text:'Do not leak draft',spoken_text:'Do not speak'};
 const runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{
 createAgentSession:async(_id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter,prompt:string){
   overlays.push(profile.overlay);prompts.push(prompt);
   this.emit('output',JSON.stringify({type:'system',subtype:'init',tools:[]}));
   const review=profile.overlay.includes('This is an internal progress review');
   const text=review?JSON.stringify(output):'Final result';
   this.emit('output',JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Draft commentary must not escape an internal review.'}]}}));
   this.emit('output',JSON.stringify({type:'result',result:text}));
 }}) as unknown as SessionProcess,releaseAgentSession:async()=>{},
 });
 const scope={agentId:'a',agentSessionId:sid,source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
 const heard=jest.fn(),seen=jest.fn();
 const unsubscribe=withVoice?runtime.subscribeVoiceResults(sid,'owner',heard):()=>{};
 try {
 const input=runtime.store.acceptInput({scope,text:'Do the work'}),decision=runtime.decisions.begin(input.conversationId,'owner',[input.inputId]);
 const task=runtime.tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'}, {title:'Work',instructions:'Inspect the document',targetProfile:'default-worker'});
 const attempt=runtime.tasks.claim(task.taskId)!;
 runtime.tasks.started(attempt.attemptId,1,{pid:process.pid,startedAt:Date.now(),instanceId:'fixture'});
 runtime.decisions.finish(decision,'Working');
 let tick=Date.now()+400000;
 const inspect=async()=>{
   runtime.tasks.observeExecution(attempt.attemptId,1,{attemptId:attempt.attemptId,observedAt:tick,lastActivityAt:tick,lastProgressAt:tick,process:{available:true,observedAt:tick,processCount:1},phase:'tool',activeTools:['Read'],quiet:false,status:'process_activity'});
   tick+=300001;
   const n=runtime.store.get("SELECT id FROM notifications WHERE status='pending' ORDER BY rowid DESC LIMIT 1")!;
   return runtime.send({scope,text:'Internal review',storeUserMessage:false,ingressKey:'notification:'+n.id},{execute:false,writeMemory:false},{timeoutMs:2000,onText:seen});
 };
 expect(await inspect()).toBe('');
 expect(seen).not.toHaveBeenCalled();expect(heard).not.toHaveBeenCalled();
 expect(runtime.store.all("SELECT id FROM notifications WHERE status!='handled'")).toHaveLength(0);
 expect(runtime.store.all("SELECT generated_text FROM assistant_responses WHERE generated_text LIKE '%leak%'")).toHaveLength(0);
 output={notify_user:true,display_text:'Document checked; reviewing appendix.',spoken_text:'Document checked.'};
 expect(await inspect()).toBe(output.display_text);
 expect(seen.mock.calls.map(c=>c[0]).join('')).toBe(output.display_text);
 expect(heard).toHaveBeenCalledTimes(withVoice?1:0);
 seen.mockClear();heard.mockClear();
 expect(await inspect()).toBe(''); // Same report is suppressed even if model asks to send.
 expect(overlays[2]).toBe(overlays[0]); // Changing historical reports do not invalidate system prefixes.
 expect(overlays[2]).not.toContain(output.display_text);
 expect(prompts[2]).toContain(output.display_text); // Full history remains available as turn data.
 expect(seen).not.toHaveBeenCalled();expect(heard).not.toHaveBeenCalled();
 runtime.tasks.finish(attempt.attemptId,1,{type:'completed',result:{summary:'Final result',artifactIds:[]}});
 const n=runtime.store.get("SELECT id FROM notifications WHERE status='pending' LIMIT 1")!;
 expect(await runtime.send({scope,text:'Report completion',storeUserMessage:false,ingressKey:'notification:'+n.id},{execute:false,writeMemory:false},{timeoutMs:2000})).toBe('Final result');
 }finally{unsubscribe();await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});
