import {standardKeyboardCommand} from '../../../src/automation/computer-command';
import {literalTextCandidates} from '../../../src/automation/computer-policy';
import assert from 'node:assert/strict';
import {JevError} from '../../../src/jev/types';
import {validateJevRequest} from '../../../src/jev/validation';
import {runComputerUse,ComputerObservation,type ComputerUseDependencies} from '../../../src/automation/computer-use';
function fixture(plan:string[]){
 let revision={revision:1,goal:'Create a note'},index=0;const calls:any[]=[];
 const state={generation:'g',application:'com.apple.Notes',controls:[{ref:'c1',label:'Note',role:'AXTextArea',actions:['type'],value:''}],apps:[{id:'com.apple.Notes',name:'Notes'}],truncated:false,screenshotAvailable:true};
 const deps:ComputerUseDependencies={snapshot:async()=>{},authorized:()=>true,latestGoal:()=>revision,beforeMutation:()=>{},thinking:async()=>({text:'milk'}),call:async(name,args)=>{calls.push({name,args});return name==='computer_acquire'?{lease_token:'lease'}:name==='computer_observe'?state:{state:'completed'};},evaluate:async req=>{const chosen=plan[index++]??'DONE';return responseFor(req,chosen);}};
 return {deps,state,calls,update:(goal:string)=>revision={revision:revision.revision+1,goal}};
}
test('Computer Use invokes Thinking and guarded MCP actions, never reports unverified success',async()=>{
 const f=fixture(['type:c1','DONE']);const r=await runComputerUse({goal:'Create a note'},f.deps,new AbortController().signal);
 assert.equal(r.status,'needs_verification');assert.equal(r.steps,1);
 const actions=f.calls.filter(x=>x.name==='computer_action');assert.equal(actions.length,1);assert.equal(actions[0].args.text,'milk');assert.equal(actions[0].args.generation,'g');
});
test('a new goal during evaluation discards old decision before any action',async()=>{
 const f=fixture(['type:c1','DONE']),evaluate=f.deps.evaluate;let first=true;
 f.deps.evaluate=async(...args)=>{const r=await evaluate(...args);if(first){first=false;f.update('Stop editing; inspect the note');}return r;};
 const r=await runComputerUse({goal:'Create a note'},f.deps,new AbortController().signal);
 assert.equal(r.revision,2);assert.equal(f.calls.filter(x=>x.name==='computer_action').length,0);
});
test('a revision during Thinking cannot type obsolete text',async()=>{
 const f=fixture(['type:c1','DONE']);f.deps.thinking=async()=>{f.update('Inspect only');return {text:'obsolete'};};
 await runComputerUse({goal:'Create a note'},f.deps,new AbortController().signal);
 assert.equal(f.calls.filter(x=>x.name==='computer_action').length,0);
});
test('unknown mutation fences continuation and is not replayed',async()=>{
 const f=fixture(['type:c1']),call=f.deps.call;f.deps.call=async(...args)=>args[0]==='computer_action'?{state:'unknown'}:call(...args);
 const r=await runComputerUse({goal:'Create a note'},f.deps,new AbortController().signal);
 assert.equal(r.status,'needs_reconciliation');assert(r.operationId);
});
test('revoked authorization cannot dispatch even after successful inference',async()=>{
 const f=fixture(['type:c1']),evaluate=f.deps.evaluate;let allowed=true;f.deps.authorized=()=>allowed;
 f.deps.evaluate=async(...args)=>{const r=await evaluate(...args);allowed=false;return r;};
 const r=await runComputerUse({goal:'Create a note'},f.deps,new AbortController().signal);
 assert.equal(r.reason,'ACCESS_DENIED');assert.equal(f.calls.filter(x=>x.name==='computer_action').length,0);
});
test('independent verification is strict and partial observations cannot complete',async()=>{
 for(const truncated of [true,false]){const f=fixture(['DONE']);f.state.truncated=truncated;f.deps.verify=async()=>true;
 const r=await runComputerUse({goal:'Inspect'},f.deps,new AbortController().signal);assert.equal(r.status,truncated?'needs_verification':'succeeded');}
});
test('experience hooks are ignored by the basic computer loop',async()=>{
 for(const verified of [true,false]){
  const f=fixture(['type:c1','DONE']),call=f.deps.call,evaluate=f.deps.evaluate;const outcomes:string[]=[];let state=structuredClone(f.state),hintSeen=false;
  f.deps.call=async(name,args,signal)=>{if(name==='computer_observe')return structuredClone(state);if(name==='computer_action')state={...state,generation:'g2',controls:[{...state.controls[0],value:'milk'}]};return call(name,args,signal);};
  (f.deps as any).experience={select:async()=>[{when:{role:'text-area',state:'empty'},action:'type',expected:'value-changed',source:'pack',validation:'fixture',success:0,failure:0}],record:async(_c:unknown,_e:unknown,outcome:string)=>{outcomes.push(outcome);}};
  f.deps.evaluate=async(...args)=>{hintSeen=Array.isArray((args[0].state as any).experience)&&(args[0].state as any).experience.length>0;return evaluate(...args);};
  f.deps.verify=async()=>verified;
  await runComputerUse({goal:'Create a note'},f.deps,new AbortController().signal);
  assert.equal(hintSeen,false);assert.deepEqual(outcomes,[]);
 }
});

test('static app content and window title survive observation parsing and reach verification',async()=>{
 const f=fixture(['DONE']);Object.assign(f.state,{windowTitle:'September 2026',text:['23','Team meeting 10:00']});
 f.deps.verify=async state=>{assert.equal(state.windowTitle,'September 2026');assert.deepEqual(state.text,['23','Team meeting 10:00']);return true;};
 const r=await runComputerUse({goal:'Read this month'},f.deps,new AbortController().signal);assert.equal(r.status,'succeeded');
});
test('BLOCKED choice means no supported action, not an account or provider refusal',async()=>{
 const f=fixture(['BLOCKED']);const r=await runComputerUse({goal:'Inspect'},f.deps,new AbortController().signal);assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert(r.trace.events.some(e=>e.reason==='NO_SUPPORTED_ACTION'));assert.equal(r.steps,0);
});

test('fresh satisfied field values progress without repeated typing or reopening current app',async()=>{
 const f=fixture(['type:c1','key:enter','DONE']);f.state.controls[0].value='milk';let count=0;
 const evaluate=f.deps.evaluate;f.deps.evaluate=async(...args)=>{const criteria=args[0].questions.action.criteria;assert.equal(Object.hasOwn(criteria,'open:com.apple.Notes'),false);if(count++>0)assert.equal(Object.hasOwn(criteria,'type:c1'),false);return evaluate(...args);};
 const r=await runComputerUse({goal:'Search milk'},f.deps,new AbortController().signal);
 assert.equal(r.steps,1);const actions=f.calls.filter(x=>x.name==='computer_action');assert.equal(actions.length,1);assert.equal(actions[0].args.kind,'key');
});

