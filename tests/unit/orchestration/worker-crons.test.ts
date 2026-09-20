import { workerCrons } from '../../../src/orchestration/worker-crons';
import { TaskFiles } from '../../../src/orchestration/task-files';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import { containerTaskTools } from '../../../src/orchestration/bridge';

function fixture(container = false) {
  const scope = jest.fn(() => ({ task: { agentId: 'owner', capabilities: { execute: true } } }));
  const request = jest.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ job: { agentId: 'owner', type: 'agent' } })));
  const call = workerCrons({ scope } as unknown as TaskFiles, { id: 'owner', ...(container ? {type:'app-agent'} : {}) } as AgentConfig,
    { gateway: { api: { keys: [{ key: 'host-only', agents: '*' }] } } } as GatewayConfig, request as typeof fetch);
  return { call, scope, request };
}
test('worker creates cron for captured agent with normalized timeout and host credential', async () => {
  const f=fixture(); await f.call('attempt',1,'cron_create',{name:'monitor',type:'agent',schedule:'*/15 * * * *',prompt:'Inspect',timeout_ms:10000});
  const [,init]=f.request.mock.calls[0];
  expect(JSON.parse(init.body as string)).toMatchObject({agentId:'owner',timeoutMs:10000,deleteAfterRun:false});
  expect(JSON.parse(init.body as string)).not.toHaveProperty('timeout_ms');
  expect(init.headers).toMatchObject({Authorization:'Bearer host-only'});
});
test.each(['cron_update','cron_delete','cron_run','cron_get_runs'])('%s rejects another agent job even with an admin-like key',async tool=>{
 const f=fixture(); f.request.mockResolvedValue(new Response(JSON.stringify({job:{agentId:'other',type:'agent'}})));
 await expect(f.call('attempt',1,tool,{job_id:'other-job'})).rejects.toThrow('CRON_SCOPE_DENIED');expect(f.request).toHaveBeenCalledTimes(1);
});
test('cannot override ownership or path; stale worker cannot mutate after ownership lookup',async()=>{
 const f=fixture();await expect(f.call('a',1,'cron_create',{agentId:'other'})).rejects.toThrow('INVALID_INPUT');
 await expect(f.call('a',1,'cron_delete',{job_id:'../other'})).rejects.toThrow('INVALID_INPUT');expect(f.request).not.toHaveBeenCalled();
 f.scope.mockImplementationOnce(()=>({task:{agentId:'owner',capabilities:{execute:true}}})).mockImplementationOnce(()=>({task:{agentId:'owner',capabilities:{execute:true}}})).mockImplementation(()=>{throw new Error('STALE_ATTEMPT');});
 await expect(f.call('a',1,'cron_delete',{job_id:'job'})).rejects.toThrow('STALE_ATTEMPT');expect(f.request).toHaveBeenCalledTimes(1);
});
test('container can schedule agent jobs but cannot create/change/run host commands',async()=>{
 const f=fixture(true);await f.call('a',1,'cron_create',{name:'monitor',type:'agent',schedule:'0 * * * *',prompt:'Inspect'});
 for(const [tool,args] of [['cron_create',{type:'command',command:'id'}],['cron_update',{job_id:'job',type:'command'}],['cron_update',{job_id:'job',command:'id'}],['cron_run',{job_id:'job'}]] as const){await expect(f.call('a',1,tool,args)).rejects.toThrow('CRON_SCOPE_DENIED');}
 expect(f.request).toHaveBeenCalledTimes(1);
 expect(containerTaskTools('worker').some(t=>t.name==='cron_create')).toBe(true);
});
test('read scope filters other agents and container command jobs',async()=>{
 const f=fixture(true);f.request.mockResolvedValue(new Response(JSON.stringify({jobs:[{agentId:'other',type:'agent'},{agentId:'owner',type:'command'},{agentId:'owner',type:'agent'}]})));
 await expect(f.call('a',1,'cron_list',{})).resolves.toEqual({jobs:[{agentId:'owner',type:'agent'}]});
});
test('API errors do not become successful results',async()=>{
 const f=fixture();f.request.mockResolvedValue(new Response(JSON.stringify({error:'invalid schedule'}),{status:400}));
 await expect(f.call('a',1,'cron_create',{name:'bad',type:'agent'})).rejects.toThrow('HTTP 400');
});

test.each([['cron_update','PUT','/job'],['cron_delete','DELETE','/job'],['cron_run','POST','/job/run'],['cron_get_runs','GET','/job/runs']])('owned %s uses the scoped endpoint',async(tool,method,suffix)=>{
 const f=fixture();await f.call('a',1,tool,{job_id:'job',...(tool==='cron_update'?{prompt:'Updated',timeout_ms:9000}:{})});
 expect(f.request).toHaveBeenCalledTimes(2);const [url,init]=f.request.mock.calls[1];expect(url.endsWith(suffix)).toBe(true);expect(init.method).toBe(method);
 if(tool==='cron_update')expect(JSON.parse(init.body as string)).toEqual({prompt:'Updated',timeoutMs:9000});
});
test('read-only task has no cron execution permission',async()=>{
 const f=fixture();f.scope.mockReturnValue({task:{agentId:'owner',capabilities:{execute:false}}});
 await expect(f.call('a',1,'cron_list',{})).rejects.toThrow('CRON_SCOPE_DENIED');expect(f.request).not.toHaveBeenCalled();
});

