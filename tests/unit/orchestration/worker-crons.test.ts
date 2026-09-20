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
