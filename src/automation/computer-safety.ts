import type {ComputerState} from './computer-use';
import {normalizeCommand} from './direct-command';

/**
 * Shared high-impact action policy for direct commands and step runs. Pure:
 * no provider or device calls. False positives only return control early.
 */
// Each group is one high-impact intent across English and Thai. A command
// authorizes a target only through a shared group, never through "ok"/"yes".
const GROUPS:Array<{id:string;pattern:RegExp}>=[
 {id:'delete',pattern:/\b(?:delete|remove|erase|trash|discard)\b|ลบ|ทิ้ง|ถังขยะ/iu},
 {id:'send',pattern:/\b(?:send|submit)\b|ส่ง/iu},
 {id:'pay',pattern:/\b(?:pay|payment|purchase|buy|checkout|check out|place order|order now|transfer)\b|จ่าย|ชำระ|ซื้อ|สั่งซื้อ|โอน/iu},
 {id:'confirm',pattern:/\bconfirm\b|ยืนยัน/iu},
 {id:'publish',pattern:/\b(?:publish|post)\b|โพสต์|เผยแพร่/iu},
 {id:'quit',pattern:/\b(?:quit|uninstall|sign out|log out|unsubscribe)\b|ออกจากระบบ|ถอนการติดตั้ง|ออกจากโปรแกรม|ปิดโปรแกรม/iu},
];
// Generic dialog answers are high-impact only as a whole label.
const CONFIRM_LABELS=/^(?:ok|okay|yes|allow|continue|agree|accept|ตกลง|ใช่|อนุญาต|ยอมรับ|ดำเนินการต่อ)$/iu;
/** Direct commands need this confidence, plus an explicit matching verb, before a high-impact press. */
export const DESTRUCTIVE_CONFIDENCE=0.85;

const masked=(text:string)=>text.replace(/"[^"\n]*"|“[^”\n]*”/gu,quoted=>'\u0000'.repeat(quoted.length)).trim();
const groups=(text:string|undefined)=>text?GROUPS.filter(g=>g.pattern.test(masked(text))).map(g=>g.id):[];
export function destructiveText(text:string|undefined){
 if(!text)return false;
 return groups(text).length>0||CONFIRM_LABELS.test(masked(text));
}

export interface DestructiveTarget {label:string;groups:string[]}
/**
 * The high-impact meaning of a pending press or Enter, judged from the
 * observation it was decided on. strict treats every generic confirm label as
 * high-impact (step runs); otherwise a confirm label counts only when its
 * dialog context names a high-impact operation.
 */
export function destructiveTarget(state:ComputerState|undefined,action:Record<string,unknown>,strict:boolean):DestructiveTarget|undefined{
 const control=action.kind==='press'?state?.controls.find(c=>c.ref===action.ref):undefined;
 if(action.kind==='press'&&!control)return strict?{label:'unobserved control',groups:[]}:undefined;
 const label=action.kind==='press'?control!.label:action.kind==='key'&&action.key==='enter'?state?.focusedControl?.label:undefined;
 if(!label)return;
 return destructiveLabel({label,value:control?.value,context:[control?.context,state?.windowTitle,...(state?.text??[])].filter(Boolean).join(' · ')},strict);
}
/**
 * Surface-agnostic form of destructiveTarget for any observed control (desktop
 * or web page): its own label/value name a high-impact operation, or it is a
 * generic confirm label whose surrounding context does (always, when strict).
 */
export function destructiveLabel(control:{label:string;value?:string;context?:string},strict:boolean):DestructiveTarget|undefined{
 const own=[...new Set([...groups(control.label),...groups(control.value)])];
 if(own.length)return {label:control.label,groups:own};
 if(!CONFIRM_LABELS.test(masked(control.label)))return;
 if(strict)return {label:control.label,groups:[]};
 const context=groups(control.context);
 return context.length?{label:control.label,groups:context}:undefined;
}
/** The user's command itself names the same high-impact operation as the target. */
export function commandAuthorizes(command:string,target:DestructiveTarget){
 const own=groups(command);
 return target.groups.some(group=>own.includes(group));
}

const TEXT_ROLES=new Set(['AXTextField','AXTextArea','AXSearchField','AXComboBox']);
/**
 * "ลบ", "ลบๆๆ", "delete 3", "backspace x2" while a text field has focus mean
 * erase characters, not press a Delete button. Returns the character count.
 */
export function eraseCommand(command:string):number|undefined{
 const normalized=normalizeCommand(command);
 const match=/^(?:กด ?|press )?(?:ลบ|backspace|delete|del)((?: ?ๆ)*)(?: ?(?:x ?)?(\d{1,2})(?: ?(?:ครั้ง|ตัว|ตัวอักษร|times?|chars?|characters?))?)?$/u.exec(normalized);
 if(!match)return;
 const count=match[2]?Number(match[2]):1+(match[1].match(/ๆ/gu)?.length??0);
 return count>=1?Math.min(count,50):undefined;
}
/** Keyboard focus is in text (any text role, sensitive or not): words there are text editing. */
export function textFocused(state:ComputerState){
 const role=state.focusedControl?.role;
 return Boolean(role&&(TEXT_ROLES.has(role)||role==='AXStaticText'));
}
/** The focused, non-sensitive, typeable text field an erase command applies to. */
export function focusedTextField(state:ComputerState){
 const focus=state.focusedControl;
 if(!focus||focus.sensitive)return;
 if(focus.role==='AXStaticText')return containingTextField(state,focus);
 if(!TEXT_ROLES.has(focus.role))return;
 const control=state.controls.find(c=>!c.sensitive&&(focus.ref?c.ref===focus.ref:c.focused===true)&&TEXT_ROLES.has(c.role));
 return control?.actions.includes('type')?control:undefined;
}
// Chrome can report focus on the static text inside a field after typing (E2E
// e6149724: AXStaticText "test123" in Google's AXTextArea). The observation has
// no parent links, so the field is the one typeable text control holding that text.
function containingTextField(state:ComputerState,focus:NonNullable<ComputerState['focusedControl']>){
 const text=state.controls.find(c=>focus.ref?c.ref===focus.ref:c.focused===true)?.value??focus.label;
 if(!text)return;
 const fields=state.controls.filter(c=>!c.sensitive&&TEXT_ROLES.has(c.role)&&c.actions.includes('type')&&c.value===text);
 return fields.length===1?fields[0]:undefined;
}
