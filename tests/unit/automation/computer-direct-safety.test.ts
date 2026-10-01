import {runComputerUse,type ComputerUseDependencies} from '../../../src/automation/computer-use';
import {eraseCommand} from '../../../src/automation/computer-safety';
import {computerOutcomeText} from '../../../src/automation/computer-outcome';

// Shapes recorded from conversation 7d256cb7, task e0361cb8 revisions 43-45
// (Notes, AXTextArea focused with "l;ylfu") and revision 1 (Chrome, Google
// results). Labels and roles are copied; menu rows are abbreviated.
const menus=(app:string,items:string[])=>items.map((label,i)=>({ref:'m'+i,role:'AXMenuItem',label:`Menu: ${app} → ${label}`,actions:['press'],focused:false}));
function notes(){
 return {generation:'g1',application:'com.apple.Notes',windowTitle:'Notes',truncated:true,apps:[{id:'com.apple.Notes',name:'Notes'}],
  focusedControl:{ref:'c0',role:'AXTextArea',label:'AXTextArea'},text:['Today','l;ylfu'],
  controls:[
   {ref:'c0',role:'AXTextArea',label:'AXTextArea',value:'l;ylfu',focused:true,actions:['press','type'],context:'Today · l;ylfu'},
   {ref:'c1',role:'AXTextField',label:'AXTextField',value:'',actions:['press','type'],context:'Search'},
   {ref:'c7',role:'AXButton',label:'Delete',actions:['press']},
   {ref:'c8',role:'AXButton',label:'New Note',actions:['press']},
   ...menus('Notes',['About Notes','Quit Notes']),
  ]};
}
function chrome(){
 return {generation:'g1',application:'com.google.Chrome',windowTitle:'getpod - ค้นหาด้วย Google - Google Chrome',truncated:true,apps:[{id:'com.google.Chrome',name:'Google Chrome'}],
  focusedControl:{role:'AXWebArea',label:'getpod - ค้นหาด้วย Google'},
  controls:[
   {ref:'c0',role:'AXTextArea',label:'ค้นหา',value:'getpod',actions:['press','type']},
   {ref:'c10',role:'AXButton',label:'New Tab',actions:['press']},
   {ref:'c50',role:'AXLink',label:'GetPod — Cloud dev environments',actions:['press']},
   ...['Chrome → About Google Chrome','File → New Tab','File → New Window','File → Close Tab','History → Show Full History','Help → Report an Issue…']
     .map((label,i)=>({ref:'m'+i,role:'AXMenuItem',label:'Menu: '+label,actions:['press'],focused:false})),
  ]};
}
const choice=(criteria:Record<string,unknown>,chosen:string,confidence:number)=>({choice:chosen,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?confidence:(1-confidence)/(Object.keys(criteria).length-1||1)]))});
function fixture(state:any,chosen?:string,confidence=1,extra:Record<string,string>={}){
 const calls:any[]=[],requests:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async(name,args)=>{calls.push({name,args});return name==='computer_acquire'?{lease_token:'lease'}:name==='computer_observe'?structuredClone(state):{state:'completed'};},
  evaluate:async req=>{requests.push(req);const kind=chosen?.split(':')[0]??'BLOCKED';
   return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choice(q.criteria as any,extra[name]??(name==='action'?kind:name==='target_'+kind?chosen!:name==='text'?'NONE':name==='impact'?'HIGH_IMPACT':'BLOCKED'),confidence)]))};}};
 const actions=()=>calls.filter(c=>c.name==='computer_action').map(c=>c.args);
 return {deps,calls,requests,actions};
}
// The gateway's single direct command under user control (gateway-tasks/computer.ts).
const run=(f:ReturnType<typeof fixture>,goal:string)=>runComputerUse({goal,yieldAfterInteraction:true,readRequest:true},f.deps,new AbortController().signal);

