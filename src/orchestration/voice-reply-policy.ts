import type { OrchestrationStore } from './store';
export type VoiceReplyMode = 'off' | 'auto' | 'on';
export const VOICE_REPLY_MODES: readonly VoiceReplyMode[] = ['off','auto','on'];
export function voiceReplyAllowed(mode: VoiceReplyMode, voiceOrigin: boolean): boolean {
  return mode === 'on' || (mode === 'auto' && voiceOrigin);
}
/** Derive provenance from persisted decision inputs/tasks, never model text or
 * the latest message in the chat. A new user instruction resets continuation provenance. */
export function responseHasVoiceOrigin(store: OrchestrationStore, responseId: string): boolean {
  const decision = store.get('SELECT d.* FROM conversation_decisions d JOIN assistant_responses r ON r.decision_id=d.id WHERE r.id=?', responseId);
  if (!decision) return false;
  const input = (id: string) => store.get(
    'SELECT modality,store_user_message FROM conversation_inputs WHERE id=? AND conversation_id=?', id, decision.conversation_id);
  const isVoice = (row: ReturnType<typeof input>) => row?.modality === 'voice_note' || row?.modality === 'live_voice';
  const userInputs = (JSON.parse(String(decision.input_ids_json)) as string[]).map(input)
    .filter(row => row && row.store_user_message !== 0);
  // A new user turn owns its reply policy, even when it consumes older task notifications.
  if (userInputs.length) return userInputs.some(isVoice);
  for (const row of store.all('SELECT task_id FROM notifications WHERE decision_id=?', decision.id)) {
    let task = store.task(String(row.task_id));
    const visited = new Set<string>();
    while (task && task.conversationId === decision.conversation_id && !visited.has(task.taskId) && visited.size < 64) {
      visited.add(task.taskId);
      const origin = input(task.initiatingInputId);
      if (origin && origin.store_user_message !== 0) {
        if (isVoice(origin)) return true;
        // Reusing a worker/task does not carry a previous voice turn into a new text request.
        break;
      }
      if (!task.continueTaskId) break;
      task = store.task(task.continueTaskId);
    }
  }
  return false;
}
