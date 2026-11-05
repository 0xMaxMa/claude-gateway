import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
import {ComputerObservation} from '../../../src/automation/computer-use';
import {computerOutcomeText} from '../../../src/automation/computer-outcome';
import {buildComputerCommand} from '../../../src/automation/computer-command';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({...jest.requireActual('../../../src/automation/computer-use'),runComputerUse:jest.fn()}));
const {runComputerUse}=require('../../../src/automation/computer-use');

// Pod-jinawong r7, task 2f65b7cf: GetPod was frontmost, so GetPod Desktop withheld the screen
// (application "unapproved", no controls, frontmostProtected + reason). The gateway's schema dropped
// both fields, and the agent told the user "Spotify is not approved".
const REASON='The frontmost application is protected on this computer; open or switch to an allowed application.';
const WITHHELD={generation:'g1',application:'unapproved',controls:[],apps:[{id:'com.google.Chrome',name:'Google Chrome'}],truncated:false,screenshotAvailable:false,frontmostProtected:true,reason:REASON};
const NOT_DONE={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,trace:{events:[{sequence:1,round:1,at:1,revision:1,steps:0,evaluations:1,phase:'waiting',reason:'NO_SUPPORTED_ACTION'}]}};

test('the observation schema keeps why the screen is withheld, bounded',()=>{
 const parsed=ComputerObservation.parse(WITHHELD);
 expect(parsed).toMatchObject({application:'unapproved',frontmostProtected:true,reason:REASON});
 // A malformed field from an older or newer helper is dropped, not a rejected observation.
 expect(ComputerObservation.parse({...WITHHELD,frontmostProtected:'yes',reason:'x'.repeat(301)}).reason).toBeUndefined();
 expect(ComputerObservation.parse({...WITHHELD,frontmostProtected:'yes'}).frontmostProtected).toBeUndefined();
 expect(ComputerObservation.parse({...WITHHELD,frontmostProtected:undefined,reason:undefined}).frontmostProtected).toBeUndefined();
});

test('the decision model is told the screen is withheld and to open or switch to the target app',()=>{
 const state=ComputerObservation.parse(WITHHELD);
 const command=buildComputerCommand(state,'play a song on Spotify',new Map(),{},undefined,true,false,true,true);
 expect(command.request.state.desktop).toMatchObject({application:'unapproved',frontmostProtected:true});
 expect(command.request.state.desktop.screenWithheld).toMatch(/^The screen is withheld because a protected app/);
 expect(command.request.state.desktop.screenWithheld).toContain('Open or switch to the app or browser');
 // An ordinary screen carries neither.
 const plain=buildComputerCommand(ComputerObservation.parse({...WITHHELD,application:'com.google.Chrome',frontmostProtected:undefined,reason:undefined}),'play',new Map(),{},undefined,true,false,true,true);
 expect(plain.request.state.desktop).not.toHaveProperty('frontmostProtected');expect(plain.request.state.desktop).not.toHaveProperty('screenWithheld');
});

async function run(result:object,observed:object=WITHHELD,callTool?:jest.Mock){
 const root=mkdtempSync(join(tmpdir(),'computer-withheld-'));
 runComputerUse.mockReset();runComputerUse.mockImplementation(async(_input:any,deps:any)=>{deps.observation(ComputerObservation.parse(observed));return result;});
 const tool=callTool??jest.fn(async()=>({content:[{type:'text',text:'{"state":"approved"}'}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool:tool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}}),discover:async()=>[]};
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:2,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target',name:'Mac'},gatewayDispatch:{requestId:'request'},executionControl:{revision:2,agentHandoff:true}} as any;
 await adapter.submit(task,'request','play a song on Spotify');
 let outcome:any;for(let i=0;i<50;i++){outcome=await adapter.inspect(task,'request');if(typeof outcome==='object')break;await new Promise(r=>setImmediate(r));}
 return {outcome,adapter,task,tool,close:async()=>{await adapter.close();rmSync(root,{recursive:true,force:true});}};
}

test('a round that ends on a withheld screen says so: report flag, outcome line, recorded evidence',async()=>{
 const r=await run(NOT_DONE);try{
  expect(r.outcome.type).toBe('paused');
  expect(r.outcome.computerReport.screenWithheld).toBe(true);
  expect(computerOutcomeText(r.outcome.computerReport)).toMatch(/^Not done: .+\. The screen was hidden because a protected app such as GetPod was in front\.$/);
  const recorded=await r.adapter.computerEvidence(r.task,'recorded');
  expect(recorded.snapshot?.state).toMatchObject({application:'unapproved',frontmostProtected:true,reason:REASON});
  expect((recorded as any).screenWithheld).toContain('not a missing approval');
 }finally{await r.close();}
});

test('a failed round on a withheld screen tells the agent it is not a missing approval',async()=>{
 const r=await run({status:'blocked',reason:'NO_SUPPORTED_ACTION',steps:0,evaluations:1,trace:{events:[]}});try{
  expect(r.outcome.type).toBe('failed');
  expect(r.outcome.failure.message).toContain('This is not a missing approval or permission for the target app.');
 }finally{await r.close();}
});

test('a round that switched away from the withheld screen carries no withheld flag',async()=>{
 const r=await run(NOT_DONE,{...WITHHELD,application:'com.google.Chrome',frontmostProtected:undefined,reason:undefined});try{
  expect(r.outcome.computerReport.screenWithheld).toBeUndefined();
  expect(computerOutcomeText(r.outcome.computerReport)).not.toContain('protected app');
 }finally{await r.close();}
});

