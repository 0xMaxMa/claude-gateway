import type {ComputerTaskReport} from '../orchestration/types';
import type {BrowserTaskReport} from '../jev/browser-contract';
import {computerOutcomeText,UNKNOWN_PREFIX} from './computer-outcome';
import {browserOutcomeText} from './browser-outcome';
import {spokenCommand} from './direct-command';

/**
 * One short spoken line for a voice direct command that did nothing (session
 * 35bd8aff: five voice commands ended "Not done" in silence). Success stays
 * silent; the user hears the device. Thai for a Thai command or a Thai
 * conversation ("Go." in a Thai session), else English. "Say it again" is
 * spoken only while the task still takes commands; an ended task says so.
 * Most not-done commands are handed to the agent instead (agentHandoffRequested),
 * which answers; these lines remain for the rest, such as the agent's own
 * hand-off command.
 * Speaks only the user's own command words, and the chosen control's label when
 * asking to confirm the agent's high-impact command. The recorded
 * line (chat and history, authored as assistant) names the command generically,
 * so user words never become assistant-authored transcript text.
 */
const THAI:Record<string,string>={
 NO_SUPPORTED_ACTION:'ไม่เจอปุ่ม {command} บนหน้าจอ',
 CONFIRM:'จะกด {target} ใช่ไหม',
 SCREEN_CHANGING:'หน้าจอกำลังเปลี่ยน ลองพูดใหม่อีกครั้ง',
 PARTIAL:'กดได้ {done} จาก {planned} แล้วหยุด',
 UNKNOWN:'ไม่แน่ใจว่า {command} ทำไปแล้วหรือยัง ดูหน้าจอก่อนสั่งใหม่',
 NEW_TAB:'เปิดแท็บใหม่ไม่ได้ บอกชื่อเว็บแทน',
 START_URL:'แท็บยังว่าง บอกชื่อเว็บก่อน เช่น เข้า google.com',
 OBSCURED:'มีบางอย่างบังปุ่มหรือลิงก์นั้นอยู่ ปิดหน้าต่างที่บังก่อน แล้วสั่งใหม่',
 NAVIGATION:'ไม่แน่ใจว่าจะเข้าเว็บไหน บอกชื่อเว็บให้ชัด เช่น เข้า yahoo.com',
 UNCLEAR:'ไม่เข้าใจคำสั่ง {command} ลองพูดแบบอื่นดู',
 ENDED:'ยังไม่ได้ทำ {command} และงานนี้หยุดไปแล้ว ต้องเริ่มงานใหม่',
 DEFAULT:'ยังไม่ได้ทำ {command} ลองพูดใหม่อีกครั้ง',
};
const ENGLISH:Record<string,string>={
 NO_SUPPORTED_ACTION:'Could not find {command} on the screen.',
 CONFIRM:'Press {target}?',
 SCREEN_CHANGING:'The screen was changing. Please say it again.',
 PARTIAL:'Pressed {done} of {planned}, then stopped.',
 UNKNOWN:'Not sure whether {command} ran. Check the screen before saying it again.',
 NEW_TAB:'A new tab cannot be opened here. Say the site name instead.',
 START_URL:'The tab is still blank. Say the site first, for example go to google.com.',
 OBSCURED:'Something is covering that button or link. Close it first, then say it again.',
 NAVIGATION:'Not sure which website to open. Say its address, for example go to yahoo.com.',
 UNCLEAR:'Did not understand {command}. Try saying it another way.',
 ENDED:'{command} was not done, and this task has ended. Start a new one to continue.',
 DEFAULT:'{command} was not done. Please say it again.',
};
const KIND:Record<string,string>={
 NO_SUPPORTED_ACTION:'NO_SUPPORTED_ACTION',SEQUENCE_TARGET_MISSING:'NO_SUPPORTED_ACTION',CONFIRMATION_REQUIRED:'CONFIRM',
 UI_NOT_READY:'SCREEN_CHANGING',STALE_OBSERVATION:'SCREEN_CHANGING',ACTION_CONTEXT_CHANGED:'SCREEN_CHANGING',STALE_RETRY_BUDGET:'SCREEN_CHANGING',WAIT_BUDGET:'SCREEN_CHANGING',
 NEW_TAB_OUT_OF_SCOPE:'NEW_TAB',START_URL_REQUIRED:'START_URL',
 TARGET_OBSCURED:'OBSCURED',NAVIGATION_UNRESOLVED:'NAVIGATION',UNCLEAR:'UNCLEAR',
};
export interface SpeechContext {
 /** The conversation speaks Thai (voice locale, or its recent commands). */
 thai?:boolean;
 /** The task no longer takes commands after this round. */
 ended?:boolean;
}
/**
 * Jev judged a single direct command to be a question about what is shown
 * (READ_REQUEST): no action ran and the agent answers it, so it is not "not done".
 */
