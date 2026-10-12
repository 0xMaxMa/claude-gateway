import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter,COMPUTER_GOAL_MAX_STEPS} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({runComputerUse:jest.fn(),confirmationReply:jest.fn()}));
jest.mock('../../../src/automation/vision-decider',()=>({...jest.requireActual('../../../src/automation/vision-decider'),runVisionComputerUse:jest.fn()}));
const {runComputerUse,confirmationReply}=require('../../../src/automation/computer-use');
const {runVisionComputerUse}=require('../../../src/automation/vision-decider');

const SHOT={generation:'g1',mimeType:'image/jpeg',data:'/9j/AAAA',capturedAt:1,width:1280,height:800};
function fixture(vision?:()=>any,controller:'user'|'agent'='user'){
 const root=mkdtempSync(join(tmpdir(),'computer-vision-adapter-'));runComputerUse.mockReset();runVisionComputerUse.mockReset();confirmationReply.mockReset();
 const callTool=jest.fn(async({name}:{name:string})=>({content:[{type:'text',text:JSON.stringify(name==='computer_screenshot'?SHOT:name==='computer_end_session'?{state:'stopped'}:{state:'approved'})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{device_id:'d',grant_id:'g'}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 const decide=jest.fn();
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true,...(vision?{vision}:{})});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:controller,gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 const run=async(request:string,goal:string)=>{await adapter.submit(task,request,goal);for(let i=0;i<50;i++){const outcome=await adapter.inspect(task,request);if(typeof outcome==='object')return outcome as any;await new Promise(r=>setImmediate(r));}throw Error('not settled');};
 return {run,decide,callTool,task,close:async()=>{await adapter.close();rmSync(root,{recursive:true,force:true});}};
}
const reached={status:'succeeded',reason:'GOAL_REACHED',steps:2,evaluations:3};

test('ax mode (no vision factory, or the factory says ax) runs the Accessibility loop exactly as before',async()=>{
 for(const vision of [undefined,()=>undefined]){
  const f=fixture(vision);try{
   runComputerUse.mockImplementationOnce(async()=>reached);
   expect((await f.run('r1','open YouTube')).type).toBe('completed');
   expect(runVisionComputerUse).not.toHaveBeenCalled();
   expect(runComputerUse.mock.calls[0][0]).toMatchObject({goal:'open YouTube',runToGoal:true,maxSteps:COMPUTER_GOAL_MAX_STEPS});
  }finally{await f.close();}
 }
});

test('vision mode decides the goal from screenshots sized by the helper and never starts the Accessibility loop',async()=>{
 let f:ReturnType<typeof fixture>|undefined;
 f=fixture(()=>({mode:'hybrid',decide:()=>f!.decide}));try{
  runVisionComputerUse.mockImplementationOnce(async(input:any,deps:any)=>{
   expect(input).toMatchObject({goal:'search YouTube for lofi and play it',revision:1,maxSteps:COMPUTER_GOAL_MAX_STEPS});
   expect(deps.mode).toBe('hybrid');expect(deps.decide).toBe(f!.decide);
   await deps.call('computer_acquire',{});
   expect(await deps.screenshot({generation:'g1'},new AbortController().signal)).toEqual({generation:'g1',data:'/9j/AAAA',width:1280,height:800});
   return reached;
  });
  const outcome=await f.run('r1','search YouTube for lofi and play it');
  expect(outcome.type).toBe('completed');
  expect(runComputerUse).not.toHaveBeenCalled();
  expect((f.callTool.mock.calls.find(([c]:any)=>c.name==='computer_screenshot')![0] as any).arguments).toMatchObject({generation:'g1',device_id:'d'});
 }finally{await f.close();}
});

test('a vision fallback (no raw-input capabilities) runs the same goal on Accessibility',async()=>{
 const f=fixture(()=>({mode:'vision',decide:()=>jest.fn()}));try{
  runVisionComputerUse.mockImplementationOnce(async()=>({fallback:'RAW_CAPABILITIES_MISSING',trace:[]}));
  runComputerUse.mockImplementationOnce(async()=>reached);
  expect((await f.run('r1','open YouTube')).type).toBe('completed');
  expect(runVisionComputerUse).toHaveBeenCalledTimes(1);
  expect(runComputerUse.mock.calls[0][0]).toMatchObject({goal:'open YouTube'});
 }finally{await f.close();}
});

test('a screenshot without a pixel size is refused, so vision cannot bind coordinates to it',async()=>{
 const f=fixture(()=>({mode:'vision',decide:()=>jest.fn()}));try{
  f.callTool.mockImplementation(async({name}:{name:string})=>({content:[{type:'text',text:JSON.stringify(name==='computer_screenshot'?{...SHOT,width:undefined}:{state:'approved'})}]}));
  runVisionComputerUse.mockImplementationOnce(async(_i:any,deps:any)=>{expect(await deps.screenshot({generation:'g1'},new AbortController().signal)).toEqual({error:'SCREENSHOT_SIZE_MISSING'});return {fallback:'SCREENSHOT_SIZE_MISSING',trace:[]};});
  runComputerUse.mockImplementationOnce(async()=>reached);
  expect((await f.run('r1','open YouTube')).type).toBe('completed');
 }finally{await f.close();}
});

const STATE={generation:'g1',application:'com.example.Shop',controls:[],apps:[],truncated:false};
const CONFIRM={kind:'press',label:'Buy now',blocked:true,confirm:true,target:'a'.repeat(32),vision:true};
const asks=async(_i:any,deps:any)=>{deps.observation(STATE);return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:2,lastAction:CONFIRM};};

test('a goal run is impact-gated and keeps going; the agent\'s own command yields after each action without the gate',async()=>{
 for(const [controller,expected] of [['user',{impact:true,yieldAfterAction:false}],['agent',{impact:false,yieldAfterAction:true}]] as const){
  const f=fixture(()=>({mode:'vision',decide:()=>jest.fn()}),controller);try{
   runVisionComputerUse.mockImplementationOnce(async()=>reached);
   await f.run('r1','open YouTube');
   expect(runVisionComputerUse.mock.calls[0][0]).toMatchObject(expected);
   expect(runVisionComputerUse.mock.calls[0][0]).not.toHaveProperty('confirmedTarget');
   expect(runVisionComputerUse.mock.calls[0][1].evaluate).toEqual(expect.any(Function));
  }finally{await f.close();}
 }
});

test('the user\'s yes to a vision question resumes the goal in vision, bound to the asked target',async()=>{
 const f=fixture(()=>({mode:'vision',decide:()=>jest.fn()}));try{
  runVisionComputerUse.mockImplementationOnce(asks);
  expect((await f.run('r1','buy the blue mug')).type).toBe('paused');
  f.task.revision=2;confirmationReply.mockResolvedValueOnce('YES');
  runVisionComputerUse.mockImplementationOnce(async()=>reached);
  await f.run('r2','yes please');
  expect(confirmationReply.mock.calls[0].slice(0,2)).toEqual(['Buy now','yes please']);
  expect(runVisionComputerUse).toHaveBeenCalledTimes(2);
  expect(runVisionComputerUse.mock.calls[1][0]).toMatchObject({goal:'buy the blue mug',confirmedTarget:'a'.repeat(32),impact:true,yieldAfterAction:false,maxSteps:COMPUTER_GOAL_MAX_STEPS});
  expect(runComputerUse).not.toHaveBeenCalled();
 }finally{await f.close();}
});

test('any other reply to a vision question runs as the user\'s own command on Accessibility, without the question',async()=>{
 const f=fixture(()=>({mode:'vision',decide:()=>jest.fn()}));try{
  runVisionComputerUse.mockImplementationOnce(asks);
  await f.run('r1','buy the blue mug');
  f.task.revision=2;confirmationReply.mockResolvedValueOnce('NO');
  runComputerUse.mockImplementationOnce(async()=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1}));
  await f.run('r2','no, scroll down instead');
  expect(runVisionComputerUse).toHaveBeenCalledTimes(1);
  expect(runComputerUse.mock.calls[0][0]).toMatchObject({goal:'no, scroll down instead',yieldAfterInteraction:true});
  expect(runComputerUse.mock.calls[0][0]).not.toHaveProperty('confirmation');
 }finally{await f.close();}
});

