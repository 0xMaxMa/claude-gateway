import { DecisionService } from '../../../src/orchestration/decisions';
import { EventEmitter } from 'events';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionProcess } from '../../../src/session/process';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig,GatewayConfig } from '../../../src/types';

test.each([false,true])('real runtime publishes incremental response text before completion (voice=%s)',async voice=>{
 const root=mkdtempSync(join(tmpdir(),'response-stream-')),dir=join(root,'a'),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Fixture');
 const a={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const config={gateway:{orchestration:true,headless:true},agents:[a]} as GatewayConfig,sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const sid=randomUUID();await sessions.ensureApiSession('a','getpod',sid);
 let process:EventEmitter;let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
 const runtime=await AgentOrchestrationRuntime.open(a,config,dir,sessions,history,{
  createAgentSession:async(id,profile)=>{
   process=Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},interrupt:()=>{},stop:async()=>{},sendMessage:()=>ready()});return process as SessionProcess;
  },releaseAgentSession:async()=>{},
 });
 const updates=jest.fn(),foreground=jest.fn();let settled=false;
 const outsider=jest.fn();const stopOutsider=runtime.subscribeText(sid,'intruder',outsider);
 const unsub=runtime.subscribeText(sid,'owner',updates);
 if(voice) runtime.subscribeVoiceResults(sid,'owner',()=>{});
 const result=runtime.send({scope:{agentId:'a',agentSessionId:sid,source:'api',accountId:'owner',chatId:'getpod',threadKey:'',principalId:'owner'},text:'Explain'}, {execute:false,writeMemory:false},{timeoutMs:5000,onText:foreground}).finally(()=>{settled=true;});
 try{
  await started;
  const emit=(event:unknown)=>process.emit('output',JSON.stringify(event));
  const chunk=(text:string)=>emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:voice?{type:'input_json_delta',partial_json:text}:{type:'text_delta',text}}});
  if(voice) emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'structured',name:'StructuredOutput'}}});
  chunk(voice?'{"display_text":"Hello':'Hello');
  expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({text:'Hello',final:false}));expect(settled).toBe(false);expect(outsider).not.toHaveBeenCalled();
  chunk(voice?' world","spoken_text":"Hi"}':' world');
  expect(foreground.mock.calls.map(c=>c[0]).join('')).toBe('Hello world');
  emit({type:'result',result:'Hello world',...(voice?{structured_output:{display_text:'Hello world',spoken_text:'Hi'}}:{})});
  await expect(result).resolves.toBe('Hello world');
  expect(foreground.mock.calls.map(c=>c[0]).join('')).toBe('Hello world');
  expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({text:'Hello world',final:true}));
  expect(()=>runtime.subscribeText(sid,'intruder',()=>{})).toThrow();
  const responseId=updates.mock.calls[0][0].responseId;
  runtime.saveVoiceAudio(sid,'owner',responseId,Buffer.from('original'));
  expect(()=>runtime.voiceAudio(sid,'intruder',responseId)).toThrow();
 }finally{stopOutsider();unsub();await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});


test('stop during agent startup completes the interrupted response without a second channel delivery', async () => {
 const root=mkdtempSync(join(tmpdir(),'response-stop-')),dir=join(root,'a'),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Fixture');
 const a={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const config={gateway:{orchestration:true,headless:true},agents:[a]} as GatewayConfig,sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const sid=randomUUID();await sessions.ensureApiSession('a','getpod',sid);
 let ready!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{ready=r;}),gate=new Promise<void>(r=>{release=r;});
 const finish=jest.spyOn(DecisionService.prototype,'finish');
 const runtime=await AgentOrchestrationRuntime.open(a,config,dir,sessions,history,{
  createAgentSession:async(_id,profile)=>{ready();await gate;return Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},interrupt:()=>{},stop:async()=>{},sendMessage:()=>{}}) as unknown as SessionProcess;},releaseAgentSession:async()=>{},
 });
 try {
  const result=runtime.send({scope:{agentId:'a',agentSessionId:sid,source:'api',accountId:'owner',chatId:'getpod',threadKey:'',principalId:'owner'},text:'Work'}, {execute:false,writeMemory:false},{timeoutMs:5000});
  await started;expect(runtime.stopResponse(sid)).toBe(true);release();
  await expect(result).resolves.toBe('Response stopped.');
  expect(finish).toHaveBeenCalledWith(expect.anything(),'Response stopped.','interrupted',undefined,false);
 } finally {release();finish.mockRestore();await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});
