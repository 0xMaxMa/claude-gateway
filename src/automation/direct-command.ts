import {literalTextCandidates} from './computer-policy';

/**
 * Surface-agnostic direct-command grammar shared by Computer Use and Remote
 * Browser. Pure string parsing of the user's own command: a finite vocabulary,
 * never substring intent guessing. Compound, negated, targeted and ambiguous
 * commands return undefined and stay on the normal Jev decision path.
 */
// Speech-to-text adds hesitation fillers, polite particles and a final full
// stop ("เอาล่ะ กด enter.", "เลื่อนลงครับ"; session 35bd8aff). They are dropped
// for matching only: the stored command and Jev's goal stay verbatim, and a
// filler or particle that is the whole command is kept.
const FILLERS=/^(?:เอ่อ|อ่า|เอาล่ะ|โอเค|ok|okay)[\s,]+/iu;
const PARTICLES=/\s*(?:ครับ|ค่ะ|คะ|นะ|หน่อย|จ้า|เจ้า)$/u;
/** The command without spoken fillers, particles or trailing .!? (case kept). */
export function spokenCommand(command:string):string {
 let text=command.trim().replace(/\s+/gu,' '),previous='';
 while(text!==previous){
  previous=text;
  const next=text.replace(/[\s.!?。…]+$/u,'').replace(PARTICLES,'').replace(FILLERS,'').trim();
  if(next)text=next;
 }
 return text;
}
export const normalizeCommand = (command:string) => spokenCommand(command).toLocaleLowerCase();

const SCROLL:Record<string,'up'|'down'>={
 'scroll up':'up','scroll down':'down',
 'scroll ขึ้น':'up','scroll ลง':'down','scroll ขึ้นไป':'up','scroll ลงมา':'down',
 'เลื่อนขึ้น':'up','เลื่อนลง':'down','เลื่อนขึ้นไป':'up','เลื่อนลงมา':'down',
};
/** "scroll ลง", "เลื่อนขึ้น", "scroll down": the direction only. */
export function scrollCommand(command:string):'up'|'down'|undefined {
 const normalized=normalizeCommand(command);
 return Object.hasOwn(SCROLL,normalized)?SCROLL[normalized]:undefined;
}

// Exact key commands follow the native key executor contract.
const KEYS:Record<string,string>={
 'กดลูกศรขึ้น':'up','กดลูกศรลง':'down','กดลูกศรซ้าย':'left','กดลูกศรขวา':'right',
 'กด enter':'enter','กด tab':'tab','กด escape':'escape',
 'press arrow up':'up','press arrow down':'down','press arrow left':'left','press arrow right':'right',
 'press enter':'enter','press tab':'tab','press escape':'escape',
 // A bare key name is the key itself (recorded "enter" hit LOW_CONFIDENCE).
 'enter':'enter','return':'enter','เอ็นเทอร์':'enter','tab':'tab','แท็บ':'tab','esc':'escape','escape':'escape',
 'up':'up','down':'down','left':'left','right':'right','arrow up':'up','arrow down':'down','arrow left':'left','arrow right':'right',
 'ลูกศรขึ้น':'up','ลูกศรลง':'down','ลูกศรซ้าย':'left','ลูกศรขวา':'right',
 'กด esc':'escape','press esc':'escape','press return':'enter','กด return':'enter',
};
/** The named key of an exact key command: enter, tab, escape, up, down, left or right. */
export function keyCommand(command:string):string|undefined {
 const normalized=normalizeCommand(command);
 return Object.hasOwn(KEYS,normalized)?KEYS[normalized]:undefined;
}

const HISTORY:Record<string,'back'|'forward'>={
 'back':'back','go back':'back','ย้อนกลับ':'back','กลับหน้าก่อน':'back','กลับไปหน้าก่อน':'back',
 'forward':'forward','go forward':'forward','ไปข้างหน้า':'forward','ไปหน้าถัดไป':'forward',
};
// Spoken Thai "back" wording varies ("ย้อนกลับไปหน้าก่อนหน้า", session
// b01a566f): back/return + optional "ไป" + optional "the previous page".
const THAI_BACK=/^(?:ย้อนกลับ|ย้อน|กลับ)(?:ไป)?(?:ที่)?(?:หน้า(?:ก่อน(?:หน้า)?(?:นี้)?|ที่แล้ว|เดิม))$|^ย้อนกลับ(?:ไป)?$/u;
const ENGLISH_BACK=/^(?:go )?back(?: to)?(?: the)? previous page$|^previous page$/u;
/** Exact history commands; anything else keeps the normal Jev path. */
export function historyCommand(command:string):'back'|'forward'|undefined {
 const normalized=normalizeCommand(command);
 if(Object.hasOwn(HISTORY,normalized))return HISTORY[normalized];
 if(THAI_BACK.test(normalized.replace(/\s+/gu,''))||ENGLISH_BACK.test(normalized))return 'back';
}

