import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { sendChannelSpeech } from '../../../src/orchestration/channel-speech';
import { ShareStore } from '../../../src/share/share-store';
import { createSharesPublicRouter } from '../../../src/api/share-router';
import { AgentConfig } from '../../../src/types';

let available = true;
try { execFileSync('ffmpeg',['-version'],{stdio:'ignore'}); execFileSync('ffprobe',['-version'],{stdio:'ignore'}); } catch { available = false; }
const mediaTest = available ? test : test.skip;
mediaTest('LINE converts actual TTS MP3 to fast-start AAC-LC M4A and serves its named URL with byte ranges', async () => {
  const root=mkdtempSync(join(tmpdir(),'line-aac-')),workspace=join(root,'a','workspace');mkdirSync(workspace,{recursive:true});
  const before=process.env.SHARE_DB_PATH;process.env.SHARE_DB_PATH=join(root,'shares.db');
  let store:ShareStore|undefined;
  try {
    const mp3=join(root,'input.mp3');
    execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libmp3lame',mp3]);
    const bytes=readFileSync(mp3);writeFileSync(join(root,'a','.public-base'),'https://fixture.invalid/gateway');
    const agent={id:'a',workspace,line:{channelAccessToken:'fixture'}} as AgentConfig;
    let message:any;
    const send=jest.fn(async(_url:unknown,init?:RequestInit)=>{message=JSON.parse(String(init!.body)).messages[0];return new Response(JSON.stringify({sentMessages:[{id:'receipt'}]}));});
    const provider=()=>({synthesizeFile:async()=>({bytes,mime:'audio/mpeg',name:'reply.mp3'})});
    const result=await sendChannelSpeech(agent,{channel:'line',chat_id:'Ufixture',conversation_id:'s',thread_key:''},
      {text:'Hello',provider:'fixture',model:'fixture',voiceId:'pinned'},'00000000-0000-4000-8000-000000000001',send as typeof fetch,provider as any);
    expect(result.state).toBe('delivered');expect(message.originalContentUrl).toMatch(/\/audio\.m4a$/);expect(message.duration).toBeGreaterThanOrEqual(1000);expect(message.duration).toBeLessThan(1100);
    store=new ShareStore(process.env.SHARE_DB_PATH!);
    const token=message.originalContentUrl.split('/shared/')[1].split('/')[0],share=store.lookupByToken(token)!;
    const file=join(root,'a','media',share.relativePath),audio=readFileSync(file);
    expect(audio.subarray(8,12).toString()).toBe('M4A ');expect(audio.indexOf('moov')).toBeLessThan(audio.indexOf('mdat'));
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,profile,channels,sample_rate','-of','json',file],{encoding:'utf8'}));
    expect(info.streams).toEqual([expect.objectContaining({codec_name:'aac',profile:'LC',channels:1,sample_rate:'44100'})]);
    const app=express();app.use(createSharesPublicRouter(store,root));
    const range=await request(app).get(`/shared/${token}/audio.m4a`).set('Range','bytes=0-1').expect(206);
    expect(range.headers['content-type']).toBe('audio/mp4');expect(range.body).toEqual(audio.subarray(0,2));
  } finally {store?.close();if(before===undefined)delete process.env.SHARE_DB_PATH;else process.env.SHARE_DB_PATH=before;rmSync(root,{recursive:true,force:true});}
},15000);
