import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter,COMPUTER_GOAL_MAX_STEPS} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({runComputerUse:jest.fn()}));
const {runComputerUse}=require('../../../src/automation/computer-use');

// Pod 2.0.16: a reached agent goal paused the task and never ended the relay
// session, so the Mac kept showing "Being controlled" after YouTube opened.
function fixture(endSession:'stopped'|'error'='stopped'){
 const root=mkdtempSync(join(tmpdir(),'computer-goal-adapter-'));runComputerUse.mockReset();
 const callTool=jest.fn(async({name}:{name:string})=>name==='computer_end_session'?(endSession==='stopped'?{content:[{type:'text',text:'{"state":"stopped"}'}]}:{isError:true,content:[{type:'text',text:'{"error":"COMPUTER_CLOSED"}'}]}):{content:[{type:'text',text:'{"state":"approved"}'}]});
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{device_id:'d',grant_id:'g'}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 const run=async(t:any,request:string,goal:string)=>{await adapter.submit(t,request,goal);for(let i=0;i<50;i++){const outcome=await adapter.inspect(t,request);if(typeof outcome==='object')return outcome as any;await new Promise(r=>setImmediate(r));}throw Error('not settled');};
 const ended=()=>callTool.mock.calls.filter(([c]:any)=>c.name==='computer_end_session');
 return {adapter,task,run,ended,close:async()=>{await adapter.close();rmSync(root,{recursive:true,force:true});}};
}
const observe=(deps:any)=>deps.observation({generation:'g',application:'com.google.Chrome',controls:[],apps:[],truncated:false});

test('a reached goal completes and ends the device session',async()=>{
 const f=fixture();try{
  runComputerUse.mockImplementationOnce(async()=>({status:'succeeded',reason:'GOAL_REACHED',steps:3,evaluations:0,lastAction:{kind:'key',key:'enter'}}));
  const outcome=await f.run(f.task,'r1','open YouTube in Chrome');
  expect(runComputerUse.mock.calls[0][0]).toMatchObject({sessionStart:true,runToGoal:true,maxSteps:COMPUTER_GOAL_MAX_STEPS});
  expect(outcome.type).toBe('completed');
  expect(outcome.computerReport).toMatchObject({status:'succeeded',reason:'GOAL_REACHED',accessReleased:true});
  expect(outcome.result.summary).toContain('Done: 3 actions, last pressed the enter key.');
  expect(outcome.result.summary).toContain('not independently verified');
  expect(outcome.result.summary).toContain('Computer access was released.');
  expect(f.ended()).toEqual([[{name:'computer_end_session',arguments:{device_id:'d',grant_id:'g'}},undefined,expect.anything()]]);
 }finally{await f.close();}
});

test('a reached goal still completes when the relay does not confirm the end of the session',async()=>{
 const f=fixture('error');try{
  runComputerUse.mockImplementationOnce(async()=>({status:'succeeded',reason:'GOAL_REACHED',steps:2,evaluations:2}));
  const outcome=await f.run(f.task,'r1','open Notes');
  expect(outcome.type).toBe('completed');expect(outcome.computerReport.accessReleased).toBeUndefined();
  expect(outcome.result.summary).toContain('could not be released');
 }finally{await f.close();}
});

test('a goal out of steps fails with a clear code and keeps the session',async()=>{
 const f=fixture();try{
  runComputerUse.mockImplementationOnce(async()=>({status:'blocked',reason:'STEP_LIMIT',steps:8,evaluations:8}));
  const outcome=await f.run(f.task,'r1','make notes');
  expect(outcome.type).toBe('failed');expect(outcome.failure.code).toBe('COMPUTER_STEP_LIMIT');
  expect(outcome.failure.message).toContain(`stopped after 8 desktop actions, the limit for one goal (${COMPUTER_GOAL_MAX_STEPS})`);
  // Owner-facing sentences first, then a separate agent-only instruction.
  const [owner,agent]=outcome.failure.message.split(' Agent: ');
  expect(owner).toMatch(/^Computer goal not finished: stopped after 8 desktop actions/);
  expect(owner).toContain('the Mac is still under control');
  expect(owner).toContain('send the next command');
  expect(owner).not.toContain('task_status');expect(owner).not.toContain('task_update');
  expect(agent).toContain('task_status computer_evidence=recorded');expect(agent).toContain('task_update');
  // The device session stays open: end_session is never called for a step-limit stop.
  expect(f.ended()).toHaveLength(0);
 }finally{await f.close();}
});

test.each(['CONFIRMATION_REQUIRED','LOW_CONFIDENCE','COMPLETION_UNCERTAIN','SESSION_READY'])('a %s stop still waits for the user and keeps the session',async(reason)=>{
 const f=fixture();try{
  runComputerUse.mockImplementationOnce(async()=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,trace:{events:[{phase:'waiting',reason}],truncated:false}}));
  const outcome=await f.run(f.task,'r1','clean up my notes');
  expect(outcome.type).toBe('paused');expect(f.ended()).toHaveLength(0);
 }finally{await f.close();}
});

test('a yes to the goal\'s high-impact step resumes the goal, and the context keeps the goal as the command',async()=>{
 const f=fixture();try{
  runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{observe(deps);return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:2,lastAction:{kind:'press',label:'Delete',blocked:true,confirm:true,target:'a'.repeat(32)}};});
  await f.run(f.task,'r1','clean up my notes');
  runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{deps.confirmed('YES');observe(deps);await deps.beforeMutation('op-1',{});return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:2,lastAction:{kind:'press',label:'Share',blocked:true,confirm:true}};});
  const reply={...f.task,revision:2,executionControl:{revision:2}};
  await f.run(reply,'r2','ใช่');
  expect(runComputerUse.mock.calls[1][0]).toMatchObject({goal:'ใช่',confirmation:{command:'clean up my notes',label:'Delete',target:'a'.repeat(32)},resumeGoal:COMPUTER_GOAL_MAX_STEPS});
  // A second question in the resumed goal is about the goal, not about the reply "ใช่".
  runComputerUse.mockImplementationOnce(async()=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1}));
  const again={...f.task,revision:3,executionControl:{revision:3}};
  await f.run(again,'r3','yes');
  expect(runComputerUse.mock.calls[2][0]).toMatchObject({confirmation:{command:'clean up my notes',label:'Share'},resumeGoal:COMPUTER_GOAL_MAX_STEPS});
 }finally{await f.close();}
});

test('a yes to the agent\'s single hand-off command does not become a goal',async()=>{
 const f=fixture();try{
  runComputerUse.mockImplementationOnce(async()=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1}));
  await f.run(f.task,'r1','open a session');
  runComputerUse.mockImplementationOnce(async(_input:any,deps:any)=>{observe(deps);return {status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,lastAction:{kind:'press',label:'Quit Google Chrome',blocked:true,confirm:true}};});
  const handoff={...f.task,revision:2,executionControl:{revision:2,agentHandoff:true}};
  await f.run(handoff,'r2','quit chrome');
  runComputerUse.mockImplementationOnce(async()=>({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:2}));
  const reply={...f.task,revision:3,executionControl:{revision:3}};
  await f.run(reply,'r3','ใช่');
  expect(runComputerUse.mock.calls[2][0].confirmation).toEqual({command:'quit chrome',label:'Quit Google Chrome'});
  expect(runComputerUse.mock.calls[2][0].resumeGoal).toBeUndefined();
 }finally{await f.close();}
});
