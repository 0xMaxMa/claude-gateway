import { AgentRunner } from '../../../src/agent/runner';
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
 const sid=randomUUID();await sessions.ensureApiSession('a','web-client',sid);
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
 const result=runtime.send({scope:{agentId:'a',agentSessionId:sid,source:'api',accountId:'owner',chatId:'web-client',threadKey:'',principalId:'owner'},text:'Explain'}, {execute:false,writeMemory:false},{timeoutMs:5000,onText:foreground}).finally(()=>{settled=true;});
 void result.catch(() => {});
 try{
  await started;
  const facade = Object.assign(Object.create(AgentRunner.prototype), {
    agentConfig: { ...a, orchestration: { enabled: true } },
    sessionStore: sessions, agentsBaseDir: root, apiChatIds: new Map(),
    pendingApiSessions: new Set([sid]), logger: { warn: jest.fn() },
    getOrchestration: async () => runtime,
  }) as AgentRunner;
  await expect(facade.acceptApiMessage(sid, 'web-client', 'Forbidden', {
    timeoutMs: 5000, principalId: 'intruder', clientMessageId: randomUUID(),
  })).rejects.toThrow();
  const clientMessageId = randomUUID();
  const inputId = await facade.acceptApiMessage(sid, 'web-client', 'A follow-up while speaking', {
    timeoutMs: 5000, principalId: 'owner', clientMessageId,
  });
  expect(settled).toBe(false);
  expect(history.getUserMessagesAfter(sid, 0)).toEqual(expect.arrayContaining([
    expect.objectContaining({ inputId, clientMessageId, content: 'A follow-up while speaking' }),
  ]));
  // Same client admission is not executed/persisted twice.
  expect(await facade.acceptApiMessage(sid, 'web-client', 'A follow-up while speaking', {
    timeoutMs: 5000, principalId: 'owner', clientMessageId,
  })).toBe(inputId);
  expect(history.getUserMessagesAfter(sid, 0).filter(row => row.inputId === inputId)).toHaveLength(1);
  const emit=(event:unknown)=>process.emit('output',JSON.stringify(event));
  // Cache-lineage fix: no native schema/tool is ever attached (responseSchema stays
  // undefined for every agent turn), so a voice turn streams plain text_delta events too —
  // the speech-shaped JSON is the model's own raw text, per SPEECH_OVERLAY, not a tool call.
  const chunk=(text:string)=>emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
  chunk(voice?'{"display_text":"Hello':'Hello');
  expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({text:'Hello',final:false}));expect(settled).toBe(false);expect(outsider).not.toHaveBeenCalled();
  chunk(voice?' world","spoken_text":"Hi"}':' world');
  expect(foreground.mock.calls.map(c=>c[0]).join('')).toBe('Hello world');
  emit({type:'result',result:voice?JSON.stringify({display_text:'Hello world',spoken_text:'Hi'}):'Hello world'});
  await expect(result).resolves.toBe('Hello world');
  expect(foreground.mock.calls.map(c=>c[0]).join('')).toBe('Hello world');
  expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({text:'Hello world',final:true}));
  expect(()=>runtime.subscribeText(sid,'intruder',()=>{})).toThrow();
  const responseId=updates.mock.calls[0][0].responseId;
  runtime.saveVoiceAudio(sid,'owner',responseId,Buffer.from('original'));
  expect(()=>runtime.voiceAudio(sid,'intruder',responseId)).toThrow();
  expect(()=>runtime.voiceReplaySpeech(sid,'intruder',responseId)).toThrow();
 }finally{stopOutsider();unsub();await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});


