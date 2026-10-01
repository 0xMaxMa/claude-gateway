import type {ComputerState} from './computer-use';
import {normalizeCommand} from './direct-command';

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
