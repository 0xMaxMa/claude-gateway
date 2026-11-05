import {runComputerUse,type ComputerUseDependencies} from '../../../src/automation/computer-use';
import {computerOutcomeText} from '../../../src/automation/computer-outcome';
import {goalWebAddress} from '../../../src/automation/direct-command';
import steam from '../../fixtures/computer/steam-f40127bd.json';
import tradingview from '../../fixtures/computer/tradingview-457a4930.json';

// Replays of pod-jinawong r10 rounds (gateway b38237c0, app wincu.7) against the Accessibility loop, from the recorded
// round receipts in tests/fixtures/computer (no screenshots). A scripted Mac answers each call from the recorded states.
const TRADINGVIEW='com.tradingview.tradingviewapp.desktop',CHROME='com.google.Chrome';
const choice=(criteria:Record<string,unknown>,chosen:string,confidence:number)=>({choice:chosen,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?confidence:(1-confidence)/(Object.keys(criteria).length-1||1)]))});
type Screen=Record<string,any>;
/** A Mac whose screen is `screen()` after each call; `act` sees every dispatched action and may change it. `plan`: the
 * decision model's picks in order (DONE after the last). */
function mac(start:Screen,act:(action:any,state:{screen:Screen})=>any,plan:Array<{pick:string;confidence?:number}>=[]){
 const state={screen:start};let asked=0,generation=0;const calls:any[]=[],requests:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async(name,args)=>{
   calls.push({name,args});
   if(name==='computer_acquire')return {lease_token:'lease'};
   if(name==='computer_observe'){
    const shown=typeof state.screen==='function'?(state.screen as any)():state.screen;
    // The helper's compact observation for one guarded shortcut (address:focus).
    if(args.standard_command==='address:focus')return {...shown,generation:'g'+(++generation),standardCommand:'address:focus',controls:[{ref:'standard-address-focus',role:'keyboardShortcut',label:'Focus the address bar',actions:['press']}]};
    return {...shown,generation:'g'+(++generation)};
   }
   if(name==='computer_action')return act(args,state)??{state:'completed'};
   if(name==='computer_operation_status')return {operation_id:args.operation_id,state:'unknown',continuation_ready:true};
   return {};
  },
  evaluate:async req=>{
   requests.push(req);const step=plan[asked++]??{pick:'DONE'};const kind=step.pick.includes(':')?step.pick.split(':')[0]:step.pick;
   return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choice(q.criteria as any,name==='action'?kind:name==='target_'+kind?step.pick:name==='impact'?'ROUTINE':'NONE',name==='impact'?0.95:step.confidence??0.95)]))};
  }};
 return {deps,calls,requests,state,actions:()=>calls.filter(c=>c.name==='computer_action').map(({args:{lease_token,operation_id,generation,...rest}})=>rest),
  observes:()=>calls.filter(c=>c.name==='computer_observe').length};
}
const goalRun=(goal:string,extra:Record<string,unknown>={})=>({goal,yieldAfterInteraction:true,readRequest:true,sessionStart:true,runToGoal:true,...extra});
const signal=()=>new AbortController().signal;
// The Chrome window with its address bar focused (after address:focus), holding `value`.
const omnibox=(page:Screen,value='')=>({...page,focusedControl:{ref:'o1',role:'AXTextField',label:'Address and search bar'},
 controls:[{ref:'o1',identity:'11111111-1111-4111-8111-111111111111',role:'AXTextField',label:'Address and search bar',value,focused:true,actions:['press','type']},...page.controls]});

