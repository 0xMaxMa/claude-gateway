import {runComputerUse,ComputerObservation,type ComputerUseDependencies} from '../../../src/automation/computer-use';

// Gateway side of the getpod-computer-use (develop @953bb80) review:
// relay.ts rejects some computer_action calls before recording an operation,
// and app.ts reports {state:'not_found'} (no operation_id) for such an ID.
const OP=/^[0-9a-f-]{36}$/;
function chrome(extra:Record<string,unknown>={}){
 return {generation:'g1',application:'com.google.Chrome',windowTitle:'Google Chrome',truncated:false,apps:[{id:'com.google.Chrome',name:'Google Chrome'}],
  focusedControl:{ref:'c0',role:'AXTextField',label:'Address and search bar'},
  controls:[{ref:'c0',identity:'11111111-1111-4111-8111-111111111111',role:'AXTextField',label:'Address and search bar',value:'abc',focused:true,actions:['press','type']},
   {ref:'c5',role:'AXButton',label:'New Tab',actions:['press']},
   {ref:'m0',role:'AXMenuItem',label:'Menu: Chrome → Quit Google Chrome',actions:['press']},{ref:'m1',role:'AXMenuItem',label:'Menu: File → New Tab',actions:['press']}],
  ...extra};
}
const choice=(criteria:Record<string,unknown>,chosen:string)=>({choice:chosen,confidence:0.95,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?0.95:0.05/(Object.keys(criteria).length-1||1)]))});
function fixture(state:any,handlers:{action?:(args:any)=>any;status?:(args:any)=>any;release?:()=>any;evaluate?:()=>any}={}){
 const calls:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async(name,args)=>{
   calls.push({name,args});
   if(name==='computer_acquire')return {lease_token:'lease'};
   if(name==='computer_release')return handlers.release?handlers.release():{released:true};
   if(name==='computer_observe')return structuredClone(typeof state==='function'?state(args):state);
   if(name==='computer_action')return handlers.action?handlers.action(args):{state:'completed'};
   if(name==='computer_operation_status')return handlers.status?handlers.status(args):{state:'not_found'};
   return {};
  },
  evaluate:async req=>{if(handlers.evaluate)return handlers.evaluate();return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choice(q.criteria as any,name==='action'?'press':name==='target_press'?'press:c5':'BLOCKED')]))};}};
 return {deps,calls,actions:()=>calls.filter(c=>c.name==='computer_action').map(c=>c.args)};
}
const run=(f:ReturnType<typeof fixture>,goal:string,signal=new AbortController().signal)=>runComputerUse({goal,yieldAfterInteraction:true},f.deps,signal);
const reject=(code:string)=>()=>{throw Error(code);};

describe('1. explicit pre-dispatch rejection is not an unknown outcome',()=>{
 test.each(['DEVICE_OFFLINE','CONSENT_REQUIRED','OBSERVATION_DENIED','CONTROL_DENIED','APPLICATION_NOT_ALLOWED','COMPUTER_BUSY'])('%s with a not_found receipt is not_executed with its cause',async code=>{
  const f=fixture(chrome(),{action:reject(code)});
  const r=await run(f,'กด New Tab');
  expect(r.status).not.toBe('needs_reconciliation');expect(r.operationId).toBeUndefined();
  expect(r.reason).toBe(code);
  expect(r.trace.events.find(e=>e.phase==='acted')).toMatchObject({outcome:'not_executed',reason:code});
  expect(f.actions()).toHaveLength(1);
 });
 test('a recorded receipt after an explicit error is trusted, not overridden',async()=>{
  const f=fixture(chrome(),{action:reject('COMPUTER_BUSY'),status:args=>({operation_id:args.operation_id,state:'completed'})});
  const r=await run(f,'กด New Tab');
  expect(r.trace.events.find(e=>e.phase==='acted')).toMatchObject({outcome:'completed'});
 });
 test.each([
  ['a transport failure without a cause code',reject('COMPUTER_TOOL_FAILED'),()=>({state:'not_found'})],
  ['DEVICE_OFFLINE while its receipt is still running',reject('DEVICE_OFFLINE'),(args:any)=>({operation_id:args.operation_id,state:'running'})],
  ['DEVICE_OFFLINE with the receipt unavailable',reject('DEVICE_OFFLINE'),()=>{throw Error('DEVICE_OFFLINE');}],
 ])('%s stays unknown and is never replayed',async(_name,action,status)=>{
  const f=fixture(chrome(),{action,status});
  const r=await run(f,'กด New Tab');
  expect(r.status).toBe('needs_reconciliation');expect(r.operationId).toMatch(OP);expect(f.actions()).toHaveLength(1);
 });
});

