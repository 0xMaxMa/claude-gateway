import {randomUUID} from 'node:crypto';
import {runComputerUse,type ComputerUseDependencies} from '../../../src/automation/computer-use';
import {runBrowserUse,type BrowserUseDependencies,type Observation} from '../../../src/automation/browser-use';

// Hardcoded keyword decisions moved to Jev (audit 0fcf9167, items a2-a6): each
// command below has no Thai/English keyword to match, so only Jev's own choice
// can carry it. The phrase lists that remain are fast paths, not gates.

const menu=(labels:string[])=>labels.map((label,i)=>({ref:'m'+i,role:'AXMenuItem',label:'Menu: '+label,actions:['press'],focused:false}));
function chrome(fieldLabel='アドレス検索バー',extra:any[]=[]){
 return {generation:'g1',application:'com.google.Chrome',windowTitle:'新しいタブ - Google Chrome',truncated:false,
  apps:[{id:'com.google.Chrome',name:'Google Chrome'}],
  focusedControl:{ref:'c0',role:'AXTextField',label:fieldLabel},
  controls:[
   {ref:'c0',identity:'11111111-1111-4111-8111-111111111111',role:'AXTextField',label:fieldLabel,value:'',focused:true,actions:['press','type']},
   {ref:'b1',role:'AXButton',label:'送信',actions:['press']},
   ...extra,
   ...menu(['Chrome → Google Chromeを終了','編集 → コピー','Edit → Copy']),
  ]};
}
function notes(){
 return {generation:'g1',application:'com.apple.Notes',windowTitle:'Notes',truncated:false,apps:[{id:'com.apple.Notes',name:'Notes'}],
  focusedControl:{ref:'c0',role:'AXTextArea',label:'Note'},
  controls:[
   {ref:'c0',identity:'33333333-3333-4333-8333-333333333333',role:'AXTextArea',label:'Note',value:'',focused:true,actions:['press','type']},
   {ref:'n1',role:'AXButton',label:'Close',context:'Notification: Update available',actions:['press']},
   ...menu(['Notes → Quit Notes','Edit → Copy']),
  ]};
}
const choice=(criteria:Record<string,unknown>,chosen:string,confidence:number)=>({choice:chosen,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?confidence:(1-confidence)/(Object.keys(criteria).length-1||1)]))});
/** A desktop that enforces focus for typing. plan: "kind:id" for the action, or a field id for the address question. */
function desktop(initial:any,plan:(req:any)=>string|undefined=()=>undefined,confidence=0.95){
 const state=structuredClone(initial);let generation=1;const calls:any[]=[],requests:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async(name,args)=>{
   calls.push({name,args});
   if(name==='computer_acquire')return {lease_token:'lease'};
   if(name==='computer_observe')return structuredClone({...state,generation:'g'+generation});
   if(name==='computer_action'){
    const control=state.controls.find((c:any)=>c.ref===args.ref);
    if(args.kind==='type'&&!control.focused)return {state:'not_executed',error:'FOCUS_REQUIRED'};
    generation++;if(args.kind==='type')control.value=args.text;
    return {state:'completed'};
   }
   return {};
  },
  evaluate:async req=>{requests.push(req);const chosen=plan(req);const kind=chosen?.split(':')[0]??'BLOCKED';
   return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q]:[string,any])=>[name,choice(q.criteria,
    name==='field'?chosen??'NONE':name==='impact'?'HIGH_IMPACT':name==='action'?kind:name==='target_'+kind?chosen!:name==='text'?Object.keys(q.criteria).find(k=>k!=='NONE')??'NONE':'BLOCKED',confidence)]))};}};
 return {deps,requests,actions:()=>calls.filter(c=>c.name==='computer_action').map(({args:{lease_token,operation_id,generation,...rest}})=>rest)};
}
const command=(f:ReturnType<typeof desktop>,goal:string,extra:Record<string,unknown>={})=>runComputerUse({goal,yieldAfterInteraction:true,...extra},f.deps,new AbortController().signal);

describe('a2 Computer Use: Jev decides between typing and acting when a field has focus',()=>{
 test('a Japanese command to press a button presses it instead of typing the command',async()=>{
  const f=desktop(chrome(),()=>'press:b1');
  await command(f,'送信ボタンを押して');
  expect(f.requests).toHaveLength(1);
  expect(f.actions()).toEqual([{kind:'press',ref:'b1'}]);
 });
 test('Japanese dictation is typed as the whole command when Jev chooses typing',async()=>{
  const f=desktop(notes(),()=>'type:c0');
  await command(f,'こんにちは');
  expect(f.requests).toHaveLength(1);
  expect(Object.values(f.requests[0].questions.text.criteria)).toContain(JSON.stringify({text:'こんにちは'}));
  expect(f.actions()).toEqual([{kind:'type',ref:'c0',text:'こんにちは'}]);
 });
});

