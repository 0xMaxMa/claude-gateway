import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
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
 const f=fixture();expect(await f.a.discover('',0,context())).toMatchObject({targets:[{session_id:'target'}]});
 for(const ctx of [context('other'),context('owner','other')]){expect(await f.a.discover('',0,ctx)).toMatchObject({targets:[]});expect(()=>f.a.resolve({adapter:'browser',session_id:'target'},ctx)).toThrow();}
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
test('evidence is scoped, fresh proof expires, and unknown mutations cannot be verified',async()=>{
 const result:BrowserExecutionResult={status:'needs_verification',reason:'COMPLETION_CANDIDATE',steps:1,evaluations:2,lastAction:{operationId:'op',operation:'TYPE_TEXT',outcome:'confirmed'}};
 const inspect=jest.fn(async()=>({observedAt:Date.now(),observation:{generation:'g',elements:[]}}));
 const binding:BrowserTaskBinding={version:1,id:'target',name:'Browser',principalId:'owner',conversationId:'chat',run:async()=>result,inspect};
 let allowed=true;
 const a=new BrowserTaskAdapter({agentId:'alpha',root:dir,allowed:()=>allowed,bindings:()=>[binding],evaluate:jest.fn()});adapters.push(a);
 const t=task({gatewayDispatch:{requestId:'r',submittedAt:Date.now()}});
 await a.submit(t,'r','goal');await settle(a,t);
 expect((await a.evidence(t)).evidenceId).toBeUndefined();
 await expect(a.evidence({...t,ownerPrincipalId:'other'},true)).rejects.toThrow();expect(inspect).not.toHaveBeenCalled();
 const proof=await a.evidence(t,true);expect(proof.evidenceId).toBeTruthy();
 expect(()=>a.verifyEvidence(t,'r',proof.evidenceId!)).not.toThrow();
 expect(()=>a.verifyEvidence(t,'other',proof.evidenceId!)).toThrow();
 const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now+300001);
 expect(()=>a.verifyEvidence(t,'r',proof.evidenceId!)).toThrow();jest.restoreAllMocks();
 allowed=false;await expect(a.evidence(t,true)).rejects.toThrow();
 allowed=true;
 const file=join(dir,readdirSync(dir)[0]);const receipt=JSON.parse(readFileSync(file,'utf8'));
 receipt.browserResult.lastAction.outcome='unknown';require('fs').writeFileSync(file,JSON.stringify(receipt));
 expect(()=>a.verifyEvidence(t,'r',proof.evidenceId!)).toThrow();
});
test('provider reset metadata survives runner handoff without raw provider prose',async()=>{
 const binding:BrowserTaskBinding={version:1,id:'target',name:'Browser',principalId:'owner',conversationId:'chat',run:async(c)=>{
  try{await c.evaluate({state:'page',questions:{}},c.signal);}catch{}
  return {status:'failed',reason:'QUOTA_EXCEEDED',steps:0,evaluations:1};
 }};
 const {JevError}=require('../../../src/jev/types');
 const a=new BrowserTaskAdapter({agentId:'alpha',root:dir,allowed:()=>true,bindings:()=>[binding],evaluate:async()=>{throw new JevError('QUOTA_EXCEEDED','private provider prose',{status:402,resetAt:'2030-01-01T00:00:00Z',retryAfter:'30'});}});adapters.push(a);
 await a.submit(task(),'r','goal');const outcome=await settle(a);
 expect(outcome.browserReport?.providerFailure).toEqual({code:'QUOTA_EXCEEDED',status:402,resetAt:'2030-01-01T00:00:00Z',retryAfter:'30'});
 expect(JSON.stringify(outcome)).not.toContain('private provider prose');
});
test('interrupted receipts allow read-only inspection but cannot authorize verification',async()=>{
 const f=fixture();f.run.mockImplementation(untilAbort);const t=task({gatewayDispatch:{requestId:'r',submittedAt:Date.now()}});
 await f.a.submit(t,'r','goal');await new Promise(setImmediate);
 const inspector=jest.fn(async()=>({observedAt:Date.now(),observation:{generation:'g',elements:[]}}));
 const binding:BrowserTaskBinding={version:1,id:'target',name:'Browser',principalId:'owner',conversationId:'chat',run:jest.fn(),inspect:inspector};
 const afterRestart=new BrowserTaskAdapter({agentId:'alpha',root:dir,allowed:()=>true,bindings:()=>[binding],evaluate:jest.fn()});adapters.push(afterRestart);
 const proof=await afterRestart.evidence(t,true);
 expect(proof.executionState).toBe('interrupted');expect(proof.result).toBeUndefined();expect(proof.fresh).toBeDefined();
 expect(()=>afterRestart.verifyEvidence(t,'r',proof.evidenceId!)).toThrow('BROWSER_VERIFICATION_UNAVAILABLE');expect(binding.run).not.toHaveBeenCalled();
 await f.a.cancel(t,'r');await settle(f.a,t);
});
test('mutation checkpoint survives thrown runner errors and directs fresh inspection after recovery',async()=>{
 const f=fixture(),id='22222222-2222-4222-8222-222222222222';
 f.run.mockImplementation(async c=>{c.beforeMutation!(id,'page_click');const receipt=JSON.parse(readFileSync(join(dir,readdirSync(dir)[0]),'utf8'));expect(receipt.lastDispatchedMutation.operationId).toBe(id);throw Error('connection lost');});
 const t=task({gatewayDispatch:{requestId:'r',submittedAt:Date.now()}});
 await f.a.submit(t,'r','goal');expect((await settle(f.a,t)).type).toBe('unknown');
 const inspect=jest.fn(async(_result:Partial<BrowserExecutionResult>|undefined)=>({observedAt:Date.now(),observation:{}}));
 const binding:BrowserTaskBinding={version:1,id:'target',name:'Browser',principalId:'owner',conversationId:'chat',run:f.run,inspect};
 const a=new BrowserTaskAdapter({agentId:'alpha',root:dir,allowed:()=>true,bindings:()=>[binding],evaluate:jest.fn()});adapters.push(a);
 const evidence=await a.evidence(t,true);
 expect(evidence.lastDispatchedMutation?.operationId).toBe(id);
 expect(inspect.mock.calls[0][0]).toMatchObject({lastAction:{operationId:id,outcome:'unknown'}});
 await expect(a.submit(t,'r','goal')).rejects.toThrow('BROWSER_REQUEST_ALREADY_SUBMITTED');
 expect(f.run).toHaveBeenCalledTimes(1);
});
test('a runner cannot hide the latest dispatched mutation with an older successful result',async()=>{
 const f=fixture();f.run.mockImplementation(async c=>{c.beforeMutation!('22222222-2222-4222-8222-222222222222','page_click');return complete;});
 await f.a.submit(task(),'r','goal');expect(await settle(f.a)).toMatchObject({type:'unknown',browserReport:{reason:'OUTCOME_UNKNOWN',lastAction:{outcome:'unknown'}}});
});
test('checkpoint persistence failure aborts the dispatch boundary',async()=>{
 const f=fixture();let dispatched=false,aborted=false;
 f.run.mockImplementation(async c=>{
  const fail=jest.spyOn(require('node:fs'),'fsyncSync').mockImplementationOnce(()=>{throw Error('disk error');});
  try{c.beforeMutation!('22222222-2222-4222-8222-222222222222','page_click');dispatched=true;return complete;}
  finally{aborted=c.signal.aborted;fail.mockRestore();}
 });
 await f.a.submit(task(),'r','goal');expect((await settle(f.a)).type).toBe('unknown');
 expect(dispatched).toBe(false);expect(aborted).toBe(true);
 expect(readdirSync(dir)).toHaveLength(1);
});
test('browser start URL is explicit, validated and passed to the runner',async()=>{
 const f=fixture();
 const target=f.a.resolve({adapter:'browser',session_id:'target',start_url:'https://www.google.com/'},context());
 expect(target.startUrl).toBe('https://www.google.com/');
 for(const start_url of ['javascript:alert(1)','file:///etc/passwd','https://user:secret@example.com'])expect(()=>f.a.resolve({adapter:'browser',session_id:'target',start_url},context())).toThrow('INVALID_BROWSER_START_URL');
 f.run.mockImplementation(async(c:BrowserExecutionContext)=>{c.beforeMutation!('11111111-1111-4111-8111-111111111111','tab_navigate');expect(JSON.parse(readFileSync(join(dir,readdirSync(dir)[0]),'utf8')).lastDispatchedMutation.operation).toBe('tab_navigate');return complete;});await f.a.submit(task({gatewayTarget:target}),'start-url','goal');await settle(f.a,task({gatewayTarget:target}),'start-url');
 expect(f.run.mock.calls[0][0].startUrl).toBe('https://www.google.com/');
});

