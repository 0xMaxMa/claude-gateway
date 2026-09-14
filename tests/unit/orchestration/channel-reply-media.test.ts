import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveStoredReply, replyContext } from '../../../src/orchestration/reply-context';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { channelInputMedia } from '../../../src/orchestration/channel-input-media';
import { createMessageHandler } from '../../../mcp/tools/discord/inbound';
import { normalizeSlackEvent } from '../../../src/api/slack-webhook-router';
import { normalizeLineEvent } from '../../../src/api/line-webhook-router';
import { resolveWeixinReply } from '../../../src/wechat/ilink-client';
import type { AgentConfig } from '../../../src/types';
import type { ChatChannel } from '../../../src/history/types';

test.each<ChatChannel>(['telegram','discord','slack','line','whatsapp','whatsapp_cloud','wechat'])('%s ID-only reply resolves its text and image/file from the same authorized chat',source=>{
 const store=new OrchestrationStore(':memory:','a');
 const scope={agentId:'a',agentSessionId:'s',source,accountId:'bot',chatId:'c',threadKey:'account:first',principalId:'u'};
 try{
  store.acceptInput({scope,text:'Original report with attachment',metadata:{platformMessageId:'42',senderName:'User'},attachmentIds:['media/photo.png','media/report.pdf']});
  expect(resolveStoredReply(store,scope,{repliedMessageId:'42'})).toMatchObject({repliedText:'Original report with attachment',repliedAttachmentIds:['media/photo.png','media/report.pdf']});
  for(const changed of [{chatId:'elsewhere'},{accountId:'other'},{principalId:'outsider'}])expect(resolveStoredReply(store,{...scope,...changed},{repliedMessageId:'42'})).toEqual({repliedMessageId:'42'});
  if(source==='whatsapp')expect(resolveStoredReply(store,{...scope,threadKey:'account:second'},{repliedMessageId:'42'})).toEqual({repliedMessageId:'42'});
  expect(replyContext(resolveStoredReply(store,scope,{repliedMessageId:'missing'}))).toContain('unavailable');
 }finally{store.close();}
});
test('own files and quoted files survive ingestion separately, including duplicate bytes and multiple attachments',async()=>{
 const root=mkdtempSync(join(tmpdir(),'channel-media-'));
 try{
  const own=join(root,'own.txt'),quoted=join(root,'quoted.pdf');writeFileSync(own,'own');writeFileSync(quoted,'%PDF-quoted');
  const result=await channelInputMedia({id:'a'} as AgentConfig,root,'slack','chat',{attachments_json:JSON.stringify([{path:own,name:'own.txt'},{path:quoted,name:'quoted.pdf',quoted:true}]),replied_image_path:quoted},jest.fn());
  expect(result.media).toHaveLength(2);expect(new Set(result.quoted).size).toBe(1);
  expect(readFileSync(join(root,'a',result.media[1]),'utf8')).toBe('%PDF-quoted');
  expect(result.details).toContainEqual({ref:result.media[1],name:'quoted.pdf',quoted:true});
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Telegram replied document is downloaded even when current message has no attachment',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tg-quote-')),prior=global.fetch;
 const request=jest.fn(async(url:any)=>String(url).endsWith('/getFile')?new Response(JSON.stringify({ok:true,result:{file_path:'documents/report.pdf'}})):new Response('%PDF-bytes'));global.fetch=request as typeof fetch;
 try{
  const result=await channelInputMedia({id:'a',telegram:{botToken:'test'}} as AgentConfig,root,'telegram','chat',{replied_attachment_file_id:'provider-file',replied_attachment_name:'report.pdf'},jest.fn());
  expect(result.media).toHaveLength(1);expect(result.quoted).toEqual(result.media);expect(result.details[0].name).toBe('report.pdf');
 }finally{global.fetch=prior;rmSync(root,{recursive:true,force:true});}
});
test('Discord keeps all own attachments and same-channel replied attachments; cannot fetch a different channel',async()=>{
 const replied:any={channelId:'c',content:'Quoted caption',author:{username:'bot'},attachments:{values:()=>[{url:'https://cdn.discordapp.com/a.png',name:'a.png'}].values()}};
 const message:any={id:'new',content:'Check this',author:{id:'u',username:'u',bot:false},guild:null,guildId:null,channelId:'c',channel:{isThread:()=>false},client:{user:{id:'bot'}},createdTimestamp:1,
  attachments:{first:()=>({url:'https://cdn.discordapp.com/one.pdf'}),values:()=>[{url:'https://cdn.discordapp.com/one.pdf'},{url:'https://cdn.discordapp.com/two.pdf'}].values()},reference:{messageId:'old',channelId:'c'},fetchReference:jest.fn(async()=>replied)};
 const receive=jest.fn(),handle=createMessageHandler('a',receive,{} as any,{dmPolicy:'open',dmAllowlist:[],guildAllowlist:[],channelAllowlist:[],roleAllowlist:[]});
 await handle(message);expect(receive.mock.calls[0][0]).toMatchObject({replyToMessageId:'old',repliedText:'Quoted caption'});expect(receive.mock.calls[0][0].attachments).toHaveLength(3);
 message.reference.channelId='other';message.fetchReference.mockClear();await handle(message);expect(message.fetchReference).not.toHaveBeenCalled();expect(receive.mock.calls[1][0].replyToMessageId).toBeUndefined();
});
test('LINE and Slack preserve quote IDs without pretending the API supplied original text',()=>{
 const line=normalizeLineEvent({type:'message',timestamp:1,source:{type:'user',userId:'u'},message:{type:'text',id:'new',text:'This',quotedMessageId:'old'}} as any);
 expect(line?.meta.replied_message_id).toBe('old');expect(line?.meta.replied_text).toBeUndefined();
 const slack=normalizeSlackEvent({type:'message',channel:'D1',channel_type:'im',user:'u',ts:'2',thread_ts:'1',text:'This'});
 expect(slack?.meta).toMatchObject({thread_ts:'1',replied_message_id:'1'});
});
test('WeChat native ref_msg text is preserved and untrusted quoted media URLs remain denied',()=>{
 expect(resolveWeixinReply([{type:1,ref_msg:{svr_id:'old',title:'summary',message_item:{type:1,text_item:{text:'Full quoted text'}}}}])).toMatchObject({messageId:'old',text:'Full quoted text'});
 const value=resolveWeixinReply([{type:1,ref_msg:{message_item:{type:2,image_item:{media:{full_url:'http://127.0.0.1/private'}}}}}]);
 expect(value?.image).toBeUndefined();
});

test.each([{path:'x',quoted:'false'}, {path:'x',name:{}}, {}])('rejects malformed attachment metadata before reading files: %j',async item=>{
 await expect(channelInputMedia({id:'a'} as AgentConfig,'/unused','slack','chat',{attachments_json:JSON.stringify([item])},jest.fn())).rejects.toThrow('INVALID_ATTACHMENT');
});

test('an expired quoted attachment preserves the new message and its own attachment with an explicit diagnostic',async()=>{
 const root=mkdtempSync(join(tmpdir(),'expired-quote-'));
 try{
  const own=join(root,'own.txt');writeFileSync(own,'current file');
  const meta:Record<string,string>={attachments_json:JSON.stringify([{path:own},{path:join(root,'missing.pdf'),quoted:true}])};
  const result=await channelInputMedia({id:'a'} as AgentConfig,root,'discord','chat',meta,jest.fn());
  expect(result.media).toHaveLength(1);expect(result.quoted).toEqual([]);expect(meta.attachment_error).toContain('quoted attachment is unavailable');
 }finally{rmSync(root,{recursive:true,force:true});}
});
