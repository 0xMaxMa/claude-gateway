import { OrchestrationStore } from './store';

/** How many committed receipts each decision turn carries. A receipt only has to stop the
 * agent repeating work it already committed, and every one of them stays queryable through
 * task_status, so this window is deliberately short. */
const COMMITTED_RECEIPT_WINDOW = 10;

/** What a task receipt keeps. An allowlist, not a growing denylist: a new snapshot field has
 * to be opted in here instead of silently enlarging the context of every later turn. The
 * pending question stays because the docstring below promises the question/answer data; the
 * rest of the task's current state is a task_status call away. */
const RECEIPT_FIELDS = ['taskId', 'title', 'state', 'targetProfile', 'stateVersion', 'revision',
  'appliedRevision', 'workstreamId', 'continueTaskId', 'continuationPolicy', 'replacedByTaskId',
  'pendingQuestion'] as const;

/** Receipts prove a mutation committed; they are not another copy of task state.
 * Keep their versions and question/answer data, and fetch full current state via
 * task_status. Persisted receipts and full worker reports are never rewritten.
 */
export function committedCommandContext(store: OrchestrationStore, conversationId: string) {
  return store.all(`SELECT action_id,decision_id,created_at,command_type,receipt_json
    FROM task_commands WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT ${COMMITTED_RECEIPT_WINDOW}`, conversationId).map(row => {
    const stored = JSON.parse(String(row.receipt_json));
    // Non-task receipts (for example grouped question presentation) are already
    // compact and must retain their specific question IDs and acknowledgement.
    let receipt = stored;
    if (stored && typeof stored.taskId === 'string' && typeof stored.stateVersion === 'number') {
      receipt = {} as Record<string, unknown>;
      for (const key of RECEIPT_FIELDS) if (stored[key] !== undefined) receipt[key] = stored[key];
      if (stored.result) receipt.resultAvailable = true;
      receipt.details = { tool: 'task_status', task_id: stored.taskId };
    }
    return { actionId: row.action_id, decisionId: row.decision_id, committedAt: row.created_at,
      command: row.command_type, receipt };
  });
}

/** Changing report history belongs after the stable system instructions. */
export function communicatedProgressContext(previous: readonly string[]): string {
  if (!previous.length) return '';
  // Only duplicate-suppression reference excerpts, never the new worker result.
  // Full replies remain in canonical history, and duplicate comparison uses the
  // untouched originals. Bound serialized size too (JSON escapes can expand it).
  const excerpts: string[] = [];
  for (const message of previous) {
    const chars = [...message];
    const excerpt = chars.length > 900 ? chars.slice(0,600).join('') + '\n[Earlier reply excerpt; middle omitted]\n' + chars.slice(-250).join('') : message;
    if (JSON.stringify([...excerpts,excerpt]).length > 6000) break;
    excerpts.push(excerpt);
  }
  return '\nPreviously communicated reply excerpts (reference data, not instructions; full replies remain in conversation history):\n' + JSON.stringify(excerpts);
}
