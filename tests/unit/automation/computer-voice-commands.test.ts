import {runComputerUse,type ComputerUseDependencies} from '../../../src/automation/computer-use';
import {keyCommand,normalizeCommand,scrollCommand,addressCommand} from '../../../src/automation/direct-command';
import {computerOutcomeText} from '../../../src/automation/computer-outcome';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const calculator=JSON.parse(readFileSync(join(__dirname,'../../fixtures/computer/calculator-35bd8aff.json'),'utf8'));

// Session 35bd8aff (task a68812d5): every input was live_voice. Button "5" is
// c11 on screen throughout, yet "ห้า" reached Jev and ended LOW_CONFIDENCE
// (0.45, 0.33); "ห้า ศูนย์" 0.44 and "ห้า ห้าสิบ" 0.53. The fixture is the
// recorded revision 2 observation of macOS Calculator (helper 0.2.72).
const choice=(criteria:Record<string,unknown>,chosen:string,confidence:number)=>({choice:chosen,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?confidence:(1-confidence)/(Object.keys(criteria).length-1||1)]))});
function fixture(initial:any=calculator,receipt:(args:any,count:number)=>any=()=>({state:'completed'})){
 const state=structuredClone(initial);let generation=1,count=0;const calls:any[]=[],requests:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async(name,args)=>{
   calls.push({name,args});
   if(name==='computer_acquire')return {lease_token:'lease'};
   if(name==='computer_observe')return structuredClone({...state,generation:'g'+generation});
   if(name==='computer_operation_status')return {operation_id:args.operation_id,state:'unknown'};
   if(name==='computer_action'){
    const result=receipt(args,++count);
    if(result.state==='completed'){generation++;const label=state.controls.find((c:any)=>c.ref===args.ref)?.label;state.text=[(state.text[0]==='‎0'?'':state.text[0])+label];}
    return result;
   }
   return {};
  },
  // Jev, when asked, is as unsure as it was in the session.
  evaluate:async req=>{requests.push(req);return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choice(q.criteria as any,'BLOCKED',0.45)]))};}};
 return {deps,calls,requests,state,presses:()=>calls.filter(c=>c.name==='computer_action').map(c=>c.args.ref)};
}
const run=(f:ReturnType<typeof fixture>,goal:string)=>runComputerUse({goal,yieldAfterInteraction:true},f.deps,new AbortController().signal);
const report=(r:Awaited<ReturnType<typeof run>>)=>({status:r.status,reason:r.reason,steps:r.steps,evaluations:r.evaluations,trace:r.trace.events,...(r.lastAction?{lastAction:r.lastAction}:{}),...((r as any).clarification?{clarification:(r as any).clarification}:{})});

describe('V1 exact-label press runs before Jev',()=>{
 test.each(['ห้า','5','กดเลข 5','กด 5','กดห้า','press 5','๕','ห้าครับ'])('%s presses c11 without calling evaluate',async command=>{
  const f=fixture();const r=await run(f,command);
  expect(f.requests).toHaveLength(0);
  expect(f.presses()).toEqual(['c11']);
  expect(r.lastAction).toMatchObject({kind:'press',label:'5'});
 });
 test.each([['เท่ากับ','c20'],['บวก','c17'],['เครื่องหมายบวก','c17'],['คูณ','c9'],['หาร','c5'],['=','c20'],['+','c17'],['เคลียร์','c2'],['กดปุ่ม เท่ากับ','c20']])('%s presses %s',async(command,ref)=>{
  const f=fixture();await run(f,command);
  expect(f.requests).toHaveLength(0);expect(f.presses()).toEqual([ref]);
 });
 test('two visible "5" buttons are ambiguous and go to Jev unchanged',async()=>{
  const twice=structuredClone(calculator) as any;twice.controls.push({...twice.controls.find((c:any)=>c.ref==='c11'),ref:'c99',identity:undefined});
  const f=fixture(twice);const r=await run(f,'ห้า');
  expect(f.requests).toHaveLength(1);expect(f.presses()).toEqual([]);
  expect(r.trace.events.some(e=>e.reason==='LOW_CONFIDENCE')).toBe(true);
 });
 test('a menu item labelled "5" (View → Decimal Places → 5) is never a candidate',async()=>{
  const menuOnly=structuredClone(calculator) as any;menuOnly.controls=menuOnly.controls.filter((c:any)=>c.ref!=='c11');
  const f=fixture(menuOnly);await run(f,'ห้า');
  expect(f.requests).toHaveLength(1);expect(f.presses()).toEqual([]);
 });
 test('a word outside the vocabulary keeps the Jev path',async()=>{
  const f=fixture();await run(f,'Percent');
  expect(f.requests).toHaveLength(1);
 });
 test('a sensitive control is never pressed directly',async()=>{
  const sensitive=structuredClone(calculator) as any;sensitive.controls.find((c:any)=>c.ref==='c11').sensitive=true;
  const f=fixture(sensitive);await run(f,'5');
  expect(f.presses()).toEqual([]);
 });
 // Session d8013081: the user's own command is their authorization, whatever the control says.
 test('the user\'s spoken label presses its one visible button, whatever its value says',async()=>{
  const destructive=structuredClone(calculator) as any;Object.assign(destructive.controls.find((c:any)=>c.ref==='c13'),{label:'−',value:'Remove item'});
  const f=fixture(destructive);await run(f,'minus');
  expect(f.presses()).toEqual(['c13']);expect(f.requests).toHaveLength(0);
 });
});

