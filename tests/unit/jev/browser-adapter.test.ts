import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BrowserTaskAdapter,BrowserTaskBinding} from '../../../src/orchestration/gateway-tasks/browser';
import {BrowserExecutionContext,BrowserExecutionResult} from '../../../src/jev/browser-contract';
import {CommandContext,TaskSnapshot,WorkerOutcome} from '../../../src/orchestration/types';
const complete:BrowserExecutionResult={status:'succeeded',reason:'VERIFIED',steps:1,evaluations:2};
const task=(patch:Partial<TaskSnapshot>={})=>({agentId:'alpha',taskId:'a',ownerPrincipalId:'owner',conversationId:'chat',gatewayTarget:{adapter:'browser',sessionId:'target',name:'Browser'},...patch} as TaskSnapshot);
const context=(principalId='owner',conversationId='chat')=>({principalId,conversationId} as CommandContext);
let dir:string,adapters:BrowserTaskAdapter[];
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'browser-adapter-'));adapters=[];});
afterEach(async()=>{await Promise.all(adapters.map(x=>x.close()));rmSync(dir,{recursive:true,force:true});});
function fixture(){
 let allowed=true;
 const run=jest.fn(async(_context:BrowserExecutionContext)=>structuredClone(complete));
 const binding:BrowserTaskBinding={version:1,id:'target',name:'Browser',principalId:'owner',conversationId:'chat',run};
 let bindings=[binding];
 const onNeedsInput=jest.fn(()=>false);
 const options={agentId:'alpha',root:dir,allowed:()=>allowed,bindings:()=>bindings,evaluate:jest.fn(),onNeedsInput};
 const make=()=>{const a=new BrowserTaskAdapter(options);adapters.push(a);return a;};
 return {a:make(),make,run,onNeedsInput,revoke:()=>{allowed=false;},remove:()=>{bindings=[];}};
}
async function settle(a:BrowserTaskAdapter,t=task(),r='r'):Promise<WorkerOutcome>{
 for(let i=0;i<50;i++){const value=await a.inspect(t,r);if(typeof value!=='string')return value;await new Promise(setImmediate);}
 throw Error('not settled');
}
function untilAbort(c:BrowserExecutionContext):Promise<BrowserExecutionResult>{return new Promise(resolve=>c.signal.addEventListener('abort',()=>resolve({status:'cancelled',reason:'TASK_CANCELLED',steps:0,evaluations:0}),{once:true}));}
test('discovery and submission require agent, principal AND conversation ownership',async()=>{
 const f=fixture();expect(f.a.discover('',0,context())).toMatchObject({targets:[{session_id:'target'}]});
 for(const ctx of [context('other'),context('owner','other')]){expect(f.a.discover('',0,ctx)).toMatchObject({targets:[]});expect(()=>f.a.resolve({adapter:'browser',session_id:'target'},ctx)).toThrow();}
 for(const patch of [{agentId:'beta'},{ownerPrincipalId:'other'},{conversationId:'other'}])await expect(f.a.submit(task(patch),'r','goal')).rejects.toThrow();
 expect(f.run).not.toHaveBeenCalled();
});
test('durable receipt precedes execution and verified success retains counters',async()=>{
 const f=fixture();f.run.mockImplementation(async()=>{expect(JSON.parse(readFileSync(join(dir,readdirSync(dir)[0]),'utf8')).status).toBe('running');return complete;});
 await f.a.submit(task(),'r','goal');expect(await settle(f.a)).toMatchObject({type:'completed',result:{summary:expect.stringContaining('1 actions, 2 evaluations')}});
 await expect(f.a.submit(task(),'r','goal')).rejects.toThrow('BROWSER_REQUEST_ALREADY_SUBMITTED');
 expect(JSON.parse(readFileSync(join(dir,readdirSync(dir)[0]),'utf8')).browserResult).toEqual(complete);
});
test('restart reports uncertain running receipt without replay',async()=>{
 const f=fixture();f.run.mockImplementation(untilAbort);await f.a.submit(task(),'r','goal');await new Promise(setImmediate);
 expect(await f.make().inspect(task(),'r')).toMatchObject({type:'unknown',failure:{code:'BROWSER_EXECUTION_INTERRUPTED'}});
 expect(f.run).toHaveBeenCalledTimes(1);
 await f.a.cancel(task(),'r');await settle(f.a);
});
test('another task cannot cancel a request and another owner cannot inspect its receipt',async()=>{
 const f=fixture();f.run.mockImplementation(untilAbort);await f.a.submit(task(),'r','goal');await new Promise(setImmediate);
 await f.a.cancel(task({taskId:'other'}),'r');expect(await f.a.inspect(task(),'r')).toBe('running');
 await expect(f.a.inspect(task({ownerPrincipalId:'other'}),'r')).rejects.toThrow();
 await f.a.cancel(task(),'r');expect(await settle(f.a)).toMatchObject({type:'stopped'});
});
test('unknown mutation remains unknown even if runner says succeeded or cancelled',async()=>{
 for(const status of ['succeeded','cancelled'] as const){const f=fixture();f.run.mockResolvedValue({...complete,status,lastAction:{operationId:'op',operation:'CLICK',outcome:'unknown'}});await f.a.submit(task({taskId:status}),status,'goal');expect((await settle(f.a,task({taskId:status}),status)).type).toBe('unknown');}
});
test('revocation after verification cannot publish success',async()=>{
 const f=fixture();f.run.mockImplementation(async()=>{f.revoke();return complete;});await f.a.submit(task(),'r','goal');expect((await settle(f.a)).type).toBe('unknown');
});
test('missing field can enter existing input-question lifecycle',async()=>{
 const f=fixture();f.run.mockResolvedValue({...complete,status:'blocked',reason:'FIELD_TEXT_REQUIRED'});f.onNeedsInput.mockReturnValue(true);
 await f.a.submit(task(),'r','goal');expect((await settle(f.a)).type).toBe('paused');expect(f.onNeedsInput).toHaveBeenCalled();
});
test('invalid external result never becomes successful completion',async()=>{
 const f=fixture();f.run.mockResolvedValue({...complete,steps:-1});await f.a.submit(task(),'r','goal');expect((await settle(f.a)).type).toBe('unknown');
});