test('manual run waits beyond CRUD deadline and returns the actual result', async () => {
  const f = fixture(), deadlines = jest.spyOn(AbortSignal, 'timeout');
  let complete!: (response: Response) => void;
  f.request.mockImplementation(async url => url.endsWith('/run') ? new Promise<Response>(resolve => { complete = resolve; }) : new Response(JSON.stringify({job:{agentId:'owner',type:'agent'}})));
  const running = f.call('a', 1, 'cron_run', {job_id:'job'});
  try {
    while (!complete) await new Promise(resolve => setImmediate(resolve));
    expect(deadlines).toHaveBeenCalledTimes(1); // ownership lookup only
    expect(f.request.mock.calls[1][1].signal).toBeUndefined();
    complete(new Response(JSON.stringify({run:{status:'ok',durationMs:25000}})));
    await expect(running).resolves.toMatchObject({run:{status:'ok',durationMs:25000}});
  } finally { deadlines.mockRestore(); }
});

test('cancelled run wait preserves unknown execution outcome instead of invalid request', async () => {
  const f = fixture(), controller = new AbortController();
  let started = false;
  f.request.mockImplementation(async (url, init) => {
    if (!url.endsWith('/run')) return new Response(JSON.stringify({job:{agentId:'owner',type:'agent'}}));
    started = true;
    return new Promise<Response>((_resolve,reject) => init.signal!.addEventListener('abort', () => reject(new Error('cancelled')), {once:true}));
  });
  const running = f.call('a',1,'cron_run',{job_id:'job'},controller.signal);
  const outcome = expect(running).rejects.toMatchObject({code:'CRON_OUTCOME_UNKNOWN',message:expect.stringContaining('Do not retry')});
  while (!started) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await outcome;
  expect(f.request).toHaveBeenCalledTimes(2);
});

test('lost mutation response is explicitly uncertain and never retried', async () => {
  const f=fixture(); f.request.mockRejectedValue(new Error('network failure'));
  await expect(f.call('a',1,'cron_create',{name:'fixture',type:'agent',prompt:'fixture',schedule:'0 * * * *'})).rejects.toMatchObject({code:'CRON_OUTCOME_UNKNOWN'});
  expect(f.request).toHaveBeenCalledTimes(1);
});

test.each(['revoke', 'disconnect', 'close'] as const)('bridge %s cancels an in-flight run wait', async reason => {
  const { TaskBridge } = await import('../../../src/orchestration/bridge');
  const { mkdtempSync, readFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const f = fixture(); let started = false, aborted = false;
  f.request.mockImplementation(async (url, init) => {
    if (!url.endsWith('/run')) return new Response(JSON.stringify({job:{agentId:'owner',type:'agent'}}));
    started = true;
    return new Promise<Response>((_resolve,reject) => init.signal!.addEventListener('abort', () => { aborted=true;reject(new Error('cancelled')); }, {once:true}));
  });
  const directory = mkdtempSync(join(tmpdir(),'cron-bridge-'));
  const bridge = new TaskBridge({store:{agentId:'owner'}} as any, {scope:f.scope,releaseCaptured:()=>{}} as any, undefined, undefined, undefined, f.call);
  try {
    await bridge.start();
    const ticket = bridge.issue({role:'worker',attemptId:'a',generation:1},directory,directory);
    const auth = JSON.parse(readFileSync(join(directory,'ticket.json'),'utf8'));
    const client = new AbortController();
    const pending = fetch(auth.url,{method:'POST',headers:{Authorization:`Bearer ${auth.token}`},body:JSON.stringify({tool:'cron_run',args:{job_id:'job'},action_id:'fixture'}),signal:client.signal})
      .then(async res => ({status:res.status,body:await res.json()})).catch(error => ({error}));
    while (!started) await new Promise(resolve => setImmediate(resolve));
    if (reason === 'revoke') ticket.revoke();
    else if (reason === 'disconnect') client.abort();
    else await bridge.close();
    const result = await pending;
    for(let n=0;n<100&&!aborted;n++) await new Promise(resolve=>setTimeout(resolve,1));
    expect(aborted).toBe(true);
    if (reason === 'revoke') expect(result).toMatchObject({status:400,body:{error:'CRON_OUTCOME_UNKNOWN',retryable:false,message:expect.stringContaining('may still complete')}});
  } finally { await bridge.close();rmSync(directory,{recursive:true,force:true}); }
});

test.each([
  {admin:true, agents:[]},
  {admin:true, agents:['different-agent']},
  {admin:false, agents:['owner']},
])('cron accepts an API-authorized key: %j', async permissions => {
  const request = jest.fn(async () => new Response(JSON.stringify({jobs:[]})));
  const call = workerCrons({scope:()=>({task:{agentId:'owner',capabilities:{execute:true}}})} as unknown as TaskFiles,
    {id:'owner'} as AgentConfig,
    {gateway:{api:{keys:[{key:'fixture-only',...permissions}]}}} as GatewayConfig, request);
  await expect(call('attempt',1,'cron_list',{})).resolves.toEqual({jobs:[]});
  expect(request).toHaveBeenCalledTimes(1);
});

test('non-admin key scoped to another agent cannot dispatch cron requests', async () => {
  const request = jest.fn();
  const call = workerCrons({scope:()=>({task:{agentId:'owner',capabilities:{execute:true}}})} as unknown as TaskFiles,
    {id:'owner'} as AgentConfig,
    {gateway:{api:{keys:[{key:'fixture-only',admin:false,agents:['other']}]}}} as GatewayConfig, request);
  await expect(call('attempt',1,'cron_list',{})).rejects.toThrow('CRON_NOT_CONFIGURED');
  expect(request).not.toHaveBeenCalled();
});