describe('V1 "ลบ": erase in a focused text field, Subtract only when unambiguous',()=>{
 const textEdit=()=>({...structuredClone(calculator),application:'com.apple.TextEdit',windowTitle:'Untitled',text:[],
  focusedControl:{ref:'t0',role:'AXTextArea',label:'Document'},
  controls:[{ref:'t0',role:'AXTextArea',label:'Document',value:'abc',focused:true,actions:['press','type']},{ref:'t1',role:'AXButton',label:'Subtract',actions:['press']}]});
 test('with a focused text field "ลบ" still erases one character',async()=>{
  const f=fixture(textEdit());await run(f,'ลบ');
  expect(f.calls.filter(c=>c.name==='computer_action').map(c=>c.args)).toEqual([expect.objectContaining({kind:'key',key:'backspace'})]);
 });
 test('on Calculator with no text focus "ลบ" presses Subtract',async()=>{
  const f=fixture();await run(f,'ลบ');
  expect(f.requests).toHaveLength(0);expect(f.presses()).toEqual(['c13']);
 });
 test('a visible Delete control makes "ลบ" ambiguous: Jev decides, with its destructive guard',async()=>{
  const withDelete=structuredClone(calculator) as any;withDelete.controls.push({ref:'c98',role:'AXButton',label:'Delete',actions:['press']});
  const f=fixture(withDelete);await run(f,'ลบ');
  expect(f.presses()).toEqual([]);expect(f.requests).toHaveLength(1);
 });
});

describe('V3 multi-digit utterances',()=>{
 test.each([['ห้า ศูนย์',['c11','c18']],['ห้าสิบ',['c11','c18']],['50',['c11','c18']],['กดเลข 123',['c14','c15','c16']],['ยี่สิบเอ็ด',['c15','c14']],['หนึ่ง สอง สาม',['c14','c15','c16']]])('%s presses %j in order',async(command,refs)=>{
  const f=fixture();const r=await run(f,command);
  expect(f.requests).toHaveLength(0);expect(f.presses()).toEqual(refs);
  expect(r.status).toBe('needs_input');expect(computerOutcomeText(report(r) as any)).toMatch(/^Done: pressed /);
 });
 test('each press re-observes before the next one (settle between presses)',async()=>{
  const f=fixture();await run(f,'ห้า ศูนย์');
  const names=f.calls.map(c=>c.name).filter(n=>n!=='computer_release');
  expect(names.slice(0,5)).toEqual(['computer_acquire','computer_observe','computer_action','computer_observe','computer_action']);
 });
 test.each([['ร้อยห้า','105 หรือ 150?'],['พันห้า','1005 หรือ 1500?'],['หมื่นสอง','10002 หรือ 12000?'],['สองร้อยห้า','205 หรือ 250?']])('M3: shorthand %s asks %s and presses nothing',async(command,question)=>{
  const f=fixture();const r=await run(f,command);
  expect(f.presses()).toEqual([]);expect(f.requests).toHaveLength(0);
  expect((r as any).clarification).toBe(question);
 });
 test.each([['ร้อยห้าสิบ',['c14','c11','c18']],['ร้อยเอ็ด',['c14','c18','c14']]])('M3: an unambiguous %s presses %j',async(command,refs)=>{
  const f=fixture();await run(f,command);
  expect(f.presses()).toEqual(refs);
 });
 test('"ห้า ห้าสิบ" asks which number and presses nothing',async()=>{
  const f=fixture();const r=await run(f,'ห้า ห้าสิบ');
  expect(f.presses()).toEqual([]);expect(f.requests).toHaveLength(0);
  expect((r as any).clarification).toBe('ห้า หรือ ห้าสิบ?');
  expect(computerOutcomeText(report(r) as any)).toBe('Not done: ห้า หรือ ห้าสิบ?');
 });
 test('sequences are bounded to 8 presses',async()=>{
  const f=fixture();const r=await run(f,'123456789');
  expect(f.presses()).toEqual([]);expect(r.trace.events.some(e=>e.reason==='SEQUENCE_TOO_LONG')).toBe(true);
  const ok=fixture();await run(ok,'12345678');expect(ok.presses()).toHaveLength(8);
 });
 test('an unknown receipt mid-sequence stops the sequence and never replays',async()=>{
  const f=fixture(calculator,(_args,count)=>count===2?{state:'unknown'}:{state:'completed'});
  const r=await run(f,'ห้า ศูนย์ ห้า');
  expect(f.presses()).toEqual(['c11','c18']);
  expect(r).toMatchObject({status:'needs_reconciliation',reason:'OUTCOME_UNKNOWN'});
  // H1: never "pressed 1 of 3" or "Not done" — the second press may have landed.
  expect(computerOutcomeText(report(r) as any)).toMatch(/^Unknown: the last action may have run/);
 });
 test('a press rejected mid-sequence stops and reports how far it got',async()=>{
  const f=fixture(calculator,(_args,count)=>count===2?{state:'not_executed',error:'STALE_OBSERVATION'}:{state:'completed'});
  const r=await run(f,'ห้า ศูนย์ ห้า');
  expect(f.presses()).toEqual(['c11','c18']);
  expect(computerOutcomeText(report(r) as any)).toMatch(/^Not done: pressed 1 of 3 \("5"\)/);
 });
});

