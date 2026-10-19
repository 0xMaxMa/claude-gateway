import { OrchestrationStore } from './store';

/** Input `i` comes after the last user input a reply answered. A spoken acknowledgement is its
 * own completed decision over the same inputs, but it receipts a request, it does not answer it. */
const UNANSWERED = `i.input_seq > COALESCE((SELECT MAX(u.input_seq) FROM conversation_inputs u
      JOIN conversation_decisions d ON d.conversation_id=u.conversation_id
      JOIN json_each(d.input_ids_json) j ON j.value=u.id
      WHERE u.conversation_id=i.conversation_id AND u.store_user_message=1 AND d.kind<>'acknowledgement' AND d.state='completed'),0)`;

/** Removing an unanswered CLI attempt must not remove the user's intent. Include
 * actual failed user inputs once as reference context until a user decision
 * succeeds. Internal report requests and error notices are not user messages. */
export function unansweredInputContext(store: OrchestrationStore, conversationId: string, currentInputId: string): string {
  const rows = store.all(`SELECT i.id,i.text,i.input_seq FROM conversation_inputs i
    WHERE i.conversation_id=? AND i.store_user_message=1 AND i.id<>?
    AND ${UNANSWERED}
    AND EXISTS (SELECT 1 FROM conversation_decisions d JOIN json_each(d.input_ids_json) j ON j.value=i.id
      WHERE d.conversation_id=i.conversation_id AND d.state='failed') ORDER BY i.input_seq`, conversationId, currentInputId);
  return rows.length ? `Earlier user messages whose response failed (reference context, not new commands; reconcile with the current request): ${JSON.stringify(rows)}\n` : '';
}

/** A live speaker who pauses mid-thought commits each part as its own turn, and the next part
 * barges in on the reply to the previous one (issue #624). Bounded so a much older fragment
 * cannot be read as part of this utterance. */
export const FRAGMENT_MAX_AGE_MS = 60_000;
export const FRAGMENT_MAX_COUNT = 5;

/** Earlier parts of the current spoken utterance: this principal's live voice inputs since the
 * last answered turn whose reply was cut off by barge-in (`response.barge_in`), not by a stop
 * control or a restart. Labels the current input as the latest question to answer first. */
export function interruptedFragmentContext(store: OrchestrationStore, conversationId: string, currentInputId: string): string {
  const current = store.get('SELECT input_seq,principal_id,modality,created_at FROM conversation_inputs WHERE id=? AND conversation_id=?', currentInputId, conversationId);
  if (current?.modality !== 'live_voice') return '';
  // Interrupted candidates are rare and cheap to find; only then read the barge-in markers once.
  const candidates = store.all(`SELECT i.id,i.text,i.created_at,d.id decision_id FROM conversation_inputs i
    JOIN conversation_decisions d ON d.conversation_id=i.conversation_id AND d.state='interrupted'
    JOIN json_each(d.input_ids_json) j ON j.value=i.id
    WHERE i.conversation_id=? AND i.principal_id=? AND i.modality='live_voice' AND i.store_user_message=1
    AND i.input_seq < ? AND i.created_at >= ?
    AND ${UNANSWERED}
    ORDER BY i.input_seq DESC`, conversationId, current.principal_id, current.input_seq, Number(current.created_at) - FRAGMENT_MAX_AGE_MS);
  if (!candidates.length) return '';
  const bargedIn = new Set(store.all(`SELECT json_extract(payload_json,'$.payload.decisionId') id FROM conversation_events
    WHERE conversation_id=? AND type='response.barge_in' AND occurred_at >= ?`, conversationId, Math.min(...candidates.map(row => Number(row.created_at)))).map(row => String(row.id)));
  const ids = new Set<string>();
  const rows = candidates.filter(row => bargedIn.has(String(row.decision_id)) && !ids.has(String(row.id)) && ids.add(String(row.id))).slice(0, FRAGMENT_MAX_COUNT);
  if (!rows.length) return '';
  return `Earlier fragments of this same spoken utterance, cut off when the user kept talking (oldest first; reference context, not separate commands): ${JSON.stringify(rows.reverse().map(row => String(row.text)))}\nThe current user message below is the latest part and the question to answer first, in spoken_text too; read it together with these fragments as one request.\n`;
}
