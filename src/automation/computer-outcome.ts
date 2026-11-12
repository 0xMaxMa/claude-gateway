import type {ComputerTaskReport} from '../orchestration/types';

/**
 * One owner-facing line per direct command: what was done, or why nothing was
 * done and what to try next. Built from the structural report only; it never
 * repeats typed text or window contents beyond the chosen control's label.
 */
const HINTS:Record<string,string>={
 UNCLEAR:'the command was not understood. Say it another way, or name the item as it appears on screen.',
 NO_SUPPORTED_ACTION:'no visible control matches this command. Check that the right window is in front, or name the item as it appears on screen.',
 FIELD_TEXT_REQUIRED:'no text to enter was found in the command. Put the text in quotes, for example: พิมพ์ "hello".',
 FOCUS_REQUIRED:'the target needs keyboard focus first. Click the field, then send the command again.',
 FOCUS_UNSUPPORTED:'this control cannot take keyboard focus. Click it instead.',
 TARGET_OCCLUDED:'the target is covered by another window or popup. Close it, then try again.',
 TARGET_NOT_REACHED:'the button only appears when the pointer is over it, so it couldn\'t be clicked.',
 UI_NOT_READY:'the screen kept changing while it waited. Send the command again.',
 STALE_OBSERVATION:'the screen changed before the action ran. Send the command again.',
 ACTION_CONTEXT_CHANGED:'the screen changed before the action ran. Send the command again.',
 SUBMIT_CONTEXT_CHANGED:'the field changed before Enter was pressed. Check it and press Enter if still wanted.',
 NOTHING_TO_ERASE:'the focused field is already empty.',
 ERASE_UNAVAILABLE:'the focused field is too long to edit safely this way.',
 CONFIRMATION_REQUIRED:'{target} is high-impact, so the user was asked to confirm it; their yes or no answers.',
 CONFIRMATION_DECLINED:'the user said no, so it was not pressed.',
 COMPLETION_NOT_ESTABLISHED:'the result could not be confirmed from the screen.',
 SEQUENCE_TARGET_MISSING:'the next button was not found exactly once on the screen.',
 RAW_INPUT_REQUIRED:'this app shows no controls Computer Use can read, so it has to work from the screen with the mouse and keyboard. Turn on "Allow mouse and keyboard control" in GetPod\'s Computer Use settings, then send the command again.',
 RAW_INPUT_UNAVAILABLE:'this app shows no controls Computer Use can read, and mouse and keyboard control is not available on this computer yet.',
 SCREEN_CAPTURE_REQUIRED:'this app shows no controls Computer Use can read, and its window could not be captured to work from the screen. Check the Screen Recording permission for GetPod, then send the command again.',
 SCREEN_CAPTURE_UNAVAILABLE:'this app shows no controls Computer Use can read, and its window could not be captured to work from the screen. Check the app window and try again.',
 APPLICATION_LAUNCH_UNCONFIRMED:'the computer did not confirm that the app opened. Check that it is in front, then send the command again.',
 ADDRESS_NOT_SHOWN:'the page in front does not show the web address yet. Check the browser, then send the command again.',
};
/** Stop codes as one plain sentence for the owner (the card) and for the agent to pass on. A code not listed here is
 * still never shown raw: the owner reads a generic line, and the agent's message keeps the code for diagnosis. */