test('typed search advances to Enter with focused state and within-run action feedback',async()=>{
 const f=fixture([]);let state={...f.state,controls:[{...f.state.controls[0],role:'AXTextField',label:'Search',focused:false}],focusedControl:{ref:'other',role:'AXButton',label:'Other'}};let submitted=false;const events:any[]=[];
 f.deps.progress=e=>events.push(e);
 f.deps.call=async(name,args)=>{f.calls.push({name,args});if(name==='computer_acquire')return {lease_token:'l'};if(name==='computer_observe')return structuredClone(state);if(name==='computer_action'){if(args.kind==='type'){state.controls[0].value=String(args.text);state.controls[0].focused=true;state.focusedControl={ref:'c1',role:'AXTextField',label:'Search'};}if(args.kind==='key'){assert.equal(args.key,'enter');assert.equal(state.controls[0].focused,true);submitted=true;}return {state:'completed'};}return {};};
 f.deps.evaluate=async req=>{const input=req.state as any;let choice='DONE';if(!state.controls[0].value)choice='type:c1';else if(!submitted){assert.equal(input.desktop.focusedControl.ref,'c1');assert.equal(input.recentActions.at(-1).action,'type');assert.equal(input.recentActions.at(-1).changed,true);assert.equal(Object.hasOwn(req.questions.action.criteria,'type:c1'),false);choice='key:enter';}return {answers:{action:{choice,confidence:1,probabilities:Object.fromEntries(Object.keys(req.questions.action.criteria).map(k=>[k,k===choice?1:0]))}}};};
 f.deps.verify=async()=>submitted;
 const r=await runComputerUse({goal:'Search for milk'},f.deps,new AbortController().signal);
 assert.equal(r.status,'succeeded');assert.equal(r.steps,2);assert.equal(r.evaluations,3);
 assert.ok(events.some(e=>e.phase==='thinking'));assert.ok(events.some(e=>e.phase==='acted'&&e.key==='enter'&&e.outcome==='completed'));assert.ok(events.some(e=>e.phase==='observed'&&e.changed));
 assert.equal(JSON.stringify(r.trace).includes('milk'),false);assert.equal(JSON.stringify(r.trace).includes('Search'),false);
});
test('unchanged successful dispatches are observed and not offered endlessly',async()=>{
 const f=fixture([]);f.state.controls=[{ref:'c1',label:'Continue',role:'AXButton',actions:['press'] as any,value:''}];let decision=0;
 f.deps.evaluate=async req=>{const c=req.questions.action.criteria;decision++;if(decision>2)assert.equal(Object.hasOwn(c,'press:c1'),false);const choice=decision<=2?'press:c1':'BLOCKED';return {answers:{action:{choice,confidence:1,probabilities:Object.fromEntries(Object.keys(c).map(k=>[k,k===choice?1:0]))}}};};
 const r=await runComputerUse({goal:'Continue'},f.deps,new AbortController().signal);assert.equal(r.steps,2);assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert(r.trace.events.some(e=>e.reason==='NO_SUPPORTED_ACTION'));assert.equal(r.trace.events.filter(e=>e.phase==='observed'&&e.changed===false).length,2);
});
test('trace sink errors cannot turn a confirmed action into an unknown mutation',async()=>{
 const f=fixture(['type:c1','DONE']);f.deps.progress=()=>{throw Error('sink offline');};const r=await runComputerUse({goal:'Draft a note'},f.deps,new AbortController().signal);assert.equal(r.status,'needs_verification');assert.equal(r.steps,1);assert.equal(r.operationId,undefined);
});

test('shared interruption cancels reasoning but preserves an unknown desktop action',async()=>{
 for(const inFlight of [false,true]){
  const f=fixture(['type:c1']),control=new AbortController(),call=f.deps.call;f.deps.interruptSignal=control.signal;
  if(inFlight)f.deps.call=async(n,a,s)=>{if(n==='computer_action'){control.abort();return {state:'unknown'};}return call(n,a,s);};
  else f.deps.thinking=async()=>{control.abort();return new Promise(()=>{});};
  const r=await runComputerUse({goal:'Type note'},f.deps,new AbortController().signal);
  assert.equal(r.reason,inFlight?'OUTCOME_UNKNOWN':'REVISION_SUPERSEDED');
  if(!inFlight)assert(!f.calls.some(c=>c.name==='computer_action'));
 }
});
test('speech interrupts verification without waiting for the model or reporting stale success',async()=>{
 const f=fixture(['DONE']),control=new AbortController();f.deps.interruptSignal=control.signal;
 f.deps.verify=async(_s,_g,signal)=>{control.abort();assert.equal(signal.aborted,true);return new Promise(()=>{});};
 const r=await runComputerUse({goal:'Inspect note'},f.deps,new AbortController().signal);
 assert.equal(r.reason,'REVISION_SUPERSEDED');assert.equal(r.status,'cancelled');assert(f.calls.some(c=>c.name==='computer_release'));
});
test('speech after the durable fence clears only an undispatched operation',async()=>{
 const f=fixture(['type:c1']),control=new AbortController();f.deps.interruptSignal=control.signal;let operation='';
 f.deps.beforeMutation=id=>{operation=id;control.abort();};
 const r=await runComputerUse({goal:'Write note'},f.deps,new AbortController().signal);
 assert.equal(r.reason,'REVISION_SUPERSEDED');assert(!f.calls.some(c=>c.name==='computer_action'));
 assert(r.trace.events.some(e=>e.operationId===operation&&e.phase==='acted'&&e.outcome==='not_executed'));
});
test('speech during a confirmed desktop mutation waits for its result and never aborts the mutation',async()=>{
 const f=fixture(['type:c1']),control=new AbortController(),call=f.deps.call;f.deps.interruptSignal=control.signal;
 f.deps.call=async(n,a,s)=>{if(n==='computer_action'){control.abort();assert.equal(s.aborted,false);await new Promise(r=>setTimeout(r,10));return {state:'completed'};}return call(n,a,s);};
 const r=await runComputerUse({goal:'Write note'},f.deps,new AbortController().signal);
 assert.equal(r.reason,'REVISION_SUPERSEDED');assert.equal(r.steps,1);assert.equal(r.operationId,undefined);
 assert.equal(f.calls.filter(c=>c.name==='computer_release').length,1);
});

test('lost action reply reads the matching receipt and continues from observation without replay',async()=>{
 const f=fixture(['key:enter','DONE']),call=f.deps.call;let actions=0,reads=0,op='';
 f.deps.call=async(name,args,s)=>{
  if(name==='computer_action'){actions++;op=String(args.operation_id);throw Error('TRANSPORT_LOST');}
  if(name==='computer_operation_status'){reads++;assert.deepEqual(args,{operation_id:op});return {operation_id:op,state:'completed'};}
  return call(name,args,s);
 };
 const r=await runComputerUse({goal:'Search'},f.deps,new AbortController().signal);
 assert.equal(actions,1);assert.equal(reads,1);assert.equal(r.steps,1);assert.equal(r.operationId,undefined);
 assert(r.trace.events.some(e=>e.phase==='reconciling'));assert.equal(r.status,'needs_verification');
});
test('wrong operation receipt cannot clear the mutation fence',async()=>{
 const f=fixture(['key:enter']),call=f.deps.call;let actions=0;
 f.deps.call=async(name,args,s)=>name==='computer_action'?(actions++,{state:'unknown'}):name==='computer_operation_status'?{operation_id:'wrong',state:'completed'}:call(name,args,s);
 const r=await runComputerUse({goal:'Search'},f.deps,new AbortController().signal);
 assert.equal(actions,1);assert.equal(r.status,'needs_reconciliation');assert(r.operationId);
});
test('acquisition recovery preserves the old operation and never starts inference or actions',async()=>{
 const f=fixture(['key:enter']),operation='11111111-1111-4111-8111-111111111111';
 f.deps.call=async()=>({recovery_required:true,operation_id:operation});f.deps.evaluate=async()=>{throw Error('must not infer');};
 const r=await runComputerUse({goal:'Search'},f.deps,new AbortController().signal);
 assert.equal(r.operationId,operation);assert.equal(r.status,'needs_reconciliation');assert.equal(r.evaluations,0);assert.equal(r.steps,0);
});
test('prepared field values bypass Thinking only for a unique current app/field match',async()=>{
 for(const application of ['com.apple.Notes','com.other.App']){
  const f=fixture(['type:c1','DONE']);let calls=0;f.deps.thinking=async()=>{calls++;return {text:'fallback'};};
  await runComputerUse({goal:'Create a note',preparedInputs:[{application,label:'Note',text:'prepared'}]},f.deps,new AbortController().signal);
  assert.equal(calls,application==='com.apple.Notes'?0:1);
  assert.equal(f.calls.find(x=>x.name==='computer_action').args.text,application==='com.apple.Notes'?'prepared':'fallback');
 }
});
test('ambiguous prepared fields do not bypass Thinking',async()=>{
 const f=fixture(['type:c1','DONE']);f.state.controls.push({...f.state.controls[0],ref:'c2'});let calls=0;f.deps.thinking=async()=>{calls++;return {text:'fallback'};};
 await runComputerUse({goal:'Create a note',preparedInputs:[{application:'com.apple.Notes',label:'Note',text:'prepared'}]},f.deps,new AbortController().signal);assert.equal(calls,1);
});
test('completion captures visual evidence for the parent without requiring an inference model',async()=>{
 const f=fixture(['DONE']);(f.state as any).screenshotAvailable=true;let images=0;
 f.deps.snapshot=async()=>{images++;};delete f.deps.thinking;
 const result=await runComputerUse({goal:'Inspect'},f.deps,new AbortController().signal);assert.equal(result.status,'needs_verification');assert.equal(images,1);
});
test('missing field values attach a snapshot before asking the parent without Thinking',async()=>{
 const f=fixture(['type:c1']);(f.state as any).screenshotAvailable=true;delete f.deps.thinking;let captures=0;f.deps.snapshot=async()=>{captures++;};
 const result=await runComputerUse({goal:'Write a note'},f.deps,new AbortController().signal);assert.equal(result.status,'needs_input');assert.equal(captures,1);assert.equal(f.calls.filter(x=>x.name==='computer_action').length,0);
});