describe('2. contract version and tolerant observation parsing',()=>{
 test('unknown future action values are ignored instead of failing the observation',async()=>{
  const state=chrome({supportedActions:['scroll:down','zoom:in'],standardCommand:'window:tile',capabilities:{standardCommands:['tab:new','window:tile'],keys:['backspace','f13']},contractVersion:1});
  state.controls.push({ref:'c9',role:'AXButton',label:'Future',actions:['press','drag']} as any);
  const parsed=ComputerObservation.parse(state);
  expect(parsed.supportedActions).toEqual(['scroll:down']);expect(parsed.standardCommand).toBeUndefined();
  expect(parsed.controls.find(c=>c.ref==='c9')?.actions).toEqual(['press']);
  const f=fixture(state);const r=await run(f,'click that button');
  expect(r.status).not.toBe('blocked');expect(f.actions()).toHaveLength(1);
 });
 test('an incompatible major contract version is refused before any action',async()=>{
  const f=fixture(chrome({contractVersion:2}));const r=await run(f,'กด New Tab');
  expect(r).toMatchObject({status:'blocked',reason:'COMPUTER_CONTRACT_UNSUPPORTED'});expect(f.actions()).toHaveLength(0);
 });
 test('older helpers without contractVersion keep working',async()=>{
  const f=fixture(chrome());await run(f,'กด New Tab');expect(f.actions()).toHaveLength(1);
 });
});

describe('3. the lease is always released (the relay has no lease expiry)',()=>{
 test.each([
  ['a failure',(f:any)=>({evaluate:()=>{throw Error('JEV_BROKEN');}})],
  ['a cancellation',(f:any)=>({})],
 ])('released after %s',async(name)=>{
  const abort=new AbortController();
  const f=fixture(chrome(),name==='a failure'?{evaluate:()=>{throw Error('JEV_BROKEN');}}:{evaluate:()=>{abort.abort();throw Error('CANCELLED');}});
  await run(f,'กด New Tab',abort.signal);
  expect(f.calls.filter(c=>c.name==='computer_release')).toEqual([{name:'computer_release',args:{lease_token:'lease'}}]);
 });
 test('a failed release is retried once',async()=>{
  let attempts=0;
  const f=fixture(chrome(),{release:()=>{if(++attempts===1)throw Error('COMPUTER_TOOL_FAILED');return {released:true};}});
  await run(f,'กด New Tab');
  expect(f.calls.filter(c=>c.name==='computer_release')).toHaveLength(2);
 });
});

describe('5. capability-gated standard commands',()=>{
 const capable=(args:any)=>args.standard_command
  ?{generation:'s1',application:'com.google.Chrome',standardCommand:args.standard_command,truncated:true,apps:[],capabilities:{standardCommands:['tab:new','address:focus','tab:close','app:quit'],keys:['backspace','enter']},
    controls:[{ref:'standard-'+args.standard_command.replace(':','-'),role:'keyboardShortcut',label:'shortcut',actions:['press']}]}
  :chrome({capabilities:{standardCommands:['tab:new','address:focus','tab:close','app:quit'],keys:['backspace','enter']}});
 test.each([['เปิด tab ใหม่','tab:new'],['ปิด tab','tab:close'],['ปิด chrome','app:quit']])('%s uses standard_command %s when advertised',async(command,standard)=>{
  const f=fixture(capable);await run(f,command);
  expect(f.calls.some(c=>c.name==='computer_observe'&&c.args.standard_command===standard)).toBe(true);
  expect(f.actions()).toEqual([expect.objectContaining({kind:'press',ref:'standard-'+standard.replace(':','-')})]);
 });
 test('without the capability the menu path is kept',async()=>{
  const f=fixture(chrome());await run(f,'เปิด tab ใหม่');
  expect(f.calls.some(c=>c.args?.standard_command)).toBe(false);expect(f.actions()).toEqual([expect.objectContaining({kind:'press',ref:'m1'})]);
 });
 test('erase uses the backspace key when advertised',async()=>{
  const f=fixture(capable);await run(f,'ลบ 2');
  expect(f.actions()).toEqual([expect.objectContaining({kind:'key',key:'backspace'}),expect.objectContaining({kind:'key',key:'backspace'})]);
 });
 test('erase falls back to rewriting the field without the capability',async()=>{
  const f=fixture(chrome());await run(f,'ลบ 2');
  expect(f.actions()).toEqual([expect.objectContaining({kind:'type',ref:'c0',text:'a'})]);
 });
 test('opening a site with no observed address field focuses it with address:focus',async()=>{
  let focused=false,typed='';
  const f=fixture((args:any)=>{
   if(args.standard_command)return capable(args);
   const state=chrome({capabilities:{standardCommands:['address:focus'],keys:[]}});
   state.controls=state.controls.filter((c:any)=>c.ref!=='c0');
   if(focused)state.controls.push({ref:'c0',identity:'11111111-1111-4111-8111-111111111111',role:'AXTextField',label:'Address and search bar',value:typed,focused:true,actions:['press','type']});
   return state;
  },{action:args=>{if(args.ref==='standard-address-focus')focused=true;if(args.kind==='type')typed=args.text;return {state:'completed'};}});
  await run(f,'เข้า google');
  expect(f.actions().map(a=>[a.kind,a.ref??a.key,a.text])).toEqual([['press','standard-address-focus',undefined],['type','c0','google.com'],['key','enter',undefined]]);
 });
});

