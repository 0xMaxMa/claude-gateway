import { OrchestrationStore } from './store';

// A commitment to (re)start work right after its subject: "I'll re-run the review", "let me retry",
// "ผมจะสั่งรันรีวิวใหม่", "เดี๋ยวผมรันใหม่ให้". Only adverbs and particles may sit in between, so
// "I'll summarize the run" or "จะสรุปผลการรัน" is not one.
const ENGLISH_PROMISE = /\b(?:I(?:'ll| will| am going to|'m going to)|let me(?! know)|we(?:'ll| will))(?:\s+(?:now|then|also|just|immediately|quickly|automatically|go ahead and|try to|start to))*\s+(?:re-?run|run|re-?start|retry|resume|continue(?! to (?:keep|update|let))|kick off|redo|re-?launch|try (?:it )?again)\b/i;
const THAI_PROMISE = /(?:จะ|เดี๋ยว)(?:\s*(?:ผม|ฉัน|เรา|หนู|ขอ|ให้|ทำการ|ลอง|รีบ|ไป))*\s*(?:รัน|เริ่ม|ทำต่อ|ดำเนินการต่อ|สั่ง|ลองใหม่|ลองอีก|ทำใหม่|รีวิวใหม่|ตรวจใหม่)/g;
// An offer ("let me know if…", "if you want, I'll…", "ถ้าต้องการ…จะ…") promises nothing on its own.
const ENGLISH_CONDITION = /\b(?:if|unless|whether)\b/i;
const THAI_CONDITION = /ถ้า|หาก/, THAI_CANNOT = /^[^ ]{0,25}?ไม่(?:ได้|ไหว)/;

/** Whether a reply says the agent will start, re-run or continue work. */
export function promisesWork(text: string): boolean {
  const normalized = text.replace(/[\u2018\u2019]/g, "'");
  if (normalized.split(/[.!?\n]+/).some(sentence => ENGLISH_PROMISE.test(sentence) && !ENGLISH_CONDITION.test(sentence))) return true;
  // Thai rarely punctuates sentences, so an offer or a "cannot" is looked for around the match.
  for (const match of normalized.matchAll(THAI_PROMISE)) {
    const before = normalized.slice(Math.max(0, match.index! - 30), match.index), after = normalized.slice(match.index! + match[0].length);
    if (!THAI_CONDITION.test(before) && !THAI_CANNOT.test(after)) return true;
  }
  return false;
}

/** Work a report turn can truthfully say continues besides a task command it committed: a task of
 * the conversation that is queued, running, waiting for an answer or resuming after a restart. */
export function workPending(store: OrchestrationStore, conversationId: string): boolean {
  return Boolean(store.get(`SELECT 1 FROM tasks WHERE conversation_id=? AND (state IN ('queued','starting','running','waiting_input','interrupting','recovering')
      OR (state='needs_reconciliation' AND json_extract(snapshot_json,'$.restartRecovery') IS NOT NULL)) LIMIT 1`, conversationId));
}

/** Appended to a report-turn reply that promises work nothing will run (#605). */
export function unbackedPromiseNote(reply: string): string {
  return /[฀-๿]/.test(reply)
    ? 'หมายเหตุจากระบบ: ตอนนี้ยังไม่มีงานที่กำลังรันหรือรอรันอยู่ งานจะยังไม่เริ่มเอง หากต้องการให้ทำต่อ กรุณาส่งข้อความสั่งงานอีกครั้ง'
    : 'Note from the gateway: no task is running or queued, so this work will not start on its own. To have it done, send a message asking for it.';
}