test('three progressing actions do not trigger Thinking takeover',async()=>{
 const f=fixture(['key:down','key:down','key:down','DONE']);let count=0;const call=f.deps.call;
 f.deps.call=async(n,a,s)=>{if(n==='computer_action')f.state.controls[0].value=String(++count);return call(n,a,s);};
 (f.deps as any).decideAction=async()=>{throw Error('unexpected takeover');};
 const r=await runComputerUse({goal:'Move down'},f.deps,new AbortController().signal);assert.equal(r.steps,3);assert.equal(r.status,'needs_verification');assert(!r.trace.events.some(e=>e.reason==='THINKING_TAKEOVER'));
});
test('unknown result never hands over or replays even after two no-effect actions',async()=>{
 const f=fixture(['key:down','key:down','key:up']);let actions=0;const call=f.deps.call;
 f.deps.call=async(n,a,s)=>n==='computer_action'&&++actions===3?{state:'unknown'}:call(n,a,s);
 (f.deps as any).decideAction=async()=>{throw Error('must not run');};
 const r=await runComputerUse({goal:'Move'},f.deps,new AbortController().signal);assert.equal(r.status,'needs_reconciliation');assert.equal(f.calls.filter(c=>c.name==='computer_action').length,2);
});

test('new navigation actions are offered only when native observation advertises them',async()=>{
 const f=fixture(['scroll:down','navigate:back','DONE']);Object.assign(f.state,{supportedActions:['scroll:down','navigate:back']});
 const r=await runComputerUse({goal:'Scroll then back'},f.deps,new AbortController().signal);assert.equal(r.steps,2);
 assert.deepEqual(f.calls.filter(c=>c.name==='computer_action').map(c=>[c.args.kind,c.args.direction]),[['scroll','down'],['navigate','back']]);
});


test('control slice returns after one confirmed action and captures its screen',async()=>{
 const f=fixture(['key:enter','key:down']);let captures=0;Object.assign(f.state,{screenshotAvailable:true});f.deps.snapshot=async()=>{captures++;};
 const r=await runComputerUse({goal:'Continue',yieldAfterAction:true},f.deps,new AbortController().signal);
 assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.equal(r.steps,1);assert.equal(r.evaluations,1);assert.equal(captures,1);assert.notEqual(r.status,'succeeded');
});

test('app switching stops after three opens even when every screen changes',async()=>{
 {
  const f=fixture([]);f.state.apps=[{id:'a',name:'A'},{id:'b',name:'B'}];f.state.application='a';f.state.controls=[];
  let decisions=0,thinking=0;const call=f.deps.call;
  f.deps.call=async(n,a,s)=>{if(n==='computer_action')f.state.application=String(a.app_id);return call(n,a,s);};
  f.deps.evaluate=async req=>{decisions++;const choice=f.state.application==='a'?'open:b':'open:a';return {answers:{action:{choice,confidence:1,probabilities:Object.fromEntries(Object.keys(req.questions.action.criteria).map(k=>[k,k===choice?1:0]))}}};};
  const r=await runComputerUse({goal:'Open B'},f.deps,new AbortController().signal);
  assert.equal(r.status,'needs_input');assert.equal(r.steps,3);assert.equal(decisions,3);assert.equal(thinking,0);
  assert(r.trace.events.some(e=>e.appId==='b'));
 }
});

function choiceFor(criteria:Record<string,string>,choice:string){return {choice,confidence:1,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===choice?1:0]))};}
test('a satisfied open-only command cannot click a field from an earlier search',async()=>{
 const f=fixture([]);f.deps.evaluate=async req=>({answers:{action:choiceFor(req.questions.action.criteria,'type:c1'),completion:choiceFor(req.questions.completion.criteria,'SATISFIED')}});
 const r=await runComputerUse({goal:'Open Notes. Previous reference only: search milk'},f.deps,new AbortController().signal);
 assert.equal(r.steps,0);assert.equal(r.status,'needs_verification');assert.equal(f.calls.filter(c=>c.name==='computer_action').length,0);
});
test('DONE with unknown completion returns control without silently claiming completion',async()=>{
 const f=fixture([]);let calls=0;
 f.deps.evaluate=async req=>({answers:{action:choiceFor(req.questions.action.criteria,'DONE'),completion:choiceFor(req.questions.completion.criteria,'UNKNOWN')}});
 (f.deps as any).decideAction=async()=>{calls++;return {action:null,text:null};};
 const r=await runComputerUse({goal:'Search milk'},f.deps,new AbortController().signal);
 assert.equal(calls,0);assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.ok(r.trace.events.some(e=>e.reason==='COMPLETION_NOT_ESTABLISHED'));assert.equal(r.steps,0);
});
test('an unsupported completion returns control without an inference recovery ladder',async()=>{
 const f=fixture([]);let decisions=0;
 f.deps.evaluate=async req=>{decisions++;return {answers:{action:choiceFor(req.questions.action.criteria,'DONE'),completion:choiceFor(req.questions.completion.criteria,'REQUIRED_STEP')}};};
 const r=await runComputerUse({goal:'Type milk'},f.deps,new AbortController().signal);
 assert.equal(r.steps,0);assert.equal(decisions,1);assert.equal(r.reason,'COMMAND_WAITING_INPUT');
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,0);
});

test('alternating navigation and clicks are detected despite volatile page text',async()=>{
 const f=fixture([]);let n=0,observed=0,thinking=0;
 f.state.controls=[{ref:'c1',label:'Back target',role:'AXButton',actions:['press'] as any,value:''}];
 const call=f.deps.call;f.deps.call=async(name,args,signal)=>{if(name==='computer_observe')return {...f.state,text:['Clock '+observed],supportedActions:['navigate:back']};if(name==='computer_action')observed++;return call(name,args,signal);};
 f.deps.evaluate=async req=>({answers:{action:choiceFor(req.questions.action.criteria,n++%2===0?'press:c1':'navigate:back')}});
 (f.deps as any).decideAction=async()=>{thinking++;return {action:null,text:null};};
 const r=await runComputerUse({goal:'Find the requested result'},f.deps,new AbortController().signal);
 assert.equal(r.steps,4);assert.equal(thinking,0);assert.equal(r.reason,'COMMAND_WAITING_INPUT');
});
test('follow-up Enter uses one key action and shares continuation semantics with both questions',async()=>{
 const f=fixture(['key:enter','DONE']);const evaluate=f.deps.evaluate;
 f.deps.evaluate=async(req,s)=>{
  assert.equal(typeof req.questions.action.instructions,'string');
  assert.equal(typeof req.questions.completion.instructions,'string');
  assert.match(req.questions.action.instructions as string,/CURRENT command/);
  assert.match(req.questions.completion.instructions as string,/CURRENT requested effect/);
  return evaluate(req,s);
 };
 await runComputerUse({goal:'Current user command: enter เลย. Previous command: open Facebook in a new tab.'},f.deps,new AbortController().signal);
 const actions=f.calls.filter(x=>x.name==='computer_action');assert.equal(actions.length,1);assert.equal(actions[0].args.kind,'key');assert.equal(actions[0].args.key,'enter');
});
test('device Thinking preference is ignored: Jev starts every command without requiring screenshots',async()=>{
 const f=fixture(['type:c1','DONE']);Object.assign(f.state,{decisionMode:'thinking',screenshotAvailable:false});
 (f.deps as any).decideAction=async()=>{throw Error('unexpected fallback');};
 f.deps.snapshot=async()=>{throw Error('screenshots must not block AX decisions');};
 const r=await runComputerUse({goal:'Type hello'},f.deps,new AbortController().signal);
 assert(r.evaluations>0);assert.equal(r.steps,1);
});





