import {runComputerUse,type ComputerProgress,type ComputerUseDependencies} from '../../../src/automation/computer-use';
import {computerOutcomeText,computerProgressText,computerReasonText,computerRefusalNote,pointerRefusal} from '../../../src/automation/computer-outcome';
import {parkedGoalRunNote} from '../../../src/orchestration/tasks/automation-session';
import type {ComputerTaskReport} from '../../../src/orchestration/types';
import spotify from '../../fixtures/computer/spotify-web-56f64e16.json';

// Replay of pod-jinawong r12 task 56f64e16 rev 8 (gateway 5f88c9cf, app wincu.9 on Windows): "click "Play ขี้หึง by Silly
// Fools" in the Songs list on Spotify in Chrome". Spotify web shows a row's Play button only while the pointer is over the
// row. The helper hit-tested before hovering, hit the row (pointer_hit_ancestor, same Chrome window) and answered
// TARGET_OCCLUDED; the card said "covered by another window or popup" and the agent told the user GetPod was in the way.
// GetPod Desktop 0.1.1 hovers first and answers TARGET_NOT_REACHED when it still cannot reach the button.
type Screen=Record<string,any>;
const page=spotify.rev8.state as Screen;
const CHROME={id:'chrome.exe',name:'Google Chrome'};
const choice=(criteria:Record<string,unknown>,chosen:string,confidence:number)=>({choice:chosen,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?confidence:(1-confidence)/(Object.keys(criteria).length-1||1)]))});
/** A Windows PC showing the recorded page; `act` answers each computer_action; `plan`: the decision model's picks in order. */
function pc(act:(n:number,args:any)=>unknown,plan:string[]){
 let asked=0,looks=0,acts=0;const calls:any[]=[],requests:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async(name,args)=>{
   calls.push({name,args});
   if(name==='computer_acquire')return {lease_token:'lease'};
   if(name==='computer_observe')return {...page,generation:'g'+(++looks)};
   if(name==='computer_action')return act(acts++,args);
   return {};
  },
  evaluate:async req=>{
   requests.push(req);const pick=plan[asked++]??'DONE';const kind=pick.includes(':')?pick.split(':')[0]:pick;
   return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choice(q.criteria as any,name==='action'?kind:name==='target_'+kind?pick:name==='impact'?'ROUTINE':'NONE',0.95)]))};
  }};
 return {deps,requests,actions:()=>calls.filter(c=>c.name==='computer_action').map(({args:{lease_token,operation_id,generation,...rest}})=>rest)};
}
const goal=()=>({goal:spotify.rev8.command,yieldAfterInteraction:true,readRequest:false,runToGoal:true});
const signal=()=>new AbortController().signal;
const lastWait=(r:{trace:{events:Array<{phase:string;reason?:string}>}})=>[...r.trace.events].reverse().find(e=>e.phase==='waiting')?.reason;
const report=(r:any,extra:Record<string,unknown>={})=>({...r,phase:'terminal',trace:r.trace.events,targetApp:CHROME,...extra});
const refused=(error:string,phase?:string)=>({state:'not_executed',error,...(phase?{phase}:{})});
const offered=(request:any)=>Object.keys(request.questions.target_press?.criteria??{});

