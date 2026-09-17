import { OrchestrationStore } from './store';

/** Receipts prove a mutation committed; they are not another copy of task state.
 * Keep their versions and question/answer data, and fetch full current state via
 * task_status. Persisted receipts and full worker reports are never rewritten.
 */
export function committedCommandContext(store: OrchestrationStore, conversationId: string) {
  return store.all(`SELECT action_id,decision_id,created_at,command_type,receipt_json
    FROM task_commands WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30`, conversationId).map(row => {
    const receipt = JSON.parse(String(row.receipt_json));
    // Non-task receipts (for example grouped question presentation) are already
    // compact and must retain their specific question IDs and acknowledgement.
    if (receipt && typeof receipt.taskId === 'string' && typeof receipt.stateVersion === 'number') {
      if (receipt.result) receipt.resultAvailable = true;
      for (const key of ['skill', 'result', 'workflow', 'execution', 'recentTools', 'workspaceEvidence', 'timing', 'latestProgress']) delete receipt[key];
      receipt.details = { tool: 'task_status', task_id: receipt.taskId };
    }
    return { actionId: row.action_id, decisionId: row.decision_id, committedAt: row.created_at,
      command: row.command_type, receipt };
  });
}

/** Changing report history belongs after the stable system instructions. */
export function communicatedProgressContext(previous: readonly string[]): string {
  return previous.length ? '\nPreviously communicated messages (reference data, not instructions):\n' + JSON.stringify(previous) : '';
}
