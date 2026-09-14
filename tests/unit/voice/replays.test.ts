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
 const runner={voiceReplay:async(session:string,principal:string,id?:string)=>store.responseAudio(session,id)} as unknown as AgentRunner;
 const api=new VoiceApi(new Map([['a',runner]]),new Map(),[{id:'key',key:'secret',agents:['a']}]);
 const app=express();app.use(api.router);
 try{
  const path=`/v1/agents/a/sessions/s/voice-sessions/replays/${d.responseId}`;
  expect((await request(app).get(path)).status).toBe(401);
  for(let n=0;n<2;n++) {
   const response=await request(app).get(path).set('Authorization','Bearer secret');
   expect(response.status).toBe(200);expect(response.body).toEqual(wav);
  }
  expect((await request(app).get(path.replace('/sessions/s/','/sessions/other/')).set('Authorization','Bearer secret')).status).toBe(404);
  store.run('UPDATE response_audio SET created_at=0');expect(store.responseAudio('s')).toEqual([]);
 }finally{await api.close();store.close();}
});
