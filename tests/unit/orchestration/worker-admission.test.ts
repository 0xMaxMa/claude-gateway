import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { TaskBridge } from '../../../src/orchestration/bridge';

 test('MCP rejects a non-Git profile before queuing; same turn can correct it and retain its workstream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-admission-'));
  const store = new OrchestrationStore(':memory:', 'a');
  const tasks = new TaskService(store, {tasks:{workspaceMode:'isolated-worktree'}}, root);
  const bridge = new TaskBridge(tasks);
  try {
    const input = store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',principalId:'u',chatId:'c',threadKey:''},text:'Check the already authorized merge'});
    const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
    const context = {...input,...decision,principalId:'u',execute:true,writeMemory:false};
    const prior = tasks.spawn({...context,actionId:'prior'}, {title:'Prior work',instructions:'Check status',targetProfile:'media-worker'});
    const attempt = tasks.claim(prior.taskId)!;
    tasks.finish(attempt.attemptId,attempt.generation,{type:'failed',failure:{code:'GATEWAY_SHUTDOWN',message:'Interrupted',observedAt:Date.now()}});
    await bridge.start();
    bridge.issue({role:'agent',context}, join(root,'ticket'), root);
    const ticket = JSON.parse(readFileSync(join(root,'ticket/ticket.json'),'utf8'));
    const call = async (profile: string) => {
      const response = await fetch(ticket.url, {method:'POST',headers:{Authorization:`Bearer ${ticket.token}`,'Content-Type':'application/json'},body:JSON.stringify({tool:'task_spawn',action_id:profile,args:{title:'Check PR',instructions:'Check current state before any merge',target_profile:profile,continue_task_id:prior.taskId}})});
      return {status:response.status,body:await response.json() as any};
    };
    const rejected = await call('default-worker');
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({error:'WORKER_GIT_PROJECT_REQUIRED',retryable:true});
    expect(rejected.body.message).toContain('media-worker');
    expect(store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(1);
    const accepted = await call('media-worker');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({state:'queued',continueTaskId:prior.taskId,workstreamId:prior.workstreamId,resourceProfile:{mode:'isolated-worktree',projectRoot:root}});
    const again = await call('media-worker');
    expect(again.body.taskId).toBe(accepted.body.taskId);
    execFileSync('git',['init',root],{stdio:'ignore'});
    execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','fixture'],{stdio:'ignore'});
    expect((await call('default-worker')).status).toBe(200);
    for (const mode of ['host','container'] as const) {
      tasks.configure({tasks:{workspaceMode:mode,projectRoot:join(root,'not-a-host-path')}});
      await expect(tasks.validateSpawnProfile({...context,actionId:mode},'default-worker')).resolves.toBeUndefined();
    }
  } finally { await bridge.close(); store.close(); rmSync(root,{recursive:true,force:true}); }
});

test('default worker accepts non-Git work through MCP without project config, preserving continuation and replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'general-worker-'));
  const store = new OrchestrationStore(':memory:', 'a');
  const tasks = new TaskService(store, undefined, root), bridge = new TaskBridge(tasks);
  try {
    const input = store.acceptInput({scope:{agentId:'a',agentSessionId:'s',source:'api',accountId:'u',principalId:'u',chatId:'c',threadKey:''},text:'Prepare a shopping list'});
    const decision = new DecisionService(store).begin(input.conversationId, 'u', [input.inputId]);
    await bridge.start();
    bridge.issue({role:'agent',context:{...input,...decision,principalId:'u',execute:true,writeMemory:false}},join(root,'ticket'),root);
    const ticket = JSON.parse(readFileSync(join(root,'ticket/ticket.json'),'utf8'));
    const call = async (action: string, prior?: string) => {
      const response = await fetch(ticket.url,{method:'POST',headers:{Authorization:`Bearer ${ticket.token}`,'Content-Type':'application/json'},body:JSON.stringify({tool:'task_spawn',action_id:action,args:{title:'Shopping list',instructions:'Write the requested list',target_profile:'default-worker',...(prior?{continue_task_id:prior}:{})}})});
      expect(response.status).toBe(200);
      return await response.json() as any;
    };
    const first = await call('first');
    expect(first).toMatchObject({state:'queued',resourceProfile:{mode:'host',projectRoot:root}});
    const attempt = tasks.claim(first.taskId)!;
    tasks.started(attempt.attemptId,attempt.generation);
    tasks.finish(attempt.attemptId,attempt.generation,{type:'completed',result:{summary:'List ready',artifactIds:[]}});
    const second = await call('followup',first.taskId);
    expect(second).toMatchObject({state:'queued',continueTaskId:first.taskId,workstreamId:first.workstreamId});
    expect((await call('followup',first.taskId)).taskId).toBe(second.taskId);
    expect(tasks.claim(second.taskId)!.workerId).toBe(attempt.workerId);
  } finally { await bridge.close(); store.close(); rmSync(root,{recursive:true,force:true}); }
});
