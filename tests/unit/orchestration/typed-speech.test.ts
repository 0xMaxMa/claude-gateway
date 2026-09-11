import { ORCHESTRATION_DEFAULTS } from '../../../src/orchestration/config';
import { VoiceError } from '../../../src/voice/types';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionProcess } from '../../../src/session/process';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';

test('typed chat speaks only to the connected same-principal listener and retains text modality', async () => {
 const root=mkdtempSync(join(tmpdir(),'typed-speech-')),dir=join(root,'a'),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const a={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]},orchestration:{enabled:true,channels:['api']}} as AgentConfig;
 const c={gateway:{ orchestration: true,headless:true},agents:[a]} as GatewayConfig,sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const sid=randomUUID();await sessions.ensureApiSession('a','chat',sid);const received=jest.fn();
 const runtime=await AgentOrchestrationRuntime.open(a,c,dir,sessions,history,{
  createAgentSession:async(id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){this.emit('output',JSON.stringify({type:'system',subtype:'init',tools:[]}));this.emit('output',JSON.stringify({type:'result',result:profile.overlay.includes('spoken_text')?JSON.stringify({display_text:'Hello in chat',spoken_text:'Hello aloud'}):'Hello in chat'}));}}) as unknown as SessionProcess,
  releaseAgentSession:async()=>{},
 });
 const send=()=>runtime.send({scope:{agentId:'a',agentSessionId:sid,source:'api',accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'},text:'Introduce yourself',requestId:randomUUID()},{execute:false,writeMemory:false},{timeoutMs:1000});
 try {
  await send();expect(received).not.toHaveBeenCalled();
  const unsubscribe=runtime.subscribeVoiceResults(sid,'owner',received);
  await expect(send()).resolves.toBe('Hello in chat');expect(received).toHaveBeenCalledTimes(1);expect(received.mock.calls[0][0]).toMatchObject({spoken:'Hello aloud',speechOnly:true,requestId:expect.any(String)});
  expect(runtime.store.all('SELECT DISTINCT modality FROM conversation_inputs')).toEqual([{modality:'text'}]);
  expect(()=>runtime.subscribeVoiceResults(sid,'other',received)).toThrow();
  unsubscribe();await send();expect(received).toHaveBeenCalledTimes(1);
 }finally{await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});

test.each([[true,'json'],[true,'plain'],[true,'structured'],[false,'plain']] as const)('Telegram voice opt-in %s with %s output persists speech for text and voice', async (enabled,format) => {
 const root=mkdtempSync(join(tmpdir(),'tg-speech-')),dir=join(root,'a'),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const a={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]},orchestration:{enabled:true,channels:['telegram'],voice:{enabled:true,notes:{enabled:true,replyWithVoice:enabled},tts:{voiceId:'chosen'}}}} as AgentConfig;
 const c={gateway:{ orchestration: true,headless:true},agents:[a]} as GatewayConfig,sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const sid=randomUUID();await sessions.ensureApiSession('a','chat',sid);
 const runtime=await AgentOrchestrationRuntime.open(a,c,dir,sessions,history,{
  transcribeNote:async()=> '日本語で自己紹介してください',
  createAgentSession:async(id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){this.emit('output',JSON.stringify({type:'system',subtype:'init',tools:[]}));if(enabled) expect(profile.responseSchema).toBeDefined();
    const fields={display_text:'こんにちは。アシスタントです。',spoken_text:'こんにちは。アシスタントです。'};
    this.emit('output',JSON.stringify({type:'result',result:format==='json'?JSON.stringify(fields):'こんにちは。アシスタントです。',...(format==='structured'?{structured_output:fields}:{})}));}}) as unknown as SessionProcess,
  releaseAgentSession:async()=>{},
 });
 if(enabled) runtime.store.setTelegramVoice('chat',true);
 // No Telegram credentials: inspect durable intent without external sends.
 try {
  for(const modality of ['voice_note','text'] as const) await runtime.send({scope:{agentId:'a',agentSessionId:sid,source:'telegram',accountId:'bot',chatId:'chat',threadKey:'',principalId:'owner'},text:'intro',modality,attachmentIds:modality==='voice_note'?['media/chat/fixture.ogg']:undefined,requestId:randomUUID()},{execute:false,writeMemory:false},{timeoutMs:1000});
  const deliveries=runtime.store.all("SELECT * FROM deliveries WHERE modality='speech'");
  expect(deliveries).toHaveLength(enabled?2:0);
  if(enabled) expect(JSON.parse(String(deliveries[0].delivered_text))).toMatchObject({text:'こんにちは。アシスタントです。',voiceId:'chosen'});
  expect(runtime.store.all("SELECT * FROM deliveries WHERE modality='text'")).toHaveLength(2);
 }finally{await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});

