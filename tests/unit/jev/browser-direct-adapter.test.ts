import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BrowserTaskAdapter,type BrowserTaskBinding} from '../../../src/orchestration/gateway-tasks/browser';
import type {BrowserExecutionContext,BrowserExecutionResult} from '../../../src/jev/browser-contract';
import type {TaskSnapshot,WorkerOutcome} from '../../../src/orchestration/types';

// Remote Browser direct commands at the adapter boundary: new primitives pass
// the write-ahead fence, user-controlled rounds run as direct commands with
// the previous command's context, step mode is flag-gated, and a settled
// round asks for an immediate controller tick.
const task=(patch:Partial<TaskSnapshot>={})=>({agentId:'alpha',taskId:'a',ownerPrincipalId:'owner',conversationId:'chat',revision:1,automationController:'user',gatewayTarget:{adapter:'browser',sessionId:'target',name:'Browser'},...patch} as TaskSnapshot);
let dir:string,adapters:BrowserTaskAdapter[];
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'browser-direct-adapter-'));adapters=[];});
afterEach(async()=>{await Promise.all(adapters.map(x=>x.close()));rmSync(dir,{recursive:true,force:true});});
function fixture(options:{stepMode?:boolean;userSteps?:string}={}){
 const contexts:BrowserExecutionContext[]=[];
 let next:(c:BrowserExecutionContext)=>Promise<BrowserExecutionResult>=async()=>({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0});
 const run=jest.fn(async(c:BrowserExecutionContext)=>{contexts.push(c);return next(c);});
 const binding:BrowserTaskBinding={version:1,id:'target',name:'Browser',principalId:'owner',conversationId:'chat',run};
 const settled=jest.fn();
 const a=new BrowserTaskAdapter({agentId:'alpha',root:dir,allowed:()=>true,bindings:()=>[binding],evaluate:jest.fn(),settled,
  stepMode:()=>options.stepMode===true,userSteps:()=>options.userSteps});
 adapters.push(a);
 return {a,run,contexts,settled,setRun:(f:typeof next)=>{next=f;}};
}
async function settle(a:BrowserTaskAdapter,t:TaskSnapshot,r:string):Promise<WorkerOutcome>{
 for(let i=0;i<50;i++){const value=await a.inspect(t,r);if(typeof value!=='string')return value;await new Promise(setImmediate);}
 throw Error('not settled');
}
const op='11111111-1111-4111-8111-111111111111';

test.each(['page_keypress','tab_history'])('%s passes the durable write-ahead fence',async operation=>{
 const f=fixture();
 f.setRun(async c=>{c.beforeMutation!(op,operation);return {status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:0,lastAction:{operationId:op,operation:'KEY',outcome:'confirmed'}};});
 await f.a.submit(task(),'r','enter');
 expect(await settle(f.a,task(),'r')).toMatchObject({type:'paused'});
});

test('a user-controlled round is a direct command; its outcome and step run are accepted',async()=>{
 const f=fixture();
 f.setRun(async()=>({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:0,lastAction:{operationId:op,operation:'SCROLL_DOWN',outcome:'confirmed'},commandOutcome:{done:true,action:{kind:'scroll',direction:'down'}},observation:{url:'https://a.test/',title:'A'}}));
 await f.a.submit(task(),'r1','scroll ลง');
 const outcome=await settle(f.a,task(),'r1');
 expect(f.contexts[0]).toMatchObject({command:true,goal:'scroll ลง'});
 expect(outcome).toMatchObject({type:'paused',browserReport:{commandOutcome:{done:true}}});
 expect(f.settled).toHaveBeenCalled();
});

test('an agent-controlled round keeps the agent goal path',async()=>{
 const f=fixture();
 await f.a.submit(task({automationController:'agent'}),'r','Fill in the form');
 await settle(f.a,task({automationController:'agent'}),'r');
 expect(f.contexts[0].command).toBeUndefined();
});