describe('P0-2 erase vs Delete (revision 43: "ลบๆๆๆ" pressed Notes Delete at confidence 0.59)',()=>{
 test('an erase command in a focused text field erases characters instead of asking Jev',async()=>{
  const f=fixture(notes(),'press:c7',0.59);
  const r=await run(f,'ลบๆๆๆ');
  expect(f.requests).toHaveLength(0);
  expect(f.actions()).toEqual([expect.objectContaining({kind:'type',ref:'c0',text:'l;'})]);
  expect(r.lastAction).toMatchObject({kind:'erase',label:'AXTextArea',count:4});
 });
 // Session d8013081: the user's own command is their authorization. Whatever
 // Jev confidently picks for it runs; no word in the command has to name it.
 test('a press Jev picks for the user\'s command runs, whatever the control or the words',async()=>{
  const state=notes();delete (state as any).focusedControl;state.controls[0].focused=false;
  for(const command of ['ลบ','send','送信','กดปุ่มนั้น']){
   const f=fixture(state,'press:c7',0.77);await run(f,command);
   expect(f.actions()).toEqual([expect.objectContaining({kind:'press',ref:'c7'})]);
  }
 });
 test('below Jev\'s normal confidence bar nothing is pressed (LOW_CONFIDENCE)',async()=>{
  const state=notes();delete (state as any).focusedControl;state.controls[0].focused=false;
  const f=fixture(state,'press:c7',0.4);
  const r=await run(f,'ลบๆๆๆ');
  expect(f.actions()).toEqual([]);
  expect(r.trace.events.some(e=>e.reason==='LOW_CONFIDENCE')).toBe(true);
 });
 test('"ok" on a dialog presses what Jev picks',async()=>{
  const dialog={generation:'g2',application:'com.apple.Notes',windowTitle:'',truncated:false,apps:[],focusedControl:{role:'AXSheet',label:'alert'},
   text:['Are you sure you want to delete this note?'],controls:[{ref:'c0',role:'AXButton',label:'OK',actions:['press'],context:'Are you sure you want to delete this note?'}]};
  const ok=fixture(dialog,'press:c0',0.95);await run(ok,'ok');expect(ok.actions()).toHaveLength(1);
 });
 test('erase vocabulary',()=>{
  expect(eraseCommand('ลบ')).toBe(1);expect(eraseCommand('ลบๆๆๆ')).toBe(4);expect(eraseCommand('delete 3')).toBe(3);expect(eraseCommand('backspace x2')).toBe(2);
  expect(eraseCommand('ลบ note นี้')).toBeUndefined();expect(eraseCommand('delete account')).toBeUndefined();
 });
});

describe('E2E-1 in-content controls are not diluted by menu-bar items',()=>{
 test('menu items unrelated to the command are not offered to Jev',async()=>{
  const f=fixture(chrome(),'press:c50',0.9);
  await run(f,'เข้า link แรก');
  const offered=Object.keys(f.requests[0].questions.target_press.criteria);
  expect(offered).toContain('press:c50');expect(offered.some(id=>id.startsWith('press:m'))).toBe(false);
 });
 test('menu-bar items are offered as their own menu choice',async()=>{
  const f=fixture(chrome(),'menu:m4',0.9);
  await run(f,'show full history');
  expect(Object.keys(f.requests[0].questions.target_menu.criteria)).toContain('menu:m4');
 });
});

describe('E2E-2 shortcut steps execute their shortcut',()=>{
 test.each(['เปิด tab ใหม่','กด Cmd+T เพื่อเปิด tab ใหม่','new tab','⌘T'])('%s presses New Tab without inference',async command=>{
  const f=fixture(chrome(),'open:com.google.Chrome',0.9);
  const r=await run(f,command);
  expect(f.requests).toHaveLength(0);
  expect(f.actions()).toEqual([expect.objectContaining({kind:'press',ref:'m1'})]);
  expect(r.lastAction).toMatchObject({kind:'press',label:'Menu: File → New Tab'});
 });
 test('an unavailable shortcut returns control rather than doing something else',async()=>{
  const f=fixture(notes(),'press:c8',0.9);
  const r=await run(f,'Cmd+T');
  expect(f.actions()).toEqual([]);expect(r.trace.events.some(e=>e.reason==='SHORTCUT_UNAVAILABLE')).toBe(true);
 });
});