// Issue #595: a voice turn's chat copy must not show the performance tags its speech performs,
// and the streamed text must stay a prefix of the final text. A text-only turn keeps them:
// there a tag may be the subject of the answer.
test.each([
 [true,['Sure ','[lau','ghs] that ','works'],'Sure [laughs] that works','Sure that works'],
 [true,['{"display_text":"Ha [la','ughs]. Done","spoken_text":"[laughs] Done"}'],JSON.stringify({display_text:'Ha [laughs]. Done',spoken_text:'[laughs] Done'}),'Ha. Done'],
 [true,['Read [sad](https://example.com)',' first'],'Read [sad](https://example.com) first','Read [sad](https://example.com) first'],
 [false,['Sure ','[lau','ghs] that ','works'],'Sure [laughs] that works','Sure [laughs] that works'],
 [false,['Add [laughs] ','to the text.'],'Add [laughs] to the text.','Add [laughs] to the text.'],
] as const)('voice=%s chat text shows audio tags only on text turns, streamed and final alike (%#)',async (voice,chunks,result,expected)=>{
 const root=mkdtempSync(join(tmpdir(),'response-tags-')),dir=join(root,'a'),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Fixture');
 const a={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const config={gateway:{orchestration:true,headless:true},agents:[a]} as GatewayConfig,sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const sid=randomUUID();await sessions.ensureApiSession('a','web-client',sid);
 let process:EventEmitter;let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
 const runtime=await AgentOrchestrationRuntime.open(a,config,dir,sessions,history,{
  createAgentSession:async(id,profile)=>{
   process=Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},interrupt:()=>{},stop:async()=>{},sendMessage:()=>ready()});return process as SessionProcess;
  },releaseAgentSession:async()=>{},
 });
 const updates=jest.fn(),foreground=jest.fn(),spoken=jest.fn();
 const unsub=runtime.subscribeText(sid,'owner',updates);
 if(voice) runtime.subscribeVoiceResults(sid,'owner',spoken);
 const reply=runtime.send({scope:{agentId:'a',agentSessionId:sid,source:'api',accountId:'owner',chatId:'web-client',threadKey:'',principalId:'owner'},text:'Explain'}, {execute:false,writeMemory:false},{timeoutMs:5000,onText:foreground});
 void reply.catch(()=>{});
 try{
  await started;
  const emit=(event:unknown)=>process.emit('output',JSON.stringify(event));
  for(const text of chunks) emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
  emit({type:'result',result});
  await expect(reply).resolves.toBe(expected);
  expect(foreground.mock.calls.map(c=>c[0]).join('')).toBe(expected);
  const texts=updates.mock.calls.map(c=>c[0].text as string);
  for(const text of texts) expect(expected.startsWith(text)).toBe(true);
  expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({text:expected,final:true}));
 }finally{unsub();await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});

test('stop during agent startup completes the interrupted response without a second channel delivery', async () => {
 const root=mkdtempSync(join(tmpdir(),'response-stop-')),dir=join(root,'a'),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Fixture');
 const a={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const config={gateway:{orchestration:true,headless:true},agents:[a]} as GatewayConfig,sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const sid=randomUUID();await sessions.ensureApiSession('a','web-client',sid);
 let ready!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{ready=r;}),gate=new Promise<void>(r=>{release=r;});
 const finish=jest.spyOn(DecisionService.prototype,'finish');
 const runtime=await AgentOrchestrationRuntime.open(a,config,dir,sessions,history,{
  createAgentSession:async(_id,profile)=>{ready();await gate;return Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},interrupt:()=>{},stop:async()=>{},sendMessage:()=>{}}) as unknown as SessionProcess;},releaseAgentSession:async()=>{},
 });
 try {
  const result=runtime.send({scope:{agentId:'a',agentSessionId:sid,source:'api',accountId:'owner',chatId:'web-client',threadKey:'',principalId:'owner'},text:'Work'}, {execute:false,writeMemory:false},{timeoutMs:5000});
  await started;expect(runtime.stopResponse(sid)).toBe(true);release();
  await expect(result).resolves.toBe('Response stopped.');
  expect(finish).toHaveBeenCalledWith(expect.anything(),'Response stopped.','interrupted',undefined,false);
 } finally {release();finish.mockRestore();await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});
