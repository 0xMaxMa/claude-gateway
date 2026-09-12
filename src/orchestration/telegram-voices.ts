import { randomUUID } from 'crypto';
import { OrchestrationStore } from './store';
import { voiceChoices, VoiceChoice } from '../voice/providers/voice-catalog';

type TtsConfig={provider:string;model:string;voiceId:string};
export class TelegramVoices {
  private menus=new Map<string,{chatId:string;provider:string;until:number;voices:VoiceChoice[]}>();
  constructor(private store:OrchestrationStore,private config:()=>TtsConfig,private catalog=voiceChoices,private pageSize=10){}
  settings(chatId:string):TtsConfig {
    const config=this.config(),choice=this.store.get('SELECT provider,voice_id FROM telegram_tts_voices WHERE chat_id=?',chatId);
    return {...config,voiceId:choice ? choice.provider===config.provider ? String(choice.voice_id) : config.voiceId : config.voiceId};
  }
  private prune(){for(const [id,m] of this.menus)if(m.until<Date.now())this.menus.delete(id);}
  async menu(chatId:string,page=0,menuId?:string,gender?:string) {
    this.prune();const config=this.config();
    if(!Number.isSafeInteger(page)||page<0)throw Error('INVALID_VOICE_PAGE');
    if(!menuId){
      const voices=await this.catalog(config);
      if(config.provider!==this.config().provider)throw Error('VOICE_PROVIDER_CHANGED');
      menuId=randomUUID();if(this.menus.size>=1000)this.menus.delete(this.menus.keys().next().value!);
      this.menus.set(menuId,{chatId,provider:config.provider,until:Date.now()+300000,voices});
    }
    const menu=this.menus.get(menuId);
    if(!menu||menu.chatId!==chatId||menu.provider!==config.provider)throw Error('VOICE_MENU_EXPIRED');
    const groupOf=(v:VoiceChoice)=>v.gender==='male'||v.gender==='female'||v.gender==='neutral'?v.gender:'unspecified';
    const selected=this.settings(chatId).voiceId;
    const groups=['male','female','neutral','unspecified'].filter(g=>menu.voices.some(v=>groupOf(v)===g));
    if(gender!==undefined&&!groups.includes(gender))throw Error('INVALID_VOICE_GROUP');
    const filtered=menu.voices.map((v,index)=>({...v,index,selected:v.id===selected})).filter(v=>groupOf(v)===gender);
    const pages=Math.max(1,Math.ceil(filtered.length/this.pageSize));if(page>=pages)throw Error('INVALID_VOICE_PAGE');
    return {menuId,provider:config.provider,page,pages,gender,groups,
      selected:menu.voices.find(v=>v.id===selected)?.name??(selected ? 'Unavailable — choose a voice' : 'Auto'),
      voices:filtered.slice(page*this.pageSize,page*this.pageSize+this.pageSize)};
  }
  async choose(chatId:string,menuId:string,index:number){
    this.prune();const menu=this.menus.get(menuId),config=this.config();
    if(!menu||menu.chatId!==chatId||menu.provider!==config.provider)throw Error('VOICE_MENU_EXPIRED');
    const voice=menu.voices[index];if(!voice||!Number.isSafeInteger(index))throw Error('INVALID_VOICE');
    if(!(await this.catalog(config)).some(v=>v.id===voice.id)||config.provider!==this.config().provider)throw Error('VOICE_UNAVAILABLE');
    this.store.run('INSERT INTO telegram_tts_voices VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET provider=excluded.provider,voice_id=excluded.voice_id',chatId,config.provider,voice.id);
    this.menus.delete(menuId);return {voiceId:voice.id,name:voice.name,provider:config.provider};
  }
  dismiss(chatId:string,menuId:string){if(this.menus.get(menuId)?.chatId===chatId)this.menus.delete(menuId);}
}
