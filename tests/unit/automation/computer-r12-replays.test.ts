import {runComputerUse,namedApp,reconnecting,DEVICE_RECONNECT_GRACE_MS,type ComputerUseDependencies} from '../../../src/automation/computer-use';
import {computerOutcomeText,computerReasonText} from '../../../src/automation/computer-outcome';
import ec82 from '../../fixtures/computer/tradingview-ec82ed05.json';

// Replays of pod-jinawong r11 task ec82ed05 (gateway 3d370131, app wincu.8 on macOS 26.6.2): "draw a new BTC channel
// touching the real peaks" in TradingView. From the recorded round receipts in tests/fixtures/computer (no screenshots).
const TRADINGVIEW='com.tradingview.tradingviewapp.desktop';
type Screen=Record<string,any>;
const chart=ec82.rev3.state as Screen;
const apps=chart.apps as Array<{id:string;name:string}>;
const choice=(criteria:Record<string,unknown>,chosen:string,confidence:number)=>({choice:chosen,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?confidence:(1-confidence)/(Object.keys(criteria).length-1||1)]))});
/** A Mac whose screen is `look(n)` on its n-th observation; `plan`: the decision model's picks in order (DONE after). */
function mac(look:(n:number)=>Screen,plan:Array<{pick:string;confidence?:number}>=[],opts:{acquire?:()=>unknown;act?:(a:any)=>unknown}={}){
 let asked=0,looks=0;const calls:any[]=[],requests:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async(name,args)=>{
   calls.push({name,args});
   if(name==='computer_acquire')return opts.acquire?opts.acquire():{lease_token:'lease'};
   if(name==='computer_observe')return {...look(looks++),generation:'g'+looks};
   if(name==='computer_action')return opts.act?.(args)??{state:'completed'};
   return {};
  },
  evaluate:async req=>{
   requests.push(req);const step=plan[asked++]??{pick:'DONE'};const kind=step.pick.includes(':')?step.pick.split(':')[0]:step.pick;
   return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choice(q.criteria as any,name==='action'?kind:name==='target_'+kind?step.pick:name==='impact'?'ROUTINE':'NONE',name==='impact'?0.95:step.confidence??0.95)]))};
  }};
 return {deps,calls,requests,actions:()=>calls.filter(c=>c.name==='computer_action').map(({args:{lease_token,operation_id,generation,...rest}})=>rest),
  count:(name:string)=>calls.filter(c=>c.name===name).length};
}
// rev3 was the user's reply to a self-paused goal round: the paused command resumes as a goal (computer.ts resumedPause).
const resumed=(extra:Record<string,unknown>={})=>({goal:`${ec82.rev3.command}\n\nThe user's reply after this goal paused (it continues the goal above unless it asks for something else): ${ec82.rev3.reply}`,yieldAfterInteraction:true,readRequest:false,runToGoal:true,...extra});
const signal=()=>new AbortController().signal;
const lastWait=(r:{trace:{events:Array<{phase:string;reason?:string}>}})=>[...r.trace.events].reverse().find(e=>e.phase==='waiting')?.reason;
// The chart ticks: its price and clock text change on every look; its controls do not.
const ticking=(n:number)=>({...chart,text:[...chart.text.slice(0,2),`76,8${24+n}.45`,...chart.text.slice(3)]});

