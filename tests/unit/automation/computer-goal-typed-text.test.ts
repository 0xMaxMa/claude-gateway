import {runComputerUse,type ComputerUseDependencies} from '../../../src/automation/computer-use';
import {goalTextCandidates,commandTextCandidates} from '../../../src/automation/computer-command';
import {computerOutcomeText,computerRoundDone} from '../../../src/automation/computer-outcome';

// Pod-jinawong r8 (aad2807e), 2026-11-03: "play bodyslam on Spotify in Chrome" (task 16542265).
// The goal run opened Chrome, pressed the web player's search combobox, then had no "bodyslam"
// candidate to type (only suffixes of the sentence) and chose BLOCKED: NO_SUPPORTED_ACTION. The
// agent's hand-off 'type bodyslam in the "What do you want to play?" field and press enter' offered
// only the quoted field label, so the text head said NONE and the user was asked for the text.
const APPS=[{id:'com.apple.finder',name:'Finder'},{id:'com.google.Chrome',name:'Google Chrome'},{id:'com.spotify.client',name:'Spotify'}];
const WEB_PLAYER='Spotify - Web Player: Listen to Music, Podcasts, and Audiobooks Online - Google Chrome - Jinawong';
const SEARCH='What do you want to play?';
const player=(value='',focused=true)=>()=>({application:'com.google.Chrome',windowTitle:WEB_PLAYER,truncated:false,apps:APPS,
 ...(focused?{focusedControl:{ref:'c0',role:'AXComboBox',label:SEARCH}}:{}),
 controls:[{ref:'c0',identity:'33333333-3333-4333-8333-333333333333',role:'AXComboBox',label:SEARCH,value,focused,actions:['press','type']},
  {ref:'c52',role:'AXRadioButton',label:'Home',actions:['press'],focused:false}]});

const choice=(criteria:Record<string,unknown>,chosen:string,confidence:number)=>({choice:chosen,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?confidence:(1-confidence)/(Object.keys(criteria).length-1||1)]))});
type Step={pick:string;text?:(criteria:Record<string,string>)=>string};
function fixture(screens:Array<()=>any>,plan:Step[]){
 let shown=0,asked=0;const calls:any[]=[],requests:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async(name,args)=>{
   calls.push({name,args});
   if(name==='computer_acquire')return {lease_token:'lease'};
   if(name==='computer_observe')return {...screens[Math.min(shown,screens.length-1)](),generation:'g'+shown};
   if(name==='computer_action'){shown++;return {state:'completed'};}
   return {};
  },
  evaluate:async req=>{
   requests.push(req);const step=plan[asked++]??{pick:'DONE'};const kind=step.pick.includes(':')?step.pick.split(':')[0]:step.pick;
   return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choice(q.criteria as any,
    name==='action'?kind:name==='target_'+kind?step.pick:name==='impact'?'ROUTINE':name==='text'?(step.text?.(q.criteria as any)??'NONE'):'BLOCKED',0.95)]))};
  }};
 return {deps,requests,actions:()=>calls.filter(c=>c.name==='computer_action').map(({args:{lease_token,operation_id,generation,...rest}})=>rest)};
}
/** The text head picks the offered candidate equal to `value`, or NONE when none is. */
const pick=(value:string)=>(criteria:Record<string,string>)=>Object.entries(criteria).find(([k,v])=>k.startsWith('TEXT:')&&JSON.parse(v).text===value)?.[0]??'NONE';
const offered=(req:any)=>Object.entries(req.questions.text?.criteria??{}).filter(([k])=>k.startsWith('TEXT:')).map(([,v])=>JSON.parse(v as string).text);
const spawn=(f:ReturnType<typeof fixture>,goal:string)=>runComputerUse({goal,yieldAfterInteraction:true,readRequest:true,sessionStart:true,runToGoal:true,maxSteps:8},f.deps,new AbortController().signal);
const handoff=(f:ReturnType<typeof fixture>,goal:string)=>runComputerUse({goal,yieldAfterInteraction:true,readRequest:false,agentCommand:true,runToGoal:true,maxSteps:8},f.deps,new AbortController().signal);

