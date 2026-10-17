import { OrchestrationStore } from './store';

// A first-person commitment to (re)start work: "I'll re-run the review", "ผมจะสั่งรันรีวิวใหม่".
const ENGLISH_PROMISE = /\b(?:I(?:'ll| will| am going to|'m going to)|let me|we(?:'ll| will))\b.{0,60}?\b(?:re-?run|run|re-?start|retry|resume|continue|kick off|redo|re-?launch|try (?:it )?again)\b/i;
const THAI_PROMISE = /(?:จะ|เดี๋ยว).{0,40}?(?:รัน|เริ่ม|ทำต่อ|ดำเนินการต่อ|(?<!คำ)สั่ง|ลองใหม่|ลองอีก|ทำใหม่|รีวิวใหม่|ตรวจใหม่|ต่อให้)/;
// A negated or conditional clause ("I will not re-run it", "let me know if…", "จะรันเองไม่ได้", "ถ้าจะให้…") promises nothing.
const NOT_A_COMMITMENT = /\b(?:not|never|unable|cannot|if|unless|whether|let me know)\b|n't\b|ไม่|ถ้า|หาก/i;

/** Whether a reply says the agent will start, re-run or continue work. Thai rarely ends a
 * sentence with punctuation, so a space before Thai text also ends a clause. */
export function promisesWork(text: string): boolean {
  return text.split(/[.!?;\n]+|\s+(?=[\u0E00-\u0E7F])/).some(clause =>
    !NOT_A_COMMITMENT.test(clause) && (ENGLISH_PROMISE.test(clause) || THAI_PROMISE.test(clause)));
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
