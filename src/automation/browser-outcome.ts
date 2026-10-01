import {stepRunText,UNKNOWN_PREFIX} from './computer-outcome';
import {COMMAND_DECISION_FAILURES} from './direct-command';
import type {BrowserTaskReport} from '../jev/browser-contract';
import type {BrowserCommandAction} from './browser-command';

/**
 * One owner-facing line per direct Remote Browser command, as for Computer
 * Use: what was done, or why nothing was done and what to try next. Built
 * from the structural report only; never repeats typed text or page text
 * beyond the chosen control's label.
 */
const HINTS:Record<string,string>={
 UNCLEAR:'the command was not understood. Say it another way, or name the link, button or field as it appears on the page.',
 NO_SUPPORTED_ACTION:'nothing on the page matches this command. Name the link, button or field as it appears on the page.',
 LOW_OPERATION_CONFIDENCE:'the command did not match one action confidently. Name the link, button or field as it appears on the page.',
 LOW_TARGET_CONFIDENCE:'no link, button or field matched this command confidently. Name it as it appears on the page.',
 NO_PROGRESS:'the page did not change after trying. Check the page, then send the command again or name another control.',
 PAGE_CONTENT_UNAVAILABLE:'the page has no readable content yet. Wait for it to load, then send the command again.',
 WAIT_BUDGET:'the page kept changing. Send the command again when it settles.',
 ACTION_SPACE_TOO_LARGE:'the page has too many controls to choose from. Scroll to the part you need or name the control.',
 DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED:'{target} is a high-impact control (delete, send, pay, publish or confirm). To proceed, name the action in the command, for example "กด Delete" or "confirm delete".',
 HISTORY_UNAVAILABLE:'there is no page to go {direction} to in this tab.',
 SCROLL_LIMIT:'the page is already at the {edge}.',
 NEW_TAB_OUT_OF_SCOPE:'Remote Browser works only in the one tab you approved, so no new tab was opened. Send the site or address (for example "เข้า google") and it opens in this tab.',
 START_URL_REQUIRED:'the tab is still blank. Send the site or address first (for example "เข้า google.com") and it opens in this tab.',
 KEY_UNSUPPORTED:'this browser extension version cannot press keys. Update the Remote Browser extension (0.3.5 or later).',
 STALE_OBSERVATION:'the page changed before the action ran. Send the command again.',
 STALE_RETRY_BUDGET:'the page kept changing. Send the command again when it settles.',
 FIELD_TEXT_REQUIRED:'no text to enter was found in the command. Put the text in quotes, for example: พิมพ์ "hello".',
 COMPLETION_CANDIDATE:'the page already appears to match; no action was needed.',
 ACTION_BUDGET:'the action limit for one command was reached. Send the next command.',
 EVALUATION_BUDGET:'the decision limit for one command was reached. Send the command again, more specifically.',
 TARGET_OBSCURED:'something is covering {target} (for example a pop-up, banner or menu), so it was not clicked. Close what covers it, then send the command again.',
 NAVIGATION_UNRESOLVED:'could not tell which website to open. Say its address, for example "เข้า yahoo.com".',
};
// The decision service failed for this command only; the session keeps going.
for(const code of COMMAND_DECISION_FAILURES)
 HINTS[code]='no decision was made for this command ('+code+'). Send the command again.';
const quoted=(label?:string)=>label?JSON.stringify(label.slice(0,80)):'the chosen control';
function done(action:BrowserCommandAction|undefined){
 switch(action?.kind){
  case 'scroll':return `scrolled ${action.direction??''}`.trim();
  case 'key':return `pressed the ${action.key??''} key`.replace('  ',' ');
  case 'history':return `went ${action.direction??'back'}`;
  case 'navigate':return `opened ${action.url?JSON.stringify(action.url.slice(0,120)):'the address'}`;
  case 'search':return `searched in ${quoted(action.label)}`;
  case 'click':return `clicked ${quoted(action.label)}`;
  case 'type':return `entered text in ${quoted(action.label)}`;
  case 'select':return `selected an option in ${quoted(action.label)}`;
  default:return 'completed the action';
 }
}
function hint(reason:string,action?:BrowserCommandAction){
 return HINTS[reason].replace('{target}',quoted(action?.label)).replace('{direction}',action?.direction??'back').replace('{edge}',action?.direction==='up'?'top':'bottom');
}
export function browserOutcomeText(report:BrowserTaskReport):string{
 if(report.stepRun)return stepRunText(report.stepRun,detail=>HINTS[detail]?hint(detail):undefined);
 const outcome=report.commandOutcome;
 if(report.reason==='OUTCOME_UNKNOWN'||report.lastAction?.outcome==='unknown')return `${UNKNOWN_PREFIX} the last action may have run. Check the page before sending the command again.`;
 if(outcome?.done)return `Done: ${done(outcome.action)}.${outcome.reason==='PAGE_STILL_LOADING'?' The page was still loading; check it before the next command.':' Send the next command.'}`;
 const reason=outcome?.reason??report.reason;
 if(reason==='READ_REQUEST')return 'Read request: nothing was clicked; the assistant answers from the current page.';
 if(outcome&&HINTS[reason])return `Not done: ${hint(reason,outcome.action)}`;
 if(report.lastAction?.outcome==='confirmed'&&report.steps>0)return 'Done: the action was sent. Send the next command.';
 if(HINTS[reason])return `Not done: ${hint(reason)}`;
 return `Not done: ${reason}. Send the next command.`;
}
