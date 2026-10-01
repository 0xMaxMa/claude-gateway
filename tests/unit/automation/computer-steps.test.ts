import assert from 'node:assert/strict';
import {parseComputerSteps,runComputerSteps,destructiveText} from '../../../src/automation/computer-steps';
import {standardNavigationCommand} from '../../../src/automation/computer-command';
import {validateJevRequest} from '../../../src/jev/validation';
import type {ComputerUseDependencies} from '../../../src/automation/computer-use';

type Request=Parameters<ComputerUseDependencies['evaluate']>[0];
const choice=(criteria:Record<string,string>,chosen:string,confidence=1)=>({choice:chosen,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?1:0]))});
/** Answers every fan-out question: the operation, its target and optional literal text. */
function answer(req:Request,target:string,{submit=false,text='TEXT:0',confidence=1}:{submit?:boolean;text?:string;confidence?:number}={}){
 const kind=target.split(':')[0];
 return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,
  name==='action'?choice(q.criteria,['WAIT','BLOCKED','DONE'].includes(target)?target:submit?'submit_text':kind,confidence):
  name==='target_'+kind?choice(q.criteria,target,confidence):
  name==='text'?choice(q.criteria,text):choice(q.criteria,'BLOCKED')]))};
}
const FIELD='11111111-1111-4111-8111-111111111111';
/** A browser-like desktop whose observable state changes with each dispatched action. */
function desktop(plan:(command:string,req:Request)=>ReturnType<typeof answer>,options:{inert?:string[]}={}){
 let generation=0;const calls:Array<{name:string;args:any}>=[];const fenced:string[]=[];const questions:Request[]=[];let snapshots=0;
 const state:any={generation:'g0',application:'com.google.Chrome',windowTitle:'Start',text:['start'],truncated:false,screenshotAvailable:true,
  apps:[{id:'com.google.Chrome',name:'Chrome'}],supportedActions:['scroll:down','scroll:up','navigate:back'],
  focusedControl:{ref:'addr',role:'AXTextField',label:'Address and search bar'},
  controls:[{ref:'newtab',label:'New Tab',role:'AXButton',actions:['press']},
   {ref:'addr',identity:FIELD,label:'Address and search bar',role:'AXTextField',actions:['press','type'],value:'',focused:true},
   {ref:'link1',label:'First result',role:'AXLink',actions:['press']},
   {ref:'danger',label:'Delete account',role:'AXButton',actions:['press']}]};
 const change=(title:string)=>{state.windowTitle=title;state.text=[title];};
 const deps:ComputerUseDependencies={
  authorized:()=>true,
  snapshot:async()=>{snapshots++;},
  beforeMutation:id=>{fenced.push(id);},
  call:async(name,args)=>{
   calls.push({name,args});
   if(name==='computer_acquire')return {lease_token:'lease-1'};
   if(name==='computer_release')return {released:true};
   if(name==='computer_observe')return structuredClone({...state,generation:'g'+generation});
   if(name==='computer_action'){
    assert.equal(fenced.at(-1),args.operation_id,'write-ahead receipt precedes dispatch');
    generation++;
    const inert=options.inert?.includes(String(args.kind)+':'+String(args.ref??args.direction??args.key));
    if(!inert){
     if(args.kind==='type')Object.assign(state.controls[1],{value:args.text,focused:true});
     else if(args.kind==='key')change('Results '+state.controls[1].value);
     else if(args.kind==='press')change('Pressed '+args.ref);
     else change(args.kind+' '+args.direction+' '+generation);
    }
    return {state:'completed'};
   }
   throw Error('UNEXPECTED_TOOL');
  },
  evaluate:async req=>{validateJevRequest(req,{});questions.push(req);return plan((req.state as any).command,req);},
 };
 return {deps,state,calls,fenced,questions,snapshots:()=>snapshots,actions:()=>calls.filter(c=>c.name==='computer_action').map(c=>c.args)};
}
const browsePlan=(command:string,req:Request)=>{
 if(command==='เปิด tab ใหม่')return answer(req,'press:newtab');
 if(command==='เข้า google'||command==='ค้น google'||command==='ค้น xxx')return answer(req,'type:addr',{submit:true});
 if(command==='เข้า link แรก')return answer(req,'press:link1');
 return answer(req,'BLOCKED');
};
const run=(steps:string[],deps:ComputerUseDependencies,extra:Record<string,unknown>={})=>runComputerSteps({steps,...extra},deps,new AbortController().signal);

