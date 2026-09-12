import * as lineAudio from '../../../src/voice/line-audio';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {sendChannelSpeech} from '../../../src/orchestration/channel-speech';
import {mp3DurationMs} from '../../../src/voice/mp3';
import {AgentConfig} from '../../../src/types';
import {ShareStore,mimeDetectorFor} from '../../../src/share/share-store';

const frame=Buffer.alloc(417);frame.set([255,251,144,0]);const audio=Buffer.concat(Array.from({length:40},()=>frame));
test('MP3 duration counts frames and explicit audio shares reject active content',()=>{
 expect(mp3DurationMs(audio)).toBe(1045);expect(()=>mp3DurationMs(Buffer.from('not audio'))).toThrow();
 expect(mimeDetectorFor('audio')(audio.subarray(0,12))).toBe('audio/mpeg');expect(mimeDetectorFor('any')(audio.subarray(0,12))).toBeNull();expect(mimeDetectorFor('audio')(Buffer.from('<html>active'))).toBeNull();
});
test.each(['discord','line','slack'])('%s sends pinned-voice MP3 to original conversation and never synthesizes when off',async channel=>{
 const convert=jest.spyOn(lineAudio,'convertLineAudio').mockImplementation(async(_input,output)=>{writeFileSync(output,Buffer.from('00000020667479704d344120000000006d6f6f7600000000','hex'));return 1045;});
 const root=mkdtempSync(join(tmpdir(),'channel-tts-')),workspace=join(root,'a','workspace');mkdirSync(workspace,{recursive:true});writeFileSync(join(root,'a','.public-base'),'https://fixture.invalid/gateway');
 const prior=process.env.SHARE_DB_PATH;process.env.SHARE_DB_PATH=join(root,'shares.db');
 const synth=jest.fn(async()=>({bytes:audio,mime:'audio/mpeg',name:'reply.mp3'}));const provider=jest.fn(()=>({synthesizeFile:synth}));
 const request=jest.fn(async(url:string,_init:RequestInit)=>new Response(JSON.stringify(url.endsWith('getUploadURLExternal')?{ok:true,file_id:'F1',upload_url:'https://files.slack.com/upload/test'}:{ok:true,id:'receipt',files:[{id:'F1'}],sentMessages:[{id:'L1'}]})));
 const agent={id:'a',workspace,discord:{botToken:'d'},line:{channelAccessToken:'l'},slack:{botToken:'s'}} as AgentConfig;
 const binding={channel,chat_id:'original',thread_key:'topic',conversation_id:'c'},speech={text:'調べました。',provider:'elevenlabs',model:'m',voiceId:'female-choice'};
 try{
  expect(await sendChannelSpeech(agent,binding,speech,'00000000-0000-4000-8000-000000000001',request as typeof fetch,provider as any,()=>false)).toMatchObject({code:'VOICE_REPLY_DISABLED'});expect(synth).not.toHaveBeenCalled();
  expect(await sendChannelSpeech(agent,binding,speech,'00000000-0000-4000-8000-000000000001',request as typeof fetch,provider as any)).toMatchObject({state:'delivered'});
  expect(synth).toHaveBeenCalledWith(expect.objectContaining({text:'調べました。',voiceId:'female-choice'}));
  const [url,init]=request.mock.calls.at(-1)!;
  if(channel==='discord'){expect(url).toContain('/original/messages');expect(init.body).toBeInstanceOf(FormData);}
  if(channel==='slack')expect(JSON.parse(String(init.body))).toMatchObject({channel_id:'original',thread_ts:'topic'});
  if(channel==='line'){
   expect(convert).toHaveBeenCalledTimes(1);
   const body=JSON.parse(String(init.body));expect(body.messages[0].originalContentUrl).toMatch(/\/audio\.m4a$/);expect(body.to).toBe('original');expect(body.messages[0]).toMatchObject({type:'audio',duration:1045});
   const shares=new ShareStore(process.env.SHARE_DB_PATH!);try{expect(shares.lookupByToken(body.messages[0].originalContentUrl.split('/shared/')[1].split('/')[0])?.allowKind).toBe('audio');}finally{shares.close();}
  }
 }finally{convert.mockRestore();if(prior===undefined)delete process.env.SHARE_DB_PATH;else process.env.SHARE_DB_PATH=prior;rmSync(root,{recursive:true,force:true});}
});