describe('a goal run types an unquoted payload from its own text',()=>{
 test('16542265 rev1: the focused web player search gets "bodyslam", then Enter',async()=>{
  const f=fixture([player('',false),player(),player('bodyslam'),player('bodyslam')],[{pick:'press:c0'},{pick:'type:c0',text:pick('bodyslam')},{pick:'key:enter'},{pick:'DONE'}]);
  const r=await spawn(f,'play bodyslam on Spotify in Chrome');
  expect(offered(f.requests[1])).toContain('bodyslam');
  expect(f.actions()).toEqual([{kind:'press',ref:'c0'},{kind:'type',ref:'c0',text:'bodyslam'},{kind:'key',key:'enter'}]);
  expect(r).toMatchObject({status:'succeeded',reason:'GOAL_REACHED',steps:3});
 });
 test('16542265 rev2: a quoted field label does not hide the unquoted payload of a hand-off',async()=>{
  const f=fixture([player(),player('bodyslam'),player('bodyslam')],[{pick:'type:c0',text:pick('bodyslam')},{pick:'key:enter'},{pick:'DONE'}]);
  const r=await handoff(f,`type bodyslam in the "${SEARCH}" field and press enter`);
  expect(offered(f.requests[0])).toEqual(expect.arrayContaining([SEARCH,'bodyslam']));
  expect(f.actions()).toEqual([{kind:'type',ref:'c0',text:'bodyslam'},{kind:'key',key:'enter'}]);
  expect(r.reason).not.toBe('FIELD_TEXT_REQUIRED');
 });
 test('typed text is only ever a verbatim span of the goal: screen text is never offered, NONE still asks',async()=>{
  // The screen shows a tempting value; it is no candidate, so NONE stops and names the field.
  const screen=()=>({...player()(),text:['Recent searches: Paradise']});
  const f=fixture([screen],[{pick:'type:c0',text:pick('Paradise')}]);
  const r=await spawn(f,'play bodyslam on Spotify in Chrome');
  expect(offered(f.requests[0])).not.toContain('Paradise');
  for(const text of offered(f.requests[0]))expect('play bodyslam on Spotify in Chrome').toContain(text);
  expect(f.actions()).toEqual([]);
  expect(r).toMatchObject({status:'needs_input',reason:'FIELD_TEXT_REQUIRED',fieldRequest:{label:SEARCH,role:'AXComboBox'}});
 });
 test('a user-issued direct command keeps its own candidates (no behavior change)',async()=>{
  const f=fixture([player()],[{pick:'type:c0',text:pick('bodyslam')}]);
  const r=await runComputerUse({goal:'play bodyslam on Spotify in Chrome',yieldAfterInteraction:true,readRequest:true},f.deps,new AbortController().signal);
  expect(offered(f.requests[0])).not.toContain('bodyslam');
  expect(f.actions()).toEqual([]);
  expect(r.reason).toBe('COMMAND_WAITING_INPUT');
 });
});

describe('goalTextCandidates',()=>{
 test('keeps the direct-command candidates first, then spans by position, verbatim',()=>{
  const direct=commandTextCandidates('play bodyslam on Spotify in Chrome');
  const goal=goalTextCandidates('play bodyslam on Spotify in Chrome');
  expect(goal.slice(0,direct.length)).toEqual(direct);
  expect(goal).toEqual(expect.arrayContaining(['bodyslam','play bodyslam','Spotify','Chrome']));
  expect(goalTextCandidates('เล่นเพลง bodyslam on Spotify')).toContain('bodyslam');
  expect(goalTextCandidates('type "hello" in Notes')[0]).toBe('hello');
 });
 test('spans never cross a quoted span and stay within six words',()=>{
  const values=goalTextCandidates(`type bodyslam in the "${SEARCH}" field and press enter`);
  expect(values[0]).toBe(SEARCH);
  expect(values).not.toContain('the field');
  expect(values.every(v=>v===SEARCH||v.split(/\s+/).length<=6)).toBe(true);
 });
 test('a long goal offers no spans: its payload has to be quoted',()=>{
  const long='open Chrome then go to the Spotify web player and search for the newest album of bodyslam and play it now';
  expect(goalTextCandidates(long)).toEqual(commandTextCandidates(long));
 });
});