test('low confidence cannot dispatch an otherwise available action',async()=>{
 const f=fixture([]); f.deps.evaluate=async req=>({answers:{action:{...choiceFor(req.questions.action.criteria,Object.hasOwn(req.questions.action.criteria,'type:c1')?'type:c1':'type'),confidence:.1}}});
 const r=await runComputerUse({goal:'Type milk'},f.deps,new AbortController().signal);
 assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert(r.trace.events.some(e=>e.reason==='LOW_CONFIDENCE'));assert.equal(r.steps,0);assert(!f.calls.some(c=>c.name==='computer_action'));
});
test('freshness changes during Jev evaluation discard its action before checkpoint',async()=>{
 const f=fixture(['type:c1','DONE']);const evaluate=f.deps.evaluate;let checkpoints=0;
 f.deps.beforeMutation=()=>{checkpoints++;};
 f.deps.evaluate=async(...args)=>{const answer=await evaluate(...args);f.state.controls[0].label='Different field';return answer;};
 // Remote observations are values, not aliases of mutable fixture state.
 const call=f.deps.call;f.deps.call=async(...args)=>structuredClone(await call(...args));
 const r=await runComputerUse({goal:'Type milk'},f.deps,new AbortController().signal);
 assert.equal(checkpoints,0);assert.equal(r.steps,0);assert(r.trace.events.some(e=>e.reason==='ACTION_CONTEXT_CHANGED'));
});

test('typed provider failure codes remain visible instead of becoming user-input waits',async()=>{
 const f=fixture(['type:c1']);f.deps.thinking=async()=>{throw Error('THINKING_HTTP_429');};
 const r=await runComputerUse({goal:'Inspect'},f.deps,new AbortController().signal);
 assert.equal(r.status,'blocked');assert.equal(r.reason,'THINKING_HTTP_429');assert.equal(r.steps,0);
});

test('completion evidence is considered before low action confidence without calling a fallback',async()=>{
 const f=fixture([]);let calls=0;
 (f.deps as any).decideAction=async()=>{calls++;throw Error('removed action fallback');};
 f.deps.evaluate=async req=>({answers:{action:{...choiceFor(req.questions.action.criteria,'DONE'),confidence:.48},completion:choiceFor(req.questions.completion.criteria,'SATISFIED')}});
 const r=await runComputerUse({goal:'Open Notes'},f.deps,new AbortController().signal);
 assert.equal(r.status,'needs_verification');assert.equal(r.evaluations,1);assert.equal(r.steps,0);assert.equal(calls,0);
});
test('unsupported actions yield with a snapshot and never invoke a legacy action fallback',async()=>{
 const f=fixture(['BLOCKED']);let captures=0,calls=0;
 f.deps.snapshot=async()=>{captures++;};(f.deps as any).decideAction=async()=>{calls++;return {action:'type:c1',text:'unrequested'};};
 const r=await runComputerUse({goal:'Inspect'},f.deps,new AbortController().signal);
 assert.equal(r.status,'needs_input');assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.equal(captures,1);assert.equal(calls,0);assert.equal(r.steps,0);
});

test('native observations count Thai combining marks and emoji as Swift graphemes',()=>{
 const f=fixture([]);
 for(const unit of ['ก้','👨‍👩‍👧‍👦','e\u0301']){
  f.state.controls[0].value=unit.repeat(2000);
  assert.equal(ComputerObservation.parse(f.state).controls[0].value,unit.repeat(2000));
  assert.equal(ComputerObservation.safeParse({...f.state,controls:[{...f.state.controls[0],value:unit.repeat(2001)}]}).success,false);
  const result=ComputerObservation.safeParse({...f.state,controls:[{...f.state.controls[0],label:unit.repeat(500)}],text:[unit.repeat(300)],windowTitle:unit.repeat(500)});
  assert.equal(result.success,true);
 }
});

test('covered native target yields once with evidence instead of refreshing and repeating the same click',async()=>{
 const f=fixture(['type:c1']);const call=f.deps.call;let captured=0;
 f.deps.snapshot=async()=>{captured++;};
 f.deps.call=async(...args)=>args[0]==='computer_action'?{state:'not_executed',error:'TARGET_OCCLUDED'}:call(...args);
 const r=await runComputerUse({goal:'Type milk'},f.deps,new AbortController().signal);
 assert.equal(r.steps,0);assert.equal(r.evaluations,1);assert.equal(r.reason,'COMMAND_WAITING_INPUT');
 assert(r.trace.events.some(e=>e.phase==='waiting'&&e.reason==='TARGET_OCCLUDED'));assert.equal(r.operationId,undefined);assert(captured>0);
});


test.each(['PROVIDER_UNAVAILABLE','RATE_LIMITED','OUTCOME_UNKNOWN'] as const)('Jev %s preserves its typed reason without dispatch or inference retry',async code=>{
 const f=fixture(['key:enter']);let evaluations=0;
 f.deps.evaluate=async()=>{evaluations++;throw new JevError(code,'Provider details must not be copied into task diagnostics.');};
 const result=await runComputerUse({goal:'Press Enter once'},f.deps,new AbortController().signal);
 assert.equal(result.reason,'JEV_'+code);assert.equal(result.status,'blocked');assert.equal(evaluations,1);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,0);
 assert(!JSON.stringify(result).includes('Provider details'));
});

test('uncertain kind on a large desktop does not select or execute a target',async()=>{
 const f=fixture([]);f.state.apps=Array.from({length:70},(_,i)=>({id:'app-'+i,name:'App '+i}));
 let evaluations=0;
 f.deps.evaluate=async req=>{evaluations++;const keys=Object.keys(req.questions.action.criteria);return {answers:{action:{choice:keys.includes('type')?'type':'type:c1',confidence:.2,probabilities:Object.fromEntries(keys.map(k=>[k,k===(keys.includes('type')?'type':'type:c1')?1:0]))}}};};
 const result=await runComputerUse({goal:'Type milk'},f.deps,new AbortController().signal);
 assert.equal(result.status,'needs_input');assert.equal(evaluations,1);assert.equal(f.calls.filter(c=>c.name==='computer_action').length,0);
});


