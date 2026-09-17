import { ReceiverSpool } from '../../../mcp/tools/receiver-spool';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import { AgentRunner } from '../../../src/agent/runner';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import { SessionProcess } from '../../../src/session/process';

async function fixture() {
 const root=mkdtempSync(join(tmpdir(),'ingress-recovery-')),dir=join(root,'a'),workspace=join(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(join(workspace,'CLAUDE.md'),'Identity');
 const agent={id:'a',description:'fixture',env:'',workspace,claude:{model:'fixture',extraFlags:[]},telegram:{botToken:'synthetic-secret'},orchestration:{enabled:true,channels:['telegram']}} as AgentConfig;
 const gateway={gateway:{orchestration:true,headless:true},agents:[agent]} as GatewayConfig;
 const sessions=new SessionStore(root),history=HistoryDB.forAgent(root,'a');
 const originalFetch=global.fetch;
 let status=400;
 const provider=jest.fn(async (url:any)=>{
  if(String(url).endsWith('/getFile'))return status===200
   ? new Response(JSON.stringify({ok:true,result:{file_path:'documents/file.txt'}}))
   : new Response(JSON.stringify({ok:false,description:'Bad Request: file is too big'}),{status,headers:{'Retry-After':'7'}});
  if(String(url).includes('/file/'))return new Response('Synthetic contents');
  return new Response(JSON.stringify({ok:true,result:{message_id:99}}));
 });
 global.fetch=provider as typeof fetch;
 const inference=jest.fn(async()=>{
  const p=new EventEmitter() as SessionProcess;p.start=async()=>{};p.stop=async()=>{};
  p.sendMessage=()=>{process.nextTick(()=>p.emit('output',JSON.stringify({type:'result',result:'Received.'})));};return p;
 });
 let runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{createAgentSession:inference,releaseAgentSession:async()=>{}});
 const command=jest.fn(async()=>{}),logger={warn:jest.fn(),error:jest.fn(),info:jest.fn(),debug:jest.fn()};
 const runner:any=Object.assign(Object.create(AgentRunner.prototype),{agentConfig:agent,agentsBaseDir:root,sessionStore:sessions,orchestration:runtime,
  getOrchestration:async()=>runtime,channelSourceMap:new Map(),logger,handleSessionCommand:command,writeTypingDone:jest.fn()});
 await runner.startCallbackServer();
 const post=(content:string,id:string,meta:Record<string,string>={})=>originalFetch(`http://127.0.0.1:${runner.callbackPort}/channel`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,meta:{source:'telegram',chat_id:'chat',user_id:'human',message_id:id,...meta}})});
 return {root,dir,agent,gateway,sessions,history,get runtime(){return runtime;},provider,inference,command,logger,post,setStatus:(s:number)=>{status=s;},
  restart:async()=>{await runtime.close();runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{createAgentSession:inference,releaseAgentSession:async()=>{}});runner.orchestration=runtime;},
  close:async()=>{await new Promise<void>((resolve,reject)=>(runner.callbackServer as Server).close(err=>err?reject(err):resolve()));await runtime.close();global.fetch=originalFetch;(history as any).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}};
}

test('permanent provider rejection is durably admitted once and text plus /new can follow',async()=>{
 const f=await fixture();try{
  expect((await f.post('Please check this video','video',{attachment_file_id:'big-file'})).status).toBe(200);
  expect((await f.post('Please check this video','video',{attachment_file_id:'big-file'})).status).toBe(200);
  expect(f.provider.mock.calls.filter(([url])=>String(url).endsWith('/getFile'))).toHaveLength(1);
  expect((await f.post('Another request','text')).status).toBe(200);
  expect((await f.post('/new','command')).status).toBe(200);
  expect(f.command).toHaveBeenCalledTimes(1);
  const rows=f.runtime.store.all('SELECT * FROM conversation_inputs ORDER BY input_seq');expect(rows).toHaveLength(2);
  expect(rows[0].text).toBe('Please check this video');
  expect(JSON.parse(String(rows[0].ingress_json)).metadata.unavailableAttachments).toEqual([{code:'ATTACHMENT_UNAVAILABLE',quoted:false}]);
  expect(f.runtime.store.all("SELECT * FROM conversation_decisions WHERE kind='notice'")).toHaveLength(1);
 }finally{await f.close();}
});

test('transient callback rejects admission with Retry-After, then admits the same provider ID after recovery',async()=>{
 const f=await fixture();try{
  f.setStatus(429);const first=await f.post('caption','rate-limited',{attachment_file_id:'file'});
  expect(first.status).toBe(429);expect(first.headers.get('Retry-After')).toBe('7');
  expect(await first.text()).not.toContain('synthetic-secret');
  expect(f.runtime.store.all('SELECT * FROM conversation_inputs')).toHaveLength(0);
  f.setStatus(200);expect((await f.post('caption','rate-limited',{attachment_file_id:'file'})).status).toBe(200);
  expect(f.runtime.store.all('SELECT * FROM conversation_inputs')).toHaveLength(1);
  expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('synthetic-secret');
 }finally{await f.close();}
});