test('"อีก" reaches Jev verbatim with the previous command as context, decided afresh',async()=>{
 const f=fixture();
 f.setRun(async()=>({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:0,lastAction:{operationId:op,operation:'SCROLL_DOWN',outcome:'confirmed'},commandOutcome:{done:true,action:{kind:'scroll',direction:'down'}},observation:{url:'https://a.test/',title:'A'}}));
 await f.a.submit(task(),'r1','scroll ลง');await settle(f.a,task(),'r1');
 await f.a.submit(task({revision:2}),'r2','อีก');await settle(f.a,task({revision:2}),'r2');
 expect(f.contexts[1].goal).toBe('อีก');
 expect(f.contexts[1].interactionContext).toContain('do it again, in any language, means the previous command');
 expect(f.contexts[1].interactionContext).toContain('"previousCommand":"scroll ลง"');
 expect(f.contexts[1].interactionContext).toContain('"kind":"scroll"');
});

test('a Japanese "again" also reaches Jev verbatim with the previous command as context',async()=>{
 const f=fixture();
 f.setRun(async()=>({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:0,lastAction:{operationId:op,operation:'SCROLL_DOWN',outcome:'confirmed'},commandOutcome:{done:true,action:{kind:'scroll',direction:'down'}},observation:{url:'https://a.test/',title:'A'}}));
 await f.a.submit(task(),'r1','下にスクロール');await settle(f.a,task(),'r1');
 await f.a.submit(task({revision:2}),'r2','もう一回');await settle(f.a,task({revision:2}),'r2');
 expect(f.contexts[1].goal).toBe('もう一回');
 expect(f.contexts[1].interactionContext).toContain('"previousCommand":"下にスクロール"');
 expect(f.contexts[1].interactionContext).toContain('do it again, in any language, means the previous command');
});

test('step mode passes the user\'s own step list only when browserSteps is enabled',async()=>{
 const off=fixture({userSteps:'เข้า google, ค้นหา แมว'});
 await off.a.submit(task(),'r','Open Google and search');await settle(off.a,task(),'r');
 expect(off.contexts[0].steps).toBeUndefined();
 const on=fixture({stepMode:true,userSteps:'เข้า google, ค้นหา แมว, scroll ลง'});
 on.setRun(async()=>({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:2,evaluations:0,stepRun:{total:3,completed:3,stopReason:'ALL_STEPS_DONE',remaining:[]}}));
 await on.a.submit(task({taskId:'b'}),'r','Open Google and search');
 expect(await settle(on.a,task({taskId:'b'}),'r')).toMatchObject({type:'paused',browserReport:{stepRun:{completed:3}}});
 expect(on.contexts[0].steps).toEqual(['เข้า google','ค้นหา แมว','scroll ลง']);
});

test('a malformed command outcome from an installed runner is rejected, not trusted',async()=>{
 const f=fixture();
 f.setRun(async()=>({status:'needs_verification',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:0,commandOutcome:{done:'yes'} as never}));
 await f.a.submit(task(),'r','scroll ลง');
 expect((await settle(f.a,task(),'r')).type).toBe('unknown');
});

test('a completion candidate in a user-controlled round waits for the next command instead of reconciliation (E2E d97b253f)',async()=>{
 const f=fixture();
 f.setRun(async()=>({status:'needs_verification',reason:'COMPLETION_CANDIDATE',steps:1,evaluations:1,lastAction:{operationId:op,operation:'NAVIGATE',outcome:'confirmed'},lastConfirmedAction:{operationId:op,operation:'NAVIGATE',outcome:'confirmed'}}));
 await f.a.submit(task(),'r','เข้า google');
 expect((await settle(f.a,task(),'r')).type).toBe('paused');
});

test('an agent-controlled completion candidate still goes to parent verification',async()=>{
 const f=fixture();
 f.setRun(async()=>({status:'needs_verification',reason:'COMPLETION_CANDIDATE',steps:1,evaluations:1,lastAction:{operationId:op,operation:'NAVIGATE',outcome:'confirmed'}}));
 await f.a.submit(task({automationController:'agent'}),'r','Open the page');
 expect((await settle(f.a,task({automationController:'agent'}),'r')).type).toBe('unknown');
});
