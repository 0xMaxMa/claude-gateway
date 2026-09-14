import { voiceChoices, resolveVoiceId } from '../../../src/voice/providers/voice-catalog';
afterEach(()=>jest.restoreAllMocks());
test('ElevenLabs catalog sanitizes metadata and caches real voices without inventing missing defaults',async()=>{
 const old=process.env.ELEVENLABS_API_KEY;process.env.ELEVENLABS_API_KEY='catalog-test';
 const fetcher=jest.spyOn(global,'fetch').mockResolvedValue({ok:true,json:async()=>({voices:[{voice_id:'other',name:'Other',labels:{gender:'female'},secret:'omit'}]})} as Response);
 try{expect(await voiceChoices({provider:'elevenlabs',voiceId:'missing'})).toEqual([{id:'other',name:'Other',gender:'female'}]);await voiceChoices({provider:'elevenlabs',voiceId:'missing'});expect(fetcher).toHaveBeenCalledTimes(1);}
 finally{if(old===undefined)delete process.env.ELEVENLABS_API_KEY;else process.env.ELEVENLABS_API_KEY=old;}
});
test('Cartesia reads all catalog pages, normalizes gender and never reuses another provider catalog',async()=>{
 const old=process.env.CARTESIA_API_KEY;process.env.CARTESIA_API_KEY='catalog-test';
 const fetcher=jest.spyOn(global,'fetch').mockResolvedValueOnce({ok:true,json:async()=>({data:[{id:'a',name:'Alpha',gender:' FEMALE '}],has_more:true,next_page:'a'})} as Response).mockResolvedValueOnce({ok:true,json:async()=>({data:[{id:'b',name:'Beta',gender:'Male'}],has_more:false})} as Response);
 try{expect(await voiceChoices({provider:'cartesia',voiceId:'a'})).toEqual([{id:'a',name:'Alpha',gender:'female'},{id:'b',name:'Beta',gender:'male'}]);expect(String(fetcher.mock.calls[1][0])).toContain('starting_after=a');expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({'Cartesia-Version':'2026-08-14'});}
 finally{if(old===undefined)delete process.env.CARTESIA_API_KEY;else process.env.CARTESIA_API_KEY=old;}
});
test('unsupported providers report unavailable instead of offering a made-up voice',async()=>{
 const fetcher=jest.spyOn(global,'fetch');await expect(voiceChoices({provider:'unsupported',voiceId:'configured'})).rejects.toThrow('VOICE_CATALOG_UNSUPPORTED');expect(fetcher).not.toHaveBeenCalled();
});

test('Auto uses a stable ID, ignores ordering, and explicit choices bypass the catalog', async () => {
 const old=process.env.ELEVENLABS_API_KEY;process.env.ELEVENLABS_API_KEY='auto-test';
 const fetcher=jest.spyOn(global,'fetch').mockResolvedValue({ok:true,json:async()=>({voices:[{voice_id:'z',name:'Z'},{voice_id:'a',name:'A'}]})} as Response);
 try {
  expect(await resolveVoiceId({provider:'elevenlabs',voiceId:'chosen'})).toBe('chosen');
  expect(fetcher).not.toHaveBeenCalled();
  expect(await resolveVoiceId({provider:'elevenlabs',voiceId:''})).toBe('a');
  fetcher.mockRejectedValue(Error('offline'));
  expect(await resolveVoiceId({provider:'elevenlabs',voiceId:''})).toBe('a');
  process.env.ELEVENLABS_API_KEY='different-account';
  await expect(resolveVoiceId({provider:'elevenlabs',voiceId:''})).rejects.toThrow('offline');
  fetcher.mockResolvedValue({ok:true,json:async()=>({voices:[]})} as Response);
  await expect(resolveVoiceId({provider:'elevenlabs',voiceId:''})).rejects.toThrow('VOICE_CATALOG_UNAVAILABLE');
 } finally { if(old===undefined)delete process.env.ELEVENLABS_API_KEY;else process.env.ELEVENLABS_API_KEY=old; }
});

test('Gemini catalog retains documented genders for every voice', async () => {
 const previous = process.env.GEMINI_API_KEY;
 process.env.GEMINI_API_KEY = 'gender-catalog-fixture';
 try {
  const voices = await voiceChoices({provider:'gemini',voiceId:''});
  expect(voices).toHaveLength(30);
  expect(voices.filter(v=>v.gender==='female')).toHaveLength(14);
  expect(voices.filter(v=>v.gender==='male')).toHaveLength(16);
  expect(voices).toEqual(expect.arrayContaining([{id:'Kore',name:'Kore',gender:'female'},{id:'Puck',name:'Puck',gender:'male'}]));
 } finally { if(previous===undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY=previous; }
});
