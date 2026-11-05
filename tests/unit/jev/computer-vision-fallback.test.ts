import {mkdtempSync,rmSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {ComputerTaskAdapter} from '../../../src/orchestration/gateway-tasks/computer';
import {withComputerConnection} from '../../../src/jev/computer-connector';
import {computerOutcomeText,computerProgressText} from '../../../src/automation/computer-outcome';
import {visionRequestProblems} from '../../helpers/vision-request-shape';
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
   expect(input).toMatchObject({goal:'play bodyslam on Spotify',impact:true,yieldAfterAction:false,literalText:true,approvedOnly:true});expect(input.maxSteps).toBeUndefined();
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
test('a transient capture error does not claim Screen Recording permission is missing',async()=>{
 const f=fixture(fallbackOnly);try{
  runComputerUse.mockImplementationOnce(stuck);
  runVisionComputerUse.mockImplementationOnce(async()=>({fallback:'SCREENSHOT_CAPTURE_FAILED',trace:[]}));
  const text=computerOutcomeText((await f.run('play bodyslam on Spotify')).computerReport);
  expect(text).toContain('could not be captured');
  expect(text).not.toContain('Check the Screen Recording permission');
 }finally{await f.close();}
});
test('an explicit Screen Recording permission error keeps its permission guidance',async()=>{
 const f=fixture(fallbackOnly);try{
  runComputerUse.mockImplementationOnce(stuck);
  runVisionComputerUse.mockImplementationOnce(async()=>({fallback:'SCREEN_RECORDING_PERMISSION_REQUIRED',trace:[]}));
  expect(computerOutcomeText((await f.run('play bodyslam on Spotify')).computerReport)).toContain('Check the Screen Recording permission');
 }finally{await f.close();}
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

// Pod-jinawong task 56f64e16 rev 8: Spotify web's row Play only shows under the pointer. GetPod Desktop 0.1.1 answers
// TARGET_NOT_REACHED when it cannot reach such a button even after hovering; the goal round goes on from the screenshot.
// TARGET_OCCLUDED (another window covers the point) stops as before.
const CHROME_PAGE={generation:'g1',application:'chrome.exe',windowTitle:'Search for sillyfools | Spotify - Google Chrome',apps:[],truncated:true,controls:[{ref:'c5',role:'AXButton',label:'Play',actions:['press']}]};
const refusedClick=(code:string)=>({...STUCK,steps:0,lastAction:undefined,trace:{events:[ev(1,'acted',{action:'press',outcome:'not_executed',reason:code,nativePhase:'pointer_hit_ancestor',steps:0}),ev(2,'waiting',{reason:code,steps:0}),ev(3,'terminal',{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0})],truncated:false}});
test('a button the helper could not reach under the pointer: the goal goes on from the screenshot',async()=>{
 const f=fixture(fallbackOnly);try{
  runComputerUse.mockImplementationOnce(stuckOn(CHROME_PAGE,refusedClick('TARGET_NOT_REACHED')));
  runVisionComputerUse.mockImplementationOnce(async(input:any)=>{
   expect(input).toMatchObject({impact:true,yieldAfterAction:false,literalText:true,approvedOnly:true});
   expect(input.interactionContext).toContain('Accessibility already took 0 actions toward this goal in this round and then could not reach a button that only appears while the pointer is over it (nothing was clicked).');
   return REACHED;
  });
  const outcome=await f.run('click Play on the song in Chrome');
  expect(runVisionComputerUse).toHaveBeenCalledTimes(1);expect(outcome.type).toBe('completed');
 }finally{await f.close();}
});
test('a click another window covered is no reason to click from the screenshot: no fallback',async()=>{
 const f=fixture(fallbackOnly);try{
  runComputerUse.mockImplementationOnce(stuckOn(CHROME_PAGE,refusedClick('TARGET_OCCLUDED')));
  const outcome=await f.run('click Play on the song in Chrome');
  expect(runVisionComputerUse).not.toHaveBeenCalled();expect(outcome.type).toBe('paused');
 }finally{await f.close();}
});

/** A Jev choice: `choice` at `confidence`, the rest spread evenly. */
const choose=(criteria:Record<string,string>,choice:string,confidence:number)=>{const keys=Object.keys(criteria);const rest=(1-confidence)/(keys.length-1);return {choice,confidence,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?confidence:rest]))};};
const RAW_CAPS={pointer:['click','double_click','right_click','move','drag'],pointerModifiers:['alt','cmd','ctrl','shift'],scrollAt:true,keyChord:true,typeFocused:true,screenshotGeometry:true};

