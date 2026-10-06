import { resolveOrchestrationConfig } from '../../../src/orchestration/config';
test('voice.narrate rejects zero, negative and undefined limits',()=>{ for (const v of [0,-1,undefined]) expect(()=>resolveOrchestrationConfig(undefined,{enabled:true,narrate:{maxChars:v as any}} as any)).toThrow(); });
test.each([{targetChars:0},{partTimeoutMs:0},{maxParts:-1},{maxParts:'5'},{maxChars:1.5},{targetChars:null},{targetChars:4001},{maxParts:201},{partTimeoutMs:300001},{maxChars:2000001}])('voice.narrate rejects %j',narrate=>{
  expect(()=>resolveOrchestrationConfig(undefined,{enabled:true,narrate} as any)).toThrow(/voice\.narrate\./);
});
test('voice.narrate accepts the documented bounds and stays enabled with voice',()=>{
  const {voice}=resolveOrchestrationConfig(undefined,{enabled:true,stt:{provider:'elevenlabs',model:'scribe_v2_realtime'},tts:{provider:'elevenlabs',model:'eleven_v3_conversational',voiceId:'v'},notes:{enabled:false,replyWithVoice:false},narrate:{targetChars:4000,maxParts:200,partTimeoutMs:300000,maxChars:2000000}} as any);
  expect(voice.narrate).toMatchObject({enabled:true,targetChars:4000,maxParts:200,partTimeoutMs:300000,maxChars:2000000});
});
test('narrate is off whenever voice is disabled, even with a TTS provider configured',()=>{
  const {voice}=resolveOrchestrationConfig(undefined,{enabled:false,tts:{provider:'elevenlabs',model:'m',voiceId:'v'},narrate:{enabled:true}} as any);
  expect(voice.narrate.enabled).toBe(false);
});