// Pod-jinawong r10, task f40127bd: "open store.steampowered.com in Chrome" ran its fast path (open Chrome, address:focus,
// type, Enter) and declared GOAL_REACHED 1.5 s after Enter, on "Download History": Steam was still loading.
describe('f40127bd replay: a fast path waits for the page to change before GOAL_REACHED',()=>{
 const before=steam.preSubmitState as Screen;
 const withheld={...tradingview.rev3.state,controls:[]} as Screen;
 const script=(titles:string[])=>{let enter=false,looks=0;
  return mac(withheld,(action,s)=>{
   if(action.kind==='open'){s.screen=before;return;}
   if(action.kind==='press'&&action.ref==='standard-address-focus'){s.screen=omnibox(before);return;}
   if(action.kind==='type'){s.screen=omnibox(before,action.text);return;}
   if(action.kind==='key'&&action.key==='enter'){enter=true;s.screen=(()=>({...before,windowTitle:titles[Math.min(looks++,titles.length-1)]})) as any;}
  });
 };
 test('the recorded run: GOAL_REACHED only once the title left "Download History", with no model call',async()=>{
  expect(steam.trace.filter(e=>e.phase==='acted').map(e=>e.action)).toEqual(['open','press','type','key']);
  const m=script([before.windowTitle,before.windowTitle,'Welcome to Steam - Google Chrome - Profile']);
  const r=await runComputerUse(goalRun(steam.command),m.deps,signal());
  expect(m.actions()).toEqual([{kind:'open',app_id:CHROME},{kind:'press',ref:'standard-address-focus'},{kind:'type',ref:'o1',text:'store.steampowered.com'},{kind:'key',key:'enter'}]);
  expect(r).toMatchObject({status:'succeeded',reason:'GOAL_REACHED',steps:4,evaluations:0});
  // Looked again until the page changed: the two "Download History" reads were not the end.
  expect(r.observation?.windowTitle).toBe('Welcome to Steam - Google Chrome - Profile');
  expect(m.requests).toHaveLength(0);
 });
 test('a failed navigation observation cannot certify a fast-path goal',async()=>{
  const m=script([before.windowTitle]);let afterEnter=false,failed=false;
  const call=m.deps.call;
  m.deps.call=async(name,args,s)=>{
   if(name==='computer_action'&&args.kind==='key'&&args.key==='enter')afterEnter=true;
   if(name==='computer_observe'&&afterEnter&&!failed){failed=true;throw Error('OBSERVATION_FAILED');}
   return call(name,args,s);
  };
  const r=await runComputerUse(goalRun(steam.command),m.deps,signal());
  expect(failed).toBe(true);
  expect(r.trace.events.some(e=>e.reason==='NAVIGATION_PENDING')).toBe(true);
  expect(r.evaluations).toBeGreaterThan(0);
 },20000);
 test('a page that never changes within the wait goes to the decision model instead of GOAL_REACHED',async()=>{
  const m=script([before.windowTitle]);m.requests.length=0;
  const started=Date.now();
  const r=await runComputerUse(goalRun(steam.command),m.deps,signal());
  expect(Date.now()-started).toBeGreaterThanOrEqual(5500);
  expect(r.trace.events.some(e=>e.phase==='waiting'&&e.reason==='NAVIGATION_PENDING')).toBe(true);
  // The model looked at the unchanged page and decided (DONE here, after this run typed into the address bar itself).
  expect(m.requests.length).toBeGreaterThanOrEqual(1);
  expect(r.reason).toBe('GOAL_REACHED');expect(r.evaluations).toBeGreaterThanOrEqual(1);
 },20000);
});

// Pod-jinawong r10, task 457a4930 rev5: the agent's "open tradingview.com/chart/?symbol=BINANCE:BOMEUSDT in Google Chrome" went
// into Steam's own store search field, and the model judged "Steam Search, 0 results" done (0.95): GOAL_REACHED, session closed.
describe('457a4930 rev5 replay: a URL goal is not done on another site',()=>{
 const steamSearch=tradingview.rev5.finalState as Screen;
 test('the recorded DONE on "Steam Search" is refused; the address bar takes the URL and the chart opens',async()=>{
  expect(tradingview.rev5.outcome).toBe('GOAL_REACHED');
  expect(goalWebAddress(tradingview.rev5.command)).toMatchObject({host:'tradingview.com',label:'tradingview'});
  const chart={...steamSearch,windowTitle:'BOMEUSDT 0.0071 ▲ — TradingView - Google Chrome - Profile',controls:[]};
  const m=mac({...tradingview.rev3.state,controls:[]} as Screen,(action,s)=>{
   if(action.kind==='open'){s.screen=steamSearch;return;}
   if(action.kind==='press'&&action.ref==='standard-address-focus'){s.screen=omnibox(steamSearch);return;}
   if(action.kind==='type'){s.screen=omnibox(steamSearch,action.text);return;}
   if(action.kind==='key'&&action.key==='enter')s.screen=chart;
  },[{pick:'open:'+CHROME},{pick:'DONE',confidence:0.95}]);
  const r=await runComputerUse(goalRun(tradingview.rev5.command,{agentCommand:true,sessionStart:false,readRequest:false}),m.deps,signal());
  expect(r.trace.events.some(e=>e.reason==='ADDRESS_NOT_SHOWN')).toBe(true);
  expect(m.actions()).toEqual([{kind:'open',app_id:CHROME},{kind:'press',ref:'standard-address-focus'},{kind:'type',ref:'o1',text:'tradingview.com/chart/?symbol=BINANCE:BOMEUSDT'},{kind:'key',key:'enter'}]);
  expect(r).toMatchObject({status:'succeeded',reason:'GOAL_REACHED'});
  expect(r.observation?.windowTitle).toContain('TradingView');
 });
 test('without the address-bar shortcut the run waits instead of claiming the goal',async()=>{
  const plain={...steamSearch,capabilities:{keys:steamSearch.capabilities.keys}};
  const m=mac({...tradingview.rev3.state,controls:[]} as Screen,(action,s)=>{if(action.kind==='open')s.screen=plain;},[{pick:'open:'+CHROME},{pick:'DONE',confidence:0.95}]);
  const r=await runComputerUse(goalRun(tradingview.rev5.command,{agentCommand:true,sessionStart:false,readRequest:false}),m.deps,signal());
  expect(r).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT'});
  expect(computerOutcomeText({...r,phase:'terminal',trace:r.trace.events} as any)).toBe('Not finished: 1 action done, then the page in front does not show the web address yet. Check the browser, then send the command again.');
 });
});