describe('parseComputerSteps',()=>{
 test('splits commas, Thai connectors and numbered lists into ordered atomic steps',()=>{
  expect(parseComputerSteps('เปิดtab ใหม่, เข้า google,  ค้น xxx,  เข้า link แรก, scroll ลงมา')).toEqual(['เปิดtab ใหม่','เข้า google','ค้น xxx','เข้า link แรก','scroll ลงมา']);
  expect(parseComputerSteps('เข้า google แล้วค้น cats จากนั้นเข้า link แรก')).toEqual(['เข้า google','ค้น cats','เข้า link แรก']);
  expect(parseComputerSteps('1. open Chrome\n2) go back\n3. scroll down')).toEqual(['open Chrome','go back','scroll down']);
  expect(parseComputerSteps('1. open Chrome 2. scroll down 3. go back')).toEqual(['open Chrome','scroll down','go back']);
  expect(parseComputerSteps('- open Chrome\n- press enter')).toEqual(['open Chrome','press enter']);
  expect(parseComputerSteps('open Chrome, then scroll down')).toEqual(['open Chrome','scroll down']);
 });
 test('keeps quoted payloads, thousands separators and attached Thai words intact',()=>{
  expect(parseComputerSteps('พิมพ์ "a, b แล้ว c", กด enter')).toEqual(['พิมพ์ "a, b แล้ว c"','กด enter']);
  expect(parseComputerSteps('ค้น 1,000 baht, scroll ลง')).toEqual(['ค้น 1,000 baht','scroll ลง']);
  expect(parseComputerSteps('พิมพ์เสร็จแล้วกด enter')).toBeUndefined();
  expect(parseComputerSteps('open thenews.com, scroll down')).toEqual(['open thenews.com','scroll down']);
 });
 // Verbatim goal from the E2E run: the parent wrapped the user's list in a preamble,
 // a header and a trailing meta-instruction, which used to parse as 9 steps.
 const E2E_GOAL='คุณกำลังควบคุม Mac ของผู้ใช้ผ่าน Computer Use \n\nขั้นตอนที่ต้องทำทีละขั้น:\n1. เปิด Chrome แล้วเปิด tab ใหม่ (Cmd+T)\n2. ไปที่ google.com\n3. ค้นหาคำว่า "getpod"\n4. คลิก link แรกที่ปรากฏ\n5. Scroll ลงมาในหน้านั้น\n\nเริ่มจากขั้นตอนที่ 1 ก่อน: เปิด Chrome และกด Cmd+T เพื่อเปิด tab ใหม่';
 test('a numbered list inside a delegated prompt yields only its numbered items',()=>{
  expect(parseComputerSteps(E2E_GOAL)).toEqual(['เปิด Chrome แล้วเปิด tab ใหม่ (Cmd+T)','ไปที่ google.com','ค้นหาคำว่า "getpod"','คลิก link แรกที่ปรากฏ','Scroll ลงมาในหน้านั้น']);
  expect(parseComputerSteps('You are controlling the user\'s Mac.\n\nSteps:\n1. open a new tab\n2. go to google.com\n3. search "getpod, inc"\n4. open the first link\n5. scroll down\n\nStart with step 1.')).toEqual(['open a new tab','go to google.com','search "getpod, inc"','open the first link','scroll down']);
  expect(parseComputerSteps('ทำตามนี้：\n1) เปิด tab ใหม่\n2) search getpod\n3) scroll ลงมา\nDo them one by one.')).toEqual(['เปิด tab ใหม่','search getpod','scroll ลงมา']);
  expect(parseComputerSteps('Steps: 1. open Chrome 2. scroll down 3. go back')).toEqual(['open Chrome','scroll down','go back']);
  expect(parseComputerSteps('Context.\n- open Chrome\n- scroll down\n\nทำทีละขั้นตอน')).toEqual(['open Chrome','scroll down']);
 });
 test('an unnumbered list ignores a leading preamble, headers and trailing meta-instructions',()=>{
  expect(parseComputerSteps('คุณกำลังควบคุม Mac ของผู้ใช้\n\nขั้นตอน:\nเปิด tab ใหม่, เข้า google, ค้น getpod, เข้า link แรก, scroll ลงมา\n\nเริ่มจากขั้นตอนที่ 1 ก่อน')).toEqual(['เปิด tab ใหม่','เข้า google','ค้น getpod','เข้า link แรก','scroll ลงมา']);
  expect(parseComputerSteps('You are operating the user\'s browser.\n\nopen a new tab, go to google then search getpod\nStart with step 1: open a new tab')).toEqual(['open a new tab','go to google','search getpod']);
  expect(parseComputerSteps('You are controlling the Mac. open a new tab, scroll down')).toEqual(['open a new tab','scroll down']);
  expect(parseComputerSteps('Please do the following:\nopen a new tab\nเข้า google\nscroll ลงมา\n\ndo them one by one')).toEqual(['open a new tab','เข้า google','scroll ลงมา']);
 });
 test('a delegated prompt that is conditional or ambiguous stays on the normal path',()=>{
  expect(parseComputerSteps('If the page asks to log in, stop.\n\n1. open Chrome\n2. scroll down')).toBeUndefined();
  expect(parseComputerSteps('1. open Chrome\n2. scroll down\n\nAlso check the price afterwards.')).toBeUndefined();
  expect(parseComputerSteps('1. open Chrome\n   - use the work profile\n2. scroll down')).toBeUndefined();
  expect(parseComputerSteps('Steps:\n1. open Chrome\n\nMore steps:\n1. scroll down')).toBeUndefined();
  expect(parseComputerSteps('Intro:\nopen Chrome, scroll down\nNext:\ngo back, reload')).toBeUndefined();
  expect(parseComputerSteps('ขั้นตอน:\n'+Array.from({length:13},(_,i)=>`${i+1}. scroll down`).join('\n'))).toBeUndefined();
  expect(parseComputerSteps('Steps:\n1. open Chrome\n2. '+'x'.repeat(301))).toBeUndefined();
  expect(parseComputerSteps('เริ่มจากขั้นตอนที่ 1 ก่อน: เปิด Chrome')).toBeUndefined();
  expect(parseComputerSteps('1. open Chrome\n2.  \n3. scroll down')).toBeUndefined();
 });
 test('anything that is not an unmistakable step list stays on the normal path',()=>{
  expect(parseComputerSteps('เข้า google')).toBeUndefined();
  expect(parseComputerSteps('open Chrome, if it is closed')).toBeUndefined();
  expect(parseComputerSteps('ถ้ามีปุ่ม login ให้กด, แล้ว scroll ลง')).toBeUndefined();
  expect(parseComputerSteps(Array.from({length:13},(_,i)=>'scroll down '+i).join(', '))).toBeUndefined();
  expect(parseComputerSteps('open Chrome, '+'x'.repeat(301))).toBeUndefined();
  expect(parseComputerSteps('1. open Chrome 3. scroll down')).toBeUndefined();
 });
});