const REASONS:Record<string,string>={
 FOCUS_REQUIRED:'The app didn\'t accept typing: no text field had keyboard focus.',
 FOCUS_CHANGED:'Keyboard focus moved before the action ran.',
 SECURE_FIELD:'The field in focus is a password field, which Computer Use never types into.',
 TEXT_NOT_IN_GOAL:'It would have typed text that is not in your request, so it did not.',
 APPLICATION_NOT_APPROVED:'The app in front is not approved for Computer Use.',
 APPLICATION_PROTECTED:'The screen was hidden because a protected app such as GetPod was in front.',
 NO_SUPPORTED_ACTION:'No control on the screen matched the request.',
 TARGET_OCCLUDED:'The button was covered by another window or popup.',
 TARGET_NOT_REACHED:'Couldn\'t click that button: it only appears when the pointer is over it.',
 STEP_LIMIT:'It reached the action limit it was given.',
 NO_PROGRESS:'Its last actions did not change the screen.',
 ROUND_TIME_LIMIT:'It used up its time for one round.',
 COMMAND_WAITING_INPUT:'It stopped before finishing.',
 THINKING_WAITING_INPUT:'It stopped before finishing.',
 LOW_CONFIDENCE:'The next step was unclear from the screen.',
 COMPLETION_UNCERTAIN:'The goal may already be done, but the screen was not clear enough to say.',
 COMPLETION_CANDIDATE:'The goal may be done, but it was not confirmed.',
 VERIFICATION_FAILED:'The result could not be confirmed on the screen.',
 APPLICATION_LAUNCH_UNCONFIRMED:'The computer did not confirm that the app opened.',
 ADDRESS_NOT_SHOWN:'The page in front does not show the web address yet.',
 LOOP_CYCLE_BUDGET:'It took too many turns without finishing.',
 TIMEOUT:'It ran out of time.',
 CANCELLED:'It was stopped.',
 REVISION_SUPERSEDED:'A newer command replaced it.',
 OUTCOME_UNKNOWN:'The last action may have run, but the computer did not confirm it.',
 DEVICE_OFFLINE:'The computer disconnected and did not reconnect within 12 seconds.',
 ACCESS_DENIED:'Access to the computer was withdrawn.',
 COMPUTER_ACCESS_DENIED:'Access to the computer was denied.',
 COMPUTER_ACCESS_STOPPED:'Access was stopped on the computer.',
 COMPUTER_ACCESS_TIMEOUT:'Nobody approved access on the computer in time.',
 UNSUPPORTED_ACTION:'The computer does not support that kind of action.',
 RAW_INPUT_DISABLED:'Mouse and keyboard control is turned off on the computer.',
 RAW_INPUT_REQUIRED:'The app shows no controls Computer Use can read, and mouse and keyboard control is turned off.',
 RAW_INPUT_UNAVAILABLE:'The app shows no controls Computer Use can read, and mouse and keyboard control is not available on this computer yet.',
 SCREEN_CAPTURE_REQUIRED:'The app shows no controls Computer Use can read, and its window could not be captured.',
 SCREEN_CAPTURE_UNAVAILABLE:'The app shows no controls Computer Use can read, and its window could not be captured.',
 VISION_TARGET_NOT_FOUND:'What it needed was not on the screen.',
 VISION_SIGN_IN_REQUIRED:'The app needs you to sign in first.',
 VISION_HIGH_IMPACT_ACTION:'The next step would buy, send, delete or change something, so it stopped for you.',
 VISION_APP_UNAVAILABLE:'The app was not available.',
 VISION_OTHER:'The model found no way to finish on the screen.',
 VISION_NO_DECISION:'The model did not choose an action.',
 VISION_REFUSED:'The model declined to continue.',
 JEV_INVALID_REQUEST:'The decision model rejected the request.',
 JEV_RATE_LIMITED:'The decision model is busy. Try again shortly.',
 JEV_QUOTA_EXCEEDED:'The decision model\'s quota is used up.',
 JEV_DEADLINE_EXCEEDED:'The decision model took too long to answer.',
 JEV_AUTHENTICATION_FAILED:'The decision model did not accept the agent\'s credentials.',
 JEV_ACCESS_DENIED:'The decision model is not available to this agent.',
 JEV_MODEL_UNAVAILABLE:'The decision model is not available.',
 JEV_PROVIDER_UNAVAILABLE:'The decision model could not be reached.',
 JEV_INVALID_RESPONSE:'The decision model gave an answer that could not be used.',
 INVALID_DECISION:'The decision model gave an answer that could not be used.',
};
/** A round's wait on its own failed decision (computer-use: `JEV_<code>` or INVALID_DECISION): it stopped, nothing was done. */
const DECISION_FAILURE=/^(?:JEV_[A-Z_]+|INVALID_DECISION)$/;
/** Native phases at which the click point belonged to another window or process: a real cover. */
const COVERED_PHASES=new Set(['pointer_hit_other_window','pointer_check_hit','raw_pointer_occluded']);
type PointerRefusal='covered'|'hover'|'nested_scroll';
const REFUSAL_HINTS:Record<PointerRefusal,string>={covered:HINTS.TARGET_OCCLUDED,hover:HINTS.TARGET_NOT_REACHED,nested_scroll:'the pointer was over a smaller scrolling area inside it, so it did not scroll.'};
const REFUSAL_REASONS:Record<PointerRefusal,string>={covered:REASONS.TARGET_OCCLUDED,hover:REASONS.TARGET_NOT_REACHED,nested_scroll:'It did not scroll: the pointer was over a smaller scrolling area inside it.'};
/** What the helper's refusal to click means, from its native phase. GetPod Desktop 0.1.0 also answered TARGET_OCCLUDED
 * when the point hit another part of the same window (pointer_hit_ancestor, _group, ...), mostly a button that only shows
 * under the pointer; "covered by another window" then had the agent blame GetPod (pod-jinawong task 56f64e16). 0.1.1
 * sends those as TARGET_NOT_REACHED. A TARGET_OCCLUDED without a phase keeps its old meaning. */