describe('P0-3 per-command outcome text',()=>{
 const base={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:1,phase:'terminal'};
 test.each([
  [{...base,lastAction:{kind:'press',label:'Delete',role:'AXButton'},trace:[{phase:'waiting',reason:'ACTION_DISPATCHED'}]},/Done: pressed "Delete"/],
  [{...base,steps:0,trace:[{phase:'decided',confidence:0.42},{phase:'waiting',reason:'LOW_CONFIDENCE'}]},/Not done.*0\.42/],
  [{...base,steps:0,trace:[{phase:'waiting',reason:'FIELD_TEXT_REQUIRED'}]},/Not done.*quotes/],
  [{...base,steps:0,trace:[{phase:'waiting',reason:'FOCUS_REQUIRED'}]},/Not done.*focus/i],
  [{...base,steps:0,trace:[{phase:'waiting',reason:'NO_SUPPORTED_ACTION'}]},/Not done.*no visible control/i],
  [{...base,steps:0,lastAction:{kind:'press',label:'Delete',blocked:true,confirm:true},trace:[{phase:'waiting',reason:'CONFIRMATION_REQUIRED'}]},/Not done.*"Delete".*asked to confirm/],
  [{...base,steps:5,stepRun:{total:5,completed:3,stopReason:'STEP_NOT_EXECUTED',stoppedAt:4,stoppedStep:'เข้า link แรก',detail:'NO_SUPPORTED_ACTION',remaining:['เข้า link แรก','scroll ลงมา']}},/3\/5 steps done.*step 4 "เข้า link แรก".*NO_SUPPORTED_ACTION/s],
 ])('%#',(report,expected)=>{expect(computerOutcomeText(report as any)).toMatch(expected);});
});

// Session 3e950913 asked to read the page aloud under direct control. Jev decides
// READ_REQUEST (no keyword list); nothing is pressed and the agent answers.
describe('READ_REQUEST: a direct command that asks about the screen',()=>{
 const ask='อ่านให้ฟังหน่อย ลิเวอร์พูลจะเตะกับใครในแมตช์ถัดไป';
 test('Jev READ_REQUEST dispatches nothing and is reported as a read request',async()=>{
  const {readRequested,directCommandSpeech}=await import('../../../src/automation/command-speech');
  const f=fixture(chrome(),'READ_REQUEST');
  const r=await run(f,ask);
  expect(Object.keys(f.requests[0].questions.action.criteria)).toContain('READ_REQUEST');
  expect(f.actions()).toEqual([]);
  expect(r).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0});
  // The gateway adapter records trace events on the task report.
  const report={...r,trace:r.trace.events} as never;
  expect(readRequested({computerReport:report})).toBe(true);
  expect(computerOutcomeText(report)).toMatch(/^Read request:/);
  expect(directCommandSpeech({computerReport:report},ask,{thai:true})).toBeUndefined();
 });
 test('an uncertain READ_REQUEST stays LOW_CONFIDENCE, and agent control is never offered it',async()=>{
  const {readRequested}=await import('../../../src/automation/command-speech');
  const low=fixture(chrome(),'READ_REQUEST',0.4);
  const r=await run(low,ask);
  expect(low.actions()).toEqual([]);
  expect(r.trace.events.some(e=>e.reason==='LOW_CONFIDENCE')).toBe(true);
  expect(readRequested({computerReport:{...r,trace:r.trace.events} as never})).toBe(false);
  const agent=fixture(chrome(),'READ_REQUEST');
  const a=await runComputerUse({goal:ask,yieldAfterAction:true},agent.deps,new AbortController().signal);
  expect(Object.keys(agent.requests[0].questions.action.criteria)).not.toContain('READ_REQUEST');
  expect(agent.actions()).toEqual([]);
  expect(readRequested({computerReport:{...a,trace:a.trace.events} as never})).toBe(false);
 });
 test('a part of a step list (yieldAfterInteraction without readRequest) is never offered READ_REQUEST',async()=>{
  const {readRequested}=await import('../../../src/automation/command-speech');
  const f=fixture(chrome(),'READ_REQUEST');
  const r=await runComputerUse({goal:ask,yieldAfterInteraction:true,maxSteps:3},f.deps,new AbortController().signal);
  expect(Object.keys(f.requests[0].questions.action.criteria)).not.toContain('READ_REQUEST');
  expect(f.actions()).toEqual([]);
  expect(r.trace.events.some(e=>e.reason==='READ_REQUEST')).toBe(false);
  expect(readRequested({computerReport:{...r,trace:r.trace.events} as never})).toBe(false);
 });
 test('a command that types the word อ่าน still types it',async()=>{
  const state=chrome();(state.controls[0] as any).focused=true;
  const f=fixture(state,'type:c0'),evaluate=f.deps.evaluate;
  // The literal payload is chosen as Jev's text head would choose it.
  f.deps.evaluate=async(req,signal)=>{const answer=await evaluate(req,signal);if(req.questions.text)(answer.answers as any).text=choice(req.questions.text.criteria,Object.keys(req.questions.text.criteria).find(k=>k!=='NONE')!,1);return answer;};
  const r=await run(f,'พิมพ์ "อ่านการ์ตูน"');
  expect(f.actions()).toEqual([expect.objectContaining({kind:'type',text:'อ่านการ์ตูน'})]);
  expect(r.steps).toBe(1);
 });
});

