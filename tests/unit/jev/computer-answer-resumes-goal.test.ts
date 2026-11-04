import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
import {ComputerObservation} from '../../../src/automation/computer-use';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({...jest.requireActual('../../../src/automation/computer-use'),runComputerUse:jest.fn()}));
const {runComputerUse}=require('../../../src/automation/computer-use');

// Pod-jinawong r8, task 16542265: the agent's hand-off (rev 2, a goal run) stopped as FIELD_TEXT_REQUIRED
// on the web player's search box. The user's answer "bodyslam" became rev 3, which ran as a one-shot
// command: it typed the text and stopped, never pressing the Enter the goal asked for.
const SEARCH='What do you want to play?';
const PLAYER={generation:'g1',application:'com.google.Chrome',windowTitle:'Spotify - Web Player',apps:[],truncated:false,
 controls:[{ref:'c0',identity:'33333333-3333-4333-8333-333333333333',role:'AXComboBox',label:SEARCH,value:'',focused:true,actions:['press','type']}]};
const ASKED={status:'needs_input',reason:'FIELD_TEXT_REQUIRED',steps:0,evaluations:1,trace:{events:[]},fieldRequest:{label:SEARCH,application:'com.google.Chrome',role:'AXComboBox',reason:'missing'}};
const TYPED={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,trace:{events:[]}};
const ANSWER={questionId:'q',text:'bodyslam',inputId:'i',computerFieldLabel:SEARCH,computerApplication:'com.google.Chrome',computerFieldRole:'AXComboBox'};
const COMMAND=`type bodyslam in the "${SEARCH}" field and press enter`;

function harness(){
 const root=mkdtempSync(join(tmpdir(),'computer-answer-goal-'));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool:jest.fn(async()=>({content:[{type:'text',text:'{"state":"approved"}'}]}))} as any));
 const connectors={get:()=>({connectorId:'c',scope:{}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}}),discover:async()=>[]};
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true});
 const base={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target',name:'Mac'}};
 /** One round of revision `revision`: its run observes the player and returns `result`; resolves to its input. */
 const round=async(revision:number,request:string,result:object,executionControl:object|undefined,answers:any[]=[])=>{
  let input:any;
  runComputerUse.mockReset();runComputerUse.mockImplementation(async(i:any,deps:any)=>{input=i;deps.observation(ComputerObservation.parse(PLAYER));return result;});
  const task={...base,revision,gatewayDispatch:{requestId:request},...(executionControl?{executionControl}:{})} as any;
  await adapter.submit(task,request,COMMAND,answers);
  for(let i=0;i<50;i++){if(typeof await adapter.inspect(task,request)==='object')break;await new Promise(r=>setImmediate(r));}
  return input;
 };
 return {round,close:async()=>{await adapter.close();rmSync(root,{recursive:true,force:true});}};
}

test('the answer to a goal run field question resumes that goal',async()=>{
 const h=harness();try{
  const asked=await h.round(2,'r2',ASKED,{revision:2,agentHandoff:true});
  expect(asked).toMatchObject({runToGoal:true,agentCommand:true});
  // The answer revision keeps the hand-off's executionControl (revision 2), as recorded on the pod.
  const answered=await h.round(3,'r3',TYPED,{revision:2,agentHandoff:true},[ANSWER]);
  expect(answered).toMatchObject({runToGoal:true,readRequest:false});expect(answered.maxSteps).toBeUndefined();
  expect(answered.agentCommand).toBeUndefined();
  expect(answered.goal).toContain('press enter');
 }finally{await h.close();}
});

test('an answer after a one-shot direct command stays one command (no behavior change)',async()=>{
 const h=harness();try{
  await h.round(2,'r2',ASKED,undefined);
  const answered=await h.round(3,'r3',TYPED,undefined,[ANSWER]);
  expect(answered.runToGoal).toBeUndefined();
  expect(answered.readRequest).toBe(true);
 }finally{await h.close();}
});

test('a next command without an answer after a goal run is the user own command, not a resumed goal',async()=>{
 const h=harness();try{
  await h.round(2,'r2',ASKED,{revision:2,agentHandoff:true});
  const next=await h.round(3,'r3',TYPED,{revision:2,agentHandoff:true});
  expect(next.runToGoal).toBeUndefined();
 }finally{await h.close();}
});