test('missing start URL ends cleanly and legacy uncertain receipts can be cleaned up',async()=>{
 const f=fixture();f.run.mockResolvedValue({status:'blocked',reason:'START_URL_REQUIRED',steps:0,evaluations:0});
 await f.a.submit(task(),'r','goal');expect(await settle(f.a)).toMatchObject({type:'failed',failure:{code:'BROWSER_START_URL_REQUIRED'}});
 const file=join(dir,readdirSync(dir)[0]);const receipt=JSON.parse(readFileSync(file,'utf8'));
 receipt.outcome.type='unknown';writeFileSync(file,JSON.stringify(receipt));
 expect(await f.make().inspect(task(),'r')).toMatchObject({type:'failed'});
 receipt.lastDispatchedMutation={operationId:'550e8400-e29b-41d4-a716-446655440000',operation:'tab_navigate'};writeFileSync(file,JSON.stringify(receipt));
 expect(await f.make().inspect(task(),'r')).toMatchObject({type:'unknown'});
 expect(f.run).toHaveBeenCalledTimes(1);
});

test('explicit cancellation releases ended blocked work only with confirmed mutation evidence',async()=>{
 for(const outcome of ['confirmed','unknown'] as const){
  const f=fixture();const op='550e8400-e29b-41d4-a716-446655440000';
  f.run.mockImplementation(async c=>{c.beforeMutation!(op,'tab_navigate');return {status:'blocked',reason:'OBSERVATION_TRUNCATED',steps:1,evaluations:0,lastAction:{operationId:op,operation:'NAVIGATE',outcome}};});
  const t=task({taskId:outcome});await f.a.submit(t,'r','goal');await settle(f.a,t);await new Promise(setImmediate);
  await f.a.cancel(t,'r');expect((await settle(f.a,t)).type).toBe(outcome==='confirmed'?'stopped':'unknown');
 }
});

