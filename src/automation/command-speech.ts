import type {ComputerTaskReport} from '../orchestration/types';
import type {BrowserTaskReport} from '../jev/browser-contract';
import {computerOutcomeText,UNKNOWN_PREFIX} from './computer-outcome';
import {browserOutcomeText} from './browser-outcome';
import {spokenCommand} from './direct-command';

/**
 * One short spoken line for a voice direct command that did nothing (session
 * 35bd8aff: five voice commands ended "Not done" in silence). Success stays
 * silent; the user hears the device. Thai for a Thai command, else English.
 * Speaks only the user's own command words, never screen text. The recorded
 * line (chat and history, authored as assistant) names the command generically,
 * so user words never become assistant-authored transcript text.
 */
const THAI:Record<string,string>={
 LOW_CONFIDENCE:'ไม่แน่ใจว่า {command} คือปุ่มไหน ลองพูดใหม่อีกครั้ง',
 NO_SUPPORTED_ACTION:'ไม่เจอปุ่ม {command} บนหน้าจอ',
 SEQUENCE_TOO_LONG:'ตัวเลขยาวเกินไป พูดทีละไม่เกินแปดหลัก',
 DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED:'{command} เป็นปุ่มสำคัญ ต้องพูดชื่อคำสั่งให้ชัดก่อน',
 SCREEN_CHANGING:'หน้าจอกำลังเปลี่ยน ลองพูดใหม่อีกครั้ง',
 PARTIAL:'กดได้ {done} จาก {planned} แล้วหยุด',
 UNKNOWN:'ไม่แน่ใจว่า {command} ทำไปแล้วหรือยัง ดูหน้าจอก่อนสั่งใหม่',
 CLARIFY:'ถามกลับว่าหมายถึงตัวเลขไหน',
 DEFAULT:'ยังไม่ได้ทำ {command} ลองพูดใหม่อีกครั้ง',
};
const ENGLISH:Record<string,string>={
 LOW_CONFIDENCE:'Not sure which button {command} means. Please say it again.',
 NO_SUPPORTED_ACTION:'Could not find {command} on the screen.',
 SEQUENCE_TOO_LONG:'That number is too long. Say at most eight digits at a time.',
 DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED:'{command} is a high-impact button. Name the action to confirm it.',
 SCREEN_CHANGING:'The screen was changing. Please say it again.',
 PARTIAL:'Pressed {done} of {planned}, then stopped.',
 UNKNOWN:'Not sure whether {command} ran. Check the screen before saying it again.',
 CLARIFY:'Asked which number was meant.',
 DEFAULT:'{command} was not done. Please say it again.',
};
const KIND:Record<string,string>={
 LOW_CONFIDENCE:'LOW_CONFIDENCE',LOW_OPERATION_CONFIDENCE:'LOW_CONFIDENCE',LOW_TARGET_CONFIDENCE:'LOW_CONFIDENCE',
 NO_SUPPORTED_ACTION:'NO_SUPPORTED_ACTION',SEQUENCE_TARGET_MISSING:'NO_SUPPORTED_ACTION',
 SEQUENCE_TOO_LONG:'SEQUENCE_TOO_LONG',DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED:'DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED',
 UI_NOT_READY:'SCREEN_CHANGING',STALE_OBSERVATION:'SCREEN_CHANGING',ACTION_CONTEXT_CHANGED:'SCREEN_CHANGING',STALE_RETRY_BUDGET:'SCREEN_CHANGING',WAIT_BUDGET:'SCREEN_CHANGING',
};
export function directCommandSpeech(outcome:{computerReport?:ComputerTaskReport;browserReport?:BrowserTaskReport},command:string):{spoken:string;recorded:string}|undefined{
 const computer=outcome.computerReport,browser=outcome.browserReport;
 // Step lists are the agent's or the user's own plan, reported in the chat.
 if(computer?.stepRun||browser?.stepRun)return;
 const line=computer?computerOutcomeText(computer):browser?browserOutcomeText(browser):undefined;
 const thai=/\p{Script=Thai}/u.test(command),words=thai?THAI:ENGLISH;
 const said=[...spokenCommand(command)].slice(0,40).join(''),generic=thai?'คำสั่งนี้':'that command';
 const render=(template:string)=>({spoken:template.replace('{command}',said),recorded:template.replace('{command}',generic)});
 // An unresolved receipt may have acted: asking to repeat would replay it.
 if(line?.startsWith(UNKNOWN_PREFIX))return render(words.UNKNOWN);
 if(!line?.startsWith('Not done'))return;
 if(computer?.clarification)return {spoken:computer.clarification,recorded:words.CLARIFY};
 const sequence=computer?.lastAction?.sequence,planned=computer?.lastAction?.planned;
 if(sequence&&planned&&sequence.length<planned)return render(words.PARTIAL.replace('{done}',String(sequence.length)).replace('{planned}',String(planned)));
 const reason=computer?[...(computer.trace??[])].reverse().find(e=>e.phase==='waiting'&&e.reason!=='POST_ACTION_EVIDENCE_STALE')?.reason??computer.reason:browser!.commandOutcome?.reason??browser!.reason;
 return render(words[KIND[reason]??'DEFAULT']);
}