/** Phrases that ask for a new browser tab (Cmd+T). */
export const NEW_TAB_PHRASES=['new tab','open new tab','open a new tab','เปิด tab ใหม่','เปิดแท็บใหม่','tab ใหม่','แท็บใหม่'];
/**
 * A new-tab request, also as STT hears it ("แท็ก" for "แท็บ") and with a
 * site between ("เปิดแท็บ Google ใหม่"). The site is reported, never opened
 * in a new tab here: each surface decides what a new tab means.
 */
export function newTabCommand(command:string):{site?:string}|undefined {
 const normalized=normalizeCommand(command).replace(/^(?:กด|press) /u,'').replace(/แท็ก/gu,'แท็บ');
 if(NEW_TAB_PHRASES.includes(normalized)||/^(?:เปิด ?)?(?:tab|แท็บ) ?ใหม่$/u.test(normalized))return {};
 const site=/^เปิด ?(?:tab|แท็บ) (.+?) ?ใหม่$|^open (?:a )?new tab (?:for |with |to )?(.+)$/u.exec(normalized);
 const name=(site?.[1]??site?.[2])?.trim();
 return name&&!/\s/u.test(name)?{site:name}:undefined;
}

// Text entry needs the user's own verb at the start: a stray transcript (the
// page's audio heard as a command, session b01a566f) must never be typed.
const TEXT_ENTRY=/^(?:ช่วย ?)?(?:พิมพ์|ค้นหา|ค้น|กรอก|ใส่|เขียน|search|type|fill|write|enter text|input)(?![a-z])/iu;
/** The command explicitly asks to enter text (พิมพ์/ค้นหา/กรอก/search/type ...). */
export function textEntryRequested(command:string):boolean {
 return TEXT_ENTRY.test(spokenCommand(command));
}

const TEXT_VERBS=/^(?:ค้นหา|ค้น|search for|search|พิมพ์|type|กรอก)\s*(.+)$/iu;
/**
 * The literal payload of "ค้นหา X" / "search X" (typed and submitted) and
 * "พิมพ์ X" / "type X" (typed only). Thai verbs join their object without a
 * space, which word-suffix candidates cannot split. A command naming its
 * destination ("พิมพ์ X ใน search box") needs Jev to choose that field.
 */
export function textCommand(command:string):{text:string;submit:boolean}|undefined {
 const match=TEXT_VERBS.exec(command.trim());
 // A single joined token ("พิมพ์ค้นหา") is ambiguous between verb and payload.
 if(!match||!/\s|["“]/u.test(command.trim()))return;
 const submit=!/^(?:พิมพ์|type|กรอก)/iu.test(command.trim());
 const quoted=literalTextCandidates(match[1]).filter(value=>match[1].trim()===`"${value}"`||match[1].trim()===`“${value}”`);
 if(quoted.length===1)return {text:quoted[0],submit};
 const text=match[1].trim();
 if(!text||text.length>500||/["“]|\s(?:ใน|ที่ช่อง|in|into|on)\s/iu.test(text))return;
 return {text,submit};
}

// Known site names map to their address; a domain or URL is used verbatim.
const SITES:Record<string,string>={google:'google.com','กูเกิล':'google.com',youtube:'youtube.com','ยูทูป':'youtube.com',facebook:'facebook.com','เฟสบุ๊ค':'facebook.com',
 gmail:'mail.google.com',github:'github.com',x:'x.com',twitter:'x.com',instagram:'instagram.com',tiktok:'tiktok.com',wikipedia:'wikipedia.org',
 chatgpt:'chatgpt.com',pantip:'pantip.com',shopee:'shopee.co.th',lazada:'lazada.co.th'};
/** "เข้า google", "เปิด youtube", "go to example.com" or a bare address: the address to open. */
export function addressCommand(command:string):string|undefined {
 const trimmed=spokenCommand(command);
 const match=/^(?:(?:เข้า(?:ไป)?(?:ที่|เว็บ)?|เปิด(?:เว็บ)?|ไปที่|ไป|go to|open|visit)\s*)?(.+)$/iu.exec(trimmed)!;
 const target=match[1].trim(),verb=target!==trimmed;
 if(/\s/u.test(target))return;
 const site=SITES[target.toLocaleLowerCase()];
 if(site&&verb)return site;
 const url=literalTextCandidates(target);
 return url.length===1&&url[0]===target&&/^(?:https?:\/\/|www\.)|\.[a-z]{2,}(?:\/|$)/iu.test(target)?target:undefined;
}

/**
 * "อีก", "again", "zoom อีก": repeat the previous command (or the named one).
 * The repeated command is decided afresh on the current state, never replayed.
 */
export function repeatCommand(command:string,previous:string|undefined):string|undefined {
 const match=/^(?:(.+?)\s*)?(?:อีก(?:ครั้ง|ที|รอบ)?|again|once more|repeat|ซ้ำ)$/iu.exec(command.trim());
 if(!match)return;
 return match[1]?.trim()||previous?.trim()||undefined;
}
