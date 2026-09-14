import { OrchestrationStore } from '../../../src/orchestration/store';
import { TelegramVoices } from '../../../src/orchestration/telegram-voices';
test('voice selection persists per chat/provider, paginates and rejects stale or foreign picks',async()=>{
 const store=new OrchestrationStore(':memory:','a');let config={provider:'first',model:'model',voiceId:'v0'};
 const catalog=jest.fn(async()=>Array.from({length:12},(_,i)=>({id:'v'+i,name:'Voice '+i,gender:'female'})));
 const controls=new TelegramVoices(store,()=>config,catalog);
 try{
  const root=await controls.menu('chat');expect(root.groups).toEqual(['female']);expect(root.voices).toEqual([]);
  const menu=await controls.menu('chat',0,root.menuId,'female');expect(menu.voices).toHaveLength(10);expect(menu.pages).toBe(2);expect(menu.selected).toBe('Voice 0');
  const page=await controls.menu('chat',1,menu.menuId,'female');expect(page.voices[1].index).toBe(11);
  await expect(controls.choose('other',menu.menuId,11)).rejects.toThrow();await controls.choose('chat',menu.menuId,11);
  expect(controls.settings('chat').voiceId).toBe('v11');expect(controls.settings('other').voiceId).toBe('v0');
  const reopened=new TelegramVoices(store,()=>config,catalog);expect(reopened.settings('chat').voiceId).toBe('v11');
  const stale=await controls.menu('chat');config={...config,provider:'second',voiceId:'new-default'};
  await expect(controls.choose('chat',stale.menuId,0)).rejects.toThrow('VOICE_MENU_EXPIRED');expect(controls.settings('chat').voiceId).toBe('new-default');
  const next=await controls.menu('chat');await controls.choose('chat',next.menuId,2);expect(controls.settings('chat')).toMatchObject({provider:'second',voiceId:'v2'});
 }finally{store.close();}
});
test('dismiss does not select or change a voice',async()=>{
 const store=new OrchestrationStore(':memory:','a');const controls=new TelegramVoices(store,()=>({provider:'a',model:'m',voiceId:'v'}),async()=>[{id:'v',name:'Voice'}]);
 try{const menu=await controls.menu('c');controls.dismiss('c',menu.menuId);await expect(controls.choose('c',menu.menuId,0)).rejects.toThrow();expect(store.all('SELECT * FROM telegram_tts_voices')).toHaveLength(0);}finally{store.close();}
});

test('gender filtering retains original voice indexes and supports returning to categories',async()=>{
 const store=new OrchestrationStore(':memory:','a');
 const catalog=async()=>[{id:'m',name:'Male voice',gender:'male'},{id:'f',name:'Female voice',gender:'female'},{id:'u',name:'Unknown'},{id:'n',name:'Neutral voice',gender:'neutral'}];
 const controls=new TelegramVoices(store,()=>({provider:'a',model:'m',voiceId:'f'}),catalog);
 try{
  const root=await controls.menu('c');expect(root.groups).toEqual(['male','female','neutral','unspecified']);expect(root.voices).toEqual([]);
  const female=await controls.menu('c',0,root.menuId,'female');expect(female.voices).toEqual([expect.objectContaining({id:'f',index:1,selected:true})]);
  expect((await controls.menu('c',0,root.menuId)).voices).toEqual([]);
  await expect(controls.menu('other',0,root.menuId,'female')).rejects.toThrow('VOICE_MENU_EXPIRED');
  await expect(controls.menu('c',0,root.menuId,'invalid')).rejects.toThrow('INVALID_VOICE_GROUP');
  await controls.choose('c',root.menuId,female.voices[0].index);expect(controls.settings('c').voiceId).toBe('f');
 }finally{store.close();}
});
