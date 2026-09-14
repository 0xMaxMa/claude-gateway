import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { AgentOrchestrationRuntime, AgentOrchestrationHost } from '../../../src/orchestration/runtime';
import { gatewayCapacity } from '../../../src/orchestration/capacity';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';

test('runtime recovery transfers capacity ownership to cleanup without leaking slots across reopen',async()=>{
 const root=mkdtempSync(join(tmpdir(),'capacity-recovery-'));
 const store=new OrchestrationStore(join(root,'orchestration.db'),'a'),tasks=new TaskService(store),decisions=new DecisionService(store);
 const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'fixture',source:'api',accountId:'owner',chatId:'c',threadKey:'',principalId:'owner'},text:'Work'});
 const decision=decisions.begin(input.conversationId,'owner',[input.inputId]);
 const task=tasks.spawn({...input,...decision,principalId:'owner',execute:true,writeMemory:false,actionId:'spawn'}, {title:'Fixture',instructions:'Work',targetProfile:'default-worker'});
 decisions.finish(decision,'Accepted');const attempt=tasks.claim(task.taskId)!;tasks.started(attempt.attemptId,attempt.generation);store.close();
 const agent:AgentConfig={id:'a',workspace:join(root,'a','workspace'),description:'',env:'',claude:{model:'fixture',extraFlags:[]}};
 const gateway={gateway:{orchestration:true,headless:true,logDir:root,timezone:'UTC',processLimits:{maxTotal:3,reservedAgent:2}},agents:[agent]} as GatewayConfig;
 const history=HistoryDB.forAgent(root,'a'),sessions=new SessionStore(root),capacity=gatewayCapacity(gateway);
 const host:AgentOrchestrationHost={createAgentSession:async()=>{
  const process=new EventEmitter() as SessionProcess;
  process.start=async()=>{};process.stop=async()=>{};process.sendMessage=()=>{process.emit('output',JSON.stringify({type:'result',result:'Done'}));};return process;
 },releaseAgentSession:async()=>{}};
 const driver={cleanup:async()=>true,start:jest.fn(),available:()=>false};
 let runtime:AgentOrchestrationRuntime|undefined;
 try {
  runtime=await AgentOrchestrationRuntime.open(agent,gateway,root,sessions,history,host,driver);
  expect(capacity.count).toBe(1);await runtime.close();runtime=undefined;
  runtime=await AgentOrchestrationRuntime.open(agent,gateway,root,sessions,history,host,driver);
  expect(capacity.count).toBe(1);
  runtime.tasks.cancelByUser(task.conversationId,'owner',task.taskId);
  const end=Date.now()+2000;
  while(runtime.store.task(task.taskId)!.state!=='cancelled'&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));
  expect(runtime.store.task(task.taskId)!.state).toBe('cancelled');expect(capacity.count).toBe(0);
  const release=capacity.acquireWorker('a','next');expect(release).toBeDefined();release!();
 }finally{await runtime?.close();(history as unknown as {db:{close():void}}).db.close();HistoryDB.evict(root,'a');rmSync(root,{recursive:true,force:true});}
});