describe('b0ba459d rev1: one action, then no control, is not "Done"',()=>{
  // The recorded trace: open Spotify (0.95), then BLOCKED (0.9) on a menu-only Spotify window.
 const trace=[
  {phase:'observing',sequence:1,round:1,revision:1,steps:0,evaluations:0},
  {phase:'observed',sequence:2,round:1,revision:1,steps:0,evaluations:0},
  {phase:'evaluating',sequence:3,round:1,revision:1,steps:0,evaluations:0,decisionMode:'model'},
  {phase:'decided',sequence:4,round:1,revision:1,steps:0,evaluations:1,application:'unapproved',appId:'com.spotify.client',action:'open',confidence:0.95},
  {phase:'acting',sequence:5,round:1,revision:1,steps:0,evaluations:1,action:'open',appId:'com.spotify.client'},
  {phase:'acted',sequence:6,round:1,revision:1,steps:1,evaluations:1,action:'open',appId:'com.spotify.client',outcome:'completed'},
  {phase:'observing',sequence:7,round:2,revision:1,steps:1,evaluations:1},
  {phase:'observed',sequence:8,round:2,revision:1,steps:1,evaluations:1,changed:true},
  {phase:'evaluating',sequence:9,round:2,revision:1,steps:1,evaluations:1,decisionMode:'model'},
  {phase:'decided',sequence:10,round:2,revision:1,steps:1,evaluations:2,confidence:0.9},
  {phase:'waiting',sequence:11,round:2,revision:1,steps:1,evaluations:2,reason:'NO_SUPPORTED_ACTION',decisionMode:'model'},
  {phase:'terminal',sequence:12,round:2,revision:1,steps:1,evaluations:2,status:'needs_input',reason:'COMMAND_WAITING_INPUT'},
 ];
 const report={status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1,evaluations:2,phase:'terminal',trace,lastAction:{kind:'open',appId:'com.spotify.client'}} as any;
 test('says how far it got and why it stopped',()=>{
  expect(computerOutcomeText(report)).toBe('Not finished: 1 action done, then no visible control matches this command. Check that the right window is in front, or name the item as it appears on screen.');
  expect(computerRoundDone(report)).toBe(false);
 });
 test('a single direct command that acted is still Done (no behavior change)',()=>{
  const acted=[...trace.slice(0,6),{phase:'waiting',sequence:7,round:1,revision:1,steps:1,evaluations:1,reason:'ACTION_DISPATCHED'}];
  expect(computerOutcomeText({...report,trace:acted})).toBe('Done: opened com.spotify.client. Send the next command.');
  // A stop recorded before the action (a re-decided changing screen) is not the run's end.
  const early=[{phase:'waiting',sequence:0,round:1,revision:1,steps:0,evaluations:0,reason:'UI_NOT_READY'},...trace.slice(0,6)];
  expect(computerOutcomeText({...report,trace:early})).toBe('Done: opened com.spotify.client. Send the next command.');
 });
});

// The Spotify desktop window b0ba459d observed: window buttons and ~80 menu items, no text field.
describe('b0ba459d: a menu-only window gives the goal run no control, so it stops at NO_SUPPORTED_ACTION',()=>{
 const spotify=()=>({application:'com.spotify.client',windowTitle:'Spotify Free',truncated:true,apps:APPS,text:[],
  controls:[...['Close window','Full screen','Minimize window'].map((label,i)=>({ref:'c'+i,role:'AXButton',label,actions:['press'],focused:false})),
   ...Array.from({length:80},(_,i)=>({ref:'m'+i,role:'AXMenuItem',label:'Menu: '+(i===17?'Edit → Search':i===26?'Playback → Play':`Item ${i}`),actions:['press'],focused:false}))]});
 test('BLOCKED on that window is the stop the vision fallback takes over (gateway-tasks/computer.ts)',async()=>{
  // Recorded: open Spotify (0.95), then BLOCKED (0.9) on its window.
  const f=fixture([player(),spotify],[{pick:'open:com.spotify.client'},{pick:'BLOCKED'}]);
  const r=await spawn(f,'play bodyslam on Spotify');
  expect(spotify().controls).toHaveLength(83);
  expect(f.actions()).toEqual([{kind:'open',app_id:'com.spotify.client'}]);
  expect(r.status).toBe('needs_input');
  expect(r.trace.events.filter(e=>e.phase==='waiting').at(-1)?.reason).toBe('NO_SUPPORTED_ACTION');
 });
});
