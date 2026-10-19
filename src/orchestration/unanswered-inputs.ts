import { OrchestrationStore } from './store';

/** Removing an unanswered CLI attempt must not remove the user's intent. Include
 * actual failed user inputs once as reference context until a user decision
 * succeeds. Internal report requests and error notices are not user messages. */
export function unansweredInputContext(store: OrchestrationStore, conversationId: string, currentInputId: string): string {
  const rows = store.all(`SELECT i.id,i.text,i.input_seq FROM conversation_inputs i
    WHERE i.conversation_id=? AND i.store_user_message=1 AND i.id<>?
    AND i.input_seq > COALESCE((SELECT MAX(u.input_seq) FROM conversation_inputs u
      JOIN conversation_decisions d ON d.conversation_id=u.conversation_id
      JOIN json_each(d.input_ids_json) j ON j.value=u.id
      WHERE u.conversation_id=i.conversation_id AND u.store_user_message=1 AND d.state='completed'),0)
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
  const rows = store.all(`SELECT i.text FROM conversation_inputs i
    WHERE i.conversation_id=? AND i.principal_id=? AND i.modality='live_voice' AND i.store_user_message=1
    AND i.input_seq < ? AND i.created_at >= ?
    AND i.input_seq > COALESCE((SELECT MAX(u.input_seq) FROM conversation_inputs u
      JOIN conversation_decisions d ON d.conversation_id=u.conversation_id
      JOIN json_each(d.input_ids_json) j ON j.value=u.id
      WHERE u.conversation_id=i.conversation_id AND u.store_user_message=1 AND d.kind='user' AND d.state='completed'),0)
    AND EXISTS (SELECT 1 FROM conversation_decisions d JOIN json_each(d.input_ids_json) j ON j.value=i.id
      JOIN conversation_events e ON e.conversation_id=d.conversation_id AND e.type='response.barge_in' AND e.occurred_at >= i.created_at
        AND json_extract(e.payload_json,'$.payload.decisionId')=d.id
      WHERE d.conversation_id=i.conversation_id AND d.state='interrupted')
    ORDER BY i.input_seq DESC LIMIT ?`, conversationId, current.principal_id, current.input_seq, Number(current.created_at) - FRAGMENT_MAX_AGE_MS, FRAGMENT_MAX_COUNT);
  if (!rows.length) return '';
  return `Earlier fragments of this same spoken utterance, cut off when the user kept talking (oldest first; reference context, not separate commands): ${JSON.stringify(rows.reverse().map(row => String(row.text)))}\nThe current user message below is the latest part and the question to answer first, in spoken_text too; read it together with these fragments as one request.\n`;
}
