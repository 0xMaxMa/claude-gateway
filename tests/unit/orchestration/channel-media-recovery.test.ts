import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { channelInputMedia } from '../../../src/orchestration/channel-input-media';
import { receiveChannelMedia } from '../../../src/orchestration/channel-media';
import { classifyChannelMediaError } from '../../../src/orchestration/channel-media-error';
import { mergeMediaGroup } from '../../../mcp/tools/telegram/media-group';
import type { AgentConfig } from '../../../src/types';
const agent={id:'a',telegram:{botToken:'secret-token'}} as AgentConfig;
let root:string, original:typeof fetch;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'media-recovery-'));original=global.fetch;});
afterEach(()=>{global.fetch=original;rmSync(root,{recursive:true,force:true});});
test('oversized own album member is unavailable and valid member survives',async()=>{
 const own=join(root,'valid.txt');writeFileSync(own,'valid');
 global.fetch=jest.fn(async()=>new Response('secret-token provider body',{status:400})) as typeof fetch;
 const result=await channelInputMedia(agent,root,'telegram','c',{attachments_json:JSON.stringify([{ref:'too-big',name:'large.mp4'},{path:own}])},jest.fn());
 expect(result.media).toHaveLength(1);expect((result as any).unavailable).toEqual([{code:'ATTACHMENT_UNAVAILABLE',name:'large.mp4',quoted:false}]);
});
test.each([false,true])('network failures retry own or quoted=%s files without deleting earlier local files',async quoted=>{
 const own=join(root,'valid.txt');writeFileSync(own,'valid');const discard=jest.fn();
 global.fetch=jest.fn(async()=>{throw new Error('https://secret-token/private');}) as typeof fetch;
 await expect(channelInputMedia(agent,root,'telegram','c',{media_ephemeral:'1',attachments_json:JSON.stringify([{path:own},{ref:'retry',quoted}])},discard)).rejects.toMatchObject({message:'ATTACHMENT_UNAVAILABLE',retryable:true});
 expect(discard).not.toHaveBeenCalled();
});
test('metadata size rejects before provider fetch',async()=>{
 const request=jest.fn();global.fetch=request;
 const result=await channelInputMedia(agent,root,'telegram','c',{attachment_file_id:'big',attachment_size:String(20*1024*1024+1)},jest.fn());
 expect((result as any).unavailable[0].code).toBe('ATTACHMENT_TOO_LARGE');expect(request).not.toHaveBeenCalled();
});
test.each([403,404,408,429,500])('Discord status %i produces safe retry classification',async status=>{
 const request=jest.fn(async()=>new Response('sensitive body',{status,headers:{'Retry-After':'3'}}));
 await expect(receiveChannelMedia(agent,root,'discord','c','https://cdn.discordapp.com/file',request as typeof fetch)).rejects.toMatchObject({message:'ATTACHMENT_UNAVAILABLE',retryable:status>=500||status===408||status===429,status,...(status===429?{retryAfterMs:3000}:{})});
});
test('actual stream limit cannot be bypassed by absent length metadata',async()=>{
 const request=jest.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(50*1024*1024+1));c.close();}})));
 await expect(receiveChannelMedia(agent,root,'discord','c','https://cdn.discordapp.com/file',request as typeof fetch)).rejects.toMatchObject({message:'ATTACHMENT_TOO_LARGE',retryable:false});
});
test('missing local own file is explicit unavailability',async()=>{
 const result=await channelInputMedia(agent,root,'slack','c',{image_path:join(root,'missing')},jest.fn());
 expect((result as any).unavailable).toEqual([{code:'ATTACHMENT_UNAVAILABLE',quoted:false}]);
});
test('Telegram retry_after in error envelope is preserved without exposing description',async()=>{
 const request=jest.fn(async()=>new Response(JSON.stringify({ok:false,error_code:429,description:'private secret-token',parameters:{retry_after:7}}),{status:429}));
 await expect(receiveChannelMedia(agent,root,'telegram','c','file',request as typeof fetch)).rejects.toMatchObject({message:'ATTACHMENT_UNAVAILABLE',retryable:true,status:429,retryAfterMs:7000});
});
test('quoted permanent provider error retains current valid file and explicit unavailable result',async()=>{
 const own=join(root,'valid.txt');writeFileSync(own,'valid');
 global.fetch=jest.fn(async()=>new Response('expired signed URL',{status:403})) as typeof fetch;
 const result=await channelInputMedia(agent,root,'discord','c',{attachments_json:JSON.stringify([{path:own},{ref:'https://cdn.discordapp.com/expired',quoted:true,name:'x'.repeat(250)}])},jest.fn());
 expect(result.media).toHaveLength(1);expect(result.quoted).toEqual([]);
 expect(result.unavailable).toEqual([{code:'ATTACHMENT_UNAVAILABLE',quoted:true,name:'x'.repeat(200)}]);
});
test('Discord metadata size rejects before provider fetch',async()=>{
 const request=jest.fn();global.fetch=request;
 const result=await channelInputMedia(agent,root,'discord','c',{attachments_json:JSON.stringify([{ref:'https://cdn.discordapp.com/file',size:50*1024*1024+1}])},jest.fn());
 expect(result.unavailable[0].code).toBe('ATTACHMENT_TOO_LARGE');expect(request).not.toHaveBeenCalled();
});
test('Telegram metadata cannot bypass the actual stream limit',async()=>{
 const request=jest.fn(async(url:any)=>String(url).endsWith('/getFile')?new Response(JSON.stringify({ok:true,result:{file_path:'documents/file',file_size:1}})):new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(20*1024*1024+1));c.close();}})));
 await expect(receiveChannelMedia(agent,root,'telegram','c','file',request as typeof fetch,1)).rejects.toMatchObject({message:'ATTACHMENT_TOO_LARGE',retryable:false});
});

test('album aggregation retains independent sizes for early admission checks',()=>{
 const item=(id:string,size:string)=>({content:'caption',meta:{message_id:id,media_group_id:'album',media_caption:'caption',attachment_file_id:'file-'+id,attachment_size:size}});
 const result=mergeMediaGroup(mergeMediaGroup(undefined,item('1','12')),item('2','20971521'));
 expect(JSON.parse(result.meta.attachments_json)).toEqual([{ref:'file-1',size:12},{ref:'file-2',size:20971521}]);
 expect(result.content).toBe('caption\n\ncaption');
});
test.each(['EACCES','EIO','ENOSPC'])('local %s errors remain retryable and safe',code=>{
 const error=Object.assign(new Error('/secret/private/path'),{code});
 expect(classifyChannelMediaError(error)).toMatchObject({message:'ATTACHMENT_UNAVAILABLE',retryable:true});
});


test.each([-1,1.5,null,'unknown'])('invalid optional size %s cannot poison an otherwise readable album',async size=>{
 const own=join(root,'valid.txt');writeFileSync(own,'valid');const request=jest.fn();global.fetch=request;
 const result=await channelInputMedia(agent,root,'discord','c',{attachments_json:JSON.stringify([{path:own},{ref:'https://cdn.discordapp.com/file',size}])},jest.fn());
 expect(result.media).toHaveLength(1);
 expect(result.unavailable).toEqual([{code:'INVALID_ATTACHMENT',quoted:false}]);
 expect(request).not.toHaveBeenCalled();
});