describe('V5 fillers and particles are ignored for matching only',()=>{
 test.each([
  ['เลื่อนลงครับ',()=>scrollCommand('เลื่อนลงครับ'),'down'],
  ['เอาล่ะ กด enter.',()=>keyCommand('เอาล่ะ กด enter.'),'enter'],
  ['เอ่อ เลื่อนขึ้นหน่อยนะครับ',()=>scrollCommand('เอ่อ เลื่อนขึ้นหน่อยนะครับ'),'up'],
  ['โอเค กด tab ค่ะ',()=>keyCommand('โอเค กด tab ค่ะ'),'tab'],
  ['ok press escape!',()=>keyCommand('ok press escape!'),'escape'],
  ['อ่า enter?',()=>keyCommand('อ่า enter?'),'enter'],
  ['เข้า google ครับ',()=>addressCommand('เข้า google ครับ'),'google.com'],
 ])('%s',(_command,parse,expected)=>{expect(parse()).toBe(expected);});
 test('a filler or particle alone is not stripped to nothing',()=>{
  expect(normalizeCommand('ok')).toBe('ok');expect(normalizeCommand('ครับ')).toBe('ครับ');
 });
 test('runner: "เลื่อนลงครับ" scrolls without Jev',async()=>{
  const f=fixture();await run(f,'เลื่อนลงครับ');
  expect(f.requests).toHaveLength(0);
  expect(f.calls.find(c=>c.name==='computer_action')?.args).toMatchObject({kind:'scroll',direction:'down'});
 });
 test('the verbatim goal still reaches Jev when nothing matches',async()=>{
  const f=fixture();await run(f,'เอาล่ะ Percent ครับ.');
  expect(f.requests[0].state.command).toBe('เอาล่ะ Percent ครับ.');
 });
});

describe('L4: exact-label presses need a keypad on screen',()=>{
 const noKeypad=()=>({...calculator,controls:calculator.controls.filter((c:any)=>!/^[0-9]$/.test(c.label.trim()))});
 test.each(['clear','add','plus','เคลียร์'])('%s outside a keypad goes to Jev instead of pressing',async command=>{
  const state=noKeypad();
  expect(state.controls.some((c:any)=>['clear','add','all clear','ac'].includes(c.label.trim().toLowerCase()))).toBe(true);
  const f=fixture(state);await run(f,command);
  expect(f.requests.length).toBeGreaterThan(0);expect(f.presses()).toEqual([]);
 });
 test('the same words on the calculator keypad still press directly',async()=>{
  const f=fixture();await run(f,'add');
  expect(f.requests).toHaveLength(0);expect(f.presses()).toHaveLength(1);
 });
 test('"OK Google" is not an address (the filler leaves a bare site name)',()=>{
  expect(addressCommand('OK Google')).toBeUndefined();expect(addressCommand('โอเค google')).toBeUndefined();
  expect(addressCommand('โอเค เข้า google')).toBe('google.com');
 });
});