// Session d88943d1 item 3: when Jev gives up on a single direct command (BLOCKED,
// or its new UNCLEAR choice) the gateway hands that command to the agent once.
describe('AGENT_HANDOFF: Jev gives up on a single direct command',()=>{
 const odd='เอาอันนั้นมาให้หน่อย';
 test('UNCLEAR is offered with READ_REQUEST only to a single direct command',async()=>{
  const f=fixture(chrome(),'BLOCKED');
  await run(f,odd);
  expect(Object.keys(f.requests[0].questions.action.criteria)).toEqual(expect.arrayContaining(['READ_REQUEST','UNCLEAR','BLOCKED']));
  const step=fixture(chrome(),'BLOCKED');
  await runComputerUse({goal:odd,yieldAfterInteraction:true,maxSteps:3},step.deps,new AbortController().signal);
  expect(Object.keys(step.requests[0].questions.action.criteria)).not.toContain('UNCLEAR');
 });
 test.each([['BLOCKED','NO_SUPPORTED_ACTION'],['UNCLEAR','UNCLEAR']])('Jev %s dispatches nothing and requests a hand-off',async(chosen,reason)=>{
  const {agentHandoffRequested,directCommandSpeech}=await import('../../../src/automation/command-speech');
  const f=fixture(chrome(),chosen);
  const r=await run(f,odd);
  expect(f.actions()).toEqual([]);
  const report={...r,trace:r.trace.events} as never;
  expect(r.trace.events.filter(e=>e.phase==='waiting').at(-1)).toMatchObject({reason,decisionMode:'jev'});
  expect(agentHandoffRequested({computerReport:report})).toBe(true);
  // If the gateway does not hand it off, the not-done line is still spoken.
  expect(directCommandSpeech({computerReport:report},odd,{thai:true})?.spoken).toBeTruthy();
 });
 test('step parts, agent control, low confidence and deterministic not-done never request a hand-off',async()=>{
  const {agentHandoffRequested}=await import('../../../src/automation/command-speech');
  const step=fixture(chrome(),'BLOCKED');
  const s=await runComputerUse({goal:odd,yieldAfterInteraction:true,maxSteps:3},step.deps,new AbortController().signal);
  expect(agentHandoffRequested({computerReport:{...s,trace:s.trace.events} as never})).toBe(false);
  const low=fixture(chrome(),'BLOCKED',0.4);
  const l=await run(low,odd);
  expect(agentHandoffRequested({computerReport:{...l,trace:l.trace.events} as never})).toBe(false);
  const handoff=fixture(chrome(),'UNCLEAR');
  const h=await runComputerUse({goal:odd,yieldAfterInteraction:true,agentCommand:true},handoff.deps,new AbortController().signal);
  expect(Object.keys(handoff.requests[0].questions.action.criteria)).not.toContain('UNCLEAR');
  expect(agentHandoffRequested({computerReport:{...h,trace:h.trace.events} as never})).toBe(false);
 });
 const agentRun=(f:ReturnType<typeof fixture>,goal:string)=>runComputerUse({goal,yieldAfterInteraction:true,agentCommand:true},f.deps,new AbortController().signal);
 // Session d8013081: the agent's command keeps protection, but Jev (not a word
 // list) judges its impact, and a high-impact action asks the user first.
 test('the agent command runs a routine action; a high-impact one asks the user, naming it',async()=>{
  const info={generation:'g2',application:'com.apple.Notes',windowTitle:'',truncated:false,apps:[],focusedControl:{role:'AXSheet',label:'alert'},
   text:['Apply these settings?'],controls:[{ref:'c0',role:'AXButton',label:'OK',actions:['press'],context:'Apply these settings?'}]};
  const routine=fixture(info,'press:c0',0.95,{impact:'ROUTINE'});await agentRun(routine,'press OK');
  expect(routine.requests[0].questions.impact).toBeDefined();
  expect(routine.actions()).toHaveLength(1);
  const risky=fixture(info,'press:c0',0.95);const r=await agentRun(risky,'press OK');
  expect(risky.actions()).toEqual([]);
  expect(r.trace.events.filter(e=>e.phase==='waiting').at(-1)?.reason).toBe('CONFIRMATION_REQUIRED');
  expect(r.lastAction).toMatchObject({kind:'press',label:'OK',blocked:true,confirm:true});
  // An unsure impact answer asks too.
  const unsure=fixture(info,'press:c0',0.95,{impact:'ROUTINE'});
  unsure.deps.evaluate=(orig=>async(req:any,sig:AbortSignal)=>{const a:any=await orig(req,sig);if(a.answers.impact)a.answers.impact={choice:'ROUTINE',confidence:0.5,probabilities:{ROUTINE:0.5,HIGH_IMPACT:0.5}};return a;})(unsure.deps.evaluate);
  await agentRun(unsure,'press OK');expect(unsure.actions()).toEqual([]);
  // The user's own command is never asked about.
  const user=fixture(info,'press:c0',0.95);await run(user,'ok');
  expect(user.requests[0].questions.impact).toBeUndefined();expect(user.actions()).toHaveLength(1);
 });
 const chat=(field:{role:string;label:string})=>({generation:'g1',application:'com.example.Chat',windowTitle:'Chat',truncated:false,apps:[{id:'com.example.Chat',name:'Chat'}],
  focusedControl:{ref:'c0',...field},text:[],
  controls:[{ref:'c0',...field,value:'hello',focused:true,actions:['press','type']},{ref:'c1',role:'AXButton',label:'Send',actions:['press']}]});
 test('the agent\'s Enter goes through Jev\'s impact judgement; the user\'s Enter just runs',async()=>{
  const user=fixture(chat({role:'AXTextArea',label:'Message'}));await run(user,'press enter');
  expect(user.requests).toHaveLength(0);expect(user.actions()).toEqual([expect.objectContaining({kind:'key',key:'enter'})]);
  const agent=fixture(chat({role:'AXTextArea',label:'Message'}),'key:enter',0.95);const r=await agentRun(agent,'press enter');
  expect(agent.requests).toHaveLength(1);expect(agent.actions()).toEqual([]);
  expect(r.lastAction).toMatchObject({kind:'key',label:'enter',confirm:true});
  const search=fixture(chat({role:'AXSearchField',label:'Search'}),'key:enter',0.95,{impact:'ROUTINE'});await agentRun(search,'press enter');
  expect(search.actions()).toEqual([expect.objectContaining({kind:'key',key:'enter'})]);
 });
 test('quitting is offered to the agent\'s command too, and asks the user first',async()=>{
  const state=notes();delete (state as any).focusedControl;state.controls[0].focused=false;
  const agent=fixture(state,'quit:m1',0.95);const r=await agentRun(agent,'quit notes');
  expect(Object.keys(agent.requests[0].questions.target_quit.criteria)).toContain('quit:m1');
  expect(agent.actions()).toEqual([]);
  expect(r.lastAction).toMatchObject({label:'Quit Notes',confirm:true});
 });
 // The user's next command answers the question; Jev reads it in any language.
 const answer=(f:ReturnType<typeof fixture>,goal:string)=>runComputerUse({goal,yieldAfterInteraction:true,readRequest:true,confirmation:{command:'quit notes',label:'Quit Notes'}},f.deps,new AbortController().signal);
 test.each(['ใช่','yes','はい'])('"%s" runs the agent\'s command as the user\'s own',async reply=>{
  const state=notes();delete (state as any).focusedControl;state.controls[0].focused=false;
  const f=fixture(state,'quit:m1',0.95,{reply:'YES'});await answer(f,reply);
  expect(f.requests[0].questions.reply).toBeDefined();expect(f.requests[0].state.reply).toBe(reply);
  expect(f.requests[1].state.command).toBe('quit notes');expect(f.requests[1].questions.impact).toBeUndefined();
  expect(f.actions()).toEqual([expect.objectContaining({kind:'press',ref:'m1'})]);
 });
 test('"no" cancels: nothing runs and nothing is spoken',async()=>{
  const {directCommandSpeech}=await import('../../../src/automation/command-speech');
  const state=notes();delete (state as any).focusedControl;state.controls[0].focused=false;
  const f=fixture(state,'quit:m1',0.95,{reply:'NO'});const r=await answer(f,'ไม่');
  expect(f.requests).toHaveLength(1);expect(f.actions()).toEqual([]);
  expect(r.trace.events.filter(e=>e.phase==='waiting').at(-1)?.reason).toBe('CONFIRMATION_DECLINED');
  expect(directCommandSpeech({computerReport:{...r,trace:r.trace.events} as never},'ไม่',{thai:true})).toBeUndefined();
 });
 test('a different command instead of an answer runs as itself',async()=>{
  const state=notes();delete (state as any).focusedControl;state.controls[0].focused=false;
  const f=fixture(state,'press:c8',0.95,{reply:'OTHER'});await answer(f,'new note');
  expect(f.requests[1].state.command).toBe('new note');
  expect(f.actions()).toEqual([expect.objectContaining({kind:'press',ref:'c8'})]);
 });
 test('the confirmation question is spoken in the conversation language, naming the control',async()=>{
  const {directCommandSpeech}=await import('../../../src/automation/command-speech');
  const report={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,evaluations:1,lastAction:{kind:'press',label:'Quit Google Chrome',blocked:true,confirm:true},trace:[{phase:'waiting',reason:'CONFIRMATION_REQUIRED'}]} as never;
  expect(directCommandSpeech({computerReport:report},'Pit.',{thai:true})?.spoken).toBe('จะกด Quit Google Chrome ใช่ไหม');
  expect(directCommandSpeech({computerReport:report},'close it',{})?.spoken).toBe('Press Quit Google Chrome?');
 });
});

