jest.mock('../../../src/config/claude-settings', () => ({claudeSettingsEnv: () => ({ANTHROPIC_BASE_URL:'https://provider.test',ANTHROPIC_AUTH_TOKEN:'pod-token'})}));
import express from 'express';
import request from 'supertest';
import {nativeVoiceModel} from '../../../src/voice/providers/model-ref';
import {upstreamVoiceConnection} from '../../../src/voice/providers/upstream';
import {sttProvider,ttsProvider} from '../../../src/voice/providers/registry';
import {voiceSettingsRouter} from '../../../src/api/voice-settings-router';
import {resolveOrchestrationConfig} from '../../../src/orchestration/config';
import type {AgentConfig} from '../../../src/types';
afterEach(()=>jest.restoreAllMocks());
test('managed routing never falls back to BYOK',()=>{
 expect(upstreamVoiceConnection('elevenlabs',true).base.toString()).toBe('https://provider.test/v1/voice/managed/elevenlabs/');
 expect(upstreamVoiceConnection('elevenlabs').base.toString()).toBe('https://provider.test/v1/voice/elevenlabs/');
 for(const native of ['elevenlabs','paxalabs']){
  const model=native==='elevenlabs'?'eleven_v3_conversational':'paxa-tts-flash-v1';
  expect(ttsProvider({provider:`managed:${native}`,model:`getpod-voice/${native}/${model}`}).id).toBe(`managed:${native}`);
 }
 expect(sttProvider({provider:'managed:elevenlabs',model:'getpod-voice/elevenlabs/scribe_v2_realtime'}).id).toBe('managed:elevenlabs');
 expect(()=>nativeVoiceModel('upstream:elevenlabs','getpod-voice/elevenlabs/eleven_v3_conversational')).toThrow('VOICE_MODEL_PROVIDER_MISMATCH');
 expect(()=>nativeVoiceModel('managed:paxalabs','getpod-voice/elevenlabs/eleven_v3_conversational')).toThrow('VOICE_MODEL_PROVIDER_MISMATCH');
 expect(()=>resolveOrchestrationConfig(undefined,{enabled:true,notes:{enabled:false},stt:{provider:'managed:elevenlabs',model:'getpod-voice/elevenlabs/scribe_v2_realtime'},tts:{provider:'managed:elevenlabs',model:'getpod-voice/elevenlabs/eleven_v3_conversational'}})).not.toThrow();
});
test('managed catalog returns only pool-enabled models and metering metadata',async()=>{
 const fetcher=jest.spyOn(global,'fetch').mockImplementation(async(input)=>({ok:true,json:async()=>String(input).endsWith('/models')?{models:[{model_id:'getpod-voice/paxalabs/paxa-tts-flash-v1',native_model_id:'paxa-tts-flash-v1',provider:'paxalabs',display_name:'Paxa TTS',kind:'tts',realtime:true,credit_multiplier:'1'}]}:{voices:[{id:'test',name:'Test',gender:'female'}]}} as Response));
 const app=express();app.use(voiceSettingsRouter(new Map([['a',{id:'a'} as AgentConfig]]),new Map(),[{id:'reader',key:'read',agents:['a']}]));
 const response=await request(app).get('/v1/agents/a/voice-settings/catalog').query({provider:'managed:paxalabs'}).set('Authorization','Bearer read');
 expect(response.status).toBe(200);expect(response.body.models).toHaveLength(1);expect(response.body.models[0]).toMatchObject({source:'managed',metered:true,model_id:'getpod-voice/paxalabs/paxa-tts-flash-v1',credit_multiplier:'1'});
 expect(fetcher.mock.calls.map(([url])=>String(url))).toContain('https://provider.test/v1/voice/managed/models');
});

test('realtime quota rejection after connection remains a provider error',async()=>{
 const {WebSocketServer}=await import('ws');
 const {openProviderSocket}=await import('../../../src/voice/providers/socket');
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});
 await new Promise<void>(resolve=>server.once('listening',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Expected TCP address');
 server.on('connection',ws=>ws.close(1008,JSON.stringify({error:{status:429,code:'quota_exceeded',message:'Daily quota exhausted'}})));
 try{
  const socket=await openProviderSocket(`ws://127.0.0.1:${address.port}`,{},new AbortController().signal);
  await expect(socket.messages[Symbol.asyncIterator]().next()).rejects.toMatchObject({code:expect.stringContaining('HTTP_429')});
  socket.close();
 }finally{server.clients.forEach(ws=>ws.terminate());await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
