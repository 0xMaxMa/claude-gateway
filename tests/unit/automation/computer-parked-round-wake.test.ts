import {runComputerUse,type ComputerUseDependencies} from '../../../src/automation/computer-use';
import {computerOutcomeText,computerRoundDone} from '../../../src/automation/computer-outcome';
import {agentHandoffRequested,handoffNotDone} from '../../../src/automation/command-speech';
import {agentGoalRunParked,agentRound,parkedGoalRunNote,parkedRoundCapped,PARKED_WAKE_LIMIT} from '../../../src/orchestration/tasks/automation-session';
import {automationWait,ComputerLiveRuns,computerLiveView} from '../../../src/orchestration/computer-live';
import {JevError} from '../../../src/jev/types';
import type {ComputerTaskReport,TaskSnapshot} from '../../../src/orchestration/types';
import recorded from '../../fixtures/computer/parked-rounds-059a5cac-2aefd7a9.json';
import spotify from '../../fixtures/computer/spotify-web-56f64e16.json';

// Pod-jinawong, gateway 2.1.12, GetPod Desktop 0.1.1-alpha.3.test.2: rounds that stopped without asking the user anything
// and still ended on "Your turn: reply in GetPod", with nobody woken.
// - 059a5cac rev 3: the agent's command for the user's "ยังไม่เห็นเล่นเลย" ran 4 actions, then the decision model's answer
//   had the wrong keys (JEV_INVALID_RESPONSE, ANSWER_KEYS). The card said "Done: pressed the enter key", so the agent was
//   not even told it was not done, and revision 3 was no goal run, so no parked notice woke it.
// - 2aefd7a9 rev 2: the run resumed by the answer to its own question typed the song, then found no control and could
//   not capture the window for the vision fallback; revision 2, so again nobody was woken.
const rev3=recorded.rounds['059a5cac.rev3'],answerRun=recorded.rounds['2aefd7a9.rev2'];
const report=(round:{report:unknown}):ComputerTaskReport=>round.report as ComputerTaskReport;
const control=(revision:number,agentHandoff:boolean)=>({id:'c',action:'revise' as const,revision,phase:'applied' as const,requestedAt:1,...(agentHandoff?{agentHandoff:true as const}:{})});
function parked(revision:number,computerReport:ComputerTaskReport,extra:Partial<TaskSnapshot>={}):TaskSnapshot{
 return {taskId:'task-1',conversationId:'conv-1',agentSessionId:'sess-1',state:'waiting_input',stateVersion:9,revision,automationController:'user',
  gatewayTarget:{adapter:'computer',sessionId:'s',name:'Computer Use · Mac'},computerReport,...extra} as unknown as TaskSnapshot;
}

describe('059a5cac rev 3 replay: the agent\'s command stopped on an unusable decision after 4 actions',()=>{
 test('the recorded round: 4 actions, then JEV_INVALID_RESPONSE (ANSWER_KEYS) as its wait',()=>{
  const r=report(rev3);
  expect(r).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:4,lastAction:{kind:'key',key:'enter'}});
  expect(r.trace!.at(-2)).toMatchObject({phase:'waiting',reason:'JEV_INVALID_RESPONSE',validationReason:'ANSWER_KEYS'});
  expect(rev3.kind).toBe('agent_handoff');
 });
 test('its card says not finished, never Done, so a handed-off command that ended there is reported',()=>{
  const r=report(rev3);
  const text=computerOutcomeText(r);
  expect(text).toBe('Not finished: 4 actions done, then it stopped. The decision model gave an answer that could not be used.');
  expect(computerRoundDone(r)).toBe(false);
  expect(handoffNotDone({type:'paused',computerReport:r} as any)).toBe(true);
 });
 test('it parks for the agent: the parked notice wakes it, and the card says it is deciding',()=>{
  const task=parked(3,report(rev3),{executionControl:control(3,true),agentCommands:1});
  expect(agentRound(task)).toBe(true);expect(agentGoalRunParked(task)).toBe(true);expect(parkedRoundCapped(task)).toBe(false);
  expect(automationWait(task,true)).toEqual({for:'agent'});
  const live=new ComputerLiveRuns(()=>7);live.start('grant','task-1','r');
  expect(computerLiveView(live.get('grant')!,task,Date.now(),true)).toMatchObject({phase:'thinking',label:'Deciding the next step'});
  const note=parkedGoalRunNote(task);
  expect(note).toContain('exactly ONE task_update');
  expect(note).toContain(`The gateway takes ${PARKED_WAKE_LIMIT-1} more commands from you for this run`);
 });
 test('past the command cap it no longer parks, and once its wake ended the user reads no "reply"',()=>{
  const task=parked(3,report(rev3),{executionControl:control(3,true),agentCommands:PARKED_WAKE_LIMIT});
  expect(agentGoalRunParked(task)).toBe(false);expect(parkedRoundCapped(task)).toBe(true);
  const live=new ComputerLiveRuns(()=>7);live.start('grant','task-1','r');
  const view=computerLiveView(live.get('grant')!,task,Date.now(),false);
  expect(view).toMatchObject({phase:'waiting_for_user',reason:'next_command',label:'Ready for your next command'});
  expect(view.label).not.toMatch(/reply/i);
 });
});