describe('ec82ed05 rev3 replay: WAIT on a chart whose controls never change is no "screen still changing"',()=>{
 test('the recorded round: three WAITs, then UI_NOT_READY, no action',()=>{
  const phases=ec82.rev3.trace.map(e=>e.reason?`${e.phase}:${e.reason}`:e.phase);
  expect(phases.filter(p=>p==='decided')).toHaveLength(3);
  expect(phases.slice(-2)).toEqual(['waiting:UI_NOT_READY','terminal:COMMAND_WAITING_INPUT']);
  expect(ec82.rev3.trace.at(-1)).toMatchObject({steps:0,evaluations:3});
 });
 test('the same three WAITs now end as no supported step (the goal round then continues on vision)',async()=>{
  const m=mac(ticking,[{pick:'WAIT',confidence:0.95},{pick:'WAIT',confidence:0.85},{pick:'WAIT',confidence:0.85}]);
  const r=await runComputerUse(resumed(),m.deps,signal());
  expect(m.count('computer_observe')).toBe(3);expect(m.requests).toHaveLength(3);expect(m.actions()).toEqual([]);
  expect(r).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:3});
  // computer.ts hands a goal round whose last wait is NO_SUPPORTED_ACTION in an approved window to the vision fallback.
  expect(lastWait(r)).toBe('NO_SUPPORTED_ACTION');
  expect(r.trace.events.some(e=>e.reason==='UI_NOT_READY')).toBe(false);
 },15000);
 test('a screen whose controls really change keeps UI_NOT_READY, with copy that says it waited',async()=>{
  const m=mac(n=>({...chart,windowTitle:`BTCUSDT / Loading ${n}`}),[{pick:'WAIT'},{pick:'WAIT'},{pick:'WAIT'}]);
  const r=await runComputerUse(resumed(),m.deps,signal());
  expect(lastWait(r)).toBe('UI_NOT_READY');
  expect(computerOutcomeText({...r,phase:'terminal',trace:r.trace.events} as any)).toBe('Not done: the screen kept changing while it waited. Send the command again.');
 },15000);
 test('a WAIT, then an action, then WAITs: the streak starts again at the new screen',async()=>{
  let pressed=false;
  const m=mac(()=>pressed?{...chart,windowTitle:'BTCUSDT / Saved'}:chart,[{pick:'WAIT'},{pick:'press:c47'},{pick:'WAIT'},{pick:'WAIT'},{pick:'WAIT'}],{act:()=>{pressed=true;return {state:'completed'};}});
  const r=await runComputerUse(resumed(),m.deps,signal());
  expect(m.actions()).toEqual([{kind:'press',ref:'c47'}]);
  expect(lastWait(r)).toBe('NO_SUPPORTED_ACTION');
 },20000);
});

describe('ec82ed05 rev4 replay: the app socket closed during computer_acquire and came back 4 s later',()=>{
 test('the recorded round: computer_acquire DEVICE_OFFLINE, failed with 0 actions',()=>{
  expect(ec82.rev4.toolErrors).toEqual([expect.objectContaining({tool:'computer_acquire',code:'DEVICE_OFFLINE'})]);
  expect(ec82.rev4.trace.at(-1)).toMatchObject({status:'blocked',reason:'DEVICE_OFFLINE',steps:0});
 });
 test('the lease is asked again while GetPod Desktop reconnects, and the round runs',async()=>{
  let offline=2;
  const m=mac(()=>chart,[{pick:'DONE'}],{acquire:()=>{if(offline-->0)throw Error('DEVICE_OFFLINE');return {lease_token:'lease'};}});
  const started=Date.now();
  const r=await runComputerUse(resumed(),m.deps,signal());
  expect(m.count('computer_acquire')).toBe(3);
  expect(Date.now()-started).toBeGreaterThanOrEqual(1900);
  // The round looked and decided (a DONE with no action here goes to verification), instead of failing offline.
  expect(r.reason).not.toBe('DEVICE_OFFLINE');expect(r.status).not.toBe('blocked');
  expect(m.count('computer_observe')).toBeGreaterThanOrEqual(1);expect(m.requests).toHaveLength(1);
 },15000);
 test('a computer that stays away ends after the grace, in plain words',async()=>{
  const read=jest.fn(async()=>{throw Error('DEVICE_OFFLINE');});
  const started=Date.now();
  await expect(reconnecting('computer_acquire',read,signal(),2500)).rejects.toThrow('DEVICE_OFFLINE');
  expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);expect(Date.now()-started).toBeLessThan(4000);
  expect(DEVICE_RECONNECT_GRACE_MS).toBe(12000);
  expect(computerReasonText('DEVICE_OFFLINE')).toBe('The computer disconnected and did not reconnect within 12 seconds.');
 });
 test('an action is never sent twice, another error is not retried, and a stop ends the wait',async()=>{
  const action=jest.fn(async()=>{throw Error('DEVICE_OFFLINE');});
  await expect(reconnecting('computer_action',action,signal())).rejects.toThrow('DEVICE_OFFLINE');
  expect(action).toHaveBeenCalledTimes(1);
  const other=jest.fn(async()=>{throw Error('CONSENT_REQUIRED');});
  await expect(reconnecting('computer_observe',other,signal())).rejects.toThrow('CONSENT_REQUIRED');
  expect(other).toHaveBeenCalledTimes(1);
  const stop=new AbortController();setTimeout(()=>stop.abort(),200);
  const started=Date.now();
  await expect(reconnecting('computer_observe',async()=>{throw Error('DEVICE_OFFLINE');},stop.signal)).rejects.toThrow('DEVICE_OFFLINE');
  expect(Date.now()-started).toBeLessThan(1000);
 });
});

