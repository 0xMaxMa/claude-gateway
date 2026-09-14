import { OrchestrationStore } from './store';

/** Retry reports, never task execution. Decisions/inputs retain the retry clock
 * across restarts, including failed reports written before this implementation. */
export function pendingReports(store: OrchestrationStore, activeSessions: string[], scheduled: string[], automatic: boolean, now = Date.now()) {
  return store.all(`WITH candidates AS (
    SELECT n.id notification_id,c.*,i.id previous_input_id,i.input_seq previous_seq,
      d.state decision_state,d.ended_at,
      (SELECT COUNT(*) FROM conversation_decisions x WHERE x.conversation_id=c.id AND x.state='failed'
        AND EXISTS(SELECT 1 FROM json_each(x.notification_ids_json) WHERE value=n.id)) attempts
    FROM notifications n JOIN conversations c ON c.id=n.conversation_id
    LEFT JOIN conversation_inputs i ON i.id=(SELECT x.id FROM conversation_inputs x
      WHERE x.conversation_id=c.id AND (json_extract(x.ingress_json,'$.ingressKey')='notification:'||n.id
        OR json_extract(x.ingress_json,'$.ingressKey') LIKE 'notification:'||n.id||':retry:%') ORDER BY x.input_seq DESC LIMIT 1)
    LEFT JOIN conversation_decisions d ON d.id=(SELECT d2.id FROM conversation_decisions d2
      WHERE d2.conversation_id=c.id AND EXISTS(SELECT 1 FROM json_each(d2.notification_ids_json) WHERE value=n.id)
      ORDER BY d2.epoch DESC LIMIT 1)
    WHERE n.status='pending'
      AND c.agent_session_id NOT IN (SELECT value FROM json_each(?))
      AND (? OR c.id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM tasks monitored WHERE monitored.id=n.task_id AND monitored.state='running' AND json_extract(monitored.snapshot_json,'$.supervision.id') IS NOT NULL AND monitored.state_version=n.task_state_version))
      AND NOT EXISTS(SELECT 1 FROM conversation_inputs queued WHERE queued.conversation_id=c.id AND queued.status IN ('accepted','assigned'))
  ), eligible AS (
    SELECT *,ROW_NUMBER() OVER (PARTITION BY id ORDER BY notification_id) position FROM candidates
    WHERE decision_state IS NULL OR decision_state='completed' OR (decision_state='failed'
      AND ended_at+MIN(300000,5000*(1 << MIN(6,attempts-1)))<=?)
  ) SELECT * FROM eligible WHERE position=1 ORDER BY notification_id LIMIT 20`,
  JSON.stringify(activeSessions), automatic ? 1 : 0, JSON.stringify(scheduled), now);
}