// Pod-jinawong r10, task 457a4930 rev3-rev5: the chat pop put GetPod (protected) in front; every later round saw a withheld
// screen ("unapproved", no controls), and the agent's next command worked in Chrome's Steam tab instead of TradingView.
describe('457a4930 withheld replay: a round that starts with GetPod in front reopens the last target app first',()=>{
 const withheld=tradingview.rev3.state as Screen;
 const chartWindow={...tradingview.rev1.finalState} as Screen;
 const target={id:TRADINGVIEW,name:'TradingView'};
 test('the recorded withheld screen: TradingView is opened before anything is decided, never Chrome',async()=>{
  expect(withheld).toMatchObject({application:'unapproved',frontmostProtected:true,controls:[]});
  const m=mac(withheld,(action,s)=>{if(action.kind==='open'&&action.app_id===TRADINGVIEW)s.screen=chartWindow;},[{pick:'DONE'}]);
  const r=await runComputerUse(goalRun('ย่อเองเลยซิ',{sessionStart:false,reactivate:target}),m.deps,signal());
  expect(m.actions()[0]).toEqual({kind:'open',app_id:TRADINGVIEW});
  expect(m.actions().some(a=>a.app_id===CHROME)).toBe(false);
  // The first decision is made on TradingView's own window, not on the withheld screen.
  expect(m.requests[0].state.desktop?.application??JSON.stringify(m.requests[0])).toContain(TRADINGVIEW);
  // Reopening the target is no step of the command itself.
  expect(r.trace.events.find(e=>e.phase==='acted')).toMatchObject({action:'open',appId:TRADINGVIEW,reason:'REACTIVATE_TARGET'});
 });
 test('an explicit new app in the command wins over the previous target on a withheld screen',async()=>{
  const spotify={id:'com.spotify.client',name:'Spotify'};
  const screen={...withheld,apps:[...withheld.apps,spotify]};
  const m=mac(screen,(action,s)=>{if(action.kind==='open')s.screen={...chartWindow,application:action.app_id};},[{pick:'UNCLEAR'}]);
  await runComputerUse(goalRun('open Spotify',{sessionStart:false,reactivate:target}),m.deps,signal());
  expect(m.actions()[0]).toEqual({kind:'open',app_id:spotify.id});
 });
 test('an ambiguous command mentioning other approved apps does not reactivate the old target',async()=>{
  const spotify={id:'com.spotify.client',name:'Spotify'};
  const screen={...withheld,apps:[...withheld.apps,spotify]};
  const m=mac(screen,()=>undefined,[{pick:'UNCLEAR'}]);
  await runComputerUse(goalRun('play Spotify in Google Chrome',{sessionStart:false,reactivate:target}),m.deps,signal());
  expect(m.actions()[0]).not.toEqual({kind:'open',app_id:target.id});
 });
 test('a direct user command reopens it too, once, and a screen that is not withheld is left alone',async()=>{
  const direct=mac(withheld,(action,s)=>{if(action.kind==='open')s.screen=chartWindow;},[{pick:'UNCLEAR'}]);
  await runComputerUse({goal:'ย่อเองเลยซิ',yieldAfterInteraction:true,readRequest:true,reactivate:target},direct.deps,signal());
  expect(direct.actions()).toEqual([{kind:'open',app_id:TRADINGVIEW}]);
  const front=mac(chartWindow,()=>undefined,[{pick:'UNCLEAR'}]);
  await runComputerUse({goal:'ย่อเองเลยซิ',yieldAfterInteraction:true,readRequest:true,reactivate:target},front.deps,signal());
  expect(front.actions()).toEqual([]);
 });
 test('rev3: an open the helper could not confirm, with TradingView in front afterwards, goes on with the goal',async()=>{
  expect(tradingview.rev3.toolErrors.map(e=>e.code)).toContain('APPLICATION_LAUNCH_UNCONFIRMED');
  const m=mac(withheld,(action,s)=>{if(action.kind==='open'){s.screen=chartWindow;return {state:'unknown',error:'APPLICATION_LAUNCH_UNCONFIRMED',continuation_ready:true};}},[{pick:'DONE'}]);
  const r=await runComputerUse(goalRun('open the BOME chart on TradingView',{sessionStart:false,reactivate:target}),m.deps,signal());
  expect(r.reason).not.toBe('OUTCOME_UNKNOWN');expect(r.operationId).toBeUndefined();
  expect(r.trace.events.some(e=>e.reason==='OPEN_UNCONFIRMED_APP_IN_FRONT')).toBe(true);
  expect(m.requests).toHaveLength(1);
 });
 test('an unconfirmed open that left GetPod in front still stops for reconciliation (never assumed)',async()=>{
  const m=mac(withheld,()=>({state:'unknown',error:'APPLICATION_LAUNCH_UNCONFIRMED',continuation_ready:true}));
  const r=await runComputerUse(goalRun('open the BOME chart on TradingView',{sessionStart:false,reactivate:target}),m.deps,signal());
  expect(r).toMatchObject({status:'needs_reconciliation',reason:'OUTCOME_UNKNOWN'});
 });
});
