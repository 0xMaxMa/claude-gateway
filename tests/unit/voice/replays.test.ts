import express from 'express';
import request from 'supertest';
import { VoiceApi } from '../../../src/api/voice-router';
import type { AgentRunner } from '../../../src/agent/runner';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { pcmToWav } from '../../../src/voice/wav';

test('replay returns the original stored bytes, scopes to session and expires recordings',async()=>{
 const store=new OrchestrationStore(':memory:','a'), decisions=new DecisionService(store);
 const i=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'p',principalId:'p',chatId:'getpod',threadKey:''},text:'hello'});
 const d=decisions.begin(i.conversationId,'p',[i.inputId]);
 const wav=pcmToWav(Buffer.from([1,0,2,0]));store.saveResponseAudio(d.responseId!,wav);
 store.saveResponseAudio(d.responseId!,pcmToWav(Buffer.from([3,0])));
 const runner={voiceReplay:async(session:string,principal:string,id?:string)=>store.responseAudio(session,id),replayableVoiceResponses:async(session:string)=>store.replayableResponses(session)} as unknown as AgentRunner;
 const api=new VoiceApi(new Map([['a',runner]]),new Map(),[{id:'key',key:'secret',agents:['a']}]);
 const app=express();app.use(api.router);
 try{
  const path=`/v1/agents/a/sessions/s/voice-sessions/replays/${d.responseId}`;
  expect((await request(app).get(path)).status).toBe(401);
  const list=await request(app).get(path.slice(0,path.lastIndexOf('/'))).set('Authorization','Bearer secret');
  expect(list.body).toEqual({response_ids:[d.responseId],replayable_response_ids:[d.responseId]});
  for(let n=0;n<2;n++) {
   const response=await request(app).get(path).set('Authorization','Bearer secret');
   expect(response.status).toBe(200);expect(response.body).toEqual(wav);
  }
  expect((await request(app).get(path.replace('/sessions/s/','/sessions/other/')).set('Authorization','Bearer secret')).status).toBe(404);
  store.run('UPDATE response_audio SET created_at=0');expect(store.responseAudio('s')).toEqual([]);
 }finally{await api.close();store.close();}
});

test('approved speech is replayable before any recording, with session scope and without raw-text fallback', () => {
 const store=new OrchestrationStore(':memory:','a'), decisions=new DecisionService(store);
 try {
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'p',principalId:'p',chatId:'getpod',threadKey:''},text:'hello'});
  const d=decisions.begin(input.conversationId,'p',[input.inputId]);
  store.run("UPDATE assistant_responses SET state='completed',generated_text='Private full answer' WHERE id=?",d.responseId!);
  expect(store.replayableResponses('s')).toEqual([]);
  store.run('INSERT INTO response_speech VALUES(?,?)',d.responseId!,'Approved speech');
  expect(store.responseAudio('s',d.responseId!)).toBeUndefined();
  expect(store.replayableResponses('s')).toEqual([d.responseId]);
  expect(store.replaySpeech('s',d.responseId!)).toBe('Approved speech');
  expect(store.replaySpeech('other',d.responseId!)).toBeUndefined();
  expect(store.replayableResponses('other')).toEqual([]);
 } finally {store.close();}
});

test('explicit replay synthesizes missing approved audio once, saves it, and enforces ownership', async () => {
 const {FakeTtsProvider}=await import('../../../src/voice/providers/fake');
 const registry=await import('../../../src/voice/providers/registry');
 const catalog=await import('../../../src/voice/providers/voice-catalog');
 const {ORCHESTRATION_DEFAULTS}=await import('../../../src/orchestration/config');
 const tts=new FakeTtsProvider(); const synth=jest.spyOn(tts,'synthesize');
 const provider=jest.spyOn(registry,'ttsProvider').mockReturnValue(tts);
 const voice=jest.spyOn(catalog,'resolveVoiceId').mockResolvedValue('voice');
 const id='12345678-1234-1234-1234-123456789abc';
 let saved:Buffer|undefined;
 const runner={
  voiceReplay:async(s:string,p:string)=>{if(p!=='api:owner')throw Error('denied'); return s==='s'?saved:undefined;},
  voiceReplaySpeech:jest.fn(async(s:string)=>s==='s'?'Approved speech':undefined),
  saveVoiceReplay:jest.fn((_s:string,_p:string,_r:string,a:Buffer)=>{saved=a;}),
 } as unknown as AgentRunner;
 const config={id:'a',orchestration:{enabled:true},voice:{...ORCHESTRATION_DEFAULTS.voice,enabled:true}} as import('../../../src/types').AgentConfig;
 const api=new VoiceApi(new Map([['a',runner]]),new Map([['a',config]]),[{id:'owner',key:'secret',agents:['a']},{id:'other',key:'intruder',agents:['a']}]);
 const app=express();app.use(api.router);
 const path=`/v1/agents/a/sessions/s/voice-sessions/replays/${id}`;
 try{
  expect((await request(app).post(path)).status).toBe(401);
  expect((await request(app).post(path).set('Authorization','Bearer intruder')).status).toBe(403);
  expect((await request(app).post(path.replace('/sessions/s/','/sessions/other/')).set('Authorization','Bearer secret')).status).toBe(404);
  expect(synth).not.toHaveBeenCalled();
  const result=await request(app).post(path).set('Authorization','Bearer secret');
  expect(result.status).toBe(200); expect(result.body.subarray(0,4).toString()).toBe('RIFF');
  expect(runner.saveVoiceReplay).toHaveBeenCalledWith('s','api:owner',id,result.body);
  const repeat=await request(app).post(path).set('Authorization','Bearer secret');
  expect(repeat.body).toEqual(result.body);expect(synth).toHaveBeenCalledTimes(1);
 } finally {await api.close();provider.mockRestore();voice.mockRestore();}
});