test('timed out turn persists an honest failure without claiming that tasks exist', async()=>{
 const root=mkdtempSync(join(tmpdir(),'timeout-response-')),dir=join(root,'a'),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const a={id:'a',description:'fixture',env:'',workspace,voice:{...ORCHESTRATION_DEFAULTS.voice,enabled:true},claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const c={gateway:{orchestration:true,headless:true},agents:[a]} as GatewayConfig,sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const sid=randomUUID();await sessions.ensureApiSession('a','chat',sid);
 const runtime=await AgentOrchestrationRuntime.open(a,c,dir,sessions,history,{
  createAgentSession:async(id,profile)=>Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},interrupt:()=>{},sendMessage:()=>{}}) as unknown as SessionProcess,
  releaseAgentSession:async()=>{},
 });
 try {
  await expect(runtime.send({scope:{agentId:'a',agentSessionId:sid,source:'api',accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'},text:'status'}, {execute:false,writeMemory:false},{timeoutMs:20})).rejects.toMatchObject({code:'TIMEOUT'});
  const row=runtime.store.get('SELECT state,generated_text FROM assistant_responses');
  expect(row?.state).toBe('failed');expect(row?.generated_text).toContain('response time limit');
  expect(row?.generated_text).not.toContain('Committed tasks');expect(runtime.store.all('SELECT * FROM tasks')).toHaveLength(0);
 }finally{await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});

test('voice and task follow-ups launch the same selected model as typed chat', async () => {
 const root=mkdtempSync(join(tmpdir(),'conversation-model-')),dir=join(root,'a'),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const a={id:'a',description:'fixture',env:'',workspace,claude:{model:'default-model',extraFlags:[]},orchestration:{enabled:true,channels:['api']}} as AgentConfig;
 const c={gateway:{orchestration:true,headless:true},agents:[a]} as GatewayConfig,sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const sid=randomUUID();await sessions.ensureApiSession('a','chat',sid);const models:(string|undefined)[]=[];
 const runtime=await AgentOrchestrationRuntime.open(a,c,dir,sessions,history,{
  createAgentSession:async(id,profile,model)=>{models.push(model);return Object.assign(new EventEmitter(),{runtimeProfile:profile,start:async()=>{},stop:async()=>{},sendMessage:function(this:EventEmitter){this.emit('output',JSON.stringify({type:'result',result:'OK',...(profile.responseSchema?{structured_output:{display_text:'OK',spoken_text:'OK'}}:{})}));}}) as unknown as SessionProcess;},
  releaseAgentSession:async()=>{},
 });
 const scope={agentId:'a',agentSessionId:sid,source:'api' as const,accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'};
 const capabilities={execute:false,writeMemory:false};
 try {
  await runtime.send({scope,text:'Hello'},capabilities,{timeoutMs:1000,model:'gpt-5.6-luna'});
  await runtime.submitInput({scope,text:'Voice follow-up',modality:'live_voice',ingressKey:'utterance:test'},capabilities).response;
  await runtime.submitInput({scope,text:'Task update',storeUserMessage:false,ingressKey:'notification:test'},capabilities).response;
  expect(models).toEqual(['gpt-5.6-luna','gpt-5.6-luna','gpt-5.6-luna']);
 } finally {await runtime.close();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});


test('failed voice note retains provider code and returns a readable diagnostic with a reference', async () => {
 const root=mkdtempSync(join(tmpdir(),'voice-note-failure-')),dir=join(root,'a'),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const a={id:'a',description:'fixture',env:'',workspace,voice:{...ORCHESTRATION_DEFAULTS.voice,enabled:true},claude:{model:'fixture',extraFlags:[]}} as AgentConfig;
 const c={gateway:{orchestration:true,headless:true},agents:[a]} as GatewayConfig,sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const sid=randomUUID();await sessions.ensureApiSession('a','chat',sid);
 const failure=new VoiceError('VOICE_PROVIDER_ERROR_HTTP_503');
 const transcribe=jest.fn(async()=>{throw failure;});
 const createAgentSession=jest.fn();
 const log=jest.spyOn(console,'warn').mockImplementation(()=>{});
 const runtime=await AgentOrchestrationRuntime.open(a,c,dir,sessions,history,{transcribeNote:transcribe,createAgentSession,releaseAgentSession:async()=>{}});
 try {
  const result=await runtime.send({scope:{agentId:'a',agentSessionId:sid,source:'api',accountId:'owner',chatId:'chat',threadKey:'',principalId:'owner'},text:'(voice message)',modality:'voice_note',attachmentIds:['media/chat/fixture.ogg'],requestId:randomUUID()},{execute:false,writeMemory:false},{timeoutMs:1000});
  const row=runtime.store.get('SELECT * FROM voice_note_transcripts')!;
  expect(row).toMatchObject({state:'failed',error_code:'VOICE_PROVIDER_ERROR_HTTP_503'});
  expect(result).toContain('temporarily unavailable');expect(result).toContain('HTTP 503');expect(result).toContain(`Reference: ${row.input_id}`);
  expect(result).not.toContain('VOICE_NOTE_STT_FAILED');
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({event:'Voice note transcription failed',referenceId:row.input_id,httpStatus:503,code:'VOICE_PROVIDER_ERROR_HTTP_503'});
  expect(transcribe).toHaveBeenCalledTimes(1);expect(createAgentSession).not.toHaveBeenCalled();
 }finally{await runtime.close();log.mockRestore();(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});