// Pod-jinawong r9, task 6cdca7c6: "play bodyslam on Spotify in Chrome". Accessibility opened Chrome, then the Spotify desktop
// app, then chose BLOCKED (its CEF window: 3 window buttons and 80 menu items, no text, no focus). The vision fallback clicked
// the search box; the helper refused the typing with FOCUS_REQUIRED; the next vision request put the screenshot inside the
// is_error tool_result and the provider answered 400 (JEV_INVALID_REQUEST). The card read "terminal · 1 actions" and the
// action log "Done". Both real loops run here against a scripted Mac, Jev and vision model.
test('6cdca7c6 replay: the refusal is answered in a valid request, counts continue, and the stop is never Done',async()=>{
 const root=mkdtempSync(join(tmpdir(),'computer-vision-replay-'));
 const actual=jest.requireActual('../../../src/automation/computer-use'),actualVision=jest.requireActual('../../../src/automation/vision-decider');
 runComputerUse.mockReset();runVisionComputerUse.mockReset();
 runComputerUse.mockImplementation(actual.runComputerUse);runVisionComputerUse.mockImplementation(actualVision.runVisionComputerUse);
 const apps=[{id:'com.google.Chrome',name:'Google Chrome'},{id:'com.spotify.client',name:'Spotify'}];
 const windowButtons=['close','minimize','zoom'].map((label,i)=>({ref:'w'+i,role:'AXButton',label,actions:['press'],bounds:{x:0.01+i*0.02,y:0.01,width:0.015,height:0.02}}));
 const menuItems=Array.from({length:80},(_,i)=>({ref:'m'+i,role:'AXMenuItem',label:'Menu item '+i,actions:['press']}));
 let front='com.apple.finder',generation=0;
 const window:Record<string,Record<string,unknown>>={
  'com.apple.finder':{windowTitle:'Downloads',controls:[]},
  'com.google.Chrome':{windowTitle:'New Tab',controls:[{ref:'c1',role:'AXTextField',label:'Address and search bar',actions:['type'],bounds:{x:0.1,y:0.05,width:0.8,height:0.04}}]},
  'com.spotify.client':{windowTitle:'Spotify Free',controls:[...windowButtons,...menuItems],text:[]},
 };
 const observe=()=>({generation:'g'+(++generation),application:front,apps,truncated:false,screenshotAvailable:true,capabilities:RAW_CAPS,...window[front]});
 const actions:any[]=[];
 const reply=(body:unknown)=>({content:[{type:'text',text:JSON.stringify(body)}]});
 const callTool=jest.fn(async({name,arguments:args}:{name:string;arguments:any})=>{
  if(name==='computer_acquire')return reply({lease_token:'lease'});
  if(name==='computer_observe')return reply(observe());
  if(name==='computer_screenshot')return reply({generation:args.generation,mimeType:'image/jpeg',data:'/9j/'+args.generation,capturedAt:1,width:1280,height:800});
  if(name==='computer_action'){
   actions.push(args);
   if(args.kind==='open'){front=args.app_id;return reply({state:'completed',operation_id:args.operation_id});}
   if(args.kind==='type_focused')return reply({state:'not_executed',error:'FOCUS_REQUIRED',operation_id:args.operation_id});
   return reply({state:'completed',operation_id:args.operation_id});
  }
  return reply(name==='computer_end_session'?{state:'stopped'}:{state:'approved'});
 });
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{device_id:'d',grant_id:'g'}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 // Jev's Accessibility decisions as recorded: open Chrome 0.95, open Spotify 0.95, BLOCKED 0.75. Every action is routine.
 const ax=[{action:'open',target:'open:com.google.Chrome',confidence:0.95},{action:'open',target:'open:com.spotify.client',confidence:0.95},{action:'BLOCKED',confidence:0.75}];
 const axRequests:any[]=[];
 const evaluate=jest.fn(async(_t:any,request:any)=>{
  const answers:Record<string,unknown>={};
  const step=request.questions.action?ax[axRequests.push(request)-1]:undefined;
  for(const [id,q] of Object.entries<any>(request.questions)){
   const keys=Object.keys(q.criteria);
   if(id==='action')answers[id]=choose(q.criteria,step!.action,step!.confidence);
   else if(id==='impact')answers[id]=choose(q.criteria,'ROUTINE',0.9);
   else if(id.startsWith('target_'))answers[id]=choose(q.criteria,step?.target&&keys.includes(step.target)?step.target:'BLOCKED',step?.confidence??0.9);
   else answers[id]=choose(q.criteria,keys[0],0.9);
  }
  return {answers};
 });
 // The vision model: click the search box, type the song, then give up after the refusal.
 const script=[{name:'left_click',input:{coordinate:[400,30]}},{name:'type',input:{text:'bodyslam'}},{name:'finish',input:{outcome:'blocked',blocker:'OTHER'}}];
 const requests:unknown[][]=[];
 const decide=jest.fn(async(messages:unknown[])=>{
  requests.push(structuredClone(messages));
  const n=requests.length,step=script[n-1];
  return {content:[{type:'tool_use',id:'v'+n,name:step.name,input:step.input,...(step.name==='finish'?{}:{toolset_name:'computer'})}],stopReason:'tool_use'};
 });
 const reports:any[]=[];
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate,needsInput:()=>true,
  progress:(_t:any,report:any)=>reports.push(structuredClone(report)),vision:(use?:string)=>use==='fallback'?{mode:'vision',decide:()=>decide}:undefined} as any);
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{
  await adapter.submit(task,'r1','play bodyslam on Spotify in Chrome');
  let outcome:any;
  for(let i=0;i<500&&typeof outcome!=='object';i++){outcome=await adapter.inspect(task,'r1');if(typeof outcome!=='object')await new Promise(r=>setTimeout(r,2));}
  expect(typeof outcome).toBe('object');
  // F5: the goal's instructions keep the work in the application it names (prompt-level, no word lists).
  expect(JSON.stringify(axRequests[0].questions.action.instructions)).toContain('stay in that application');
  expect(axRequests).toHaveLength(3);
  expect(actions.map(a=>a.kind==='open'?'open:'+a.app_id:a.kind)).toEqual(['open:com.google.Chrome','open:com.spotify.client','pointer','type_focused']);
  // F1: three vision requests went out, each one a request the provider accepts.
  expect(requests).toHaveLength(3);
  for(const request of requests)expect(visionRequestProblems(request)).toEqual([]);
  const answer=(requests[2].at(-1) as any).content;
  expect(answer[0]).toMatchObject({type:'tool_result',tool_use_id:'v2',is_error:true,content:[{type:'text',text:expect.stringContaining('FOCUS_REQUIRED')}]});
  expect(answer.slice(1).map((b:any)=>b.type)).toEqual(['text','image']);
  // F3/F3b: the fallback counts on from the 2 Accessibility actions; the card never shows a raw phase or "1 actions".
  const after=reports.slice(reports.findIndex(r=>r.steps>=2));
  expect(after.every(r=>r.steps>=2)).toBe(true);
  expect(Math.max(...reports.map(r=>r.steps))).toBe(3);
  const texts=reports.map(r=>computerProgressText(r));
  for(const text of texts){expect(text).not.toContain('terminal');expect(text).not.toContain('1 actions');expect(text).not.toContain('evaluations');}
  expect(texts).toContain('Computer Use · Acting on the screen · 3 actions so far');
  // F4 and the stop: failed, never Done, in plain words for the card and for the agent.
  expect(outcome.type).toBe('failed');
  expect(outcome.computerReport).toMatchObject({status:'blocked',reason:'VISION_OTHER',steps:3});
  expect(computerOutcomeText(outcome.computerReport)).not.toMatch(/^Done/);
  expect(computerProgressText(outcome.computerReport)).toBe("Stopped after 3 actions. The model found no way to finish on the screen. Before that, the app didn't accept typing: no text field had keyboard focus.");
  expect(outcome.failure.message).toMatch(/^Computer work stopped after 3 desktop actions: The model found no way to finish on the screen\. Tell the user this sentence, not the code\. Code for diagnosis: VISION_OTHER\./);
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});runComputerUse.mockReset();runVisionComputerUse.mockReset();}
});