test('standard navigation grammar is exact',()=>{
 expect(standardNavigationCommand('ย้อนกลับ')).toBe('navigate:back');
 expect(standardNavigationCommand(' Go  Back ')).toBe('navigate:back');
 expect(standardNavigationCommand('go back to the first result')).toBeUndefined();
});

test('destructive vocabulary ignores quoted payloads',()=>{
 expect(destructiveText('กดส่งข้อความ')).toBe(true);
 expect(destructiveText('click Delete account')).toBe(true);
 expect(destructiveText('OK')).toBe(true);
 expect(destructiveText('OK Google')).toBe(false);
 expect(destructiveText('พิมพ์ "delete me"')).toBe(false);
 expect(destructiveText('scroll down')).toBe(false);
});

test('explicit browse steps run on one lease without returning between steps',async()=>{
 const f=desktop(browsePlan);
 const r=await run(['เปิด tab ใหม่','เข้า google','ค้น xxx','เข้า link แรก','scroll ลงมา','ย้อนกลับ'],f.deps);
 expect(r.stepRun).toEqual({total:6,completed:6,stopReason:'ALL_STEPS_DONE',remaining:[]});
 expect(r.status).toBe('needs_input');expect(r.reason).toBe('COMMAND_WAITING_INPUT');
 // Lease is acquired once and released once, and every tool call carries it.
 expect(f.calls.filter(c=>c.name==='computer_acquire')).toHaveLength(1);
 expect(f.calls.filter(c=>c.name==='computer_release')).toHaveLength(1);
 expect(f.calls.at(-1)?.name).toBe('computer_release');
 for(const c of f.calls.filter(c=>c.name!=='computer_acquire'))expect(c.args.lease_token).toBe('lease-1');
 // New tab (its New Tab control), opening a known site through the address
 // bar, scroll and back are deterministic fast paths: two Jev decisions for six steps.
 expect(f.questions).toHaveLength(2);expect(r.evaluations).toBe(2);
 expect(f.actions().map(a=>[a.kind,a.ref??a.key??a.direction,a.text])).toEqual([
  ['press','newtab',undefined],['type','addr','google.com'],['key','enter',undefined],['type','addr','xxx'],['key','enter',undefined],['press','link1',undefined],['scroll','down',undefined],['navigate','back',undefined]]);
 expect(f.fenced).toHaveLength(8);expect(r.steps).toBe(8);
 // Screenshots only at the stop point, not after every step.
 expect(f.snapshots()).toBe(1);
 expect(r.trace.events.filter(e=>e.phase==='terminal')).toHaveLength(1);
 expect(r.trace.events.filter(e=>e.reason==='STEP_VERIFIED')).toHaveLength(6);
 const sequences=r.trace.events.map(e=>e.sequence);expect(sequences).toEqual([...sequences].sort((a,b)=>a-b));
});

