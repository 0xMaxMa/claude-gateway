import { OrchestrationStore } from './store';
import { OrchestrationError, TaskSnapshot } from './types';

/** Scheduled callers need the report of their own work, not the queue acknowledgement. */
export function taskReport(store: OrchestrationStore, inputId: string): { pending: boolean; text?: string } {
  const tasks = store.all(`SELECT DISTINCT t.snapshot_json FROM task_commands tc
    JOIN conversation_decisions d ON d.id=tc.decision_id JOIN tasks t ON t.id=tc.task_id
    WHERE EXISTS (SELECT 1 FROM json_each(d.input_ids_json) WHERE value=?)`, inputId)
    .map(row => JSON.parse(String(row.snapshot_json)) as TaskSnapshot);
  if (!tasks.length) return {pending:false};
  const reports = new Map<string,string>();
  let pending = false;
  for (const task of tasks) {
    if (['failed','cancelled','needs_reconciliation','waiting_input'].includes(task.state)) {
      throw new OrchestrationError('SCHEDULED_TASK_INCOMPLETE', `Task ${task.taskId} ${task.state}: ${task.failure?.code ?? task.state} ${task.failure?.message ?? ''}`.trim());
    }
    if (task.state !== 'completed') { pending = true; continue; }
    const report = store.get(`SELECT r.id,r.generated_text FROM notifications n
      JOIN assistant_responses r ON r.decision_id=n.decision_id
      WHERE n.task_id=? AND n.task_state_version=? AND n.status='handled' AND r.state='completed'`, task.taskId, task.stateVersion);
    if (!report?.generated_text) pending = true;
    else reports.set(String(report.id),String(report.generated_text));
  }
  return pending ? {pending:true} : {pending:false,text:[...reports.values()].join('\n\n')};
}
