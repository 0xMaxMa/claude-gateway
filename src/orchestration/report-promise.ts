import { OrchestrationStore } from './store';

/** Work a report turn can truthfully say continues besides a task command it committed: a task of
 * the conversation that is queued, running, waiting for an answer or resuming after a restart. */
export function workPending(store: OrchestrationStore, conversationId: string): boolean {
  return Boolean(store.get(`SELECT 1 FROM tasks WHERE conversation_id=? AND (state IN ('queued','starting','running','waiting_input','interrupting','recovering')
      OR (state='needs_reconciliation' AND json_extract(snapshot_json,'$.restartRecovery') IS NOT NULL)) LIMIT 1`, conversationId));
}
