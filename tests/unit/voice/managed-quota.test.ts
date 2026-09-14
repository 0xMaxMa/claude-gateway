jest.mock('../../../src/config/claude-settings', () => ({claudeSettingsEnv: () => ({ANTHROPIC_BASE_URL:'https://provider.test',ANTHROPIC_AUTH_TOKEN:'pod-token'})}));
import { requireManagedVoiceCredit } from '../../../src/voice/managed-quota';
import { providerVoiceError } from '../../../src/voice/errors';
import { speechSynthesisFailure } from '../../../src/orchestration/telegram-speech';
import { VoiceError } from '../../../src/voice/types';

test('exhausted managed wallet pauses, and reset/credit adjustment is picked up on next request', async () => {
 const request = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({remaining:0}))).mockResolvedValueOnce(new Response(JSON.stringify({remaining:100})));
 await expect(requireManagedVoiceCredit('managed:paxalabs', request)).rejects.toMatchObject({code:'MANAGED_VOICE_QUOTA_EXHAUSTED'});
 await expect(requireManagedVoiceCredit('managed:paxalabs', request)).resolves.toBeUndefined();
 expect(String(request.mock.calls[0][0])).toBe('https://provider.test/v1/voice/managed/usage');
 expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer pod-token');
});
test('BYOK does not consult managed wallet', async()=>{
 const request=jest.fn();
 for(const provider of ['elevenlabs','upstream:elevenlabs','upstream:paxalabs']) await requireManagedVoiceCredit(provider,request);
 expect(request).not.toHaveBeenCalled();
});
test('only explicit managed exhaustion suppresses audio failure notifications',()=>{
 const exhausted=providerVoiceError('TTS',429,{code:'MANAGED_VOICE_QUOTA_EXHAUSTED'});
 expect(speechSynthesisFailure(exhausted)).toEqual({state:'failed',code:'MANAGED_VOICE_QUOTA_EXHAUSTED'});
 expect(speechSynthesisFailure(providerVoiceError('TTS',429,{}))).toMatchObject({speechSynthesisFailed:true});
 expect(speechSynthesisFailure(new VoiceError('TTS_PROVIDER_ERROR_HTTP_503'))).toMatchObject({speechSynthesisFailed:true});
});
test('unavailable or malformed wallet does not masquerade as exhausted credit',async()=>{
 for(const response of [new Response('{}'),new Response('null'),new Response('not JSON'),new Response('{}',{status:503})]) {
 await expect(requireManagedVoiceCredit('managed:elevenlabs',async()=>response)).rejects.toMatchObject({code:'MANAGED_VOICE_USAGE_UNAVAILABLE'});
 }
});

test('wallet network failure is retryable unavailability, never exhausted credit', async () => {
 const {describeVoiceError}=await import('../../../src/voice/errors');
 let failure: unknown;
 try { await requireManagedVoiceCredit('managed:elevenlabs',async()=>{throw Error('private upstream diagnostic')}); }
 catch(error){failure=error;}
 expect(failure).toMatchObject({code:'MANAGED_VOICE_USAGE_UNAVAILABLE'});
 expect(describeVoiceError(failure)).toMatchObject({category:'unavailable',retryable:true});
});

test('stopping playback cancels the pending wallet check before synthesis', async () => {
 const controller=new AbortController();
 let started!:()=>void;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 const request=jest.fn((_url: unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
  init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true});started();
 }));
 const pending=requireManagedVoiceCredit('managed:paxalabs',request,controller.signal);
 const rejected=expect(pending).rejects.toMatchObject({code:'PROVIDER_ABORTED'});
 await ready;controller.abort();await rejected;
 const untouched=jest.fn();
 await expect(requireManagedVoiceCredit('managed:paxalabs',untouched,controller.signal)).rejects.toMatchObject({code:'PROVIDER_ABORTED'});
 expect(untouched).not.toHaveBeenCalled();
});

test('quota exhausted between preflight and websocket handshake keeps its explicit code', async()=>{
 const {createServer}=await import('http');
 const {openProviderSocket}=await import('../../../src/voice/providers/socket');
 const server=createServer((_req,res)=>{res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'MANAGED_VOICE_QUOTA_EXHAUSTED'}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('No address');
 try {
 await expect(openProviderSocket(`ws://127.0.0.1:${address.port}`,{},new AbortController().signal)).rejects.toMatchObject({code:'MANAGED_VOICE_QUOTA_EXHAUSTED'});
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