test('stale queued commands and messages are archived once without inference, media fetches or command execution',async()=>{
 const f=await fixture();try{
  const recovery={ingress_recovery_batch:'synthetic-recovery-batch'};
  for(const [text,id] of [['/new','old-command'],['Run the old deployment','old-text'],['caption','old-file']]) {
   const meta=id==='old-file'?{...recovery,attachment_file_id:'expired'}:recovery;
   expect((await f.post(text,id,meta)).status).toBe(200);
   expect((await f.post(text,id,meta)).status).toBe(200);
  }
  await f.runtime.flushHistory();
  await f.restart();
  expect(f.command).not.toHaveBeenCalled();expect(f.inference).not.toHaveBeenCalled();
  expect(f.provider.mock.calls.filter(([url])=>String(url).endsWith('/getFile'))).toHaveLength(0);
  const rows=f.runtime.store.all('SELECT * FROM conversation_inputs ORDER BY input_seq');expect(rows).toHaveLength(3);
  expect(rows.every(row=>row.status==='handled')).toBe(true);
  expect(JSON.parse(String(rows[2].ingress_json))).toMatchObject({capabilities:{execute:false,writeMemory:false},metadata:{recoveredChannelInput:{content:'caption',meta:{attachment_file_id:'expired'}}}});
  expect(f.runtime.store.all("SELECT * FROM outbox WHERE kind='input' AND state!='completed'")).toHaveLength(0);
  expect(f.runtime.store.all("SELECT * FROM conversation_decisions WHERE kind='notice'")).toHaveLength(1);
  expect((await f.post('Fresh request','fresh')).status).toBe(200);
  expect(f.runtime.store.all('SELECT * FROM conversation_inputs')).toHaveLength(4);
 }finally{await f.close();}
});

test('lost ACK remains deduplicated when a later restart marks the original payload as recovered',async()=>{
 const f=await fixture();try{
  expect((await f.post('caption','ack-lost',{attachment_file_id:'file'})).status).toBe(200);
  await f.restart();
  expect((await f.post('caption','ack-lost',{attachment_file_id:'file',ingress_recovery_batch:'late-restart'})).status).toBe(200);
  expect(f.runtime.store.all('SELECT * FROM conversation_inputs')).toHaveLength(1);
  expect(f.runtime.store.all("SELECT * FROM conversation_decisions WHERE kind='notice'")).toHaveLength(1);
  expect(f.provider.mock.calls.filter(([url])=>String(url).endsWith('/getFile'))).toHaveLength(1);
 }finally{await f.close();}
});


test('partial album and unavailable quoted media preserve valid files and deduplicate admission after restart',async()=>{
 const f=await fixture();try{
  f.setStatus(200);
  const meta={media_group_id:'album',message_ids_json:JSON.stringify(['10','11']),
   attachments_json:JSON.stringify([{ref:'readable',name:'notes.txt'},{ref:'oversized',name:'video.mp4',size:30*1024*1024}]),
   replied_attachment_file_id:'oversized-quote',replied_attachment_size:String(30*1024*1024),replied_attachment_name:'quoted.mp4'};
  expect((await f.post('Compare these files','10',meta)).status).toBe(200);
  await f.restart();
  expect((await f.post('Compare these files','10',meta)).status).toBe(200);
  const rows=f.runtime.store.all('SELECT * FROM conversation_inputs');expect(rows).toHaveLength(1);
  expect(JSON.parse(String(rows[0].attachment_refs_json))).toHaveLength(1);
  expect(JSON.parse(String(rows[0].ingress_json)).metadata.unavailableAttachments).toEqual([
   {code:'ATTACHMENT_TOO_LARGE',name:'video.mp4',quoted:false},
   {code:'ATTACHMENT_TOO_LARGE',name:'quoted.mp4',quoted:true}]);
  expect(f.runtime.store.all("SELECT * FROM conversation_decisions WHERE kind='notice'")).toHaveLength(1);
  expect(f.provider.mock.calls.filter(([url])=>String(url).endsWith('/getFile'))).toHaveLength(1);
 }finally{await f.close();}
});


test('late album member and lost ACK survive receiver restart without conflicting SQLite receipts',async()=>{
 const f=await fixture();let spool:ReceiverSpool|undefined;
 try{
  f.setStatus(200);
  const album=(id:string)=>({content:'file',meta:{source:'telegram',chat_id:'chat',user_id:'human',media_group_id:'late-album',message_id:id,attachment_file_id:`file-${id}`}});
  let first=true;
  let attempted!:()=>void;
  const attempt=new Promise<void>(resolve=>{attempted=resolve;});
  const request=(async (_:any,init?:RequestInit)=>{
   const input=JSON.parse(String(init?.body));
   const response=await f.post(input.content,input.meta.message_id,input.meta);
   if(first){first=false;spool!.enqueue(album('21'));attempted();return new Response('',{status:503});}
   return response;
  }) as typeof fetch;
  const journal=join(f.root,'receiver-journal');
  spool=new ReceiverSpool(journal,'http://callback',request,0);
  spool.enqueue(album('20'));await attempt;
  await new Promise(resolve=>setTimeout(resolve,10));
  spool.close();spool=new ReceiverSpool(journal,'http://callback',request,0);
  await new Promise(resolve=>setTimeout(resolve,1100));await spool.flush();
  const rows=f.runtime.store.all('SELECT * FROM conversation_inputs ORDER BY input_seq');
  expect(rows).toHaveLength(2);
  expect(rows.map(row=>JSON.parse(String(row.ingress_json)).metadata.platformMessageIds)).toEqual([['20'],['21']]);
  expect(f.provider.mock.calls.filter(([url])=>String(url).endsWith('/getFile'))).toHaveLength(2);
 }finally{spool?.close();await f.close();}
});