describe('56f64e16 rev 8 replay: a row button that only shows under the pointer',()=>{
 test('the recorded round: press on the row Play, refused as TARGET_OCCLUDED at pointer_hit_ancestor, Chrome in front',()=>{
  const trace=spotify.rev8.report.trace;
  expect(trace.find(e=>e.phase==='acted')).toMatchObject({action:'press',ref:'c5',role:'AXButton',outcome:'not_executed',reason:'TARGET_OCCLUDED'});
  expect(trace.slice(-2).map(e=>e.reason)).toEqual(['TARGET_OCCLUDED','COMMAND_WAITING_INPUT']);
  expect(spotify.rev8.toolErrors).toEqual([expect.objectContaining({code:'TARGET_OCCLUDED',nativePhase:'pointer_hit_ancestor'})]);
  expect(page).toMatchObject({application:'chrome.exe',platform:{os:'windows'}});expect(page.frontmostProtected).toBeUndefined();
  expect(spotify.rev8.goalRun).toBe(true);
 });
 test('GetPod Desktop 0.1.0 (same answer): the round still waits, and no line says another window covered it',async()=>{
  const m=pc(()=>refused('TARGET_OCCLUDED','pointer_hit_ancestor'),['press:c5']);
  const r=await runComputerUse(goal(),m.deps,signal());
  expect(m.actions()).toEqual([{kind:'press',ref:'c5'}]);
  expect(lastWait(r)).toBe('TARGET_OCCLUDED');expect(r).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0});
  expect(r.trace.events.find(e=>e.phase==='acted')).toMatchObject({outcome:'not_executed',reason:'TARGET_OCCLUDED',nativePhase:'pointer_hit_ancestor'});
  const text=computerOutcomeText(report(r));
  expect(text).toContain('the button only appears when the pointer is over it, so it couldn\'t be clicked.');
  expect(text).toContain('The screen was not hidden: Google Chrome was in front.');
  expect(text).not.toMatch(/covered|another window/);
  const note=computerRefusalNote(report(r));
  expect(note).toContain('TARGET_OCCLUDED, native phase pointer_hit_ancestor');
  expect(note).toContain('The screen was NOT withheld and Google Chrome was the frontmost app');
  expect(note).toContain('do not tell the user that GetPod was in the way');
 },15000);
 test('GetPod Desktop 0.1.1: a goal run drops the unreachable button once and decides again on a fresh look',async()=>{
  const m=pc(n=>n===0?refused('TARGET_NOT_REACHED','pointer_hit_ancestor'):{state:'completed'},['press:c5','press:c6']);
  const r=await runComputerUse(goal(),m.deps,signal());
  expect(m.actions().slice(0,2)).toEqual([{kind:'press',ref:'c5'},{kind:'press',ref:'c6'}]);
  expect(offered(m.requests[0])).toContain('press:c5');
  expect(offered(m.requests[1])).not.toContain('press:c5');expect(offered(m.requests[1])).toContain('press:c6');
  expect(r.steps).toBeGreaterThanOrEqual(1);
  expect(r.trace.events.some(e=>e.phase==='waiting'&&e.reason==='TARGET_NOT_REACHED')).toBe(false);
 },15000);
 test('a second miss waits on TARGET_NOT_REACHED (computer.ts may go on with vision), with no step counted',async()=>{
  const m=pc(()=>refused('TARGET_NOT_REACHED','pointer_hit_ancestor'),['press:c5','press:c6','press:c4']);
  const r=await runComputerUse(goal(),m.deps,signal());
  expect(m.actions()).toEqual([{kind:'press',ref:'c5'},{kind:'press',ref:'c6'}]);
  expect(lastWait(r)).toBe('TARGET_NOT_REACHED');expect(r).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0});
  expect(computerOutcomeText(report(r))).toContain('the button only appears when the pointer is over it');
 },15000);
 test('outside a goal run TARGET_NOT_REACHED waits at once, like any refused click',async()=>{
  const m=pc(()=>refused('TARGET_NOT_REACHED'),['press:c5']);
  const r=await runComputerUse({goal:spotify.rev8.command,yieldAfterInteraction:true,readRequest:false},m.deps,signal());
  expect(m.actions()).toEqual([{kind:'press',ref:'c5'}]);expect(lastWait(r)).toBe('TARGET_NOT_REACHED');
 },15000);
 test('a real cover (another window at the point) still says so, and is not decided again',async()=>{
  const m=pc(()=>refused('TARGET_OCCLUDED','pointer_hit_other_window'),['press:c5','press:c6']);
  const r=await runComputerUse(goal(),m.deps,signal());
  expect(m.actions()).toEqual([{kind:'press',ref:'c5'}]);expect(lastWait(r)).toBe('TARGET_OCCLUDED');
  const text=computerOutcomeText(report(r));
  expect(text).toContain('the target is covered by another window or popup. Close it, then try again.');
  expect(computerRefusalNote(report(r))).toContain('another window or popup covered the click point');
 },15000);
});

