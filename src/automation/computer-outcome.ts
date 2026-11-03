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
 UI_NOT_READY:'the screen was still changing. Send the command again.',
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
 STEP_LIMIT:'It reached the action limit for one task.',
 LOOP_CYCLE_BUDGET:'It took too many turns without finishing.',
 TIMEOUT:'It ran out of time.',
 CANCELLED:'It was stopped.',
 REVISION_SUPERSEDED:'A newer command replaced it.',
 OUTCOME_UNKNOWN:'The last action may have run, but the computer did not confirm it.',
 DEVICE_OFFLINE:'The computer went offline.',
 ACCESS_DENIED:'Access to the computer was withdrawn.',
 COMPUTER_ACCESS_DENIED:'Access to the computer was denied.',
 COMPUTER_ACCESS_STOPPED:'Access was stopped on the computer.',
 COMPUTER_ACCESS_TIMEOUT:'Nobody approved access on the computer in time.',
 UNSUPPORTED_ACTION:'The computer does not support that kind of action.',
 RAW_INPUT_DISABLED:'Mouse and keyboard control is turned off on the computer.',
 RAW_INPUT_REQUIRED:'The app shows no controls Computer Use can read, and mouse and keyboard control is turned off.',
 RAW_INPUT_UNAVAILABLE:'The app shows no controls Computer Use can read, and mouse and keyboard control is not available on this computer yet.',
 SCREEN_CAPTURE_REQUIRED:'The app shows no controls Computer Use can read, and its window could not be captured.',
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
};
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
 if(report.status==='succeeded')return `Done after ${actions}.`;
 const stop=computerReasonText(report.reason)!;
 // The last action the computer refused names the cause when the stop itself is generic (the model gave up after it).
 const refused=[...(report.trace??[])].reverse().find(e=>e.phase==='acted'&&e.outcome==='not_executed'&&e.reason)?.reason;
 const before=refused&&REASONS[refused]&&REASONS[refused]!==stop?` Before that, ${REASONS[refused][0].toLowerCase()}${REASONS[refused].slice(1)}`:'';
 return `Stopped after ${actions}. ${stop}${before}`;
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
  case 'open':return `opened ${action.appId??'the application'}`;
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
 const text=computerOutcomeText(report);
 return ['Done','Ready:','Read request:'].some(prefix=>text.startsWith(prefix));
}
/** Said when a round that did not finish last saw a withheld screen (report.screenWithheld). */
const WITHHELD_HINT='The screen was hidden because a protected app such as GetPod was in front.';
export function computerOutcomeText(report:ComputerTaskReport,context:{handedOff?:boolean}={}):string{
 const text=outcomeText(report,context);
 if(!report.screenWithheld||text.startsWith('Done')||report.stepRun?.stopReason==='ALL_STEPS_DONE')return text;
 // A step run's raw codes stay on its last "Details:" line.
 const details=text.lastIndexOf('\nDetails:');
 return details<0?`${text} ${WITHHELD_HINT}`:`${text.slice(0,details)} ${WITHHELD_HINT}${text.slice(details)}`;
}
function outcomeText(report:ComputerTaskReport,context:{handedOff?:boolean}):string{
 const run=report.stepRun;
 if(run)return stepRunText(run,detail=>HINTS[detail]?hint(detail,report):undefined,{...context,surface:'computer',...(report.lastAction?{lastAction:report.lastAction}:{})});
 const trace=report.trace??[];
 // A goal run's own end (reached, out of steps) is the report's reason; other stops are waits.
 const waiting=['GOAL_REACHED','STEP_LIMIT'].includes(report.reason)?report.reason:[...trace].reverse().find(e=>e.phase==='waiting'&&e.reason!=='POST_ACTION_EVIDENCE_STALE')?.reason;
 // The device may have acted: never tell the owner it was not done.
 if(report.reason==='OUTCOME_UNKNOWN')return `${UNKNOWN_PREFIX} the last action may have run. Check the screen before sending the command again.`;
 if(waiting==='SESSION_READY'&&!report.steps)return 'Ready: the session is open and waits for the next command.';
 if(waiting==='READ_REQUEST'&&!report.steps)return 'Read request: nothing was pressed; the assistant answers from the current screen.';
 // A spoken number stopped part-way: say how far it got, never "Done".
 const sequence=report.lastAction?.sequence,planned=report.lastAction?.planned;
 if(sequence&&planned&&sequence.length<planned)return `Not done: pressed ${sequence.length} of ${planned} (${sequence.map(label=>quoted(label)).join(', ')}), then stopped${waiting&&HINTS[waiting]?`: ${hint(waiting,report)}`:'.'}`;
 // A goal run took several actions: say how it ended, never "Done" for a stop.
 const actions=`${report.steps} action${report.steps===1?'':'s'}`;
 if(waiting==='GOAL_REACHED'&&report.steps>0)return `Done: ${actions}, last ${report.lastAction&&!report.lastAction.blocked?computerActionText(report.lastAction):'the action was sent'}.${report.accessReleased?' Computer access was released.':' Send the next command.'}`;
 if(waiting==='STEP_LIMIT'&&report.steps>0)return `Not finished: stopped after ${actions}, the limit for one goal. Check the screen and send the next command.`;
 if(waiting==='COMPLETION_UNCERTAIN'&&report.steps>0)return `Not confirmed: ${actions} done, and the goal may already be complete, but the screen was not clear enough to say. Check the screen, then send the next command.`;
 if(waiting==='LOW_CONFIDENCE'&&report.steps>0)return `Not finished: ${actions} done, then the next step was unclear from the screen. Say what to do next.`;
 // One action, then a stop after it, is not done either. Pod-jinawong r8, task b0ba459d: a goal run
 // opened Spotify, found no control for the search, and the card said "Done: opened com.spotify.client".
 const acted=trace.map(e=>e.phase).lastIndexOf('acted');
 const stoppedAfterAction=acted>=0&&trace.slice(acted+1).some(e=>e.phase==='waiting'&&e.reason===waiting);
 if((report.steps>1||stoppedAfterAction)&&waiting&&HINTS[waiting])return `Not finished: ${actions} done, then ${hint(waiting,report)}`;
 // A round that ended blocked or failed is never Done, whatever its last action was.
 if(['blocked','failed','cancelled'].includes(report.status)&&report.steps>0)return `Not finished: ${actions} done, then it stopped. ${computerReasonText(report.reason)}`;
 if(report.lastAction&&!report.lastAction.blocked&&report.steps>0)return `Done: ${computerActionText(report.lastAction)}. Send the next command.`;
 if(report.steps>0)return 'Done: the action was sent. Send the next command.';
 if(waiting&&HINTS[waiting])return `Not done: ${hint(waiting,report)}`;
 return `Not done: ${waiting??report.reason}. Send the next command.`;
}
function hint(reason:string,report:ComputerTaskReport){
 return HINTS[reason].replace('{target}',quoted(report.lastAction?.label));
}
