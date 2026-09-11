import express from 'express';
import request from 'supertest';
import {EventEmitter} from 'events';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {AgentRunner} from '../../../src/agent/runner';
import {createApiRouter} from '../../../src/api/router';
import {AgentOrchestrationRuntime} from '../../../src/orchestration/runtime';
import {SessionStore} from '../../../src/session/store';
import {SessionProcess} from '../../../src/session/process';
import {HistoryDB} from '../../../src/history/db';
import {AgentConfig,GatewayConfig} from '../../../src/types';
const until=async(fn:()=>boolean)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('timeout');};
test('web Stop returns numbered tasks; numeric selection stops one real scheduled handle without another user inference',async()=>{
 const root=mkdtempSync(join(tmpdir(),'stop-http-')),dir=join(root,'agents','a');
 const agent={id:'a',description:'',workspace:join(dir,'workspace'),env:'',claude:{model:'fixture',extraFlags:[]},orchestration:{enabled:true}} as AgentConfig;
 const gateway={gateway:{ orchestration: true,headless:true,logDir:join(root,'logs'),timezone:'UTC'},agents:[agent]} as GatewayConfig;
 const runner=new AgentRunner(agent,gateway),sessions=new SessionStore(join(root,'agents')),history=HistoryDB.forDir(dir,'a');
 let runtime:AgentOrchestrationRuntime,userTurns=0;const stopped:string[]=[],finish=new Map<string,(r:any)=>void>();
 runtime=await AgentOrchestrationRuntime.open(agent,gateway,dir,sessions,history,{
  createAgentSession:async()=>{const p=new EventEmitter() as SessionProcess;p.start=async()=>{};p.stop=async()=>{};p.sendMessage=prompt=>{
   if(!prompt.startsWith('Report the persisted')){userTurns++;const d=runtime.store.get("SELECT d.*,c.owner_principal_id FROM conversation_decisions d JOIN conversations c ON c.id=d.conversation_id WHERE d.state='running'")!;
    for(let i=1;i<=2;i++)runtime.tasks.spawn({conversationId:String(d.conversation_id),principalId:String(d.owner_principal_id),inputId:JSON.parse(String(d.input_ids_json))[0],decisionId:String(d.id),epoch:Number(d.epoch),actionId:'spawn'+i,execute:true,writeMemory:false},{title:'Task '+i,instructions:'Fixture',targetProfile:'default-worker'});
   }
   p.emit('output',JSON.stringify({type:'result',result:'Task status received.'}));};return p;},releaseAgentSession:async()=>{},
 },{start:async task=>({accepted:Promise.resolve(),result:new Promise(r=>finish.set(task.taskId,r)),stop:async()=>{stopped.push(task.taskId);finish.get(task.taskId)!({type:'stopped'});}})});
 (runner as any).orchestration=runtime;
 const app=express();app.use(express.json());app.use('/api',createApiRouter(new Map([['a',runner]]),new Map([['a',agent]]),[{id:'owner',key:'fixture',agents:['a'],allow_tools:true}]));
 try{
  const first=await request(app).post('/api/v1/agents/a/messages').set('Authorization','Bearer fixture').send({chat_id:'chat',message:'Do two tasks'});expect(first.status).toBe(200);
  const sid=first.body.session_id;await until(()=>finish.size===2);
  const menu=await request(app).post(`/api/v1/agents/a/sessions/${sid}/stop`).set('Authorization','Bearer fixture').send({chat_id:'chat'});
  expect(menu.status).toBe(200);expect(menu.body.responseText).toContain('Which task');expect(menu.body.tasks).toHaveLength(2);
  const selected=menu.body.tasks[0].taskId,other=menu.body.tasks[1].taskId;
  const choice=await request(app).post('/api/v1/agents/a/messages').set('Authorization','Bearer fixture').send({chat_id:'chat',session_id:sid,message:'1',stream:true});
  expect(choice.status).toBe(200);expect(choice.text).toContain('Stopping task:');await until(()=>runtime.store.task(selected)!.state==='cancelled');
  expect(stopped).toEqual([selected]);expect(runtime.store.task(other)!.state).toBe('running');expect(userTurns).toBe(1);
 }finally{await runtime.close();(history as any).db.close();HistoryDB.evict(join(root,'agents'),'a');rmSync(root,{recursive:true,force:true});}
});