test('typed text comes only from the current step command, never from other steps or prepared inputs',async()=>{
 const f=desktop(browsePlan);
 // "เข้า google" is a deterministic address command; use two searches here.
 await run(['ค้น google','ค้น xxx'],f.deps);
 const offered=f.questions.map(q=>Object.entries(q.questions.text?.criteria??{}).filter(([k])=>k!=='NONE').map(([,v])=>JSON.parse(v).text));
 expect(offered).toEqual([['google'],['xxx']]);
 // A NONE text choice stops before typing anything.
 const g=desktop((command,req)=>answer(req,'type:addr',{submit:true,text:'NONE'}));
 const r=await run(['ค้น google','ค้น xxx'],g.deps);
 expect(g.actions()).toHaveLength(0);
 expect(r.stepRun).toMatchObject({stopReason:'STEP_NOT_EXECUTED',stoppedAt:1,detail:'FIELD_TEXT_REQUIRED',completed:0});
});

test('low Jev confidence returns control with the remaining steps',async()=>{
 const f=desktop((command,req)=>command==='เข้า link แรก'?answer(req,'press:link1',{confidence:.3}):browsePlan(command,req));
 const r=await run(['เปิด tab ใหม่','เข้า link แรก','scroll ลงมา'],f.deps);
 expect(r.stepRun).toMatchObject({stopReason:'STEP_NOT_EXECUTED',detail:'LOW_CONFIDENCE',stoppedAt:2,completed:1,remaining:['เข้า link แรก','scroll ลงมา']});
 expect(r.status).toBe('needs_input');expect(r.reason).toBe('COMMAND_WAITING_INPUT');
 expect(f.actions()).toHaveLength(1);
 expect(f.snapshots()).toBe(1);
 expect(f.calls.filter(c=>c.name==='computer_release')).toHaveLength(1);
});

