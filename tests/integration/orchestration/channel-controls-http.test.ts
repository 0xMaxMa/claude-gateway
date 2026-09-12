import express from 'express';
import request from 'supertest';
import {createHmac} from 'crypto';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {AgentRunner} from '../../../src/agent/runner';
import {AgentConfig,GatewayConfig} from '../../../src/types';
import {createWebhooksRouter} from '../../../src/api/webhooks-router';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {TaskControls} from '../../../src/orchestration/task-controls';
import {StopControls} from '../../../src/orchestration/stop-controls';
import {ChannelControls} from '../../../src/orchestration/channel-controls';
import {TelegramVoices} from '../../../src/orchestration/telegram-voices';
import {HistoryDB} from '../../../src/history/db';
const until=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');};
test.each(['discord','line','slack'] as const)('%s signed/native controls pass through real gateway callback, persist preference and reject stale mode',async channel=>{
 const root=mkdtempSync(join(tmpdir(),'channel-controls-http-')),originalFetch=global.fetch;
 const agent={id:'a',description:'',workspace:join(root,'agents','a','workspace'),env:'',claude:{model:'fixture',extraFlags:[]},orchestration:{enabled:true,channels:[channel],voice:{notes:{enabled:true,replyWithVoice:true},tts:{voiceId:'fixture'}}},discord:{botToken:'fixture'},line:{channelAccessToken:'fixture',channelSecret:'secret',dmPolicy:'open'},slack:{botToken:'fixture',signingSecret:'secret',dmPolicy:'open'}} as AgentConfig;
 const runner=new AgentRunner(agent,{gateway:{ orchestration: true,headless:true,logDir:join(root,'logs'),timezone:'UTC'},agents:[agent]} as GatewayConfig);
 const store=new OrchestrationStore(':memory:','a'),tasks=new TaskService(store),stop=jest.fn(()=>false);
 const controls=new ChannelControls(store,new TaskControls(store,tasks),new StopControls(store,tasks,stop),new TelegramVoices(store,()=>({provider:'fixture',model:'m',voiceId:'v'}),async()=>[{id:'v',name:'Voice',gender:'female'}]),()=>true);
 (runner as any).orchestration={channelControls:controls,updateAgentConfig:jest.fn(),ownsChannel:()=>true};
 const sent:Array<{url:string;body:any}>=[];
 global.fetch=(async(url:any,init?:RequestInit)=>{
   if(String(url).startsWith('http://127.0.0.1:'))return originalFetch(url,init);
   sent.push({url:String(url),body:JSON.parse(String(init?.body??'{}'))});return new Response(JSON.stringify({ok:true}));
 }) as typeof fetch;
 await (runner as any).startCallbackServer();const app=express();app.use('/webhooks',createWebhooksRouter(new Map([['a',runner]]),join(root,'logs')));
 const chat=channel==='slack'?'D1':channel==='line'?'U1':'100',user=channel==='discord'?'200':'U1';
 const callback=async(content:string,extra={})=>originalFetch(`http://127.0.0.1:${runner.getCallbackPort()}/channel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,meta:{source:channel,chat_id:chat,user_id:user,...extra}})});
 try{
  if(channel==='slack'){
   const body=new URLSearchParams({command:'/voice',channel_id:chat,user_id:user}).toString(),ts=String(Math.floor(Date.now()/1000));
   await request(app).post('/webhooks/slack/a').set('Content-Type','application/x-www-form-urlencoded').set('x-slack-request-timestamp',ts).set('x-slack-signature','v0='+createHmac('sha256','secret').update(`v0:${ts}:${body}`).digest('hex')).send(body).expect(200);
  }else expect((await callback('/voice')).status).toBe(200);
  await until(()=>sent.length===1);
  const body=sent[0].body;
  const data=channel==='discord'?body.components[0].components[0].custom_id:channel==='slack'?body.blocks[1].elements[0].value:body.messages[0].quickReply.items[0].action.data;
  if(channel==='line'){
   const payload=JSON.stringify({events:[{type:'postback',source:{type:'user',userId:user},replyToken:'fixture',postback:{data}}]});
   await request(app).post('/webhooks/line/a').set('Content-Type','application/json').set('x-line-signature',createHmac('sha256','secret').update(payload).digest('base64')).send(payload).expect(200);
  }else if(channel==='slack'){
   const payload=new URLSearchParams({payload:JSON.stringify({type:'block_actions',user:{id:user},channel:{id:chat},message:{ts:'menu'},actions:[{value:data}]})}).toString(),ts=String(Math.floor(Date.now()/1000));
   await request(app).post('/webhooks/slack/a').set('Content-Type','application/x-www-form-urlencoded').set('x-slack-request-timestamp',ts).set('x-slack-signature','v0='+createHmac('sha256','secret').update(`v0:${ts}:${payload}`).digest('hex')).send(payload).expect(200);
   await until(()=>sent.length===2);
   await request(app).post('/webhooks/slack/a').set('Content-Type','application/x-www-form-urlencoded').set('x-slack-request-timestamp',ts).set('x-slack-signature','invalid').send(payload).expect(401);
  }else await callback('/orch '+data.slice(5),{control_message_id:'menu'});
  expect(store.channelVoice(channel,chat)).toBe(true);expect(stop).not.toHaveBeenCalled();
  await callback('/session');expect(JSON.stringify(sent.at(-1)!.body)).toContain('Mode: Orchestration');
  await callback('/sessions');expect(JSON.stringify(sent.at(-1)!.body)).toContain('Sessions');
  (runner as any).gatewayConfig.gateway.orchestration=false;runner.updateAgentConfig(agent);await callback('/voice off');expect(store.channelVoice(channel,chat)).toBe(true);
  expect(JSON.stringify(sent.at(-1)!.body)).toContain('require orchestration');
 }finally{
  await new Promise<void>(resolve=>(runner as any).callbackServer.close(()=>resolve()));store.close();(runner as any).historyDb.db.close();HistoryDB.evict(join(root,'agents'),'a');global.fetch=originalFetch;rmSync(root,{recursive:true,force:true});
 }
});
