import { VoiceReplyMode } from './voice-reply-policy';
import { formatTaskUpdatedAt } from '../shared/task-updated-time';
import { randomUUID } from 'crypto';
import { OrchestrationStore, channelVoiceKey } from './store';
import { TaskControls } from './task-controls';
import { StopControls } from './stop-controls';
import { TelegramVoices } from './telegram-voices';

export interface ControlScope { channel:string; chatId:string; thread:string; sessionId:string; principalId:string; }
export interface ControlMenu { text:string; buttons:Array<{label:string;data:string}>; close?:boolean; }
type Action = {kind:string; page?:number; id?:string; index?:number; gender?:string; mode?:VoiceReplyMode};
export class ChannelControls {
  private actions=new Map<string,{scope:string;expires:number;action:Action}>();
  constructor(private store:OrchestrationStore,private tasks:TaskControls,private stop:StopControls,private voices:TelegramVoices,private voiceAvailable:()=>boolean){}
  private scopeKey(s:ControlScope){return JSON.stringify([s.channel,s.chatId,s.thread,s.sessionId,s.principalId]);}
  private button(s:ControlScope,label:string,action:Action){
    for(const [id,a] of this.actions)if(a.expires<Date.now())this.actions.delete(id);
    if(this.actions.size>=5000)this.actions.delete(this.actions.keys().next().value!);
    const id=randomUUID();this.actions.set(id,{scope:this.scopeKey(s),expires:Date.now()+300000,action});return {label,data:`orch:${id}`};
  }
  async handle(s:ControlScope,text:string):Promise<ControlMenu> {
    const key=channelVoiceKey(s.channel,s.chatId,s.thread);
    let action:Action;
    if(text.startsWith('/orch ')){
      const id=text.slice(6).trim(),entry=this.actions.get(id);
      if(!entry||entry.expires<Date.now()||entry.scope!==this.scopeKey(s))throw Error('CONTROL_EXPIRED');
      action=entry.action;
      if(['dismiss','voice_set','voice_pick','cancel','stop_pick'].includes(action.kind))this.actions.delete(id);
    }else{
      const [command,arg]=text.trim().split(/\s+/);
      if(command==='/voice'&&arg&&!['on','off','auto'].includes(arg.toLowerCase()))return {text:'Use /voice, /voice on, /voice auto or /voice off.',buttons:[]};
      action=command==='/voice'?{kind:arg?'voice_set':'voice',mode:arg?.toLowerCase() as VoiceReplyMode}:{kind:command.slice(1)};
    }
    if (action.kind.startsWith('voice') && !['telegram', 'discord', 'line', 'slack'].includes(s.channel)) return {text: 'Voice replies are not supported on this channel yet.', buttons: []};
    // Membership is checked even for settings. A new, unused session has no data to expose.
    this.tasks.list(s.sessionId,s.principalId);
    const b=(label:string,a:Action)=>this.button(s,label,a),dismiss=()=>b('Dismiss',{kind:'dismiss'});
    if(action.kind==='dismiss')return {text:'Dismissed.',buttons:[],close:true};
    if(action.kind==='voice'||action.kind==='voice_set'){
      if(!this.voiceAvailable())return {text:'Voice replies are not configured for this agent.',buttons:[]};
      const labels:Record<VoiceReplyMode,string>={on:'🔊 Always',auto:'🎙️ Only reply voice message',off:'🔇 Off'};
      if(action.kind==='voice_set'){this.store.setChannelVoiceMode(s.channel,s.chatId,s.thread,action.mode!);return {text:`Voice replies: ${labels[action.mode!]}`,buttons:[],close:true};}
      const mode=this.store.channelVoiceMode(s.channel,s.chatId,s.thread);
      return {text:`Voice replies: ${labels[mode]}\nAuto replies with audio to voice messages and their task results.`,buttons:([ 'on','auto','off'] as VoiceReplyMode[]).map(value=>b(`${mode===value?'✅ ':''}${labels[value]}`,{kind:'voice_set',mode:value})).concat(dismiss())};
    }
    if(action.kind==='voices'){
      const menu=await this.voices.menu(key,action.page??0,action.id,action.gender);
      const labels:Record<string,string>={male:'👨 Male',female:'👩 Female',neutral:'Neutral',unspecified:'Unspecified'};
      const buttons=menu.gender?menu.voices.map(v=>b(`${v.selected?'✅ ':''}${v.name}`,{kind:'voice_pick',id:menu.menuId,index:v.index})):menu.groups.map(g=>b(labels[g],{kind:'voices',id:menu.menuId,gender:g}));
      if(menu.gender){
        if(menu.page>0)buttons.push(b('Previous',{...action,id:menu.menuId,page:menu.page-1}));
        if(menu.page+1<menu.pages)buttons.push(b('Next',{...action,id:menu.menuId,page:menu.page+1}));
        buttons.push(b('Back',{kind:'voices',id:menu.menuId}));
      }
      buttons.push(dismiss());
      return {text:`Agent voice · ${menu.provider}\nSelected: ${menu.selected}\n${menu.gender?`${labels[menu.gender]} (${menu.page+1}/${menu.pages})\n${menu.voices.map((v,i)=>`${i+1}. ${v.selected?'✅ ':''}${v.name}`).join('\n')}`:'Choose a voice category:'}`,buttons};
    }
    if(action.kind==='voice_pick'){const voice=await this.voices.choose(key,action.id!,action.index!);return {text:`Selected: ${voice.name}`,buttons:[],close:true};}
    if(action.kind==='stop'){
      const menu=this.stop.open(s.sessionId,s.principalId);
      // /stop interrupts immediately; the regular task browser handles any number of pending tasks.
      const list=await this.handle(s,'/tasks');return {...list,text:`${menu.stopped?'Agent reply stopped.':'The agent is not currently replying.'}\n${list.text}\nChoose a task, then Stop task.`};
    }
    if(action.kind==='tasks'){
      const menu=this.tasks.list(s.sessionId,s.principalId,action.page??0,8);
      const buttons=menu.tasks.map((t,i)=>b(`${menu.page*8+i+1}. ${t.title}`,{kind:'detail',id:t.taskId}));
      if(menu.page>0)buttons.push(b('Previous',{kind:'tasks',page:menu.page-1}));
      if(menu.page+1<menu.pages)buttons.push(b('Next',{kind:'tasks',page:menu.page+1}));
      buttons.push(b('🔄 Refresh',{kind:'tasks',page:menu.page}),dismiss());
      return {text:menu.total?`Tasks (${menu.total}) · Page ${menu.page+1}/${menu.pages}\n${menu.tasks.map((t,i)=>`${menu.page*8+i+1}. ${t.title} — ${t.state}`).join('\n')}`:'No pending tasks in this chat.',buttons};
    }
    if(action.kind==='detail'||action.kind==='cancel'){
      const task=action.kind==='cancel'?this.tasks.cancel(s.sessionId,s.principalId,action.id!):this.tasks.detail(s.sessionId,s.principalId,action.id!);
      return {text:`${task.title}\nStatus: ${task.state}\nUpdated: ${formatTaskUpdatedAt(task.updatedAt)}${task.progress?`\n\nLatest progress:\n${task.progress}`:''}${task.question?`\n\nWaiting for your input:\n${task.question}`:''}`,buttons:[...(task.canStop?[b(task.state==='needs_reconciliation'?'🔄 Retry cleanup':'🔴 Stop task',{kind:'cancel',id:task.taskId})]:[]),b('🔄 Refresh',{kind:'detail',id:task.taskId}),b('Back',{kind:'tasks'}),dismiss()]};
    }
    return {text:'Commands: /session · /sessions · /voice · /voices · /tasks · /stop',buttons:[]};
  }
}
