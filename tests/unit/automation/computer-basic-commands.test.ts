import {runComputerUse,type ComputerUseDependencies} from '../../../src/automation/computer-use';
import {standardKeyboardCommand,textCommand} from '../../../src/automation/computer-command';
import {computerContinuationContext} from '../../../src/orchestration/gateway-tasks/computer-context';

// Shapes recorded from conversation 7d256cb7, task e0361cb8: revision 9 (Chrome,
// address bar focused), 28-32 (Apple Maps search field), 35-39 (Maps zoom).
const menu=(labels:string[])=>labels.map((label,i)=>({ref:'m'+i,role:'AXMenuItem',label:'Menu: '+label,actions:['press'],focused:false}));
function chrome(){
 return {generation:'g1',application:'com.google.Chrome',windowTitle:'New Tab - Google Chrome',truncated:true,
  apps:[{id:'com.google.Chrome',name:'Google Chrome'},{id:'com.apple.Maps',name:'Maps'}],
  focusedControl:{ref:'c0',role:'AXTextField',label:'Address and search bar'},
  controls:[
   {ref:'c0',identity:'11111111-1111-4111-8111-111111111111',role:'AXTextField',label:'Address and search bar',value:'',focused:true,actions:['press','type']},
   {ref:'c1',identity:'22222222-2222-4222-8222-222222222222',role:'AXTextArea',label:'Ask Google',value:'',actions:['press','type']},
   {ref:'c5',role:'AXButton',label:'New Tab',actions:['press']},
   ...menu(['Chrome → Quit Google Chrome','File → New Tab','File → Close Tab','Window → Zoom']),
  ]};
}
function maps(focused:boolean){
 return {generation:'g1',application:'com.apple.Maps',windowTitle:'Maps',truncated:true,apps:[{id:'com.apple.Maps',name:'Maps'}],
  focusedControl:focused?{ref:'c0',role:'AXTextField',label:'Apple Maps'}:{role:'AXGroup',label:'AXGroup'},
  controls:[
   {ref:'c0',identity:'33333333-3333-4333-8333-333333333333',role:'AXTextField',label:'Apple Maps',value:'',focused,actions:['press','type']},
   {ref:'c13',role:'AXButton',label:'Zoom out',actions:['press']},{ref:'c14',role:'AXButton',label:'Zoom in',actions:['press']},
   ...menu(['Maps → Quit Maps','Window → Zoom','View → Zoom In']),
  ]};
}
const choice=(criteria:Record<string,unknown>,chosen:string,confidence:number)=>({choice:chosen,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?confidence:(1-confidence)/(Object.keys(criteria).length-1||1)]))});
/** A desktop that enforces focus for typing, like the native executor (FOCUS_REQUIRED). */
function fixture(initial:any,plan:(req:any)=>string|undefined=()=>undefined){
 const state=structuredClone(initial);let generation=1;const calls:any[]=[],requests:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async(name,args)=>{
   calls.push({name,args});
   if(name==='computer_acquire')return {lease_token:'lease'};
   if(name==='computer_observe')return structuredClone({...state,generation:'g'+generation});
   if(name==='computer_action'){
    const control=state.controls.find((c:any)=>c.ref===args.ref);
    if(args.kind==='type'&&!control.focused)return {state:'not_executed',error:'FOCUS_REQUIRED'};
    generation++;
    if(args.kind==='press'&&control?.actions.includes('type')){for(const c of state.controls)c.focused=c===control;state.focusedControl={ref:control.ref,role:control.role,label:control.label};}
    if(args.kind==='type')control.value=args.text;
    return {state:'completed'};
   }
   return {};
  },
  evaluate:async req=>{requests.push(req);const chosen=plan(req);const kind=chosen?.split(':')[0]??'BLOCKED';
   // "submit_text:ref" answers the submit operation with its type target.
   const target=kind==='submit_text'?'type':kind,targetChoice=kind==='submit_text'?'type:'+chosen!.split(':')[1]:chosen;
   return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choice(q.criteria as any,name==='action'?kind:name==='target_'+target?targetChoice!:name==='text'?Object.keys((q as any).criteria).find(k=>k!=='NONE')??'NONE':'BLOCKED',0.95)]))};}};
 return {deps,calls,requests,state,actions:()=>calls.filter(c=>c.name==='computer_action').map(({args:{lease_token,operation_id,generation,...rest}})=>rest)};
}
const run=(f:ReturnType<typeof fixture>,goal:string,context?:string)=>runComputerUse({goal,yieldAfterInteraction:true,...(context?{interactionContext:context}:{})},f.deps,new AbortController().signal);

