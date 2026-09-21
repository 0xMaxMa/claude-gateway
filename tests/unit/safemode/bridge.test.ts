import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import { SafemodeTaskAdapter } from '../../../src/orchestration/gateway-tasks/safemode';
import { SafemodeStore, atomicJson } from '../../../src/safemode/store';
import type { AgentConfig } from '../../../src/types';

const nativeId='11111111-1111-4111-8111-111111111111';
async function fixture(container=false) {
 const root=mkdtempSync(join(tmpdir(),'safemode-bridge-')),workspace=join(root,'workspace');mkdirSync(workspace);
 const safeRoot=join(root,'safemode');mkdirSync(join(safeRoot,nativeId),{recursive:true});
 atomicJson(join(safeRoot,nativeId,'session.json'),{id:nativeId,name:'astra2',nativeSessionId:nativeId,cli:'codex',model:'inherit',createdAt:new Date().toISOString()});
 const safe=new SafemodeStore(safeRoot);safe.assign(nativeId,'operator');let allowed=true;
 const adapter=new SafemodeTaskAdapter('operator',()=>allowed,()=>safe);
 const store=new OrchestrationStore(join(root,'db'),'operator'),tasks=new TaskService(store);
 function input(sessionId:string,principalId='owner') {
  const receipt=store.acceptInput({scope:{agentId:'operator',agentSessionId:sessionId,source:'api',accountId:'owner',chatId:sessionId,threadKey:'',principalId},text:'inspect'});
  return {...receipt,...new DecisionService(store).begin(receipt.conversationId,principalId,[receipt.inputId]),principalId,execute:true,writeMemory:false};
 }
 const context=input('chat');
 const bridge=new TaskBridge(tasks,undefined,undefined,undefined,container?{agent:{id:'operator',workspace} as AgentConfig,spool:join(root,'spool')}:undefined,undefined,new Map([['safemode',adapter]]));await bridge.start();let count=0;
 function issue(overrides:Partial<Parameters<TaskBridge['issue']>[0]>={}) {
  const directory=join(root,'ticket-'+ ++count);const ticket=bridge.issue({role:'agent',context,...overrides} as Parameters<TaskBridge['issue']>[0],directory,workspace);
  const auth=JSON.parse(readFileSync(join(directory,'ticket.json'),'utf8'));let commands=0;
  return {...ticket,call:(tool:string,args:Record<string,unknown>={})=>new Promise<{status:number;body:any}>((ok,fail)=>{
   const opts={method:'POST',headers:{Authorization:'Bearer '+auth.token}};
   const cb=(res:import('http').IncomingMessage)=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>ok({status:res.statusCode!,body:JSON.parse(body)}));};
   const req=auth.socket?request({...opts,socketPath:auth.socket,path:'/call'},cb):request(auth.url,opts,cb);req.on('error',fail);req.end(JSON.stringify({tool,args,action_id:'cmd-'+ ++commands}));
  })};
 }
 return {issue,context,input,store,safe,adapter,setAllowed:(v:boolean)=>allowed=v,close:async()=>{await bridge.close();store.close();rmSync(root,{recursive:true,force:true});}};
}
const spawnArgs={title:'Check astra2',instructions:'Inspect the requested error',target_profile:'gateway-managed',gateway_target:{adapter:'safemode',session_id:nativeId}};

test('discovery creates no task; live revocation affects existing tickets and legacy tools are denied',async()=>{
 const f=await fixture();try{
  const t=f.issue();expect((await t.call('capabilities_list',{scope:'safemode',query:'astra2'})).body.sessions).toHaveLength(1);expect(f.store.all('SELECT * FROM tasks')).toHaveLength(0);
  expect((await t.call('safemode_validate',{operation:'list'})).body.error).toBe('TOOL_DENIED');
  f.setAllowed(false);expect((await t.call('capabilities_list',{scope:'safemode'})).body.error).toBe('SAFEMODE_AGENT_NOT_ALLOWED');expect((await t.call('task_spawn',spawnArgs)).body.error).toBe('SAFEMODE_AGENT_NOT_ALLOWED');
  f.setAllowed(true);expect((await t.call('capabilities_list',{scope:'safemode'})).body.sessions).toHaveLength(1);
 }finally{await f.close();}
});
test('a foreign native session ID cannot be discovered or assigned even by an allowlisted operator',async()=>{
 const f=await fixture();try{
  f.safe.assign(nativeId,'other-agent');const t=f.issue();expect((await t.call('capabilities_list',{scope:'safemode'})).body.sessions).toEqual([]);
  for(const id of [nativeId,'22222222-2222-4222-8222-222222222222']) expect((await t.call('task_spawn',{...spawnArgs,gateway_target:{adapter:'safemode',session_id:id}})).body.error).toBe('SAFEMODE_SESSION_NOT_AVAILABLE');
  expect(f.store.all('SELECT * FROM tasks')).toHaveLength(0);
 }finally{await f.close();}
});
test('task results and cancellation cannot cross conversations, even for the same agent',async()=>{
 const f=await fixture();try{
  const t=f.issue(),task=(await t.call('task_spawn',spawnArgs)).body;expect(task.gatewayTarget.sessionId).toBe(nativeId);
  const other=f.issue({context:f.input('other-chat')});
  for(const tool of ['task_status','task_cancel']) expect((await other.call(tool,{task_id:task.taskId})).body.error).toBe('ACCESS_DENIED');
  expect((await t.call('task_status',{task_id:task.taskId})).body[0].taskId).toBe(task.taskId);
 }finally{await f.close();}
});
test('app agents, workers, compact-only scopes and revoked tickets cannot reach host sessions',async()=>{
 const f=await fixture(true);try{for(const tool of ['capabilities_list','task_spawn']) expect((await f.issue().call(tool,tool==='task_spawn'?spawnArgs:{scope:'safemode'})).body.reason).toBe('SAFEMODE_HOST_ONLY');}finally{await f.close();}
 const host=await fixture();try{
  const worker=host.issue({role:'worker',attemptId:'fake',generation:1} as any);expect((await worker.call('capabilities_list',{scope:'safemode'})).body.error).toBe('TOOL_DENIED');
  const compact=host.issue({compactOnly:true});expect((await compact.call('task_spawn',spawnArgs)).body.reason).toBe('COMPACTION_SCOPE');
  const revoked=host.issue();revoked.revoke();expect((await revoked.call('capabilities_list',{scope:'safemode'})).body.reason).toBe('TICKET_INVALID_OR_REVOKED');
  const noExecution=host.issue({context:{...host.context,execute:false}});expect((await noExecution.call('capabilities_list',{scope:'safemode'})).body.sessions).toHaveLength(1);expect((await noExecution.call('task_spawn',spawnArgs)).body.error).toBe('EXECUTION_DENIED');
 }finally{await host.close();}
});