test('low confidence ends as failed after confirmed navigation, not a target lock',async()=>{
 const f=fixture();const op='550e8400-e29b-41d4-a716-446655440000';
 f.run.mockImplementation(async c=>{c.beforeMutation!(op,'tab_navigate');return {status:'blocked',reason:'LOW_OPERATION_CONFIDENCE',steps:1,evaluations:1,lastAction:{operationId:op,operation:'NAVIGATE',outcome:'confirmed'}};});
 await f.a.submit(task(),'r','goal');expect(await settle(f.a)).toMatchObject({type:'failed',failure:{code:'BROWSER_LOW_OPERATION_CONFIDENCE'}});
 const file=join(dir,readdirSync(dir)[0]),receipt=JSON.parse(readFileSync(file,'utf8'));receipt.outcome.type='unknown';writeFileSync(file,JSON.stringify(receipt));
 expect(await f.make().inspect(task(),'r')).toMatchObject({type:'failed'});
 receipt.browserResult.lastAction.operationId='different';writeFileSync(file,JSON.stringify(receipt));
 expect(await f.make().inspect(task(),'r')).toMatchObject({type:'unknown'});
});

test('known stop after rejected stale input is terminal without replay',async()=>{
 const f=fixture(),op='550e8400-e29b-41d4-a716-446655440000';
 f.run.mockImplementation(async c=>{c.beforeMutation!(op,'page_click');return {status:'blocked',reason:'LOW_OPERATION_CONFIDENCE',steps:0,evaluations:2,lastAction:{operationId:op,operation:'CLICK',outcome:'not_executed'}};});
 await f.a.submit(task(),'r','goal');expect((await settle(f.a)).type).toBe('failed');expect(f.run).toHaveBeenCalledTimes(1);
});

