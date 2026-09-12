import { OrchestrationStore, channelVoiceKey } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskControls } from '../../../src/orchestration/task-controls';
import { StopControls } from '../../../src/orchestration/stop-controls';
import { TelegramVoices } from '../../../src/orchestration/telegram-voices';
import { ChannelControls } from '../../../src/orchestration/channel-controls';
import { sendControlMenu } from '../../../src/orchestration/control-delivery';
import { AgentConfig } from '../../../src/types';

test.each(['discord','line','slack'] as const)('%s controls isolate preferences and callbacks, navigate voices and stop one worker',async channel=>{
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),stop=jest.fn(()=>true);
 const voices=new TelegramVoices(store,()=>({provider:'p',model:'m',voiceId:'v0'}),async()=>Array.from({length:30},(_,i)=>({id:'v'+i,name:'Voice '+i,gender:i%2?'female':'male'})),8);
 const controls=new ChannelControls(store,new TaskControls(store,tasks),new StopControls(store,tasks,stop),voices,()=>true);
 const scope={channel,chatId:'chat',thread:'thread',sessionId:'s',principalId:'owner'};
 const click=(data:string,s=scope)=>controls.handle(s,'/orch '+data.slice(5));
 try{
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:channel,accountId:'bot',chatId:'chat',threadKey:'thread',principalId:'owner'},text:'work'});
  const decision=new DecisionService(store).begin(input.conversationId,'owner',[input.inputId]);
  const a=tasks.spawn({...input,...decision,principalId:'owner',actionId:'a',execute:true,writeMemory:false},{title:'Review PR',instructions:'Review',targetProfile:'default-worker'});
  const b=tasks.spawn({...input,...decision,principalId:'owner',actionId:'b',execute:true,writeMemory:false},{title:'Keep working',instructions:'Work',targetProfile:'default-worker'});
  const initial=await controls.handle(scope,'/voice');expect(initial.text).toContain('Off');
  await expect(click(initial.buttons[0].data,{...scope,principalId:'intruder'})).rejects.toThrow();
  await expect(click(initial.buttons[0].data,{...scope,sessionId:'other'})).rejects.toThrow();
  await click(initial.buttons[0].data);expect(store.channelVoice(channel,'chat','thread')).toBe(true);expect(store.channelVoice(channel,'chat','other')).toBe(true);expect(store.channelVoice(channel,'other-chat','thread')).toBe(false);expect(store.telegramVoice('chat')).toBe(false);
  await controls.handle(scope,'/voice auto');expect(store.channelVoiceMode(channel,'chat','thread')).toBe('auto');
  let menu=await controls.handle(scope,'/voice');expect(menu.buttons.some(b=>b.label==='✅ 🎙️ Only reply voice message')).toBe(true);
  menu=await controls.handle(scope,'/voices');menu=await click(menu.buttons.find(b=>b.label==='👩 Female')!.data);
  expect(menu.text).toContain('Female');expect(menu.buttons[0].label).toBe('Voice 1');expect(menu.buttons.length).toBeLessThanOrEqual(13);
  menu=await click(menu.buttons.find(b=>b.label==='Next')!.data);expect(menu.buttons[0].label).toBe('Voice 17');
  await click(menu.buttons[0].data);expect(voices.settings(channelVoiceKey(channel,'chat','thread')).voiceId).toBe('v17');
  menu=await controls.handle(scope,'/tasks');expect(stop).not.toHaveBeenCalled();
  menu=await click(menu.buttons.find(b=>b.label.includes('Review PR'))!.data);
  await click(menu.buttons.find(b=>b.label==='🔴 Stop task')!.data);expect(store.task(a.taskId)!.state).toBe('cancelled');expect(store.task(b.taskId)!.state).toBe('queued');
  await controls.handle(scope,'/stop');expect(stop).toHaveBeenCalledWith('s');
  menu=await controls.handle(scope,'/voice');const old=Date.now;Date.now=()=>old()+300001;try{await expect(click(menu.buttons[0].data)).rejects.toThrow('CONTROL_EXPIRED');}finally{Date.now=old;}
 }finally{store.close();}
});
test.each(['discord','line','slack'])('%s renders native controls and clears them after selection',async channel=>{
 const agent={discord:{botToken:'d'},line:{channelAccessToken:'l'},slack:{botToken:'s'}} as AgentConfig;
 const request=jest.fn(async(_url:string,_init:RequestInit)=>new Response(JSON.stringify({ok:true})));
 await sendControlMenu(agent,channel,'chat',{text:'Choose',buttons:[{label:'✅ On',data:'orch:test'}]},{thread_ts:'thread',control_message_id:'message'},request as typeof fetch);
 let body=JSON.parse(String(request.mock.calls[0][1].body));
 if(channel==='discord')expect(body.components[0].components[0].custom_id).toBe('orch:test');
 if(channel==='slack')expect(body.blocks[1].elements[0].value).toBe('orch:test');
 if(channel==='line')expect(body.messages[0].quickReply.items[0].action.type).toBe('postback');
 await sendControlMenu(agent,channel,'chat',{text:'Done',buttons:[],close:true},{control_message_id:'message'},request as typeof fetch);
 body=JSON.parse(String(request.mock.calls[1][1].body));
 if(channel==='discord')expect(body.components).toEqual([]);
 if(channel==='slack')expect(body.blocks).toHaveLength(1);
 if(channel==='line')expect(body.messages[0].quickReply).toBeUndefined();
});