describe('a4 Computer Use: menu-bar commands are offered to Jev by meaning',()=>{
 test.each(['コピーして','คัดลอก'])('%s chooses Edit → Copy although no word matches',async goal=>{
  const f=desktop(notes(),()=>'menu:m1');
  await command(f,goal);
  expect(Object.keys(f.requests[0].questions.target_menu.criteria)).toEqual(['BLOCKED','menu:m0','menu:m1']);
  // In-content controls and menu-bar commands stay separate choices.
  expect(Object.keys(f.requests[0].questions.target_press.criteria).some(id=>id.includes(':m'))).toBe(false);
  expect(f.actions()).toEqual([{kind:'press',ref:'m1'}]);
 });
});

describe('a5 Computer Use: quitting is Jev\'s own choice, not a word at the start of the command',()=>{
 test('"close notification" presses the notification\'s Close button',async()=>{
  const f=desktop(notes(),()=>'press:n1');
  const r=await command(f,'close notification');
  expect(f.requests).toHaveLength(1);
  expect(f.actions()).toEqual([{kind:'press',ref:'n1'}]);
  expect(r.trace.events.some(e=>e.reason==='SHORTCUT_UNAVAILABLE')).toBe(false);
 });
 test('a Japanese quit command quits through the app\'s own (Japanese) Quit menu command',async()=>{
  const f=desktop(chrome(),()=>'quit:m0');
  const r=await command(f,'Chromeを終了して');
  expect(f.requests[0].questions.action.criteria.quit).toBeDefined();
  expect(f.actions()).toEqual([{kind:'press',ref:'m0'}]);
  expect(r.lastAction).toMatchObject({kind:'press',label:'Menu: Chrome → Google Chromeを終了'});
 });
 // Session d8013081: a separate 0.85 bar refused "ปิด chrome" at 0.79/0.77. Jev's normal bar applies.
 test('quitting uses Jev\'s normal confidence bar: 0.7 quits, 0.4 does not',async()=>{
  const sure=desktop(chrome(),()=>'quit:m0',0.7);
  await command(sure,'Chromeを終了して');
  expect(sure.actions()).toEqual([{kind:'press',ref:'m0'}]);
  const unsure=desktop(chrome(),()=>'quit:m0',0.4);
  const r=await command(unsure,'Chromeを終了して');
  expect(unsure.actions()).toEqual([]);
  expect(r.trace.events.some(e=>e.reason==='LOW_CONFIDENCE')).toBe(true);
 });
 test('the agent\'s command for a handed-off utterance may quit, after the user confirms',async()=>{
  const f=desktop(chrome(),()=>'quit:m0');
  const r=await command(f,'Chromeを終了して',{agentCommand:true});
  expect(f.requests[0].questions.action.criteria.quit).toBeDefined();
  expect(f.actions()).toEqual([]);
  expect(r.lastAction).toMatchObject({confirm:true});
 });
});

describe('a6 Computer Use: the address bar is found by role, not by its on-screen name',()=>{
 test('a Japanese-labelled address bar takes the address without a Jev round-trip',async()=>{
  const f=desktop(chrome());
  await command(f,'https://example.jp');
  expect(f.requests).toHaveLength(0);
  expect(f.actions()).toEqual([{kind:'type',ref:'c0',text:'https://example.jp'},{kind:'key',key:'enter'}]);
 });
 test('with several text fields Jev picks the address bar',async()=>{
  const f=desktop(chrome('アドレス検索バー',[{ref:'c2',identity:'22222222-2222-4222-8222-222222222222',role:'AXTextField',label:'検索',value:'',actions:['press','type']}]),req=>req.questions.field?'field:c0':undefined);
  await command(f,'เข้า google');
  expect(Object.keys(f.requests[0].questions.field.criteria)).toEqual(['NONE','field:c0','field:c2']);
  expect(f.actions()).toEqual([{kind:'type',ref:'c0',text:'google.com'},{kind:'key',key:'enter'}]);
 });
 test('outside a browser a text field is never taken for an address bar',async()=>{
  const f=desktop(notes());
  await command(f,'เข้า google');
  expect(f.actions()).toEqual([]);
  expect(f.requests[0].questions.field).toBeUndefined();
 });
});

// Remote Browser (a3): back/forward, keys and a new tab are Jev operations too.
const scope={device_id:'device',grant_id:'grant',tab_id:'tab'};
const page=(patch:Partial<Observation>={}):Observation=>({protocol_version:1,generation:'g1',url:'https://start.test/',title:'Start',text:'Start page',
 elements:[{ref:'e0',label:'About',tag:'button',operations:['CLICK'],in_viewport:true}],scroll:{up:false,down:true},
 truncated:{text:false,elements:false},navigation:{can_go_back:true,can_go_forward:false},...patch} as Observation);