describe('ec82ed05 rev1: the first round of a task, GetPod in front, no earlier target',()=>{
 const withheld:Screen={contractVersion:1,capabilities:chart.capabilities,frontmostProtected:true,reason:'The frontmost application is protected on this computer; open or switch to an allowed application.',application:'unapproved',truncated:false,controls:[],apps};
 test('the recorded round: the model spent its first action reopening TradingView',()=>{
  expect(ec82.rev1.trace.find(e=>e.phase==='acted')).toMatchObject({action:'open',appId:TRADINGVIEW,steps:1});
 });
 test('the app the command names is opened first, before any decision, and it is no step',async()=>{
  const m=mac(n=>n===0?withheld:chart,[{pick:'DONE'}]);
  const r=await runComputerUse({goal:ec82.rev1.command,yieldAfterInteraction:true,readRequest:true,sessionStart:true,runToGoal:true},m.deps,signal());
  expect(m.actions()[0]).toEqual({kind:'open',app_id:TRADINGVIEW});
  expect(r.trace.events.find(e=>e.phase==='decided')).toMatchObject({reason:'REACTIVATE_TARGET',appId:TRADINGVIEW});
  expect(JSON.stringify(m.requests[0])).toContain(TRADINGVIEW);
  expect(r.trace.events.find(e=>e.phase==='acted')).toMatchObject({action:'open',appId:TRADINGVIEW,reason:'REACTIVATE_TARGET'});
 });
 test('a screen that is not withheld is left alone; a command naming no app decides as before',async()=>{
  const front=mac(()=>chart,[{pick:'UNCLEAR'}]);
  await runComputerUse({goal:ec82.rev1.command,yieldAfterInteraction:true,readRequest:true},front.deps,signal());
  expect(front.actions()).toEqual([]);
  const none=mac(()=>withheld,[{pick:'UNCLEAR'}]);
  await runComputerUse({goal:'ลองใหม่อีกที',yieldAfterInteraction:true,readRequest:true},none.deps,signal());
  expect(none.actions()).toEqual([]);expect(none.requests).toHaveLength(1);
 });
});

describe('namedApp: the one approved app a command names, from the device\'s own list',()=>{
 const pick=(text:string)=>namedApp(text,apps)?.id;
 test('the agent\'s command and the user\'s own words',()=>{
  expect(pick(ec82.rev1.command)).toBe(TRADINGVIEW);
  expect(pick('[Computer Use] เปิด tradingview app ตีเส้น trendline channel ของ BTC ให้หน่อยได้ไหม')).toBe(TRADINGVIEW);
  expect(pick('เปิดTradingViewให้หน่อย')).toBe(TRADINGVIEW);
  expect(pick(`switch to ${TRADINGVIEW}`)).toBe(TRADINGVIEW);
  expect(pick('find Starwork office in Maps')).toBe('com.apple.Maps');
  expect(pick('open Google Chrome and go to steam')).toBe('com.google.Chrome');
 });
 test('a plain word is matched only as the app spells it, and inside other words never',()=>{
  expect(pick('show me the maps of the area')).toBeUndefined();
  expect(pick('list the apps you can open')).toBeUndefined();
  expect(pick('Notesheet')).toBeUndefined();
  expect(pick('open tradingviewer')).toBeUndefined();
 });
 test('two apps named is none; a name inside a longer one is the longer one',()=>{
  expect(pick('copy the BTC price from TradingView into Notes')).toBeUndefined();
  expect(namedApp('open Safari Technology Preview',[{id:'com.apple.Safari',name:'Safari'},{id:'com.apple.SafariTechnologyPreview',name:'Safari Technology Preview'}])?.id).toBe('com.apple.SafariTechnologyPreview');
  expect(namedApp('in Notes',[])).toBeUndefined();
 });
});