export function pointerRefusal(code:string|undefined,phase?:string):PointerRefusal|undefined{
 if(code!=='TARGET_OCCLUDED'&&code!=='TARGET_NOT_REACHED')return;
 if(phase==='scroll_nested_pane')return 'nested_scroll';
 return code==='TARGET_OCCLUDED'&&(phase===undefined||COVERED_PHASES.has(phase))?'covered':'hover';
}
/** The native phase of the round's last action the computer refused with `code`. */
const refusedPhase=(report:ComputerTaskReport,code:string)=>[...(report.trace??[])].reverse().find(e=>e.phase==='acted'&&e.outcome==='not_executed'&&e.reason===code)?.nativePhase;
const lastWaitReason=(report:ComputerTaskReport)=>[...(report.trace??[])].reverse().find(e=>e.phase==='waiting')?.reason;
/** For the agent, after a round stopped on a click the helper refused: what it means, and that the screen was visible,
 * so it does not tell the user GetPod was in the way (task 56f64e16). Empty for any other stop. */
export function computerRefusalNote(report:ComputerTaskReport):string{
 const code=lastWaitReason(report),phase=code?refusedPhase(report,code):undefined,kind=pointerRefusal(code,phase);
 if(!kind)return '';
 const meaning=kind==='covered'?'another window or popup covered the click point':kind==='nested_scroll'?'the point was over a smaller scrolling area inside the target':'the click point hit another part of the same window, usually a button that only appears while the pointer is over it';
 const front=report.targetApp?.name.slice(0,80);
 const screen=report.screenWithheld?'':` The screen was NOT withheld${front?` and ${front} was the frontmost app`:''}: no protected app such as GetPod was in front, so do not tell the user that GetPod was in the way.`;
 return `The computer refused the last action before sending it (${code}${phase?`, native phase ${phase}`:''}): ${meaning}. Nothing was clicked.${screen}`;
}
/** The owner's sentence for a stop code; `undefined` only for an empty code. */
export function computerReasonText(code:string|undefined):string|undefined{
 if(!code)return;
 const bare=code.replace(/^COMPUTER_(?=ACCESS_)/,'');
 if(REASONS[code]??REASONS[bare])return REASONS[code]??REASONS[bare];
 if(code.startsWith('JEV_'))return 'The decision model could not decide the next step.';
 if(code.startsWith('VISION_'))return 'The model\'s chosen actions could not run.';
 return 'It could not continue.';
}
/** Card copy per progress phase; a phase without a label reads as Working. */
const PHASE_LABELS:Record<string,string>={
 awaiting_access:'Waiting for access on the computer',
 observing:'Looking at the screen',observed:'Looking at the screen',
 evaluating:'Deciding the next step',decided:'Deciding the next step',thinking:'Working out what to type',
 acting:'Acting on the screen',acted:'Acting on the screen',
 verifying:'Checking the result',reconciling:'Checking the last action',waiting:'Waiting',
};
const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
/** The task card while a round runs and once it ended: a label, never a raw phase or code, and actions only. */
export function computerProgressText(report:ComputerTaskReport):string{
 const actions=plural(report.steps,'action');
 if(report.phase!=='terminal')return `Computer Use · ${PHASE_LABELS[report.phase??'']??'Working'} · ${actions} so far`;
 // Live progress reports keep status 'running'; their outcome rides on the terminal trace event.
 const last=report.trace?.at(-1);
 const status=report.status!=='running'?report.status:last?.phase==='terminal'?last.status:undefined;
 if(status==='succeeded')return `Done after ${actions}.`;
 const paused=pausedText(report);if(paused)return paused;
 const stop=computerReasonText(report.reason)!;
 // The last action the computer refused names the cause when the stop itself is generic (the model gave up after it).
 const refused=[...(report.trace??[])].reverse().find(e=>e.phase==='acted'&&e.outcome==='not_executed'&&e.reason);
 const kind=pointerRefusal(refused?.reason,refused?.nativePhase),said=kind?REFUSAL_REASONS[kind]:refused?.reason&&REASONS[refused.reason];
 const before=said&&said!==stop?` Before that, ${said[0].toLowerCase()}${said.slice(1)}`:'';
 return `Stopped after ${actions}. ${stop}${before}`;
}
/** A goal round that paused on its own (ROUND_PAUSES): the user's reply resumes it. */
function pausedText(report:ComputerTaskReport):string|undefined{
 if(report.reason==='NO_PROGRESS')return 'Paused: the last 3 actions didn\'t change the screen. Reply to continue.';
 if(report.reason==='ROUND_TIME_LIMIT')return `Paused after ${plural(Math.max(1,Math.round((report.durationMs??0)/60000)),'minute')} of work. Reply to continue.`;
}
/** A round whose last dispatched action has no receipt; it may have run. */
export const UNKNOWN_PREFIX='Unknown:';
const quoted=(label?:string)=>label?JSON.stringify(label.slice(0,80)):'the chosen control';
export function computerActionText(action:NonNullable<ComputerTaskReport['lastAction']>){
 switch(action.kind){
  case 'erase':return `erased ${action.count??1} character${action.count===1?'':'s'} in ${quoted(action.label)}`;
  case 'press':return action.sequence?.length?`pressed ${action.sequence.map(label=>quoted(label)).join(', ')}`:`pressed ${quoted(action.label)}`;
  case 'type':return `entered text in ${quoted(action.label)}`;
  case 'key':return `pressed the ${action.key??''} key`.replace('  ',' ');
  case 'scroll':return `scrolled ${action.direction??''}`.trim();
  case 'navigate':return `went ${action.direction??'back'}`;
  case 'open':return `opened ${action.appName??action.appId??'the application'}`;
  // Vision actions: a click on what was there, a key chord, typed text.
  case 'pointer':return action.label?`clicked ${quoted(action.label)}`:'clicked on the screen';
  case 'key_chord':return `pressed ${action.key??'a key'}`;
  case 'type_focused':return 'typed text';
  default:return 'completed the action';
 }
}
/** How a stopped step run is followed up: whether the run was handed to the assistant
 * (agentGoalRunParked: it wakes and checks the screen), the surface's own name, and the last action. */