// Live E2E (task e6149724): the develop relay predated gcu #67 and dropped
// standard_command, so the helper returned an ordinary observation while still
// advertising the capability. Every shortcut stopped with SHORTCUT_UNAVAILABLE.
describe('6. a relay that drops standard_command',()=>{
 const caps={standardCommands:['tab:new','address:focus','tab:close','app:quit'],keys:['backspace','enter']};
 test('a new tab falls back to the observed menu command',async()=>{
  const f=fixture(()=>chrome({capabilities:caps}));
  const r=await run(f,'เปิด tab ใหม่');
  expect(f.actions()).toEqual([expect.objectContaining({kind:'press',ref:'m1'})]);
  expect(r.trace.events.some(e=>e.reason==='SHORTCUT_UNAVAILABLE')).toBe(false);
 });
 test('it asks for a standard command at most once per run',async()=>{
  const f=fixture(()=>chrome({capabilities:caps}));
  await run(f,'เปิด tab ใหม่');
  expect(f.calls.filter(c=>c.name==='computer_observe'&&c.args.standard_command)).toHaveLength(1);
 });
 test('an address with no observed bar continues with the normal decision',async()=>{
  const state=chrome({capabilities:caps});state.controls=state.controls.filter((c:any)=>c.ref!=='c0');
  let asked=0;
  const f=fixture(()=>state,{evaluate:()=>{asked++;return {answers:{}};}});
  const r=await run(f,'เข้า google');
  expect(asked).toBe(1);
  expect(r.trace.events.some(e=>e.reason==='SHORTCUT_UNAVAILABLE')).toBe(false);
 });
});

describe('7. shortcut hints name the real obstacle',()=>{
 test('a browser in front without the command is not told to bring the browser forward',async()=>{
  const state=chrome();state.controls=state.controls.filter((c:any)=>c.ref!=='m1'&&c.ref!=='c5');
  const r=await run(fixture(state),'เปิด tab ใหม่');
  expect(r.trace.events.filter(e=>e.phase==='waiting').map(e=>e.reason)).toEqual(['SHORTCUT_NOT_OFFERED']);
 });
 test('another application in front keeps the bring-the-browser-forward hint',async()=>{
  const state=chrome({application:'ai.getpod.computer-use',windowTitle:'GetPod Computer Use',apps:[{id:'com.google.Chrome',name:'Google Chrome'},{id:'ai.getpod.computer-use',name:'GetPod Computer Use'}]});
  state.controls=state.controls.filter((c:any)=>c.ref!=='m1'&&c.ref!=='c5');
  const r=await run(fixture(state),'เปิด tab ใหม่');
  expect(r.trace.events.filter(e=>e.phase==='waiting').map(e=>e.reason)).toEqual(['SHORTCUT_UNAVAILABLE']);
 });
});

// Live E2E (task e6149724): after typing into Google's search box Chrome reported
// focus on the box's inner static text, so "ลบๆ" found no focused field.
describe('8. erase when focus is reported on the text inside a field',()=>{
 const google=(extra:Record<string,unknown>={})=>({generation:'g1',application:'com.google.Chrome',windowTitle:'Google - Google Chrome',truncated:false,apps:[{id:'com.google.Chrome',name:'Google Chrome'}],
  focusedControl:{ref:'c0',role:'AXStaticText',label:'test123'},
  controls:[{ref:'c0',role:'AXStaticText',label:'test123',value:'test123',focused:true,actions:['press']},
   {ref:'c1',role:'AXTextArea',label:'ค้นหา',value:'test123',focused:false,actions:['press','type']},
   {ref:'c31',role:'AXTextField',label:'Address and search bar',value:'google.com',focused:false,actions:['press','type']}],...extra});
 test('the field holding the focused text is erased with backspace',async()=>{
  const f=fixture(google({capabilities:{standardCommands:[],keys:['backspace']}}));
  const r=await run(f,'ลบๆ');
  expect(f.actions()).toEqual([expect.objectContaining({kind:'key',key:'backspace'}),expect.objectContaining({kind:'key',key:'backspace'})]);
  expect(r.lastAction).toMatchObject({kind:'erase',count:2});
 });
 test('without backspace the same field is rewritten',async()=>{
  const f=fixture(google());await run(f,'ลบๆ');
  expect(f.actions()).toEqual([expect.objectContaining({kind:'type',ref:'c1',text:'test1'})]);
 });
 test('static text matching two fields is ambiguous and erases nothing',async()=>{
  const state=google();state.controls.push({ref:'c2',role:'AXTextField',label:'Other',value:'test123',focused:false,actions:['press','type']});
  const f=fixture(state);await run(f,'ลบๆ');
  expect(f.actions().filter(a=>a.kind==='type'||a.key==='backspace')).toEqual([]);
 });
});
