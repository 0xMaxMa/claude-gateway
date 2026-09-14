import {mkdtempSync,readdirSync,rmSync,utimesSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {ReceiverSpool} from '../../../mcp/tools/receiver-spool';
import {mediaGroupKey,mergeMediaGroup} from '../../../mcp/tools/telegram/media-group';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {resolveStoredReply} from '../../../src/orchestration/reply-context';
const item=(id:string,caption='')=>({content:caption||'(photo)',meta:{chat_id:'chat',user_id:'user',message_thread_id:'thread',message_id:id,media_group_id:'album',media_caption:caption,attachment_file_id:'file-'+id}});
test('one caption and three Telegram updates become one input with all files in native order',()=>{
 let result=mergeMediaGroup(undefined,item('3'));
 result=mergeMediaGroup(result,item('1','Review all three images'));
 result=mergeMediaGroup(result,item('2'));
 result=mergeMediaGroup(result,item('2'));
 expect(result.content).toBe('Review all three images');
 expect(JSON.parse(result.meta.attachments_json)).toEqual([{ref:'file-1'},{ref:'file-2'},{ref:'file-3'}]);
 expect(result.meta.message_id).toBe('1');
 expect(mediaGroupKey({...item('4'),meta:{...item('4').meta,user_id:'other'}})).not.toBe(mediaGroupKey(item('1')));
});
test('spool persists an album across restart, resets the quiet window, and forwards it exactly once',async()=>{
 const root=mkdtempSync(join(tmpdir(),'album-spool-'));const request=jest.fn(async(_url:any,_init?:RequestInit)=>new Response('ok'));
 let spool=new ReceiverSpool(root,'http://callback',request,2000);
 try{
  spool.enqueue(item('1','Explain these images'));spool.enqueue(item('2'));spool.enqueue(item('3'));
  await spool.flush();expect(request).not.toHaveBeenCalled();expect(readdirSync(root)).toHaveLength(1);
  spool.close();spool=new ReceiverSpool(root,'http://callback',request,2000);
  await spool.flush();expect(request).not.toHaveBeenCalled();
  for(const file of readdirSync(root))utimesSync(join(root,file),new Date(0),new Date(0));
  await spool.flush();expect(request).toHaveBeenCalledTimes(1);
  const body=JSON.parse(request.mock.calls[0][1]!.body as string);expect(body.content).toBe('Explain these images');expect(JSON.parse(body.meta.attachments_json)).toHaveLength(3);
  expect(readdirSync(root)).toEqual([]);
 }finally{spool.close();rmSync(root,{recursive:true,force:true});}
});
test('replying to the second picture resolves the complete album within the same authorized chat',()=>{
 const store=new OrchestrationStore(':memory:','a');const scope={agentId:'a',agentSessionId:'s',source:'telegram' as const,accountId:'bot',chatId:'c',threadKey:'',principalId:'u'};
 try{
  store.acceptInput({scope,text:'Album instruction',attachmentIds:['media/one.jpg','media/two.jpg','media/three.jpg'],metadata:{platformMessageId:'1',platformMessageIds:['1','2','3'],mediaGroupId:'album'}});
  expect(resolveStoredReply(store,scope,{repliedMessageId:'2'})).toMatchObject({repliedText:'Album instruction',repliedAttachmentIds:['media/one.jpg','media/two.jpg','media/three.jpg']});
 }finally{store.close();}
});

test('ordinary text bypasses album waiting and a rejected callback retains the complete album for retry',async()=>{
 const root=mkdtempSync(join(tmpdir(),'album-retry-'));let ok=false;
 const request=jest.fn(async(_url:any,_init?:RequestInit)=>new Response('',{status:ok?200:503}));
 const spool=new ReceiverSpool(root,'http://callback',request,2000);
 try{
  spool.enqueue({content:'hello',meta:{chat_id:'chat',message_id:'ordinary'}});
  await new Promise(resolve=>setImmediate(resolve));expect(request).toHaveBeenCalledTimes(1);
  ok=true;await spool.flush();request.mockClear();
  spool.enqueue(item('1','One request'));spool.enqueue(item('2'));
  for(const file of readdirSync(root))utimesSync(join(root,file),new Date(0),new Date(0));
  ok=false;await spool.flush();expect(readdirSync(root)).toHaveLength(1);
  ok=true;await spool.flush();expect(readdirSync(root)).toHaveLength(0);
  expect(request.mock.calls[0][1]!.body).toBe(request.mock.calls[1][1]!.body);
 }finally{spool.close();rmSync(root,{recursive:true,force:true});}
});