test('an ambiguous target (BLOCKED) stops rather than guessing',async()=>{
 const f=desktop((command,req)=>answer(req,'BLOCKED'));
 const r=await run(['เข้า link แรก','scroll ลงมา'],f.deps);
 expect(r.stepRun).toMatchObject({stopReason:'STEP_NOT_EXECUTED',stoppedAt:1,detail:'NO_SUPPORTED_ACTION'});
 expect(f.actions()).toHaveLength(0);
});

test('a destructive step is never dispatched from the list',async()=>{
 const f=desktop(browsePlan);
 const r=await run(['เปิด tab ใหม่','กดส่งข้อความ','scroll ลงมา'],f.deps);
 expect(r.stepRun).toMatchObject({stopReason:'DESTRUCTIVE_STEP',stoppedAt:2,completed:1,remaining:['กดส่งข้อความ','scroll ลงมา']});
 expect(f.questions).toHaveLength(0);expect(f.actions()).toHaveLength(1);
 expect(f.snapshots()).toBe(1);
});

test('a destructive target chosen by Jev is fenced before its write-ahead receipt',async()=>{
 const f=desktop((command,req)=>answer(req,'press:danger'));
 const r=await run(['เข้า link แรก','scroll ลงมา'],f.deps);
 expect(r.stepRun).toMatchObject({stopReason:'DESTRUCTIVE_ACTION',stoppedAt:1,completed:0});
 expect(r.status).toBe('needs_input');
 expect(f.fenced).toHaveLength(0);expect(f.actions()).toHaveLength(0);
});

test('a step without an observable AX change stops the run as stuck',async()=>{
 const f=desktop(browsePlan,{inert:['press:link1']});
 const r=await run(['เปิด tab ใหม่','เข้า link แรก','scroll ลงมา'],f.deps);
 expect(r.stepRun).toMatchObject({stopReason:'STEP_NO_EFFECT',stoppedAt:2,completed:1,remaining:['scroll ลงมา']});
 // Dispatched once, never re-sent.
 expect(f.actions().filter(a=>a.ref==='link1')).toHaveLength(1);
 expect(r.trace.events.some(e=>e.reason==='STEP_NO_EFFECT')).toBe(true);
});

test('boundary scrolls are tolerated but reported as unverified',async()=>{
 const f=desktop(browsePlan,{inert:['scroll:down']});
 const r=await run(['scroll ลงมา','scroll ลงมา'],f.deps);
 expect(r.stepRun).toEqual({total:2,completed:2,stopReason:'ALL_STEPS_DONE',remaining:[],unverifiedSteps:[1,2]});
});

test('an unknown outcome is reconciled from receipts only and ends the run without replay',async()=>{
 const f=desktop(browsePlan),call=f.deps.call;let statusReads=0;
 f.deps.call=async(name,args,signal)=>{
  if(name==='computer_action'&&args.ref==='link1'){await call(name,args,signal);return {state:'unknown'};}
  if(name==='computer_operation_status'){statusReads++;return {operation_id:args.operation_id,state:'unknown'};}
  return call(name,args,signal);
 };
 const r=await run(['เปิด tab ใหม่','เข้า link แรก','scroll ลงมา'],f.deps);
 expect(r.status).toBe('needs_reconciliation');expect(r.reason).toBe('OUTCOME_UNKNOWN');
 expect(r.operationId).toBe(f.fenced.at(-1));
 expect(r.stepRun).toMatchObject({stopReason:'OUTCOME_UNKNOWN',stoppedAt:2,completed:1});
 expect(f.actions().filter(a=>a.ref==='link1')).toHaveLength(1);
 expect(f.actions().some(a=>a.kind==='scroll')).toBe(false);
 expect(statusReads).toBe(3);
});