test.each(['STALE_RETRY_BUDGET','TEXT_BUDGET','WAIT_BUDGET','NO_PROGRESS','FUTURE_SAFE_STOP'])('ended %s releases the target when the last operation was explicitly rejected',async reason=>{
 const f=fixture(),op='550e8400-e29b-41d4-a716-446655440000';
 f.run.mockImplementation(async c=>{c.beforeMutation!(op,'page_click');return {status:'blocked',reason,steps:2,evaluations:4,lastAction:{operationId:op,operation:'CLICK',outcome:'not_executed'}};});
 await f.a.submit(task(),'r','goal');expect((await settle(f.a)).type).toBe('failed');
});
test('explicit unknown outcome remains fenced even without a recorded action',async()=>{
 const f=fixture();f.run.mockResolvedValue({status:'blocked',reason:'OUTCOME_UNKNOWN',steps:0,evaluations:0});
 await f.a.submit(task(),'r','goal');expect((await settle(f.a)).type).toBe('unknown');
});

test('browser continuation omits initial navigation, but pre-dispatch revisions retain it',async()=>{
 for(const appliedRevision of [0,1]){
  const f=fixture(),t=task({taskId:'revision-'+appliedRevision,revision:2,appliedRevision,gatewayTarget:{adapter:'browser',sessionId:'target',name:'Browser',startUrl:'https://example.com/'}});
  await f.a.submit(t,'r','Updated goal');await settle(f.a,t);
  expect(f.run.mock.calls[0][0].startUrl).toBe(appliedRevision===0?'https://example.com/':undefined);
 }
});
test.each(['BROWSER_INSPECTION_DENIED','private arbitrary upstream text'])('inspection failures stay typed and redact untrusted prose: %s',async message=>{
 const binding:BrowserTaskBinding={version:1,id:'target',name:'Browser',principalId:'owner',conversationId:'chat',run:async()=>complete,inspect:async()=>{throw Error(message);}};
 const a=new BrowserTaskAdapter({agentId:'alpha',root:dir,allowed:()=>true,bindings:()=>[binding],evaluate:jest.fn()});adapters.push(a);
 const t=task({gatewayDispatch:{requestId:'r',submittedAt:Date.now()}});await a.submit(t,'r','goal');await settle(a,t);
 await expect(a.evidence(t,true)).rejects.toMatchObject({code:message.startsWith('BROWSER_')?message:'BROWSER_INSPECTION_UNAVAILABLE'});
 await expect(a.evidence(t,true)).rejects.not.toThrow('private arbitrary');
});

test('superseding revision proceeds after a known-ended missing field stop',async()=>{
 const f=fixture();f.run.mockResolvedValue({...complete,status:'blocked',reason:'FIELD_TEXT_REQUIRED',steps:0});
 const t=task({revision:2,appliedRevision:1});await f.a.submit(task({revision:1}),'r','goal');
 expect((await settle(f.a,t)).type).toBe('paused');expect(f.onNeedsInput).not.toHaveBeenCalled();
});

test('initial field handoff does not masquerade as a superseding revision',async()=>{
 const f=fixture();f.run.mockResolvedValue({...complete,status:'blocked',reason:'FIELD_TEXT_REQUIRED',steps:0});
 const t=task({revision:1,appliedRevision:0});await f.a.submit(t,'r','goal');
 expect((await settle(f.a,t)).type).toBe('unknown');expect(f.onNeedsInput).toHaveBeenCalled();
});
