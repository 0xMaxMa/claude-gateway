import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter,COMPUTER_GOAL_MAX_STEPS} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
import {computerOutcomeText} from '../../../src/automation/computer-outcome';
jest.mock('../../../src/jev/computer-connector',()=>({withComputerConnection:jest.fn()}));
jest.mock('../../../src/automation/computer-use',()=>({...jest.requireActual('../../../src/automation/computer-use'),runComputerUse:jest.fn(),confirmationReply:jest.fn()}));
jest.mock('../../../src/automation/vision-decider',()=>({...jest.requireActual('../../../src/automation/vision-decider'),runVisionComputerUse:jest.fn()}));
const {runComputerUse}=require('../../../src/automation/computer-use');
const {runVisionComputerUse}=require('../../../src/automation/vision-decider');

// Pod-jinawong r8, task b0ba459d: "play bodyslam on Spotify" opened Spotify, whose own window shows only window buttons
// and menus over Accessibility, and stopped at NO_SUPPORTED_ACTION (the model's BLOCKED). With visionFallback on, the
// rest of the goal continues from the screenshot with raw input.
const ev=(sequence:number,phase:string,extra:Record<string,unknown>={})=>({sequence,round:1,at:sequence,revision:1,steps:1,evaluations:2,phase,...extra});
const STUCK={status:'needs_input',reason:'COMMAND_WAITING_INPUT',revision:1,steps:1,evaluations:2,lastAction:{kind:'open',appId:'com.spotify.client'},
 trace:{events:[ev(1,'acted',{action:'open',appId:'com.spotify.client',outcome:'completed',steps:1}),ev(2,'decided',{confidence:0.9}),ev(3,'waiting',{reason:'NO_SUPPORTED_ACTION'}),ev(4,'terminal',{status:'needs_input',reason:'COMMAND_WAITING_INPUT'})],truncated:false}};
const REACHED={status:'succeeded',reason:'GOAL_REACHED',revision:1,steps:3,evaluations:6,trace:{events:[ev(1,'acted',{action:'type',steps:3})],truncated:false},lastAction:{kind:'press',label:'Play'}};

function fixture(vision?:(use?:string)=>any,revision=1){
 const root=mkdtempSync(join(tmpdir(),'computer-vision-fallback-'));runComputerUse.mockReset();runVisionComputerUse.mockReset();
 const callTool=jest.fn(async({name}:{name:string})=>({content:[{type:'text',text:JSON.stringify(name==='computer_end_session'?{state:'stopped'}:{state:'approved'})}]}));
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{device_id:'d',grant_id:'g'}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate:jest.fn(),needsInput:()=>true,...(vision?{vision}:{})});
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 const run=async(goal:string)=>{await adapter.submit(task,'r1',goal);for(let i=0;i<50;i++){const outcome=await adapter.inspect(task,'r1');if(typeof outcome==='object')return outcome as any;await new Promise(r=>setImmediate(r));}throw Error('not settled');};
 return {run,close:async()=>{await adapter.close();rmSync(root,{recursive:true,force:true});}};
}
/** The Accessibility round as it ran: its progress reaches the round's receipt, as on the pod. */
const SPOTIFY={generation:'g1',application:'com.spotify.client',windowTitle:'Spotify Free',apps:[],truncated:true,controls:[{ref:'m17',role:'AXMenuItem',label:'Menu: Edit → Search',actions:['press']}]};
const stuckOn=(state:Record<string,unknown>,result:any=STUCK)=>async(_input:unknown,deps:any)=>{deps.observation?.(state);for(const e of result.trace.events)deps.progress?.(e);return result;};
const stuck=stuckOn(SPOTIFY);
const fallbackOnly=(use?:string)=>use==='fallback'?{mode:'vision',decide:()=>jest.fn()}:undefined;

