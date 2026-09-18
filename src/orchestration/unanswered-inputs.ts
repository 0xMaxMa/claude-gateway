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