test('a pending recovery at acquire is reported before any step runs',async()=>{
 const f=desktop(browsePlan),call=f.deps.call,operation='22222222-2222-4222-8222-222222222222';
 f.deps.call=async(name,args,signal)=>name==='computer_acquire'?{recovery_required:true,operation_id:operation}:call(name,args,signal);
 const r=await run(['เปิด tab ใหม่','scroll ลงมา'],f.deps);
 expect(r.status).toBe('needs_reconciliation');expect(r.operationId).toBe(operation);
 expect(f.actions()).toHaveLength(0);expect(f.questions).toHaveLength(0);
});

test('a transient not-ready decision is retried only because nothing was dispatched',async()=>{
 let waits=0;
 const f=desktop((command,req)=>command==='เข้า link แรก'&&waits++<1?answer(req,'WAIT'):browsePlan(command,req));
 const r=await run(['เข้า link แรก','scroll ลงมา'],f.deps);
 expect(r.stepRun).toMatchObject({stopReason:'ALL_STEPS_DONE',completed:2});
 expect(f.questions).toHaveLength(2);expect(f.actions()).toHaveLength(2);
});

test('the overall timeout is a hard cap',async()=>{
 const f=desktop(browsePlan);
 f.deps.evaluate=(_req,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 const r=await run(['เข้า link แรก','scroll ลงมา'],f.deps,{timeoutMs:50});
 expect(r.status).toBe('blocked');expect(r.reason).toBe('TIMEOUT');
 expect(r.stepRun).toMatchObject({stopReason:'TIMEOUT',stoppedAt:1});
 expect(f.actions()).toHaveLength(0);
 expect(f.calls.filter(c=>c.name==='computer_release')).toHaveLength(1);
});

test('input validation enforces the step cap',async()=>{
 const f=desktop(browsePlan);
 await expect(run(Array.from({length:13},()=>'scroll ลงมา'),f.deps)).rejects.toThrow();
 await expect(run(['scroll ลงมา'],f.deps)).rejects.toThrow();
 expect(f.calls).toHaveLength(0);
});

// ---- E2E findings from conversation 7d256cb7 (task e0361cb8) ----
test('E2E-4: an inline header before a one-line comma list is not part of step 1',()=>{
 expect(parseComputerSteps('ทำตามขั้นตอนนี้ทีละขั้น: เปิด tab ใหม่, เข้า google.com, ค้น getpod, เข้า link แรก, scroll ลงมา'))
  .toEqual(['เปิด tab ใหม่','เข้า google.com','ค้น getpod','เข้า link แรก','scroll ลงมา']);
 expect(parseComputerSteps('Steps: open https://example.com, scroll down')).toEqual(['open https://example.com','scroll down']);
 // A URL scheme or clock time is not a header.
 expect(parseComputerSteps('เปิด https://example.com, scroll ลงมา')).toEqual(['เปิด https://example.com','scroll ลงมา']);
});

test('E2E-2: a listed step joining two commands runs both; a named shortcut runs that shortcut',async()=>{
 const f=desktop((command,req)=>command==='เปิด Chrome'?answer(req,'open:com.google.Chrome'):browsePlan(command,req));
 f.state.application='com.apple.finder';f.state.windowTitle='Finder';
 f.state.controls.push({ref:'m1',label:'Menu: File → New Tab',role:'AXMenuItem',actions:['press']});
 const call=f.deps.call;
 f.deps.call=async(name,args,signal)=>{if(name==='computer_action'&&args.kind==='open'){f.state.application='com.google.Chrome';f.state.windowTitle='Chrome';}return call(name,args,signal);};
 const r=await run(['เปิด Chrome แล้วกด Cmd+T เพื่อเปิด tab ใหม่','scroll ลงมา'],f.deps);
 expect(f.actions().map(a=>[a.kind,a.app_id??a.ref??a.direction])).toEqual([['open','com.google.Chrome'],['press','m1'],['scroll','down']]);
 expect(r.stepRun).toMatchObject({stopReason:'ALL_STEPS_DONE',completed:2});
 // Opening Chrome alone no longer completes the step when the shortcut is unavailable.
 const g=desktop((command,req)=>answer(req,'open:com.google.Chrome'));
 g.state.controls=g.state.controls.filter((c:any)=>c.ref!=='newtab');
 const stopped=await run(['เปิด Chrome แล้วกด Cmd+T','scroll ลงมา'],g.deps);
 expect(stopped.stepRun).toMatchObject({stopReason:'STEP_NOT_EXECUTED',stoppedAt:1,completed:0,detail:'SHORTCUT_NOT_OFFERED',doneParts:['เปิด Chrome']});
});

test('E2E-1: a step whose target is still loading re-observes instead of stopping at once',async()=>{
 let loaded=false;
 const f=desktop((command,req)=>command==='เข้า link แรก'?answer(req,Object.hasOwn(req.questions.target_press?.criteria??{},'press:link1')?'press:link1':'BLOCKED'):browsePlan(command,req));
 const link=f.state.controls.find((c:any)=>c.ref==='link1');f.state.controls=f.state.controls.filter((c:any)=>c!==link);
 const call=f.deps.call;let observes=0;
 f.deps.call=async(name,args,signal)=>{
  if(name==='computer_observe'&&loaded&&++observes===3)f.state.controls.push(link);
  const value=await call(name,args,signal);
  if(name==='computer_action'&&args.kind==='key')loaded=true;
  return value;
 };
 const r=await run(['ค้น xxx','เข้า link แรก'],f.deps);
 expect(r.stepRun).toMatchObject({stopReason:'ALL_STEPS_DONE',completed:2});
 expect(f.actions().at(-1)).toMatchObject({kind:'press',ref:'link1'});
});

test('E2E e6149724: the first step re-observes a shortcut target that is not shown yet, like later steps',async()=>{
 const f=desktop(browsePlan);
 const newtab=f.state.controls.find((c:any)=>c.ref==='newtab');f.state.controls=f.state.controls.filter((c:any)=>c!==newtab);
 const call=f.deps.call;let observes=0;
 f.deps.call=async(name,args,signal)=>{if(name==='computer_observe'&&++observes===2)f.state.controls.unshift(newtab);return call(name,args,signal);};
 const r=await run(['เปิด tab ใหม่','scroll ลงมา'],f.deps);
 expect(f.actions().map(a=>[a.kind,a.ref??a.direction])).toEqual([['press','newtab'],['scroll','down']]);
 expect(r.stepRun).toMatchObject({stopReason:'ALL_STEPS_DONE',completed:2});
});

// PR #525 review F1: a step of a list must never stop the list as READ_REQUEST;
// only a single direct command under user control is offered it.
describe('step lists and READ_REQUEST',()=>{
 test('no step of a list is offered READ_REQUEST',async()=>{
  const d=desktop(browsePlan);
  const r=await run(['ค้น xxx','เข้า link แรก'],d.deps);
  expect(d.questions.length).toBeGreaterThan(0);
  for(const q of d.questions)expect(Object.keys(q.questions.action.criteria)).not.toContain('READ_REQUEST');
  expect(r.stepRun).toMatchObject({total:2,completed:2});
 });
});
