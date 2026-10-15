import type { OrchestrationStore } from './store';

/** True when a reply answers words spoken in a live call. The call already
 * plays it, so a chat must not receive it again as a voice message. */
export function answersLiveVoice(store: OrchestrationStore, responseId: string): boolean {
  return Boolean(store.get(`SELECT 1 FROM assistant_responses r JOIN conversation_decisions d ON d.id=r.decision_id
    JOIN json_each(d.input_ids_json) j JOIN conversation_inputs i ON i.id=j.value AND i.conversation_id=d.conversation_id
    WHERE r.id=? AND i.modality='live_voice' LIMIT 1`, responseId));
}

/**
 * A bot cannot post as the user, so a chat reply to a call quotes what the user
 * said above the answer: one `🎙` line per utterance spoken since the chat last
 * received a reply. A barged-in turn is never delivered, so its words join the
 * next reply that is. History keeps the reply text unchanged.
 */
export function withLiveVoiceTranscript(store: OrchestrationStore, responseId: string, text: string): string {
  const rows = store.all(`WITH answered AS (
      SELECT r.conversation_id, MAX(i.input_seq) AS seq FROM assistant_responses r JOIN conversation_decisions d ON d.id=r.decision_id
        JOIN json_each(d.input_ids_json) j JOIN conversation_inputs i ON i.id=j.value AND i.conversation_id=d.conversation_id WHERE r.id=?),
    shown AS (
      SELECT MAX(i.input_seq) AS seq FROM answered a JOIN assistant_responses r ON r.conversation_id=a.conversation_id AND r.id<>?
        JOIN deliveries x ON x.response_id=r.id AND x.modality='text' JOIN conversation_decisions d ON d.id=r.decision_id
        JOIN json_each(d.input_ids_json) j JOIN conversation_inputs i ON i.id=j.value AND i.conversation_id=d.conversation_id)
    SELECT i.text FROM answered a JOIN conversation_inputs i ON i.conversation_id=a.conversation_id
    WHERE i.modality='live_voice' AND i.store_user_message<>0 AND i.input_seq<=a.seq AND i.input_seq>COALESCE((SELECT seq FROM shown),0)
    ORDER BY i.input_seq`, responseId, responseId);
  const quoted = rows.map(row => String(row.text).trim()).filter(Boolean);
  return quoted.length ? `${quoted.map(line => `🎙 ${line}`).join('\n')}\n\n${text}` : text;
}