test('no control over Accessibility: the rest of the goal runs from the screenshot, impact-gated, literal text, in budget',async()=>{
 const f=fixture(fallbackOnly);try{
  runComputerUse.mockImplementationOnce(stuck);
  runVisionComputerUse.mockImplementationOnce(async(input:any)=>{
   expect(input).toMatchObject({goal:'play bodyslam on Spotify',maxSteps:COMPUTER_GOAL_MAX_STEPS-1,impact:true,yieldAfterAction:false,literalText:true,approvedOnly:true});
   expect(input.interactionContext).toContain('Accessibility already took 1 action');
   expect(input.interactionContext).toContain('opened com.spotify.client');
   return REACHED;
  });
  const outcome=await f.run('play bodyslam on Spotify');
  expect(runVisionComputerUse).toHaveBeenCalledTimes(1);
  expect(outcome.type).toBe('completed');
  expect(outcome.computerReport).toMatchObject({status:'succeeded',reason:'GOAL_REACHED',steps:4,evaluations:8});
 }finally{await f.close();}
});

test('raw input off: the round stops as before, saying to turn on mouse and keyboard control',async()=>{
 const f=fixture(fallbackOnly);try{
  runComputerUse.mockImplementationOnce(stuck);
  runVisionComputerUse.mockImplementationOnce(async()=>({fallback:'RAW_INPUT_DISABLED',trace:[]}));
  const outcome=await f.run('play bodyslam on Spotify');
  expect(outcome.type).toBe('paused');
  const text=computerOutcomeText(outcome.computerReport);
  expect(text).toMatch(/^Not finished: 1 action done, then this app shows no controls Computer Use can read/);
  expect(text).toContain('Turn on "Allow mouse and keyboard control"');
 }finally{await f.close();}
});

test('on Windows, whose helper has no raw input, there is nothing to turn on',async()=>{
 const f=fixture(fallbackOnly);try{
  runComputerUse.mockImplementationOnce(stuckOn({...SPOTIFY,application:'spotify.exe',platform:{os:'windows',osVersion:'10.0.26200'}}));
  runVisionComputerUse.mockImplementationOnce(async()=>({fallback:'RAW_CAPABILITIES_MISSING',trace:[]}));
  const text=computerOutcomeText((await f.run('play bodyslam on Spotify')).computerReport);
  expect(text).toContain('not available on this computer yet');expect(text).not.toContain('Turn on');
 }finally{await f.close();}
});

test('an older helper without raw-input capabilities reads the same; a capture failure names the capture',async()=>{
 for(const [fallback,expected] of [['RAW_CAPABILITIES_MISSING','Allow mouse and keyboard control'],['SCREEN_RECORDING_PERMISSION_REQUIRED','could not be captured']]){
  const f=fixture(fallbackOnly);try{
   runComputerUse.mockImplementationOnce(stuck);
   runVisionComputerUse.mockImplementationOnce(async()=>({fallback,trace:[]}));
   expect(computerOutcomeText((await f.run('play bodyslam on Spotify')).computerReport)).toContain(expected);
  }finally{await f.close();}
 }
});

test('no fallback without visionFallback, for a user one-shot command, or for another stop',async()=>{
 const stop=(reason:string)=>({...STUCK,trace:{events:[ev(1,'waiting',{reason})],truncated:false}});
 for(const [vision,revision,run] of [[undefined,1,stuck],[()=>undefined,1,stuck],[fallbackOnly,2,stuck],
  [fallbackOnly,1,stuckOn(SPOTIFY,stop('LOW_CONFIDENCE'))],
  // The impact gate asked the user; the round waits for that yes or no.
  [fallbackOnly,1,stuckOn(SPOTIFY,stop('CONFIRMATION_REQUIRED'))],
  // BLOCKED on a withheld screen (GetPod in front) or an unapproved front application is no missing control.
  [fallbackOnly,1,stuckOn({...SPOTIFY,application:'unapproved',controls:[],frontmostProtected:true})],
  [fallbackOnly,1,stuckOn({...SPOTIFY,application:'unapproved',controls:[]})],
  // Consent refused: the round fails on its own reason.
  [fallbackOnly,1,async()=>{throw Error('COMPUTER_ACCESS_DENIED');}]] as const){
  const f=fixture(vision as any,revision);try{
   runComputerUse.mockImplementationOnce(run);
   await f.run('play bodyslam on Spotify');
   expect(runVisionComputerUse).not.toHaveBeenCalled();
  }finally{await f.close();}
 }
});