test('fresh screenshot evidence of a withheld screen returns the observation and the note instead of failing',async()=>{
 const tool=jest.fn(async({name}:{name:string})=>({content:[{type:'text',text:name==='computer_acquire'?'{"lease_token":"l"}':name==='computer_observe'?JSON.stringify(WITHHELD):name==='computer_screenshot'?'{"error":"SCREENSHOT_UNSUPPORTED"}':'{"state":"approved"}'}],...(name==='computer_screenshot'?{isError:true}:{})}));
 const r=await run(NOT_DONE,WITHHELD,tool as any);try{
  const fresh=await r.adapter.computerEvidence(r.task,'screenshot');
  expect(fresh).toMatchObject({recordedOnly:false,snapshot:{state:{frontmostProtected:true}}});
  expect((fresh as any).screenWithheld).toContain('Open or switch to the app');
  expect(fresh).not.toHaveProperty('screenshot');
  expect(tool.mock.calls.some(([c]:any)=>c.name==='computer_screenshot')).toBe(false);
 }finally{await r.close();}
});

test('step-run text keeps its Details line last when the hint is added',()=>{
 const text=computerOutcomeText({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,screenWithheld:true,stepRun:{total:2,completed:1,stoppedAt:2,stoppedStep:'play',stopReason:'STEP_NO_EFFECT',remaining:['play']}} as any);
 expect(text).toContain('The screen was hidden because a protected app such as GetPod was in front.\nDetails: STEP_NO_EFFECT');
 // A finished step run or a reached goal adds nothing.
 expect(computerOutcomeText({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:2,screenWithheld:true,stepRun:{total:2,completed:2,stopReason:'ALL_STEPS_DONE',remaining:[]}} as any)).not.toContain('protected app');
 expect(computerOutcomeText({status:'succeeded',reason:'GOAL_REACHED',steps:2,screenWithheld:true,trace:[]} as any)).toMatch(/^Done/);
});

// r11 R2: the last approved application a round saw is the task's target; a withheld screen ("unapproved") keeps it, and the
// next round reopens it first (computer-use.ts reactivate) and names it to the model and the agent.
test('the last target app survives a withheld round and is reopened by the next one',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-target-app-'));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool:jest.fn(async()=>({content:[{type:'text',text:'{"state":"approved"}'}]}))} as any));
 const connectors={get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}}),discover:async()=>[]};
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const TV={id:'com.tradingview.tradingviewapp.desktop',name:'TradingView'};
 const chart=ComputerObservation.parse({generation:'g1',application:TV.id,windowTitle:'BTCUSDT / Unnamed',controls:[],truncated:false,apps:[TV]});
 const hidden=ComputerObservation.parse({...WITHHELD,apps:[TV]});
 const round=async(revision:number,request:string,state:any)=>{
  let input:any;runComputerUse.mockReset();runComputerUse.mockImplementation(async(i:any,deps:any)=>{input=i;deps.observation(state);return {...NOT_DONE,steps:0};});
  const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target',name:'Mac'},gatewayDispatch:{requestId:request}} as any;
  await adapter.submit(task,request,'open the BOME chart');
  let outcome:any;for(let i=0;i<50;i++){outcome=await adapter.inspect(task,request);if(typeof outcome==='object')break;await new Promise(r=>setImmediate(r));}
  return {input,outcome};
 };
 try{
  const first=await round(1,'r1',chart);
  expect(first.input.reactivate).toBeUndefined();
  const second=await round(2,'r2',hidden);
  expect(second.input.reactivate).toEqual(TV);
  expect(second.input.interactionContext).toContain('"lastTargetApp":{"id":"com.tradingview.tradingviewapp.desktop","name":"TradingView"}');
  // The withheld round did not replace it: the third round still reopens TradingView, and the card says so.
  const third=await round(3,'r3',hidden);
  expect(third.input.reactivate).toEqual(TV);
  expect(computerOutcomeText(third.outcome.computerReport)).toContain('The next command switches back to TradingView first.');
  expect(computerOutcomeText(third.outcome.computerReport)).not.toMatch(/[A-Z_]{10,}/);
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});}
});

// r11 F2: once the device session ended (a reached goal released it), a fresh read cannot observe any more: the agent gets
// the round's last recorded screen marked sessionEnded, not one opaque error. Pod-jinawong r10, task f40127bd.
test('evidence after the session ended is the recorded last screen, marked sessionEnded; a device refusal keeps its code',async()=>{
 const r=await run(NOT_DONE);try{
  const ended={...r.task,state:'completed',automationSession:{status:'closed',idleTimeoutMs:1_800_000,closedReason:'agent'}};
  const fresh=await r.adapter.computerEvidence(ended,'fresh') as any;
  expect(fresh).toMatchObject({recordedOnly:true,sessionEnded:true});expect(fresh.snapshot.state).toMatchObject({frontmostProtected:true});
  expect(fresh.instruction).toContain('session of this task has ended');
  // Still open on the gateway, but the device says the session is over: the same recorded answer, with its code.
  jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool:jest.fn(async()=>({isError:true,content:[{type:'text',text:'{"error":"CONSENT_REQUIRED"}'}]}))} as any));
  const refused=await r.adapter.computerEvidence(r.task,'fresh') as any;
  expect(refused).toMatchObject({recordedOnly:true,sessionEnded:true,error:'CONSENT_REQUIRED'});
  jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool:jest.fn(async()=>({isError:true,content:[{type:'text',text:'{"error":"DEVICE_OFFLINE"}'}]}))} as any));
  await expect(r.adapter.computerEvidence(r.task,'fresh')).rejects.toThrow('DEVICE_OFFLINE');
 }finally{await r.close();}
});