// Session d8013081: "ปิด chrome" / "chrome" quit nothing because Jev's quit
// choice (0.79, 0.77) was under a separate 0.85 bar. Jev's normal bar applies.
describe('the user\'s quit command',()=>{
 test.each(['ปิด chrome','chrome','Quit','終了'])('%s with Jev\'s quit at 0.77 quits',async command=>{
  const state=notes();delete (state as any).focusedControl;state.controls[0].focused=false;
  const f=fixture(state,'quit:m1',0.77);await run(f,command);
  expect(f.actions()).toEqual([expect.objectContaining({kind:'press',ref:'m1'})]);
 });
 test('the helper\'s standard quit runs for the user at 0.77',async()=>{
  const state:any=notes();delete state.focusedControl;state.controls[0].focused=false;state.capabilities={standardCommands:['app:quit']};
  const f=fixture(state,'quit:standard-app-quit',0.77);await run(f,'ปิดโน้ต');
  expect(f.calls.some(c=>c.name==='computer_observe'&&c.args.standard_command==='app:quit')).toBe(true);
 });
});

// Session d8013081: the agent's spawn text ("เปิด Computer Use session…") is no
// user command; it never ends "Not done". A real first command still runs.
describe('the session-start round',()=>{
 const start=(f:ReturnType<typeof fixture>,goal:string)=>runComputerUse({goal,yieldAfterInteraction:true,readRequest:true,sessionStart:true},f.deps,new AbortController().signal);
 test.each(['BLOCKED','UNCLEAR','READ_REQUEST'])('Jev %s means ready, not Not done, and says nothing',async chosen=>{
  const {directCommandSpeech,agentHandoffRequested}=await import('../../../src/automation/command-speech');
  const f=fixture(chrome(),chosen);const r=await start(f,'เปิด Computer Use session รอคำสั่งถัดไปจากผู้ใช้');
  expect(f.actions()).toEqual([]);
  const report={...r,trace:r.trace.events} as never;
  expect(computerOutcomeText(report)).toMatch(/^Ready:/);
  expect(directCommandSpeech({computerReport:report},'x',{thai:true})).toBeUndefined();
  expect(agentHandoffRequested({computerReport:report})).toBe(false);
 });
 test('an actionable first command still runs',async()=>{
  const f=fixture(chrome(),'press:c50',0.9);await start(f,'เข้า link แรก');
  expect(f.actions()).toEqual([expect.objectContaining({kind:'press',ref:'c50'})]);
 });
});