// Pod-jinawong r10, task 457a4930 rev1 (tests/fixtures/computer/tradingview-457a4930.json): Accessibility opened TradingView,
// pressed the symbol button and typed BOMEUSDT, then found no control (BLOCKED); vision pressed four times and typed again,
// and the round hit the 8-action cap one click short of the chart: "Failed". With no action limit (r11) the same round
// clicks the first result and reaches the goal at 9 actions. Both real loops run against a scripted Mac and models.
// r12: GetPod in front and the command naming TradingView, the round opens TradingView itself before the first decision
// (computer-use.ts namedApp, no step), so the model's recorded first pick (open TradingView) is not asked: 8 actions.
test('457a4930 replay: no action cap, the round reaches the chart at 8 actions after reopening TradingView',async()=>{
 const recorded=require('../../fixtures/computer/tradingview-457a4930.json');
 expect(recorded.rev1.outcome).toBe('STEP_LIMIT');
 expect(recorded.rev1.trace.filter((e:any)=>e.phase==='acted').length).toBe(8);
 const root=mkdtempSync(join(tmpdir(),'computer-tradingview-replay-'));
 const actual=jest.requireActual('../../../src/automation/computer-use'),actualVision=jest.requireActual('../../../src/automation/vision-decider');
 runComputerUse.mockReset();runVisionComputerUse.mockReset();
 runComputerUse.mockImplementation(actual.runComputerUse);runVisionComputerUse.mockImplementation(actualVision.runVisionComputerUse);
 const window=recorded.rev1.finalState,TV='com.tradingview.tradingviewapp.desktop';
 let front='unapproved',generation=0,acted=0;
 const observe=()=>front==='unapproved'?{...recorded.rev3.state,generation:'g'+(++generation)}
  :{...window,generation:'g'+(++generation),screenshotAvailable:true,capabilities:{...window.capabilities,...RAW_CAPS},windowTitle:acted>=9?'BOMEUSDT / Unnamed':window.windowTitle,
   controls:[...window.controls,{ref:'c56',role:'AXButton',label:'Symbol search',actions:['press']}]};
 const actions:any[]=[];
 const reply=(body:unknown)=>({content:[{type:'text',text:JSON.stringify(body)}]});
 const callTool=jest.fn(async({name,arguments:args}:{name:string;arguments:any})=>{
  if(name==='computer_acquire')return reply({lease_token:'lease'});
  if(name==='computer_observe')return reply(observe());
  // Every action changes the window: a different capture each time (no stall).
  if(name==='computer_screenshot')return reply({generation:args.generation,mimeType:'image/jpeg',data:'/9j/'+args.generation,capturedAt:1,width:1280,height:800});
  if(name==='computer_action'){actions.push(args);acted++;if(args.kind==='open')front=args.app_id;return reply({state:'completed',operation_id:args.operation_id});}
  return reply(name==='computer_end_session'?{state:'stopped'}:{state:'approved'});
 });
 jest.mocked(withComputerConnection).mockImplementation(async(_c,fn)=>fn({callTool} as any));
 const connectors={get:()=>({connectorId:'c',scope:{device_id:'d',grant_id:'g'}}),connection:()=>({endpoint:'https://computer.example/mcp',headers:{}})};
 // Accessibility as recorded after its first pick: press the symbol button 0.85, type into the symbol field 0.95, BLOCKED 0.95.
 const ax=[{action:'press',target:'press:c56'},{action:'type',target:'type:c0',text:'BOMEUSDT'},{action:'BLOCKED'}];
 let axAsked=0;
 const evaluate=jest.fn(async(_t:any,request:any)=>{
  const answers:Record<string,unknown>={};const step=request.questions.action?ax[axAsked++]:undefined;
  for(const [id,q] of Object.entries<any>(request.questions)){
   const keys=Object.keys(q.criteria);
   if(id==='action')answers[id]=choose(q.criteria,step!.action,0.95);
   else if(id==='impact')answers[id]=choose(q.criteria,'ROUTINE',0.9);
   else if(id.startsWith('target_'))answers[id]=choose(q.criteria,step?.target&&keys.includes(step.target)?step.target:'BLOCKED',0.95);
   else if(id.startsWith('text'))answers[id]=choose(q.criteria,keys.find(k=>q.criteria[k].includes('BOMEUSDT'))??keys[0],0.95);
   else answers[id]=choose(q.criteria,keys[0],0.9);
  }
  return {answers};
 });
 // Vision as recorded (four presses, BOMEUSDT typed again), then the first result clicked and the chart judged done.
 const script=[...[0,1,2,3].map(i=>({name:'left_click',input:{coordinate:[200+i*40,120]}})),{name:'type',input:{text:'BOMEUSDT'}},{name:'left_click',input:{coordinate:[420,240]}},{name:'finish',input:{outcome:'done'}}];
 let turns=0;
 const decide=jest.fn(async()=>{const step=script[turns++];return {content:[{type:'tool_use',id:'v'+turns,name:step.name,input:step.input,...(step.name==='finish'?{}:{toolset_name:'computer'})}],stopReason:'tool_use'};});
 const adapter=new ComputerTaskAdapter({agentId:'a',root,connectors:connectors as any,allowed:()=>true,member:()=>true,active:()=>true,evaluate,needsInput:()=>true,
  vision:(use?:string)=>use==='fallback'?{mode:'vision',decide:()=>decide}:undefined} as any);
 const task={agentId:'a',taskId:'t',ownerPrincipalId:'p',conversationId:'c',revision:1,automationController:'user',gatewayTarget:{adapter:'computer',sessionId:'target'}} as any;
 try{
  await adapter.submit(task,'r1',recorded.rev1.command);
  let outcome:any;
  for(let i=0;i<500&&typeof outcome!=='object';i++){outcome=await adapter.inspect(task,'r1');if(typeof outcome!=='object')await new Promise(r=>setTimeout(r,2));}
  expect(typeof outcome).toBe('object');
  // The open is the round's own reopen of TradingView (not counted below); the model never asked to open it.
  expect(actions[0]).toMatchObject({kind:'open',app_id:TV});
  expect(actions.map(a=>a.kind==='open'?'open':a.kind)).toEqual(['open','press','type','pointer','pointer','pointer','pointer','type_focused','pointer']);
  expect(outcome.type).toBe('completed');
  expect(outcome.computerReport).toMatchObject({status:'succeeded',reason:'GOAL_REACHED',steps:8});
  expect(computerOutcomeText(outcome.computerReport)).toMatch(/^Done after 8 actions\. Last: clicked/);
 }finally{await adapter.close();rmSync(root,{recursive:true,force:true});runComputerUse.mockReset();runVisionComputerUse.mockReset();}
});
