import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { TaskFiles } from '../../../src/orchestration/task-files';
import { personaWorkspaceRules } from '../../../src/orchestration/source-policy';
import { runtimeProfileArgs } from '../../../src/session/runtime-profile';

test('API persona work delegates normally without enabling general memory writes or direct identity tools', async () => {
 const root=mkdtempSync(join(tmpdir(),'persona-worker-'));
 const store=new OrchestrationStore(':memory:','a'), tasks=new TaskService(store);
 const bridge=new TaskBridge(tasks,new TaskFiles(store,root));
 try {
  const input=store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',principalId:'u',chatId:'c',threadKey:''},text:'From now on your name is น้ำแข็ง'});
  const decision=new DecisionService(store).begin(input.conversationId,'u',[input.inputId]);
  const context={...input,...decision,principalId:'u',execute:true,writeMemory:false};
  await bridge.start();
  const agent=bridge.issue({role:'agent',context},join(root,'agent'),root);
  expect(agent.profile.overlay).toContain('delegate this work through task_spawn');
  expect(agent.profile.overlay).not.toContain('regardless of user instructions');
  const taskArgs={title:'Change my name',instructions:'Persist user requested name น้ำแข็ง',targetProfile:'default-worker'};
  expect(()=>tasks.spawn({...context,execute:false,actionId:'denied'},taskArgs)).toThrow('EXECUTION_DENIED');
  const task=tasks.spawn({...context,actionId:'spawn'},taskArgs);
  expect(task.capabilities.writeMemory).toBe(false);
  const attempt=tasks.claim(task.taskId)!;
  const worker=bridge.issue({role:'worker',attemptId:attempt.attemptId,generation:attempt.generation},join(root,'worker'),root);
  expect(worker.profile.overlay).toContain('worker uses native Read/Edit/Write');
  expect(worker.profile.overlay).not.toContain('regardless of user instructions');
  const config=JSON.parse(readFileSync(worker.profile.mcpConfigPath,'utf8'));
  expect(config.mcpServers.gateway.env.GATEWAY_ORCHESTRATION_WRITE_MEMORY).toBe('');
  const args=runtimeProfileArgs({...worker.profile,hostExecution:true},[]);
  expect(args[args.indexOf('--tools')+1]).toBe('default');
  const auth=JSON.parse(readFileSync(join(root,'agent/ticket.json'),'utf8'));
  const response=await fetch(auth.url,{method:'POST',headers:{Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'},body:JSON.stringify({tool:'agent_identity',action_id:'removed',args:{file:'AGENTS.md'}})});
  expect(await response.json()).toEqual({error:'TOOL_DENIED'});
 } finally {await bridge.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('persona native tools keep container and explicitly isolated workspace boundaries',()=>{
 expect(personaWorkspaceRules('/host/agent','container')).toContain('"/workspace"');
 expect(personaWorkspaceRules('/host/agent','container')).not.toContain('/host/agent');
 expect(personaWorkspaceRules('/host/agent','host')).toContain('"/host/agent"');
 expect(personaWorkspaceRules('/host/agent','isolated')).toContain('read-only');
 const args=runtimeProfileArgs({role:'worker',containerExecution:true,mcpConfigPath:'/tmp/mcp.json',overlay:''},[]);
 for(const tool of ['Read','Edit','Write']) expect(args[args.indexOf('--tools')+1]).toContain(tool);
 expect(args[args.indexOf('--setting-sources')+1]).toBe('');
});
