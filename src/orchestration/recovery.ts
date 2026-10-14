import { OrchestrationStore } from './store';
import { TaskSnapshot, TaskAttempt } from './types';

/** Invoke under the gateway instance lock before accepting new work. Unknown
 * side effects are deliberately retained for operator/process reconciliation. */
export function recoverOrchestration(store: OrchestrationStore): { inputs: number; uncertainTasks: number } {
  return store.transaction(() => {
    const now = Date.now();
    store.run("UPDATE conversations SET epoch=epoch+1 WHERE id IN (SELECT conversation_id FROM conversation_decisions WHERE state IN ('running','interrupting'))");
    store.run("UPDATE conversation_decisions SET state='interrupted',ended_at=? WHERE state IN ('running','interrupting')", now);
    store.run("UPDATE assistant_responses SET state='interrupted',completed_at=? WHERE state='generating'", now);
    const inputs = Number(store.run("UPDATE conversation_inputs SET status='accepted' WHERE status='assigned'").changes);
    store.run("UPDATE notifications SET status='pending',decision_id=NULL WHERE status='assigned'");
    let uncertainTasks = 0;
    const rows = store.all('SELECT snapshot_json FROM tasks WHERE active_attempt_id IS NOT NULL');
    for (const row of rows) {
      const task = JSON.parse(String(row.snapshot_json)) as TaskSnapshot;
      if (task.state === 'needs_reconciliation' || task.gatewayTarget) continue;
      const attempt = store.attempt(task.activeAttemptId!) as TaskAttempt;
      uncertainTasks++;
      attempt.state = 'unknown'; task.state = 'needs_reconciliation';
      task.latestProgress = { source: 'runtime', observedAt: now, text: 'Gateway restarted; process liveness and side effects require reconciliation.' };
      store.saveAttempt(attempt); store.saveTask(task, task.stateVersion);
    }
    // A subagent that had not started runs only for a running parent; one whose parent now awaits
    // reconciliation (or has ended) never would, so it is cancelled as the parent's notify would have.
    for (let changed = true; changed;) {
      changed = false;
      for (const row of store.all("SELECT snapshot_json FROM tasks WHERE active_attempt_id IS NULL AND state NOT IN ('completed','failed','cancelled') AND json_extract(snapshot_json,'$.parentTaskId') IS NOT NULL")) {
        const task = JSON.parse(String(row.snapshot_json)) as TaskSnapshot;
        const parent = store.task(task.parentTaskId!);
        if (parent && !['needs_reconciliation', 'completed', 'failed', 'cancelled', 'cancel_requested'].includes(parent.state)) continue;
        task.state = 'cancelled'; task.pendingQuestion = undefined; delete task.queuedCommands;
        task.cancellation = { requestedBy: 'agent', requestedAt: now, reason: 'Its parent task stopped when the gateway restarted.' };
        task.latestProgress = { source: 'runtime', observedAt: now, text: 'Cancelled: its parent task stopped when the gateway restarted.' };
        store.saveTask(task, task.stateVersion);
        changed = true;
      }
    }
    // A send interrupted between provider acceptance and local receipt cannot
    // be retried as if it were known not to have happened.
    store.run("UPDATE outbox SET state='unknown',lease_owner=NULL,lease_expires_at=NULL WHERE state='processing' AND kind='delivery'");
    store.run("UPDATE deliveries SET state='unknown',updated_at=? WHERE state='sending'", now);
    store.run("UPDATE task_resources SET lifecycle_state='cleanup_unknown' WHERE lifecycle_state='archiving'");
    store.run("UPDATE outbox SET state='pending',lease_owner=NULL,lease_expires_at=NULL WHERE state='processing' AND kind!='delivery'");
    return { inputs, uncertainTasks };
  });
}
