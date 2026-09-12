import { stripMarkdownPreservingUrls } from '../agent/line-pure';
import { orderLineRequest } from '../shared/line-request-order';
import type { AgentConfig } from '../types';
import type { ControlMenu } from './channel-controls';

/** Provider adapters keep menus native; LINE replaces quick replies instead of editing old messages. */
export async function sendControlMenu(agent:AgentConfig,channel:string,chatId:string,menu:ControlMenu,meta:Record<string,string>,request:typeof fetch=fetch):Promise<void>{
  const call=async(url:string,body:unknown,headers:Record<string,string>,method='POST')=>{
    const send=()=>request(url,{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const response=await (channel==='line'?orderLineRequest(agent.id,chatId,send):send());
    if(!response.ok)throw Object.assign(Error('CONTROL_DELIVERY_FAILED'),{status:response.status});
    const result=await response.json() as {ok?:boolean};if(result.ok===false)throw Error('CONTROL_DELIVERY_FAILED');
  };
  const buttons=menu.buttons;
  if(channel==='discord'&&agent.discord?.botToken){
    const components=[];for(let i=0;i<buttons.length;i+=5)components.push({type:1,components:buttons.slice(i,i+5).map(b=>({type:2,style:2,label:b.label.slice(0,80),custom_id:b.data}))});
    await call(`https://discord.com/api/v10/channels/${encodeURIComponent(chatId)}/messages${meta.control_message_id?'/'+encodeURIComponent(meta.control_message_id):''}`,{content:menu.text.slice(0,1950),components,allowed_mentions:{parse:[]}},{Authorization:`Bot ${agent.discord.botToken}`},meta.control_message_id?'PATCH':'POST');
  }else if(channel==='slack'&&agent.slack?.botToken){
    const blocks:any[]=[{type:'section',text:{type:'plain_text',text:menu.text.slice(0,2900)}}];
    for(let i=0;i<buttons.length;i+=5)blocks.push({type:'actions',elements:buttons.slice(i,i+5).map(b=>({type:'button',text:{type:'plain_text',text:b.label.slice(0,75)},action_id:b.data,value:b.data}))});
    await call(`https://slack.com/api/${meta.control_message_id?'chat.update':'chat.postMessage'}`,{channel:chatId,text:menu.text.slice(0,2900),blocks,mrkdwn:false,...(meta.control_message_id?{ts:meta.control_message_id}:meta.thread_ts?{thread_ts:meta.thread_ts}:{})},{Authorization:`Bearer ${agent.slack.botToken}`});
  }else if(channel==='line'&&agent.line?.channelAccessToken){
    if(buttons.length>13)throw Error('TOO_MANY_QUICK_REPLIES');
    const message={type:'text',text:stripMarkdownPreservingUrls(menu.text).slice(0,4900),...(buttons.length?{quickReply:{items:buttons.map(b=>({type:'action',action:{type:'postback',label:b.label.slice(0,20),data:b.data}}))}}:{})};
    const headers={Authorization:`Bearer ${agent.line.channelAccessToken}`};
    if(meta.reply_token){
      try{await call('https://api.line.me/v2/bot/message/reply',{replyToken:meta.reply_token,messages:[message]},headers);return;}catch(error){if((error as {status?:number}).status!==400)throw error;/* expired reply tokens fall back to push */}
    }
    await call('https://api.line.me/v2/bot/message/push',{to:chatId,messages:[message]},headers);
  }else throw Error('CONTROL_DELIVERY_NOT_CONFIGURED');
}