describe('2aefd7a9 rev 2 replay: the run resumed by an answer stopped without a question',()=>{
 test('the recorded round: 1 action, no control, the window could not be captured for vision',()=>{
  const r=report(answerRun);
  expect(r).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1});
  expect(answerRun.trace.map(e=>e.reason).filter(Boolean)).toEqual(expect.arrayContaining(['NO_SUPPORTED_ACTION','SCREENSHOT_WINDOW_UNAVAILABLE','SCREEN_CAPTURE_UNAVAILABLE']));
  expect(r.trace!.at(-1)).toMatchObject({phase:'waiting',reason:'SCREEN_CAPTURE_UNAVAILABLE'});
  expect(answerRun.kind).toBe('answer_run');
 });
 test('an answer run (no command of the user\'s own since) parks for the agent too',()=>{
  // The answer added revision 2; executionControl is still the older revision's (here none).
  const task=parked(2,report(answerRun));
  expect(agentRound(task)).toBe(true);expect(agentGoalRunParked(task)).toBe(true);
 });
});

describe('who a parked round waits for',()=>{
 const stopped=report(rev3);
 test('the user\'s own command (executionControl of this revision, no agentHandoff) waits for the user, as before',()=>{
  const task=parked(4,stopped,{executionControl:control(4,false)});
  expect(agentRound(task)).toBe(false);expect(agentGoalRunParked(task)).toBe(false);expect(parkedRoundCapped(task)).toBe(false);
  expect(automationWait(task,false)).toEqual({for:'user',reason:'next_command'});
 });
 test('a question, a confirmation or the user\'s pause still waits for the user',()=>{
  const base={executionControl:control(3,true),agentCommands:1};
  expect(agentGoalRunParked(parked(3,stopped,{...base,pendingQuestion:{questionId:'q',text:'Which?',revision:3}} as any))).toBe(false);
  expect(agentGoalRunParked(parked(3,{...stopped,fieldRequest:{reason:'missing',label:'Search'}} as any,base))).toBe(false);
  expect(agentGoalRunParked(parked(3,stopped,{...base,executionControl:{...control(3,true),phase:'paused'}}))).toBe(false);
 });
 test('a browser round keeps the revision 1 rule (only the computer surface changed)',()=>{
  const task={...parked(3,stopped,{executionControl:control(3,true)}),gatewayTarget:{adapter:'browser',sessionId:'tab',name:'Tab'}} as TaskSnapshot;
  expect(agentRound(task)).toBe(false);
 });
});

// Fix 2, on the real loop: a goal run that has acted asks the decision model once more when its answer cannot be used.
type Screen=Record<string,any>;
const page=spotify.rev8.state as Screen;
const choice=(criteria:Record<string,unknown>,chosen:string)=>({choice:chosen,confidence:0.95,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen?0.95:0.05/(Object.keys(criteria).length-1||1)]))});
function pc(plan:string[]){
 let asked=0,looks=0;const requests:any[]=[];
 const deps:ComputerUseDependencies={authorized:()=>true,beforeMutation:()=>{},snapshot:async()=>{},
  call:async name=>name==='computer_acquire'?{lease_token:'lease'}:name==='computer_observe'?{...page,generation:'g'+(++looks)}:name==='computer_action'?{state:'completed'}:{},
  evaluate:async req=>{
   requests.push(req);const pick=plan[asked++]??'DONE';
   if(pick==='BAD_KEYS')throw new JevError('INVALID_RESPONSE','bad answer keys',{validationReason:'ANSWER_KEYS'});
   const kind=pick.includes(':')?pick.split(':')[0]:pick;
   return {answers:Object.fromEntries(Object.entries(req.questions).map(([name,q])=>[name,choice(q.criteria as any,name==='action'?kind:name==='target_'+kind?pick:name==='impact'?'ROUTINE':'NONE')]))};
  }};
 return {deps,requests};
}
const goal=()=>({goal:spotify.rev8.command,yieldAfterInteraction:true,readRequest:false,runToGoal:true});
const waited=(r:{trace:{events:Array<{phase:string;reason?:string}>}})=>[...r.trace.events].reverse().find(e=>e.phase==='waiting')?.reason;

describe('a decision answer that cannot be used',()=>{
 test('after an action: asked once more, and the run goes on to its goal',async()=>{
  const m=pc(['press:c5','BAD_KEYS','DONE']);
  const r=await runComputerUse(goal(),m.deps,new AbortController().signal);
  expect(m.requests).toHaveLength(3);
  expect(r.trace.events.filter(e=>e.reason==='DECISION_RETRY')).toHaveLength(1);
  expect(r).toMatchObject({status:'succeeded',reason:'GOAL_REACHED',steps:1});
 });
 test('twice in a row: the run stops on it, and its card is not Done',async()=>{
  const m=pc(['press:c5','BAD_KEYS','BAD_KEYS']);
  const r=await runComputerUse(goal(),m.deps,new AbortController().signal);
  expect(m.requests).toHaveLength(3);
  expect(waited(r)).toBe('JEV_INVALID_RESPONSE');expect(r).toMatchObject({status:'needs_input',reason:'COMMAND_WAITING_INPUT',steps:1});
  expect(computerOutcomeText({...r,phase:'terminal',trace:r.trace.events} as ComputerTaskReport)).toMatch(/^Not finished: 1 action done, then it stopped\./);
 });
 test('before any action: no second ask (nothing ran, the command is handed on as before)',async()=>{
  const m=pc(['BAD_KEYS']);
  const r=await runComputerUse(goal(),m.deps,new AbortController().signal);
  expect(m.requests).toHaveLength(1);
  expect(waited(r)).toBe('JEV_INVALID_RESPONSE');expect(r.steps).toBe(0);
  expect(agentHandoffRequested({computerReport:{...r,phase:'terminal',trace:r.trace.events} as ComputerTaskReport})).toBe(true);
 });
});
