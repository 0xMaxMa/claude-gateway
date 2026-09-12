import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {SessionProcess} from '../../../src/session/process';
import {OrchestrationStore} from '../../../src/orchestration/store';
import {DecisionService} from '../../../src/orchestration/decisions';
import {TaskService} from '../../../src/orchestration/tasks/service';
import {TaskBridge} from '../../../src/orchestration/bridge';
import {TaskWorkspaces} from '../../../src/orchestration/tasks/workspace';
import {ClaudeWorkerDriver} from '../../../src/orchestration/tasks/driver';
import {AgentConfig,GatewayConfig} from '../../../src/types';

test.each([true,false])('worker timeout waits for shutdown confirmation (%s) before selecting failure or reconciliation',async confirmed=>{
 const root=mkdtempSync(join(tmpdir(),'worker-timeout-'));const workspace=join(root,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'CLAUDE.md'),'Fixture');
 const store=new OrchestrationStore(':memory:','a');const tasks=new TaskService(store);const bridge=new TaskBridge(tasks);
 const agent={id:'a',workspace,description:'fixture',env:'',claude:{model:'fixture',extraFlags:[]},orchestration:{tasks:{idleTimeoutMs:30,maxDurationMs:80},conversation:{startupTimeoutMs:1000,firstResponseTimeoutMs:1000}}} as AgentConfig;
 const gateway={gateway:{headless:true,timezone:'UTC',logDir:join(root,'logs')},agents:[agent]} as GatewayConfig;
 jest.spyOn(SessionProcess.prototype,'start').mockImplementation(async()=>{});
 jest.spyOn(SessionProcess.prototype,'sendMessage').mockImplementation(function(this:SessionProcess){this.emit('output',JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Working'}]}}));});
 jest.spyOn(SessionProcess.prototype,'stop').mockImplementation(async function(this:SessionProcess){await new Promise(resolve=>setTimeout(resolve,10));this.managedGroupStopped=confirmed;});
 try{
  await bridge.start();
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',principalId:'u',chatId:'s',threadKey:''},text:'Work'});
  const decision=new DecisionService(store).begin(input.conversationId,'u',[input.inputId]);
  const task=tasks.spawn({...input,...decision,principalId:'u',actionId:'spawn',execute:true,writeMemory:false},{title:'Work',instructions:'Work',targetProfile:'media-worker'});
  const attempt=tasks.claim(task.taskId)!;
  const driver=new ClaudeWorkerDriver(agent,gateway,tasks,bridge,new TaskWorkspaces(store,workspace,join(root,'resources')),join(root,'private'));
  const handle=await driver.start(store.task(task.taskId)!,attempt,true);await handle.accepted;
  const outcome=await handle.result;
  expect(outcome).toMatchObject({type:confirmed?'failed':'unknown',failure:{code:'TIMEOUT',message:expect.stringContaining('phase=total')}});
  tasks.finish(attempt.attemptId,attempt.generation,outcome);
  expect(store.task(task.taskId)!.state).toBe(confirmed?'failed':'needs_reconciliation');
 }finally{jest.restoreAllMocks();await bridge.close();store.close();rmSync(root,{recursive:true,force:true});}
});