test('a foreground app remains reopenable when its window was closed',async()=>{
 const f=fixture([]);f.state.application='app';f.state.apps=[{id:'app',name:'Example'}];Object.assign(f.state,{windowTitle:''});f.state.controls=[];
 f.deps.evaluate=async req=>{assert(req.questions.target_open.criteria['open:app'].startsWith('Reopen '));return responseFor(req,'open:app');};
 const r=await runComputerUse({goal:'Reopen Example to show its document window',yieldAfterAction:true},f.deps,new AbortController().signal);
 assert.equal(r.steps,1);assert.equal(f.calls.find(c=>c.name==='computer_action')!.args.app_id,'app');
});

 test.each([true,false,undefined])('single-command typing executes the requested field once even when its value matches (focused=%s)',async focused=>{
 const f=fixture(['type:c1','type:c2']);f.state.controls[0].value='milk';Object.assign(f.state.controls[0],{focused});
 f.state.controls.push({ref:'c2',label:'Unrelated field',role:'AXTextArea',actions:['type'],value:''});
 let checkpoints=0;f.deps.beforeMutation=()=>{checkpoints++;};
 const r=await runComputerUse({goal:'Type "milk" in Note',yieldAfterAction:true},f.deps,new AbortController().signal);
 assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.equal(r.status,'needs_input');
 assert.equal(r.steps,1);assert.equal(r.evaluations,1);assert.equal(checkpoints,1);
 const actions=f.calls.filter(x=>x.name==='computer_action');assert.equal(actions.length,1);
 assert.equal(actions[0].args.ref,'c1');assert.equal(actions[0].args.text,'milk');
 });

 test.each(['fresh','read-failed','capture-failed'])('unknown mutation retains post-action evidence without replay: %s',async mode=>{
 const f=fixture(['type:c1','type:c1']);let dispatched=false,actions=0,captures=0;const call=f.deps.call;
 f.deps.call=async(n,a,s)=>{
  if(n==='computer_action'){dispatched=true;actions++;return {state:'unknown'};}
  if(n==='computer_observe'&&dispatched){if(mode==='read-failed')throw Error('READ_FAILED');return {...f.state,generation:'after',controls:[{...f.state.controls[0],value:'milk'}]};}
  return call(n,a,s);
 };
 f.deps.snapshot=async state=>{if(!dispatched)return;captures++;assert.equal(state.generation,'after');if(mode==='capture-failed')throw Error('CAPTURE_FAILED');};
 const r=await runComputerUse({goal:'Type milk',yieldAfterAction:true},f.deps,new AbortController().signal);
 assert.equal(r.status,'needs_reconciliation');assert.equal(r.reason,'OUTCOME_UNKNOWN');assert.ok(r.operationId);
 assert.equal(actions,1);assert.equal(captures,mode==='read-failed'?0:1);
 assert.equal(r.observation?.generation,mode==='read-failed'?'g':'after');
 });


// Safari Wikipedia exceeded the native scan deadline; preserve the reason and
// exact helper identity instead of silently dropping diagnostics from receipts.
test('incomplete native observations retain screenshot diagnostics without capturing or claiming success',async()=>{
 const f=fixture(['BLOCKED']);
 Object.assign(f.state,{truncated:true,screenshotAvailable:false,
  screenshotRestriction:'SCREENSHOT_OBSERVATION_INCOMPLETE',
  observationStats:{visited:3775,candidates:103,exported:103,incomplete:true},
  platform:{os:'macos',osVersion:'15.6.1',appVersion:'18.6.0',helperVersion:'0.2.42',helperBuild:'36438883961',helperCommit:'e121defcc0dc58197548932689d581d2696aaf8f'}});
 let observed:any;f.deps.observation=state=>{observed=state;};
 f.deps.snapshot=async()=>{throw Error('restricted capture must not be attempted');};
 const result=await runComputerUse({goal:'Inspect the current page',yieldAfterAction:true},f.deps,new AbortController().signal);
 assert.equal(observed.screenshotRestriction,'SCREENSHOT_OBSERVATION_INCOMPLETE');
 assert.deepEqual(observed.observationStats,(f.state as any).observationStats);
 assert.deepEqual(observed.platform,(f.state as any).platform);
 assert.equal(result.status,'needs_input');
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,0);
});

for(const reason of ['FOCUS_REQUIRED','FOCUS_UNSUPPORTED'])test(`native ${reason} returns fresh evidence without repeated typing`,async()=>{
 const f=fixture(['type:c1']);const call=f.deps.call;let attempts=0,fresh=false;
 f.deps.call=async(...args)=>{if(args[0]==='computer_action'){attempts++;f.state.controls[0].label='Search requiring a click';return {state:'not_executed',error:reason};}return call(...args);};
 f.deps.observation=state=>{if(state.controls[0]?.label==='Search requiring a click')fresh=true;};
 const r=await runComputerUse({goal:'Type milk'},f.deps,new AbortController().signal);
 assert.equal(attempts,1);assert.equal(r.steps,0);assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.equal(r.operationId,undefined);assert(fresh);
 assert(r.trace.events.some(e=>e.phase==='waiting'&&e.reason===reason));
});

const scrollPanes=[{ref:'s0',label:'Navigation',bounds:{x:0,y:0,width:.25,height:1}},{ref:'s1',label:'Content',bounds:{x:.25,y:0,width:.75,height:1}}];
test('scroll targets bind direction to the selected observed pane',async()=>{
 const f=fixture(['scroll:up:s0']);Object.assign(f.state,{supportedActions:['scroll:up','scroll:down'],scrollAreas:scrollPanes});
 const evaluate=f.deps.evaluate;f.deps.evaluate=async(...args)=>{const c=args[0].questions.target_scroll.criteria;assert(!('scroll:up' in c));assert('scroll:up:s0' in c&&'scroll:up:s1' in c);return evaluate(...args);};
 const r=await runComputerUse({goal:'Scroll the left sidebar up',yieldAfterAction:true},f.deps,new AbortController().signal);
 const actions=f.calls.filter(c=>c.name==='computer_action');assert.equal(actions.length,1);assert.equal(actions[0].args.ref,'s0');assert.equal(actions[0].args.direction,'up');assert.equal(r.steps,1);
});
test.each(['ref','geometry'] as const)('changed scroll pane %s fences a stale choice before dispatch',async change=>{
 const f=fixture(['scroll:up:s0','DONE']);Object.assign(f.state,{supportedActions:['scroll:up'],scrollAreas:scrollPanes});const call=f.deps.call;let observations=0;
 f.deps.call=async(...args)=>{const value=await call(...args);if(args[0]==='computer_observe'&&++observations>1)return {...ComputerObservation.parse(value),scrollAreas:scrollPanes.map((area,i)=>i?area:change==='ref'?{...area,ref:'new'}:{...area,bounds:{...area.bounds,width:.2}})};return structuredClone(value);};
 await runComputerUse({goal:'Scroll left up'},f.deps,new AbortController().signal);assert.equal(f.calls.filter(c=>c.name==='computer_action').length,0);
});
test('unknown targeted scroll retains its receipt and is never replayed to another pane',async()=>{
 const f=fixture(['scroll:up:s0']);Object.assign(f.state,{supportedActions:['scroll:up'],scrollAreas:scrollPanes});const call=f.deps.call;let attempts=0;
 f.deps.call=async(...args)=>{if(args[0]==='computer_action'){attempts++;assert.equal(args[1].ref,'s0');return {state:'unknown'};}if(args[0]==='computer_operation_status')return {operation_id:args[1].operation_id,state:'unknown'};return call(...args);};
 const r=await runComputerUse({goal:'Scroll left up'},f.deps,new AbortController().signal);assert.equal(r.status,'needs_reconciliation');assert(r.operationId);assert.equal(attempts,1);
});
test('legacy observations keep direction-only scroll without invented refs',async()=>{
 const f=fixture(['scroll:up']);Object.assign(f.state,{supportedActions:['scroll:up']});
 await runComputerUse({goal:'Scroll up',yieldAfterAction:true},f.deps,new AbortController().signal);
 const a=f.calls.find(c=>c.name==='computer_action');assert(a);assert.equal(a.args.kind,'scroll');assert.equal(a.args.ref,undefined);
});
test('scroll observations reject duplicate refs and off-window geometry',()=>{
 const f=fixture([]);
 for(const scrollAreas of [[scrollPanes[0],scrollPanes[0]],[{...scrollPanes[0],bounds:{x:.9,y:0,width:.2,height:1}}]])assert.equal(ComputerObservation.safeParse({...f.state,scrollAreas}).success,false);
});

