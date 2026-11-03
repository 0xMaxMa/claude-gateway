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
};
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
export function computerOutcomeText(report:ComputerTaskReport,context:{handedOff?:boolean}={}):string{
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
 if(report.steps>1&&waiting&&HINTS[waiting])return `Not finished: ${actions} done, then ${hint(waiting,report)}`;
 if(report.lastAction&&!report.lastAction.blocked&&report.steps>0)return `Done: ${computerActionText(report.lastAction)}. Send the next command.`;
 if(report.steps>0)return 'Done: the action was sent. Send the next command.';
 if(waiting&&HINTS[waiting])return `Not done: ${hint(waiting,report)}`;
 return `Not done: ${waiting??report.reason}. Send the next command.`;
}
function hint(reason:string,report:ComputerTaskReport){
 return HINTS[reason].replace('{target}',quoted(report.lastAction?.label));
}
