import type {ComputerTaskReport} from '../orchestration/types';

/**
 * One owner-facing line per direct command: what was done, or why nothing was
 * done and what to try next. Built from the structural report only; it never
 * repeats typed text or window contents beyond the chosen control's label.
 */
const HINTS:Record<string,string>={
 LOW_CONFIDENCE:'no visible control matched this command confidently{confidence}. Name the button, link or field as it appears on screen.',
 NO_SUPPORTED_ACTION:'no visible control matches this command. Check that the right window is in front, or name the item as it appears on screen.',
 FIELD_TEXT_REQUIRED:'no text to enter was found in the command. Put the text in quotes, for example: พิมพ์ "hello".',
 FOCUS_REQUIRED:'the target needs keyboard focus first. Click the field, then send the command again.',
 FOCUS_UNSUPPORTED:'this control cannot take keyboard focus. Click it instead.',
 TARGET_OCCLUDED:'the target is covered by another window or popup. Close it, then try again.',
 UI_NOT_READY:'the screen was still changing. Send the command again.',
 STALE_OBSERVATION:'the screen changed before the action ran. Send the command again.',
 ACTION_CONTEXT_CHANGED:'the screen changed before the action ran. Send the command again.',
 SUBMIT_CONTEXT_CHANGED:'the field changed before Enter was pressed. Check it and press Enter if still wanted.',
 SHORTCUT_UNAVAILABLE:'this shortcut is not available in the front application. Bring the target application (for tabs, the browser) to the front first.',
 SHORTCUT_NOT_OFFERED:'the browser in front did not offer this command as a menu item or shortcut. Name the menu item as it appears on screen.',
 NOTHING_TO_ERASE:'the focused field is already empty.',
 ERASE_UNAVAILABLE:'the focused field is too long to edit safely this way.',
 DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED:'{target} is a high-impact control (delete, send, pay, quit or confirm). To proceed, name the action in the command, for example "กด Delete" or "confirm delete".',
 COMPLETION_NOT_ESTABLISHED:'the result could not be confirmed from the screen.',
 SEQUENCE_TARGET_MISSING:'the next button was not found exactly once on the screen.',
 SEQUENCE_TOO_LONG:'the number is too long to press safely. Say at most 8 digits at a time.',
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
/** Shared step-run summary; the surface supplies its own hint for a stop detail. */
export function stepRunText(run:import('./command-steps').CommandStepRun,hintFor:(detail:string)=>string|undefined):string{
 const head=`${run.completed}/${run.total} steps done.${run.notes?.length?' '+run.notes.join(' '):''}`;
 if(run.stopReason==='ALL_STEPS_DONE')return head+(run.unverifiedSteps?.length?` No visible change after step ${run.unverifiedSteps.join(', ')}.`:'');
 const detailHint=run.detail?hintFor(run.detail):undefined;
 const reason=detailHint?`${run.stopReason} (${run.detail}): ${detailHint}`:`${run.stopReason}${run.detail?` (${run.detail})`:''}`;
 return `${head} Stopped at step ${run.stoppedAt} ${JSON.stringify(run.stoppedStep??'')}: ${reason}${run.doneParts?.length?` Already done in that step: ${run.doneParts.map(s=>JSON.stringify(s)).join(', ')}.`:''}${run.remaining.length?` Not run: ${run.remaining.map(s=>JSON.stringify(s)).join(', ')}.`:''}`.slice(0,1500);
}
export function computerOutcomeText(report:ComputerTaskReport):string{
 const run=report.stepRun;
 if(run)return stepRunText(run,detail=>HINTS[detail]?hint(detail,report):undefined);
 const trace=report.trace??[];
 const waiting=[...trace].reverse().find(e=>e.phase==='waiting'&&e.reason!=='POST_ACTION_EVIDENCE_STALE')?.reason;
 // The device may have acted: never tell the owner it was not done.
 if(report.reason==='OUTCOME_UNKNOWN')return `${UNKNOWN_PREFIX} the last action may have run. Check the screen before sending the command again.`;
 if(report.clarification)return `Not done: ${report.clarification}`;
 if(waiting==='READ_REQUEST'&&!report.steps)return 'Read request: nothing was pressed; the assistant answers from the current screen.';
 // A spoken number stopped part-way: say how far it got, never "Done".
 const sequence=report.lastAction?.sequence,planned=report.lastAction?.planned;
 if(sequence&&planned&&sequence.length<planned)return `Not done: pressed ${sequence.length} of ${planned} (${sequence.map(label=>quoted(label)).join(', ')}), then stopped${waiting&&HINTS[waiting]?`: ${hint(waiting,report)}`:'.'}`;
 if(report.lastAction&&!report.lastAction.blocked&&report.steps>0)return `Done: ${computerActionText(report.lastAction)}. Send the next command.`;
 if(report.steps>0)return 'Done: the action was sent. Send the next command.';
 if(waiting&&HINTS[waiting])return `Not done: ${hint(waiting,report)}`;
 return `Not done: ${waiting??report.reason}. Send the next command.`;
}
function hint(reason:string,report:ComputerTaskReport){
 const confidence=[...(report.trace??[])].reverse().find(e=>e.phase==='decided'&&typeof e.confidence==='number')?.confidence;
 return HINTS[reason].replace('{confidence}',confidence===undefined?'':` (confidence ${confidence.toFixed(2)})`).replace('{target}',quoted(report.lastAction?.label));
}