export interface StepRunTextContext {
 handedOff?:boolean;
 surface?:'computer'|'browser';
 lastAction?:{kind:string;appId?:string};
}
/** Shared step-run summary; the surface supplies its own hint for a stop detail.
 * The first lines are for the owner; raw stop codes go on the last "Details:" line.
 * A stopped step that may have run is never listed as not run: only later steps are. */
export function stepRunText(run:import('./command-steps').CommandStepRun,hintFor:(detail:string)=>string|undefined,context:StepRunTextContext={}):string{
 const head=`${run.completed}/${run.total} steps done.${run.notes?.length?' '+run.notes.join(' '):''}`;
 if(run.stopReason==='ALL_STEPS_DONE')return head+(run.unverifiedSteps?.length?` No visible change after step ${run.unverifiedSteps.join(', ')}.`:'');
 const detailHint=run.detail?hintFor(run.detail):undefined;
 const step=run.stoppedAt??run.completed+1;
 const done=run.doneParts?.length?` Already done in step ${step}: ${run.doneParts.map(s=>JSON.stringify(s)).join(', ')}.`:'';
 const later=run.remaining.slice(1);
 const notStarted=later.length?` Not started: ${later.map(s=>JSON.stringify(s)).join(', ')}.`:'';
 const details=`\nDetails: ${run.stopReason}${run.detail?` · ${run.detail}`:''}`;
 let line:string;
 if(run.stopReason==='OUTCOME_UNKNOWN'){
  const last=context.lastAction,device=context.surface==='browser'?'the browser':'this computer';
  const effect=last?.kind==='open'&&last.appId?`${last.appId.slice(0,80)} may have opened`:'its last action may have run';
  line=`Step ${step} couldn't be confirmed: ${effect}, but ${device} didn't confirm it. ${context.handedOff?'The assistant is checking the screen.':'Check the screen before sending it again.'}`;
 }else if(context.handedOff)line=`Step ${step} needs a decision — handing it to the assistant…`;
 else line=`Stopped at step ${step} ${JSON.stringify(run.stoppedStep??'')}: ${detailHint??'it could not be completed.'}`;
 return `${head} ${line}${done}${notStarted}`.slice(0,1400)+details.slice(0,100);
}
/** The card line once the assistant confirmed a parked run's goal from fresh evidence (verify_computer/verify_browser). */
export const ANSWERED_FROM_SCREEN='Done · The assistant answered from the screen.';
/** Whether a settled round did what it was asked: its own outcome line says Done (or Ready, or a read
 * the assistant answers), or every step of its step list ran. */