function extension(initial=page()){
 let current=structuredClone(initial),generation=1;const calls:Array<{name:string;args:Record<string,unknown>}>=[];
 const call:BrowserUseDependencies['call']=async(name,args)=>{
  calls.push({name,args});
  if(name==='browser_task_acquire')return {state:'completed',result:{protocol_version:1,lease_token:randomUUID()}};
  if(name.startsWith('browser_task_'))return {state:'completed',result:{}};
  if(name==='page_observe')return structuredClone(current);
  current={...current,generation:'g'+ ++generation};
  return {state:'completed',result:{observation:structuredClone(current)}};
 };
 return {call,mutations:()=>calls.filter(c=>!c.name.startsWith('browser_task_')&&c.name!=='page_observe')};
}
function jev(pick:Record<string,string>){
 const requests:any[]=[];
 const evaluate:BrowserUseDependencies['evaluate']=async request=>{requests.push(request);return {model:'test-jev',answers:Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
  const ids=Object.keys(q.criteria),selected=pick[key]??(key==='operation'?'BLOCKED':ids[0]);
  return [key,{choice:selected,confidence:0.95,probabilities:Object.fromEntries(ids.map(id=>[id,id===selected?1:0]))}];
 }))};};
 return {evaluate,requests};
}
const browse=(goal:string,b:ReturnType<typeof extension>,j:ReturnType<typeof jev>,extra:Record<string,unknown>={})=>
 runBrowserUse({goal,scope,command:true,yieldAfterAction:true,...extra} as never,{call:b.call,evaluate:j.evaluate},new AbortController().signal);

describe('a3 Remote Browser: history, keys and a new tab are Jev operations',()=>{
 test('a Japanese "go back" goes back in the tab',async()=>{
  const b=extension(),j=jev({operation:'HISTORY_BACK'});
  const r=await browse('前のページに戻って',b,j);
  expect(b.mutations()).toEqual([{name:'tab_history',args:expect.objectContaining({direction:'back'})}]);
  expect(r.commandOutcome).toMatchObject({done:true,action:{kind:'history',direction:'back'}});
 });
 test('going forward with no forward history reports it',async()=>{
  const b=extension(),j=jev({operation:'HISTORY_FORWARD'});
  const r=await browse('次のページへ',b,j);
  expect(b.mutations()).toEqual([]);
  expect(r.commandOutcome).toMatchObject({done:false,reason:'HISTORY_UNAVAILABLE'});
 });
 test('a Japanese key command presses the key Jev names',async()=>{
  const b=extension(),j=jev({operation:'KEY',key_target:'Escape'});
  const r=await browse('エスケープキーを押して',b,j);
  expect(Object.keys(j.requests[0].questions.key_target.criteria)).toEqual(['Enter','Tab','Escape','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
  expect(b.mutations()).toEqual([{name:'page_keypress',args:expect.objectContaining({key:'Escape'})}]);
  expect(r.commandOutcome).toMatchObject({done:true,action:{kind:'key',key:'Escape'}});
 });
 test('a Japanese new-tab command is answered, not performed',async()=>{
  const b=extension(),j=jev({operation:'NEW_TAB'});
  const r=await browse('新しいタブを開いて',b,j);
  expect(b.mutations()).toEqual([]);
  expect(r.commandOutcome).toMatchObject({done:false,reason:'NEW_TAB_OUT_OF_SCOPE'});
 });
 test('steps and an old extension are not offered these operations; the agent\'s command is, without READ_REQUEST',async()=>{
  for(const [extra,observation] of [[{command:false},page()],[{stepPart:true},page()],[{},page({navigation:undefined})]] as const){
   const j=jev({});await browse('前のページに戻って',extension(observation as Observation),j,extra);
   const offered=Object.keys(j.requests[0].questions.operation.criteria);
   expect(offered).not.toContain('HISTORY_BACK');expect(offered).not.toContain('KEY');
  }  const agent=jev({});await browse('前のページに戻って',extension(page()),agent,{agentCommand:true});
  const offered=Object.keys(agent.requests[0].questions.operation.criteria);
  expect(offered).toEqual(expect.arrayContaining(['HISTORY_BACK','KEY']));expect(offered).not.toContain('READ_REQUEST');expect(offered).not.toContain('UNCLEAR');
 });
 test('the exact phrase stays a fast path with no Jev round-trip',async()=>{
  const b=extension(),j=jev({});
  await browse('ย้อนกลับ',b,j);
  expect(j.requests).toHaveLength(0);
  expect(b.mutations()).toEqual([{name:'tab_history',args:expect.objectContaining({direction:'back'})}]);
 });
});

describe('a7 the previous command reaches Jev as context (no "again" rewrite)',()=>{
 test('Computer Use passes it as previousInteraction',async()=>{
  const f=desktop(notes(),()=>'press:n1');
  await command(f,'もう一回',{interactionContext:'Recorded interaction context: {"previousCommand":"close notification"}'});
  expect(f.requests[0].state.command).toBe('もう一回');
  expect(f.requests[0].state.previousInteraction).toContain('"previousCommand":"close notification"');
 });
 test('Remote Browser passes it as previous_interaction',async()=>{
  const j=jev({operation:'SCROLL_DOWN'});
  await browse('もう一回',extension(),j,{interactionContext:'Recorded interaction context: {"previousCommand":"下にスクロール"}'});
  expect(j.requests[0].state.goal).toBe('もう一回');
  expect(j.requests[0].state.previous_interaction).toContain('"previousCommand":"下にスクロール"');
 });
});