export function readRequested(outcome:{computerReport?:ComputerTaskReport;browserReport?:BrowserTaskReport}):boolean{
 const computer=outcome.computerReport,browser=outcome.browserReport;
 if(computer)return !computer.stepRun&&computer.reason==='COMMAND_WAITING_INPUT'&&!computer.steps&&
  [...(Array.isArray(computer.trace)?computer.trace:[])].reverse().find(e=>e.phase==='waiting'&&e.reason!=='POST_ACTION_EVIDENCE_STALE')?.reason==='READ_REQUEST';
 return !!browser&&!browser.stepRun&&browser.reason==='COMMAND_WAITING_INPUT'&&browser.commandOutcome?.reason==='READ_REQUEST'&&!browser.lastConfirmedAction&&browser.lastAction?.outcome!=='unknown';
}
// Not-done outcomes that are answers in themselves: a read request (its own
// route), the session start, a confirmation question or the user's "no", and
// plain facts nothing else could change.
const NO_HANDOFF=new Set(['READ_REQUEST','SESSION_READY','CONFIRMATION_REQUIRED','CONFIRMATION_DECLINED','NEW_TAB_OUT_OF_SCOPE','SCROLL_LIMIT','HISTORY_UNAVAILABLE','NOTHING_TO_ERASE','KEY_UNSUPPORTED']);
/**
 * A single direct command that ran nothing and did not end in an answer of its
 * own: the gateway hands the same input to the agent once, instead of "say it
 * again". Step runs, any action that ran, and uncertain receipts never qualify.
 */
export function agentHandoffRequested(outcome:{computerReport?:ComputerTaskReport;browserReport?:BrowserTaskReport}):boolean{
 const computer=outcome.computerReport,browser=outcome.browserReport;
 if(computer){
  if(computer.stepRun||computer.reason!=='COMMAND_WAITING_INPUT'||computer.steps)return false;
  const waiting=[...(Array.isArray(computer.trace)?computer.trace:[])].reverse().find(e=>e.phase==='waiting'&&e.reason!=='POST_ACTION_EVIDENCE_STALE');
  return !!waiting?.reason&&!NO_HANDOFF.has(waiting.reason);
 }
 return !!browser&&!browser.stepRun&&browser.reason==='COMMAND_WAITING_INPUT'&&browser.commandOutcome?.done===false&&!NO_HANDOFF.has(browser.commandOutcome.reason??'')&&!browser.lastConfirmedAction&&browser.lastAction?.outcome!=='unknown';
}
export function directCommandSpeech(outcome:{computerReport?:ComputerTaskReport;browserReport?:BrowserTaskReport},command:string,context:SpeechContext={}):{spoken:string;recorded:string}|undefined{
 // The agent speaks the answer itself.
 if(readRequested(outcome))return;
 const computer=outcome.computerReport,browser=outcome.browserReport;
 // Step lists are the agent's or the user's own plan, reported in the chat.
 if(computer?.stepRun||browser?.stepRun)return;
 const line=computer?computerOutcomeText(computer):browser?browserOutcomeText(browser):undefined;
 const thai=/\p{Script=Thai}/u.test(command)||context.thai===true,words=thai?THAI:ENGLISH;
 const said=[...spokenCommand(command)].slice(0,40).join(''),generic=thai?'คำสั่งนี้':'that command';
 const render=(template:string)=>({spoken:template.replace('{command}',said),recorded:template.replace('{command}',generic)});
 // An unresolved receipt may have acted: asking to repeat would replay it.
 if(line?.startsWith(UNKNOWN_PREFIX))return render(words.UNKNOWN);
 if(!line?.startsWith('Not done'))return;
 if(context.ended)return render(words.ENDED);
 const sequence=computer?.lastAction?.sequence,planned=computer?.lastAction?.planned;
 if(sequence&&planned&&sequence.length<planned)return render(words.PARTIAL.replace('{done}',String(sequence.length)).replace('{planned}',String(planned)));
 const reason=computer?[...(computer.trace??[])].reverse().find(e=>e.phase==='waiting'&&e.reason!=='POST_ACTION_EVIDENCE_STALE')?.reason??computer.reason:browser!.commandOutcome?.reason??browser!.reason;
 // The user said no: nothing ran, as they asked; nothing more to say.
 if(reason==='CONFIRMATION_DECLINED')return;
 // The question names the chosen control, so the user knows what they confirm.
 const target=[...(computer?.lastAction?.label??browser?.commandOutcome?.action?.label??'')].slice(0,60).join('');
 return render(words[KIND[reason]??'DEFAULT'].replace('{target}',target));
}