describe('pointer refusal copy',()=>{
 test('only a phase at another window or process reads as covered; an unknown phase keeps the old meaning',()=>{
  for(const phase of ['pointer_hit_other_window','pointer_check_hit','raw_pointer_occluded',undefined])expect(pointerRefusal('TARGET_OCCLUDED',phase)).toBe('covered');
  for(const phase of ['pointer_hit_ancestor','pointer_hit_group','pointer_hit_row','pointer_hit_window','pointer_check_geometry'])expect(pointerRefusal('TARGET_OCCLUDED',phase)).toBe('hover');
  expect(pointerRefusal('TARGET_NOT_REACHED')).toBe('hover');expect(pointerRefusal('TARGET_NOT_REACHED','pointer_hit_other_window')).toBe('hover');
  expect(pointerRefusal('TARGET_OCCLUDED','scroll_nested_pane')).toBe('nested_scroll');
  expect(pointerRefusal('FOCUS_REQUIRED','pointer_hit_ancestor')).toBeUndefined();
  expect(computerReasonText('TARGET_NOT_REACHED')).toBe('Couldn\'t click that button: it only appears when the pointer is over it.');
 });
 const ev=(sequence:number,phase:ComputerProgress['phase'],extra:Partial<ComputerProgress>={}):ComputerProgress=>({sequence,round:1,at:sequence,revision:1,steps:0,evaluations:1,phase,...extra});
 const stopped=(nativePhase?:string):ComputerTaskReport=>({status:'blocked',reason:'VISION_OTHER',steps:0,evaluations:1,phase:'terminal',targetApp:CHROME,
  trace:[ev(1,'acted',{action:'press',outcome:'not_executed',reason:'TARGET_OCCLUDED',...(nativePhase?{nativePhase}:{})}),ev(2,'terminal',{status:'blocked',reason:'VISION_OTHER'})]});
 test('the stopped card names the refused click by its phase',()=>{
  expect(computerProgressText(stopped('pointer_hit_group'))).toBe('Stopped after 0 actions. The model found no way to finish on the screen. Before that, couldn\'t click that button: it only appears when the pointer is over it.');
  expect(computerProgressText(stopped('pointer_hit_other_window'))).toContain('Before that, the button was covered by another window or popup.');
 });
 test('a withheld screen keeps its own line and no "not withheld" claim; other stops add nothing',()=>{
  const withheld:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,phase:'terminal',screenWithheld:true,targetApp:CHROME,trace:[ev(1,'acted',{outcome:'not_executed',reason:'TARGET_NOT_REACHED'}),ev(2,'waiting',{reason:'TARGET_NOT_REACHED'})]};
  expect(computerRefusalNote(withheld)).not.toContain('NOT withheld');
  expect(computerOutcomeText(withheld)).not.toContain('The screen was not hidden');
  expect(computerOutcomeText(withheld)).toContain('The screen was hidden because a protected app such as GetPod was in front.');
  const other:ComputerTaskReport={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,phase:'terminal',targetApp:CHROME,trace:[ev(1,'waiting',{reason:'NO_SUPPORTED_ACTION'})]};
  expect(computerRefusalNote(other)).toBe('');expect(computerOutcomeText(other)).not.toContain('The screen was not hidden');
 });
 test('the agent\'s parked goal-run wake carries the note',()=>{
  const task={taskId:'56f64e16',revision:8,gatewayTarget:{adapter:'computer'},computerReport:{status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:0,phase:'terminal',targetApp:CHROME,
   trace:[ev(1,'acted',{action:'press',outcome:'not_executed',reason:'TARGET_OCCLUDED',nativePhase:'pointer_hit_ancestor'}),ev(2,'waiting',{reason:'TARGET_OCCLUDED'})]}} as any;
  expect(parkedGoalRunNote(task)).toContain('The screen was NOT withheld and Google Chrome was the frontmost app');
  expect(parkedGoalRunNote({...task,computerReport:{...task.computerReport,trace:[ev(1,'waiting',{reason:'NO_SUPPORTED_ACTION'})]}})).not.toContain('withheld');
 });
});
