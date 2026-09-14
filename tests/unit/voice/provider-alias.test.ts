import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { canonicalVoiceProvider, nativeVoiceModel } from '../../../src/voice/providers/model-ref';
import { sttProvider, ttsProvider } from '../../../src/voice/providers/registry';
import { resolveOrchestrationConfig } from '../../../src/orchestration/config';
import { migrateAgentVoiceConfig } from '../../../src/orchestration/gateway-config';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TelegramVoices } from '../../../src/orchestration/telegram-voices';
import { resolveVoiceId, voiceChoices } from '../../../src/voice/providers/voice-catalog';
import { voicePreviewLanguages } from '../../../src/voice/preview';
import { transcribeVoiceNote } from '../../../src/voice/notes';
import * as upstream from '../../../src/voice/providers/upstream';

afterEach(()=>jest.restoreAllMocks());
test('canonical provider identities separate direct credentials from upstream routing',()=>{
  expect(canonicalVoiceProvider('upstream')).toBe('upstream:elevenlabs');
  for(const provider of ['elevenlabs','upstream:elevenlabs','gemini','upstream:gemini','paxalabs','upstream:paxalabs'])expect(canonicalVoiceProvider(provider)).toBe(provider);
  expect(nativeVoiceModel('upstream:elevenlabs','elevenlabs/eleven_flash_v2_5')).toBe('eleven_flash_v2_5');
  expect(()=>nativeVoiceModel('upstream:elevenlabs','gemini/model')).toThrow('VOICE_MODEL_PROVIDER_MISMATCH');
});
test('config migration normalizes all roles once without changing selections or enablement',()=>{
  const voice={enabled:false,tts:{provider:'upstream',model:'eleven_v3',voiceId:'chosen'},stt:{provider:'upstream',model:'scribe_v2_realtime'},notes:{enabled:true,provider:'upstream',model:'scribe_v2'}};
  const document={gateway:{orchestration:true},agents:[{id:'a',voice}]};
  expect(migrateAgentVoiceConfig(document)).toBe(true);
  for(const role of ['tts','stt','notes'] as const)expect(voice[role].provider).toBe('upstream:elevenlabs');
  expect(voice.enabled).toBe(false);expect(voice.tts.voiceId).toBe('chosen');expect(voice.tts.model).toBe('eleven_v3');
  expect(migrateAgentVoiceConfig(document)).toBe(false);
  expect(resolveOrchestrationConfig(undefined,{...voice,tts:{...voice.tts,provider:'upstream'}}).voice.tts.provider).toBe('upstream:elevenlabs');
});
test('legacy per-chat voice remains selected after the agent provider is normalized',()=>{
  const store=new OrchestrationStore(':memory:','a');
  try{
    store.run('INSERT INTO telegram_tts_voices VALUES(?,?,?)','chat','upstream','chosen');
    const voices=new TelegramVoices(store,()=>({provider:'upstream:elevenlabs',model:'eleven_v3',voiceId:'default'}));
    expect(voices.settings('chat').voiceId).toBe('chosen');
  }finally{store.close();}
});
test('both aliases use the same upstream adapters, catalog cache and automatic voice',async()=>{
  jest.spyOn(upstream,'upstreamVoiceConnection').mockReturnValue({base:new URL('https://provider.test/v1/voice/elevenlabs/'),key:'alias-catalog'});
  const fetcher=jest.spyOn(global,'fetch').mockResolvedValue({ok:true,json:async()=>({voices:[{voice_id:'chosen',name:'Chosen'}]})} as Response);
  for(const provider of ['upstream','upstream:elevenlabs']){
    expect(ttsProvider({provider,model:'eleven_v3'}).id).toBe('upstream:elevenlabs');
    expect(sttProvider({provider,model:'scribe_v2_realtime'}).id).toBe('upstream:elevenlabs');
    expect(await voiceChoices({provider,voiceId:''})).toEqual([{id:'chosen',name:'Chosen',gender:undefined}]);
    expect(await resolveVoiceId({provider,voiceId:''})).toBe('chosen');
    expect(voicePreviewLanguages(provider,'eleven_flash_v2_5')).not.toContain('th');
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toBe('https://provider.test/v1/voice/elevenlabs/voices');
});
test.each(['upstream','upstream:elevenlabs'])('voice notes with %s use the relay token and endpoint',async provider=>{
  jest.spyOn(upstream,'upstreamVoiceConnection').mockReturnValue({base:new URL('https://provider.test/v1/voice/elevenlabs/'),key:'relay-key'});
  const root=mkdtempSync(join(tmpdir(),'voice-alias-'));
  const file=join(root,'note.wav');writeFileSync(file,'fixture audio');
  const request=jest.fn().mockResolvedValue({ok:true,json:async()=>({text:'hello'})});
  try{
    expect(await transcribeVoiceNote(file,{provider,model:'scribe_v2'},request)).toBe('hello');
    expect(request.mock.calls[0][0]).toBe('https://provider.test/v1/voice/elevenlabs/speech-to-text');
    expect(request.mock.calls[0][1].headers).toEqual({Authorization:'Bearer relay-key'});
  }finally{rmSync(root,{recursive:true,force:true});}
});