describe('P1-4 basic commands run without a Jev round-trip',()=>{
 test.each([['เข้า google','google.com'],['เปิด google','google.com'],['www.google.com','www.google.com'],['go to https://example.com/a','https://example.com/a'],['เปิด youtube','youtube.com']])('%s types %s into the address bar and presses Enter',async(command,url)=>{
  const f=fixture(chrome());
  await run(f,command);
  expect(f.requests).toHaveLength(0);
  expect(f.actions()).toEqual([{kind:'type',ref:'c0',text:url},{kind:'key',key:'enter'}]);
 });
 // Quitting is Jev's own quit choice: one decision, then the app's own Quit command.
 test.each(['ปิด chrome','quit chrome','ปิดแอป','Cmd+Q'])('%s quits the front app through its own Quit menu command',async command=>{
  const f=fixture(chrome(),()=>'quit:m0');
  const r=await run(f,command);
  expect(f.requests).toHaveLength(1);expect(f.actions()).toEqual([{kind:'press',ref:'m0'}]);
  expect(r.lastAction).toMatchObject({kind:'press',label:'Menu: Chrome → Quit Google Chrome'});
 });
 test('quitting an app that is not in front is refused rather than guessed',async()=>{
  const f=fixture(chrome());const r=await run(f,'ปิด maps');
  expect(f.requests[0].questions.target_quit).toBeDefined();
  expect(f.actions()).toEqual([]);expect(r.trace.events.some(e=>e.reason==='NO_SUPPORTED_ACTION')).toBe(true);
 });
 test('ปิด tab presses Close Tab',async()=>{const f=fixture(chrome());await run(f,'ปิด tab');expect(f.actions()).toEqual([{kind:'press',ref:'m2'}]);});
});

describe('P1-5 text extraction',()=>{
 test('revision 9: "ค้นหาเที่ยวบิน เชียงใหม่ โอซาก้า" types the query and submits it',async()=>{
  // Jev still chooses the field and operation; the query is now a candidate.
  const f=fixture(chrome(),()=>'submit_text:c0');await run(f,'ค้นหาเที่ยวบิน เชียงใหม่ โอซาก้า');
  expect(Object.values(f.requests[0].questions.text.criteria)).toContain(JSON.stringify({text:'เที่ยวบิน เชียงใหม่ โอซาก้า'}));
  expect(f.actions()).toEqual([{kind:'type',ref:'c0',text:'เที่ยวบิน เชียงใหม่ โอซาก้า'},{kind:'key',key:'enter'}]);
 });
 test('revision 30: bare text with a focused field is typed without Enter, as Jev decides',async()=>{
  const f=fixture(maps(true),()=>'type:c0');await run(f,'starwork');
  expect(f.requests).toHaveLength(1);
  expect(Object.values(f.requests[0].questions.text.criteria)).toContain(JSON.stringify({text:'starwork'}));
  expect(f.actions()).toEqual([{kind:'type',ref:'c0',text:'starwork'}]);
 });
 test('bare text naming a visible control is not typed',async()=>{
  const f=fixture(maps(true),req=>'press:c14');await run(f,'zoom');
  expect(f.actions()).toEqual([{kind:'press',ref:'c14'}]);
 });
 test('vocabulary',()=>{
  expect(textCommand('search cats')).toEqual({text:'cats',submit:true});
  expect(textCommand('พิมพ์ "l;ylfu"')).toEqual({text:'l;ylfu',submit:false});
  expect(textCommand('พิมพ์ getpod ใน search box')).toBeUndefined();
 });
});

describe('P1-6 typing into an unfocused field focuses it first in the same command',()=>{
 test('revision 28: "ค้นหา starwork" in Maps clicks the field, types and submits, with one Jev decision',async()=>{
  const f=fixture(maps(false),req=>'submit_text:c0');
  const r=await run(f,'ค้นหา starwork');
  expect(f.requests).toHaveLength(1);
  expect(f.actions()).toEqual([{kind:'type',ref:'c0',text:'starwork'},{kind:'press',ref:'c0'},{kind:'type',ref:'c0',text:'starwork'},{kind:'key',key:'enter'}]);
  expect(r.trace.events.some(e=>e.reason==='FOCUS_REQUIRED'&&e.phase==='waiting')).toBe(false);
 });
});

describe('P1-7 bare key names',()=>{
 test.each([['enter','enter'],['Enter','enter'],['return','enter'],['tab','tab'],['esc','escape'],['escape','escape'],['up','up'],['ลูกศรลง','down'],['arrow left','left'],['เอ็นเทอร์','enter']])('%s → %s',(command,key)=>{
  expect(standardKeyboardCommand(command)).toBe(key);
 });
 test('revision 32: "enter" with a focused field presses Enter without asking Jev',async()=>{
  const f=fixture(maps(true));await run(f,'enter');expect(f.requests).toHaveLength(0);expect(f.actions()).toEqual([{kind:'key',key:'enter'}]);
 });
});

describe('P1-8 command context and in-content preference',()=>{
 test('"zoom" offers the in-content Zoom buttons, not Window → Zoom',async()=>{
  const f=fixture(maps(false),req=>'press:c14');await run(f,'zoom');
  const offered=Object.keys(f.requests[0].questions.target_press.criteria);
  expect(offered).toContain('press:c14');expect(offered.some(id=>id.startsWith('press:m'))).toBe(false);
 });
 test('menu-bar commands are their own choice for Jev',async()=>{
  const f=fixture(maps(false),req=>'menu:m1');await run(f,'เมนู window zoom');
  expect(Object.keys(f.requests[0].questions.target_menu.criteria)).toContain('menu:m1');
  expect(f.actions()).toEqual([{kind:'press',ref:'m1'}]);
 });
 test('the previous action and its target reach Jev as context',()=>{
  const note=computerContinuationContext({observedAt:1,state:{application:'com.apple.Maps'}},[],'zoom',{kind:'press',label:'Zoom in',role:'AXButton'});
  expect(note).toContain('"previousAction":{"kind":"press","label":"Zoom in","role":"AXButton"}');
 });
});
