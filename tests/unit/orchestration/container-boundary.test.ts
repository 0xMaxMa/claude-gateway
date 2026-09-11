import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request } from 'http';
import { TaskBridge, containerTaskTools } from '../../../src/orchestration/bridge';
import { TaskFiles } from '../../../src/orchestration/task-files';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { runtimeProfileArgs } from '../../../src/session/runtime-profile';
import { AgentConfig } from '../../../src/types';

test('container profiles do not inherit executable settings or host MCP inventory', () => {
  const args = runtimeProfileArgs({ role: 'worker', containerExecution: true, mcpConfigPath:'/tmp/mcp.json', overlay:'' }, []);
  expect(args).toContain('--strict-mcp-config');
  expect(args[args.indexOf('--setting-sources')+1]).toBe('');
  expect(args[args.indexOf('--tools')+1]).not.toBe('default');
  expect(containerTaskTools('worker').map(t=>t.name)).toEqual(['task_report_progress','task_request_input','task_stage_file']);
  expect(containerTaskTools('agent').map(t=>t.name)).toEqual(['task_spawn','task_status','task_cancel','task_update','task_answer']);
});

test('container bridge rejects host tools and revoked tickets; artifacts require imported spool bytes', async () => {
  const root=mkdtempSync(join(tmpdir(),'cb-')), workspace=join(root,'a','workspace'), spool=join(root,'spool'); mkdirSync(workspace,{recursive:true});
  const store=new OrchestrationStore(join(root,'db'),'a'), tasks=new TaskService(store), files=new TaskFiles(store,root,spool);
  const scope={agentId:'a',agentSessionId:'session',source:'api' as const,accountId:'u',chatId:'c',threadKey:'',principalId:'u'};
  const input=store.acceptInput({scope,text:'task'}), decisions=new DecisionService(store), decision=decisions.begin(input.conversationId,'u',[input.inputId]);
  const context={...input,...decision,principalId:'u',execute:true,writeMemory:false,actionId:'spawn'};
  const task=tasks.spawn(context,{title:'test',instructions:'test',targetProfile:'media-worker'}), attempt=tasks.claim(task.taskId)!;
  const bridge=new TaskBridge(tasks,files,undefined,undefined,{agent:{id:'a',workspace} as AgentConfig,spool});
  try {
    await bridge.start(); const ticket=bridge.issue({role:'worker',attemptId:attempt.attemptId,generation:attempt.generation},join(root,'ticket'),workspace);
    const auth=JSON.parse(readFileSync(join(root,'ticket','ticket.json'),'utf8'));
    const call=(tool:string)=>new Promise<any>((resolve,reject)=>{const r=request({socketPath:auth.socket,path:'/call',method:'POST',headers:{Authorization:'Bearer '+auth.token}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve(JSON.parse(b)));});r.on('error',reject);r.end(JSON.stringify({tool,args:{},action_id:tool}));});
    for(const tool of ['Bash','task_share_call','task_memory_append','generate_image','generate_video','browser_navigate','task_spawn']) expect(await call(tool)).toEqual({error:'TOOL_DENIED'});
    const hostFile=join(workspace,'host-file');writeFileSync(hostFile,'test');expect(()=>files.allowedPath(attempt.attemptId,attempt.generation,hostFile)).toThrow();
    mkdirSync(join(spool,attempt.attemptId),{recursive:true});const imported=join(spool,attempt.attemptId,'result');writeFileSync(imported,'bytes');expect(files.allowedPath(attempt.attemptId,attempt.generation,imported)).toBe(imported);
    ticket.revoke();expect(await call('task_validate')).toEqual({error:'ACCESS_DENIED'});
    tasks.started(attempt.attemptId,attempt.generation,{pid:123,startedAt:Date.now(),instanceId:'test'});
    store.transaction(()=>store.appendEvent(input.conversationId,'tool.activity',{type:'tool_use',name:'Bash',taskId:task.taskId},task.taskId));
    const runtime=Object.assign(Object.create(AgentOrchestrationRuntime.prototype),{store,agent:{type:'app-agent',container:'app-agent'},config:{enabled:true,tasks:{workspaceMode:'container'}},active:new Map(),seenSessions:new Set(),scheduler:{startedSessions:new Set()}}) as AgentOrchestrationRuntime;
    expect(runtime.dashboardSummary().tasks[0]).toMatchObject({taskId:task.taskId,sessionId:'session',workerSessionId:attempt.sessionId,hostProcessId:123,lastTool:{name:'Bash'}});
    tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'done',artifactIds:[]}});
    expect(runtime.dashboardSummary().tasks[0]).toMatchObject({state:'completed',workerSessionId:attempt.sessionId,hostProcessId:undefined});
  } finally {await bridge.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('app configuration automatically selects container and rejects host/project overrides on reload', () => {
  const configure = jest.fn();
  const runtime = Object.assign(Object.create(AgentOrchestrationRuntime.prototype), {
    agent: {id:'app',type:'app-agent'}, tasks:{configure}, drain:jest.fn(),
  }) as AgentOrchestrationRuntime;
  runtime.configure(undefined);
  expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({tasks:{workspaceMode:'container'}}));
  for (const workspaceMode of ['host','isolated-worktree','shared-lock'] as const) {
    expect(()=>runtime.configure({tasks:{workspaceMode}})).toThrow('CONTAINER_WORKSPACE_REQUIRED');
  }
  expect(()=>runtime.configure({tasks:{projectRoot:'/host/project'}})).toThrow('CONTAINER_WORKSPACE_REQUIRED');
  const host = Object.assign(Object.create(AgentOrchestrationRuntime.prototype), {
    agent:{id:'host'},tasks:{configure},drain:jest.fn(),
  }) as AgentOrchestrationRuntime;
  expect(()=>host.configure({tasks:{workspaceMode:'container'}})).toThrow('CONTAINER_REQUIRED');
});