test('action trace retains its target frame when a later frame reuses the same ref',async()=>{
 const f=fixture(['press:c1','DONE']);
 let state={...f.state,controls:[{ref:'c1',role:'AXMenuItem',label:'Private original target',actions:['press'] as any,value:''}]};
 f.deps.call=async(name,args)=>{
  if(name==='computer_acquire')return {lease_token:'l'};
  if(name==='computer_observe')return structuredClone(state);
  if(name==='computer_action'){state={...state,generation:'after',controls:[{...state.controls[0],role:'AXButton',label:'Private different target'}]};return {state:'completed'};}
  return {};
 };
 const r=await runComputerUse({goal:'Navigate'},f.deps,new AbortController().signal);
 assert.equal(r.steps,1);assert.equal(r.observation?.generation,'after');
 const actionEvents=r.trace.events.filter(e=>e.action==='press'&&['acting','acted','observed'].includes(e.phase));
 assert.equal(actionEvents.length,3);
 for(const event of actionEvents){assert.equal(event.ref,'c1');assert.equal(event.targetGeneration,'g');assert.equal(event.role,'AXMenuItem');}
 assert.equal(JSON.stringify(r.trace).includes('Private'),false);
});

test('control geometry survives observation parsing and rejects coordinates outside the approved window',()=>{
 const f=fixture([]);const bounds={x:.1,y:.2,width:.3,height:.4};
 const state={...f.state,controls:[{...f.state.controls[0],bounds}]};
 assert.deepEqual(ComputerObservation.parse(state).controls[0].bounds,bounds);
 assert(ComputerObservation.safeParse(f.state).success);
 for(const invalid of [{...bounds,x:-.1},{...bounds,x:.9},{...bounds,width:0},{...bounds,y:Infinity}]){
  assert(!ComputerObservation.safeParse({...state,controls:[{...state.controls[0],bounds:invalid}]}).success);
 }
});

for(const operation of ['scroll:up','scroll:down','navigate:back','navigate:forward'])test('a direct relative command executes once even when the model keeps requesting it: '+operation,async()=>{
 const f=fixture([]);Object.assign(f.state,{supportedActions:[operation]});
 f.deps.evaluate=async req=>responseFor(req,operation);
 const r=await runComputerUse({goal:'One relative navigation step',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.equal(r.steps,1);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,1);
});

for(const operation of ['press:c2','key:enter','open:com.example.Browser'])test('direct interaction yields before reinterpreting a completed action: '+operation,async()=>{
 const f=fixture([]);f.state.controls.push({ref:'c2',label:'Close popup',role:'AXButton',actions:['press'],value:''});
 f.state.apps.push({id:'com.example.Browser',name:'Browser'});let queries=0,captures=0;
 f.deps.snapshot=async()=>{captures++;};
 f.deps.evaluate=async req=>{assert.equal(++queries,1);return responseFor(req,operation);};
 const r=await runComputerUse({goal:'One direct interaction',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.equal(r.status,'needs_input');assert.equal(r.steps,1);assert.equal(captures,0);assert.equal(r.observation,undefined);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,1);
});
for(const mode of ['settles','continuous','revoked'])test('post-action stale screenshot refreshes evidence without replay: '+mode,async()=>{
 const f=fixture(['key:enter']);let captures=0,authorized=true;
 f.deps.authorized=()=>authorized;
 f.deps.snapshot=async()=>{captures++;if(mode==='revoked')authorized=false;if(mode!=='settles'||captures===1)throw Error('STALE_OBSERVATION');};
 const r=await runComputerUse({goal:'Press Enter once',yieldAfterAction:true},f.deps,new AbortController().signal);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,1);assert.equal(r.steps,1);
 if(mode==='revoked'){assert.equal(r.reason,'ACCESS_DENIED');assert.equal(captures,1);}
 else{assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.equal(captures,mode==='settles'?2:3);assert.equal(Boolean(r.observation),mode==='settles');assert(r.trace.events.some(e=>e.reason==='POST_ACTION_EVIDENCE_STALE'));}
});

test('literal text candidates preserve exact quoted content and never invent domains',()=>{
 assert.deepEqual(literalTextCandidates('พิมพ์ "New  York"'),['New  York']);
 assert.deepEqual(literalTextCandidates('เข้า google.com'),['google.com']);
 assert.deepEqual(literalTextCandidates('open YouTube'),[]);
 assert.deepEqual(literalTextCandidates('email user@example.com'),[]);
 assert.deepEqual(literalTextCandidates('search flights'),[]);
 assert(literalTextCandidates(Array.from({length:30},(_,i)=>'"value'+i+'"').join(' ')).length<=16);
});
test('editable field neighbour context reaches decisions without replacing its value',async()=>{
 const f=fixture(['DONE']);Object.assign(f.state.controls[0],{label:'Promotional placeholder',context:'Search products',value:''});
 f.deps.evaluate=async req=>{const field=(req.state as any).desktop.controls[0];assert.equal(field.context,'Search products');assert.equal(field.value,'');return {answers:{action:choiceFor(req.questions.action.criteria,'DONE')}};};
 await runComputerUse({goal:'Inspect search field'},f.deps,new AbortController().signal);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,0);
});

