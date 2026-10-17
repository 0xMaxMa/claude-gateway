import { OrchestrationStore } from './store';

// A first-person commitment to (re)start work: "I'll re-run the review", "ผมจะสั่งรันรีวิวใหม่".
// A negated one ("I will not re-run it", "จะไม่รันซ้ำ") promises nothing.
const ENGLISH_PROMISE = /\b(?:I(?:'ll| will| am going to|'m going to)|let me|we(?:'ll| will))\b(?![^.!?\n]{0,20}?\b(?:not|never)\b)[^.!?\n]{0,60}?\b(?:re-?run|run|re-?start|retry|resume|continue|kick off|redo|re-?launch|try (?:it )?again)\b/i;
const THAI_PROMISE = /(?:จะ|เดี๋ยว)(?!(?:ยัง)?ไม่)[^.!?\n]{0,40}?(?:รัน|เริ่ม|ทำต่อ|ดำเนินการต่อ|สั่ง|ลองใหม่|ลองอีก|ทำใหม่|รีวิวใหม่|ตรวจใหม่|ต่อให้)/;

/** Whether a reply says the agent will start, re-run or continue work. */
export function promisesWork(text: string): boolean {
  return ENGLISH_PROMISE.test(text) || THAI_PROMISE.test(text);
}

/** Work a report turn can truthfully say continues: a task command it committed, or a task of the
 * conversation that is queued, running, waiting for an answer or resuming after a restart. */
export function workPending(store: OrchestrationStore, conversationId: string, decisionId: string): boolean {
  return Boolean(store.get("SELECT 1 FROM task_commands WHERE decision_id=? AND command_type IN ('spawn','update','answer') LIMIT 1", decisionId) ||
    store.get(`SELECT 1 FROM tasks WHERE conversation_id=? AND (state IN ('queued','starting','running','waiting_input','interrupting','recovering')
      OR (state='needs_reconciliation' AND json_extract(snapshot_json,'$.restartRecovery') IS NOT NULL)) LIMIT 1`, conversationId));
}

/** Appended to a report-turn reply that promises work nothing will run (#605). */
export function unbackedPromiseNote(reply: string): string {
  return /[฀-๿]/.test(reply)
    ? 'หมายเหตุจากระบบ: ตอนนี้ยังไม่มีงานที่กำลังรันหรือรอรันอยู่ งานจะยังไม่เริ่มเอง หากต้องการให้ทำต่อ กรุณาส่งข้อความสั่งงานอีกครั้ง'
    : 'Note from the gateway: no task is running or queued, so this work will not start on its own. To have it done, send a message asking for it.';
}