export function computerRoundDone(report:ComputerTaskReport):boolean{
 if(report.stepRun)return report.stepRun.stopReason==='ALL_STEPS_DONE';
 // The agent's own command reached its goal, but the task's goal is not confirmed until the agent closes it.
 if(agentCommandDone(report))return false;
 const text=computerOutcomeText(report);
 return ['Done','Ready:','Read request:'].some(prefix=>text.startsWith(prefix));
}
/** A round of the agent's own command (a handed-off utterance or a parked round's next move) that reached that
 *  command's goal and parked for the agent to check the task's goal (gateway-tasks/computer.ts). */
export function agentCommandDone(report:ComputerTaskReport):boolean{
 return report.status==='needs_input'&&report.reason==='COMMAND_WAITING_INPUT'&&!report.stepRun&&lastWaitReason(report)==='GOAL_REACHED';
}
/** Said when a round that did not finish last saw a withheld screen (report.screenWithheld). */
const WITHHELD_HINT='The screen was hidden because a protected app such as GetPod was in front.';
const withheldHint=(report:ComputerTaskReport)=>report.targetApp?`${WITHHELD_HINT} The next command switches back to ${report.targetApp.name.slice(0,80)} first.`:WITHHELD_HINT;
export function computerOutcomeText(report:ComputerTaskReport,context:{handedOff?:boolean}={}):string{
 const text=outcomeText(report,context);
 if(!report.screenWithheld&&report.targetApp&&pointerRefusal(lastWaitReason(report))&&!text.startsWith('Done')){
  // A refused click on a visible screen: say whose window it was, so nobody reads it as GetPod in the way.
  const visible=`The screen was not hidden: ${report.targetApp.name.slice(0,80)} was in front.`,details=text.lastIndexOf('\nDetails:');
  return details<0?`${text} ${visible}`:`${text.slice(0,details)} ${visible}${text.slice(details)}`;
 }
 if(!report.screenWithheld||text.startsWith('Done')||report.stepRun?.stopReason==='ALL_STEPS_DONE')return text;
 // A step run's raw codes stay on its last "Details:" line.
 const details=text.lastIndexOf('\nDetails:');
 return details<0?`${text} ${withheldHint(report)}`:`${text.slice(0,details)} ${withheldHint(report)}${text.slice(details)}`;
}
function outcomeText(report:ComputerTaskReport,context:{handedOff?:boolean}):string{
 const run=report.stepRun;
 if(run)return stepRunText(run,detail=>HINTS[detail]?hint(detail,report):undefined,{...context,surface:'computer',...(report.lastAction?{lastAction:report.lastAction}:{})});
 const trace=report.trace??[];
 // A goal run's own end (reached, out of steps) is the report's reason; other stops are waits.
 const waiting=['GOAL_REACHED','STEP_LIMIT'].includes(report.reason)?report.reason:[...trace].reverse().find(e=>e.phase==='waiting'&&e.reason!=='POST_ACTION_EVIDENCE_STALE')?.reason;
 // The device may have acted: never tell the owner it was not done.
 if(report.reason==='OUTCOME_UNKNOWN')return `${UNKNOWN_PREFIX} the last action may have run. Check the screen before sending the command again.`;
 const paused=pausedText(report);if(paused)return paused;
 if(waiting==='SESSION_READY'&&!report.steps)return 'Ready: the session is open and waits for the next command.';
 if(waiting==='READ_REQUEST'&&!report.steps)return 'Read request: nothing was pressed; the assistant answers from the current screen.';
 // A spoken number stopped part-way: say how far it got, never "Done".
 const sequence=report.lastAction?.sequence,planned=report.lastAction?.planned;
 if(sequence&&planned&&sequence.length<planned)return `Not done: pressed ${sequence.length} of ${planned} (${sequence.map(label=>quoted(label)).join(', ')}), then stopped${waiting&&HINTS[waiting]?`: ${hint(waiting,report)}`:'.'}`;
 // A goal run took several actions: say how it ended, never "Done" for a stop.
 const actions=`${report.steps} action${report.steps===1?'':'s'}`;
 if(waiting==='GOAL_REACHED'&&report.steps>0)return `Done after ${actions}. Last: ${report.lastAction&&!report.lastAction.blocked?computerActionText(report.lastAction):'the action was sent'}.${report.accessReleased?' Computer access was released.':agentCommandDone(report)?' The assistant checks what is left of the task.':' Send the next command.'}`;
 if(waiting==='GOAL_REACHED'&&agentCommandDone(report))return 'Done: the screen already showed what was asked. The assistant checks what is left of the task.';
 if(waiting==='STEP_LIMIT'&&report.steps>0)return `Not finished: stopped after ${actions}, the action limit it was given. Check the screen and send the next command.`;
 if(waiting==='COMPLETION_UNCERTAIN'&&report.steps>0)return `Not confirmed: ${actions} done, and the goal may already be complete, but the screen was not clear enough to say. Check the screen, then send the next command.`;
 if(waiting==='LOW_CONFIDENCE'&&report.steps>0)return `Not finished: ${actions} done, then the next step was unclear from the screen. Say what to do next.`;
 // One action, then a stop after it, is not done either. Pod-jinawong r8, task b0ba459d: a goal run
 // opened Spotify, found no control for the search, and the card said "Done: opened com.spotify.client".
 const acted=trace.map(e=>e.phase).lastIndexOf('acted');
 const stoppedAfterAction=acted>=0&&trace.slice(acted+1).some(e=>e.phase==='waiting'&&e.reason===waiting);
 if((report.steps>1||stoppedAfterAction)&&waiting&&HINTS[waiting])return `Not finished: ${actions} done, then ${hint(waiting,report)}`;
 // A round that ended blocked or failed is never Done, whatever its last action was.
 if(['blocked','failed','cancelled'].includes(report.status)&&report.steps>0)return `Not finished: ${actions} done, then it stopped. ${computerReasonText(report.reason)}`;
 // Nor one whose next decision failed after its actions (pod-jinawong 2.1.12, task 059a5cac rev 3: "Done: pressed the enter key").
 if(waiting&&DECISION_FAILURE.test(waiting)&&report.steps>0)return `Not finished: ${actions} done, then it stopped. ${computerReasonText(waiting)}`;
 if(report.lastAction&&!report.lastAction.blocked&&report.steps>0)return `Done: ${computerActionText(report.lastAction)}. Send the next command.`;
 if(report.steps>0)return 'Done: the action was sent. Send the next command.';
 // An open the computer never confirmed names the app (pod-jinawong r10, task 457a4930 rev3: TradingView's open).
 if(waiting==='APPLICATION_LAUNCH_UNCONFIRMED'){
  const id=[...trace].reverse().find(e=>e.action==='open'&&e.appId)?.appId,name=id&&report.targetApp?.id===id?report.targetApp.name:id;
  if(name)return `Not done: opening ${name.slice(0,80)} was not confirmed by the computer.`;
 }
 if(waiting&&HINTS[waiting])return `Not done: ${hint(waiting,report)}`;
 // Never a raw code on the card: the reason's own sentence (pod-jinawong r10, task 457a4930: "Not done: COMMAND_WAITING_INPUT").
 const reason=computerReasonText(waiting&&waiting!=='COMMAND_WAITING_INPUT'?waiting:report.reason)!;
 return `Not done: ${reason[0].toLowerCase()}${reason.slice(1)} Send the next command.`;
}
function hint(reason:string,report:ComputerTaskReport){
 const refusal=pointerRefusal(reason,refusedPhase(report,reason));
 return (refusal?REFUSAL_HINTS[refusal]:HINTS[reason]).replace('{target}',quoted(report.lastAction?.label));
}