function responseFor(req:Parameters<ComputerUseDependencies['evaluate']>[0],chosen:string,submit=false){
 if(!Object.keys(req.questions).some(k=>k.startsWith('target_')))return {answers:{action:choiceFor(req.questions.action.criteria,chosen)}};
 const kind=chosen.split(':')[0];
 return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choiceFor(q.criteria,name==='action'?(submit&&kind==='type'?'submit_text':kind):name==='target_'+kind?chosen:name==='submit'?(submit?'ENTER':'NONE'):name==='text'?'TEXT:0':'BLOCKED')]))};
}
for(const mode of ['valid','uncertain','invalid','wrong-kind','stale','revision','revoked'])test('one command batch retains mutation guards: '+mode,async()=>{
 const f=fixture([]);let queries=0,allowed=true;f.deps.authorized=()=>allowed;
 f.state.apps=Array.from({length:100},(_,i)=>({id:'app-'+i,name:'App '+i}));
 f.state.controls=Array.from({length:150},(_,i)=>({ref:'field-'+i,label:'Field '+i,role:'AXTextField',actions:['press','type'],value:''})) as any;
 const abort=new AbortController();let observations=0;const call=f.deps.call;
 f.deps.call=async(...args)=>{if(args[0]==='computer_observe'&&++observations>2&&['stale','revision'].includes(mode))abort.abort();const value=await call(...args);return args[0]==='computer_action'&&mode==='stale'?{state:'not_executed',error:'STALE_OBSERVATION'}:structuredClone(value);};
 f.deps.evaluate=async req=>{
  queries++;validateJevRequest(req,{});assert.equal((req.state as any).previousInteraction,'Prior command evidence');
  assert(!req.questions.target_menu);assert.equal(Object.keys(req.questions.target_press.criteria).length,151);
  const r=responseFor(req,'press:field-149');
  if(mode==='uncertain')r.answers.target_press.confidence=.2;
  if(mode==='invalid'||mode==='wrong-kind')r.answers.target_press=choiceFor(req.questions.target_press.criteria,mode==='invalid'?'press:invented':'type:field-149');
  if(mode==='stale')f.state.controls[149].label='Other target';
  if(mode==='revision')f.update('Stop');
  if(mode==='revoked')allowed=false;
  return r;
 };
 const r=await runComputerUse({goal:'Click Field 149',interactionContext:'Prior command evidence',yieldAfterInteraction:true},f.deps,abort.signal);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,['valid','stale'].includes(mode)?1:0);
 if(mode==='stale')assert.equal(r.steps,0);
 if(!['stale','revision'].includes(mode))assert.equal(queries,1);
 if(mode==='valid')assert.equal(r.evaluations,1);
});
test('every speculative command head carries the current revision, not prior interaction text',async()=>{
 const f=fixture([]);f.update('Type "replacement"');let evaluations=0;
 f.deps.evaluate=async req=>{
  evaluations++;validateJevRequest(req,{});
  for(const q of Object.values(req.questions)){
   assert.equal(typeof q.instructions,'object');
   assert.equal((q.instructions as {command:string}).command,'Type "replacement"');
  }
  assert.equal((req.state as any).command,'Type "replacement"');
  assert.equal((req.state as any).previousInteraction,'Type "obsolete"');
  return responseFor(req,'type:c1');
 };
 const obsolete=await runComputerUse({goal:'Type "obsolete"',interactionContext:'Type "obsolete"',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(obsolete.reason,'REVISION_SUPERSEDED');assert.equal(evaluations,0);
 const result=await runComputerUse({goal:'Type "replacement"',revision:2,interactionContext:'Type "obsolete"',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(result.revision,2);assert.equal(evaluations,1);
 const actions=f.calls.filter(c=>c.name==='computer_action');
 assert.equal(actions.length,1);assert.equal(actions[0].args.text,'replacement');
});
for(const mode of ['type-only','submit','renamed','renumbered','focus-changed','window-changed','unknown','revision','value-present'])test('literal payload and submit are selected in the original batch: '+mode,async()=>{
 const f=fixture([]);Object.assign(f.state.controls[0],{identity:'11111111-1111-4111-8111-111111111111'});delete f.deps.thinking;let queries=0;const call=f.deps.call;
 f.deps.evaluate=async req=>{queries++;assert.equal(JSON.parse(req.questions.text.criteria['TEXT:0']).text,'Bangkok');return responseFor(req,'type:c1',mode!=='type-only');};
 if(mode==='value-present'){f.state.controls[0].value='Bangkok';Object.assign(f.state.controls[0],{focused:false});}
 f.deps.call=async(name,args,s)=>{const result=await call(name,args,s);if(name==='computer_action'&&args.kind==='type'){
  if(mode==='unknown')return {state:'unknown'};
  Object.assign(f.state.controls[0],{value:'Bangkok',focused:mode!=='focus-changed'});
  if(mode==='revision')f.update('Stop');
  if(mode==='renamed')f.state.controls[0].label='AXTextArea';
  if(mode==='renumbered')f.state.controls[0].ref='new-ref';
  if(mode==='window-changed')Object.assign(f.state.controls[0],{identity:'22222222-2222-4222-8222-222222222222'});
 }return structuredClone(result);};
 const r=await runComputerUse({goal:'Type "Bangkok"'+(mode==='type-only'?'':' and submit'),yieldAfterInteraction:true},f.deps,new AbortController().signal);
 const actions=f.calls.filter(c=>c.name==='computer_action');
 assert.equal(queries,1);assert.equal(actions.length,['submit','renamed','renumbered','value-present'].includes(mode)?2:1);
 assert.equal(actions[0].args.text,'Bangkok');
 if(mode==='unknown')assert.equal(r.status,'needs_reconciliation');
 if(mode==='focus-changed'||mode==='window-changed')assert(r.trace.events.some(e=>e.reason==='SUBMIT_CONTEXT_CHANGED'));
});
for(const mode of ['none','uncertain','invalid'])test('literal payload cannot be fabricated by a command choice: '+mode,async()=>{
 const f=fixture([]);delete f.deps.thinking;
 f.deps.evaluate=async req=>{const r=responseFor(req,'type:c1');r.answers.text=choiceFor(req.questions.text.criteria,mode==='invalid'?'TEXT:99':mode==='none'?'NONE':'TEXT:0');if(mode==='uncertain')r.answers.text.confidence=.1;return r;};
 const r=await runComputerUse({goal:'Type "Bangkok"',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,0);assert.equal(r.evaluations,1);
});

test('command target choices carry observed semantics and preserve spatial evidence',async()=>{
 const f=fixture([]);const bounds={x:.1,y:.2,width:.3,height:.1};
 Object.assign(f.state.controls[0],{context:'Neighbouring field purpose',bounds});
 let checked=false;f.deps.evaluate=async req=>{
  validateJevRequest(req,{});const desktop=(req.state as any).desktop;
  const field=JSON.parse(desktop.elements[0]);
  assert.equal(field.context,'Neighbouring field purpose');assert.deepEqual(field.bounds,bounds);assert.equal(field.value,'');
  const target=JSON.parse(req.questions.target_type.criteria['type:c1']);
  assert.equal(target.label,field.label);assert.equal(target.value,field.value);assert.equal(target.context,field.context);assert.equal(target.role,field.role);
  assert.equal(target.ref,'c1');
  assert.equal(desktop.truncated,false);checked=true;return responseFor(req,'BLOCKED');
 };
 await runComputerUse({goal:'Inspect',yieldAfterInteraction:true},f.deps,new AbortController().signal);assert(checked);
});

test('an older helper without stable target identity cannot partially dispatch type-and-submit',async()=>{
 const f=fixture([]);f.deps.evaluate=async req=>responseFor(req,'type:c1',true);
 const r=await runComputerUse({goal:'Type "x" and submit',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.steps,0);assert(r.trace.events.some(e=>e.reason==='SUBMIT_IDENTITY_UNAVAILABLE'));
});

for(const rejection of ['STALE_OBSERVATION','ACCESS_REVOKED'])test('planned submission never re-decides or replays a rejected native dispatch: '+rejection,async()=>{
 const f=fixture([]);Object.assign(f.state.controls[0],{identity:'11111111-1111-4111-8111-111111111111'});
 let queries=0,readsAfterType=0,typed=false,keys=0;const call=f.deps.call;
 f.deps.evaluate=async req=>{queries++;return responseFor(req,'type:c1',true);};
 f.deps.call=async(name,args,s)=>{
  if(name==='computer_observe'&&typed)readsAfterType++;
  const r=await call(name,args,s);
  if(name==='computer_action'&&args.kind==='type'){typed=true;Object.assign(f.state.controls[0],{value:'Bangkok',focused:true});}
  if(name==='computer_action'&&args.kind==='key'){keys++;return {state:'not_executed',error:rejection};}
  return structuredClone(r);
 };
 const r=await runComputerUse({goal:'Type "Bangkok" and submit',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(queries,1);assert.equal(keys,1);assert.equal(readsAfterType,1);
 assert.equal(r.steps,1);assert(r.trace.events.some(e=>e.reason===rejection));
});

test('same-label controls remain separate spatial choices and dispatch the selected ref',async()=>{
 const f=fixture([]);
 (f.state as any).controls=[
  {ref:'left',label:'Document',role:'AXRadioButton',actions:['press'],bounds:{x:.1,y:0,width:.1,height:.05}},
  {ref:'right',label:'Document',role:'AXRadioButton',actions:['press'],bounds:{x:.3,y:0,width:.1,height:.05}},
 ];
 f.deps.evaluate=async req=>{
  const elements=(req.state as any).desktop.elements.map((line:string)=>JSON.parse(line));
  assert.equal(elements.length,2);assert(elements[0].bounds.x<elements[1].bounds.x);
  assert.equal(JSON.parse(req.questions.target_press.criteria['press:left']).label,'Document');
  assert.equal(JSON.parse(req.questions.target_press.criteria['press:right']).label,'Document');
  return responseFor(req,'press:right');
 };
 await runComputerUse({goal:'Select the right Document tab',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 const actions=f.calls.filter(c=>c.name==='computer_action');
 assert.equal(actions.length,1);assert.equal(actions[0].args.ref,'right');assert.equal(actions[0].args.generation,'g');
});

for(const command of ['เข้า yahoo','ค้นหา จองตั๋วเครื่องบิน','type Bonjour'])test('direct unquoted payload avoids the text writer: '+command,async()=>{
 const f=fixture(['type:c1']);let thinking=0;f.deps.thinking=async()=>{thinking++;throw Error('unexpected text writer');};
 const r=await runComputerUse({goal:command,yieldAfterAction:true},f.deps,new AbortController().signal);
 assert.equal(r.steps,1);assert.equal(r.evaluations,1);assert.equal(thinking,0);
 assert.equal(f.calls.find(c=>c.name==='computer_action')!.args.text,command.slice(command.indexOf(' ')+1));
});

for(const mode of ['none','uncertain'])for(const direct of ['yieldAfterAction','yieldAfterInteraction'])test('direct commands never call a configured writer when text is '+mode+' / '+direct,async()=>{
 const f=fixture(['type:c1']);let thinking=0,captures=0;
 (f.state as any).screenshotAvailable=true;
 f.deps.thinking=async()=>{thinking++;return {text:'invented'};};
 f.deps.snapshot=async()=>{captures++;};
 const evaluate=f.deps.evaluate;
 f.deps.evaluate=async(req,signal)=>{const r=await evaluate(req,signal);r.answers.text=mode==='none'?choiceFor(req.questions.text.criteria,'NONE'):{...choiceFor(req.questions.text.criteria,'TEXT:0'),confidence:.2};return r;};
 const r=await runComputerUse({goal:'type hello', [direct]:true},f.deps,new AbortController().signal);
 assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.equal(r.steps,0);
 assert(r.trace.events.some(e=>e.reason==='FIELD_TEXT_REQUIRED'));
 assert.equal(thinking,0);assert.equal(captures,0);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,0);
});

for(const command of ['scroll ลงมา','scroll up','close window'])test('standard command uses one compact observation and guarded executor, no model: '+command,async()=>{
 const f=fixture([]);const standard=command==='close window'?'close:window':command==='scroll up'?'scroll:up':'scroll:down';
 Object.assign(f.state,{standardCommand:standard,supportedActions:standard==='close:window'?[]:[standard]});
 if(standard==='close:window')f.state.controls=[{ref:'standard-close',role:'AXButton',label:'Close window',actions:['press'],value:''}];
 f.deps.evaluate=async()=>{throw Error('model must not run');};f.deps.thinking=async()=>{throw Error('writer must not run');};
 let checkpoints=0;f.deps.beforeMutation=()=>{checkpoints++;};
 const r=await runComputerUse({goal:command,yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.steps,1);assert.equal(r.evaluations,0);assert.equal(checkpoints,1);assert.equal(r.status,'needs_input');
 assert.equal(f.calls.filter(c=>c.name==='computer_observe').length,1);
 assert.equal(f.calls.find(c=>c.name==='computer_observe')!.args.standard_command,standard);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,1);
});
test('standard command with unavailable target waits without model or action',async()=>{
 const f=fixture([]);Object.assign(f.state,{standardCommand:'scroll:down',supportedActions:[]});
 f.deps.evaluate=async()=>{throw Error('model must not run');};
 const r=await runComputerUse({goal:'scroll down',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.steps,0);assert(r.trace.events.some(e=>e.reason==='NO_SUPPORTED_ACTION'));
});
test('standard command rejected by native freshness is never replayed',async()=>{
 const f=fixture([]);Object.assign(f.state,{standardCommand:'scroll:down',supportedActions:['scroll:down']});
 const call=f.deps.call;f.deps.call=async(name,args,s)=>{const r=await call(name,args,s);return name==='computer_action'?{state:'not_executed',error:'STALE_OBSERVATION'}:r;};
 const r=await runComputerUse({goal:'scroll down',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.steps,0);assert.equal(f.calls.filter(c=>c.name==='computer_action').length,1);
});

for(const accepted of [true,false])test('direct action uses original generation and honors native rejection: '+accepted,async()=>{
 const f=fixture(['open:com.example.Browser']);f.state.apps.push({id:'com.example.Browser',name:'Browser'});
 const call=f.deps.call;let reads=0;
 f.deps.call=async(name,args,signal)=>{
  if(name==='computer_observe'&&++reads>1)throw Error('REDUNDANT_FULL_OBSERVATION');
  const value=await call(name,args,signal);
  if(name==='computer_action'){
   assert.equal(args.generation,'g');
   return accepted?{state:'completed'}:{state:'not_executed',error:'APPLICATION_NOT_ALLOWED'};
  }
  return structuredClone(value);
 };
 const r=await runComputerUse({goal:'Open Browser',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,1);
 assert.equal(r.steps,accepted?1:0);
 assert.equal(reads,1);
});

test('user command releases ownership immediately after completed action without waiting for another observation',async()=>{
 const f=fixture(['key:enter']);Object.assign(f.state,{focusedControl:{ref:'c1',role:'AXTextArea',label:'Note'}});const call=f.deps.call;let completed=false;
 f.deps.call=async(name,args,signal)=>{
  if(completed&&name==='computer_observe')throw Error('POST_ACTION_READ_WOULD_DELAY_NEXT_COMMAND');
  if(name==='computer_action')completed=true;
  return call(name,args,signal);
 };
 f.deps.snapshot=async()=>{throw Error('POST_ACTION_SCREENSHOT_WOULD_DELAY_NEXT_COMMAND');};
 const r=await runComputerUse({goal:'Press Enter',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.status,'needs_input');assert.equal(r.reason,'COMMAND_WAITING_INPUT');assert.equal(r.steps,1);
 assert.equal(r.observation,undefined);assert(r.trace.events.some(e=>e.reason==='ACTION_DISPATCHED'));
 assert.equal(f.calls.at(-1)?.name,'computer_release');
});

test('single command can activate the current application without entering a reopen loop',async()=>{
 const f=fixture(['open:com.apple.Notes']);let evaluations=0;
 f.deps.evaluate=async req=>{evaluations++;return responseFor(req,'open:com.apple.Notes');};
 const r=await runComputerUse({goal:'Open Notes',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.steps,1);assert.equal(evaluations,1);
 assert.equal(f.calls.filter(c=>c.name==='computer_action').length,1);
 assert.equal(f.calls.find(c=>c.name==='computer_action')?.args.app_id,'com.apple.Notes');
});

for(const command of ['กดลูกศรขึ้น','กดลูกศรลง','press enter'])test('exact key command bypasses inference but preserves native focus guard: '+command,async()=>{
 const f=fixture([]);Object.assign(f.state,{focusedControl:{ref:'c1',role:'AXTextArea',label:'Note'}});
 f.deps.evaluate=async()=>{throw Error('UNNECESSARY_INFERENCE');};
 const r=await runComputerUse({goal:command,yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.steps,1);assert.equal(r.evaluations,0);
 assert.equal(f.calls.filter(c=>c.name==='computer_observe').length,1);
});
test('exact key cannot target missing or sensitive focus',async()=>{
 for(const focus of [undefined,{ref:'c1',role:'AXSecureTextField',label:'Password',sensitive:true}]){
  const f=fixture([]);Object.assign(f.state,{focusedControl:focus});
  const r=await runComputerUse({goal:'press enter',yieldAfterInteraction:true},f.deps,new AbortController().signal);
  assert.equal(r.steps,0);assert.equal(r.evaluations,0);
 }
});
test('legacy single-pane scroll bypasses inference with observed pane ref',async()=>{
 const f=fixture([]);Object.assign(f.state,{supportedActions:['scroll:down'],scrollAreas:[{ref:'s0',label:'Content',bounds:{x:0,y:0,width:1,height:1}}]});
 f.deps.evaluate=async()=>{throw Error('UNNECESSARY_INFERENCE');};
 const r=await runComputerUse({goal:'scroll ลงมา',yieldAfterInteraction:true},f.deps,new AbortController().signal);
 assert.equal(r.steps,1);assert.equal(r.evaluations,0);
 assert.equal(f.calls.find(c=>c.name==='computer_action').args.ref,'s0');
});

test('key fast path excludes negated, compound and targeted instructions',()=>{
 for(const command of ['do not press enter','press enter twice','กดลูกศรขึ้นแล้วกด enter','press enter in another window','กดลูกศรขึ้นไหม']){
  assert.equal(standardKeyboardCommand(command),undefined);
 }
});
