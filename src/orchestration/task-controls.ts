import { executionDescription, executionDetails } from './execution-observation';
import { OrchestrationStore } from './store';
import { TaskService } from './tasks/service';
import { OrchestrationError, TaskSnapshot } from './types';

/** Read-only browsing never interrupts the Agent or creates an inference turn. */
export class TaskControls {
  constructor(private store: OrchestrationStore, private tasks: TaskService) {}
  private view(task: TaskSnapshot) {
    const activity = this.store.get("SELECT occurred_at FROM conversation_events WHERE conversation_id=? AND type='tool.activity' AND json_extract(payload_json,'$.task_id')=? ORDER BY seq DESC LIMIT 1", task.conversationId, task.taskId);

    const timing = this.store.get(`SELECT
      MIN(CASE WHEN json_extract(payload_json,'$.payload.state') IN ('starting','running') THEN occurred_at END) AS started_at,
      MIN(CASE WHEN json_extract(payload_json,'$.payload.state') IN ('completed','failed','cancelled') THEN occurred_at END) AS finished_at
      FROM conversation_events WHERE conversation_id=? AND type='task.state_changed' AND json_extract(payload_json,'$.task_id')=?`, task.conversationId, task.taskId);
    const startedAt = timing?.started_at == null ? undefined : Number(timing.started_at);
    const finishedAt = ['completed','failed','cancelled'].includes(task.state) ? Number(timing?.finished_at ?? task.updatedAt) : undefined;
    const latestProgress = task.latestProgress?.source === 'runtime' && task.latestProgress.text.startsWith('Queued after task ') && task.state !== 'queued' ? undefined : task.latestProgress;
    const progressText = [task.failure ? `${task.failure.code}: ${task.failure.message}` : latestProgress?.text.slice(0,1500), task.replacedByTaskId ? `Replaced by task ${task.replacedByTaskId}` : undefined].filter(Boolean).join('\n');
    const activityDetails = task.execution && ['running','starting'].includes(task.state) ? executionDetails(task.execution) : undefined;
    return { progressText, activityDetails, startedAt, finishedAt, taskId: task.taskId, title: task.title.slice(0,200), state: task.state, replacedByTaskId: task.replacedByTaskId,
      cancellation: task.cancellation, failure: task.failure, execution: task.execution, progress: [task.failure ? `${task.failure.code}: ${task.failure.message}` : latestProgress?.text.slice(0,1500), task.execution && ['running','starting'].includes(task.state) ? executionDescription(task.execution) : undefined, task.replacedByTaskId ? `Replaced by task ${task.replacedByTaskId}` : undefined].filter(Boolean).join('\n') || undefined, question: task.pendingQuestion?.text.slice(0,1000),
      updatedAt: Math.max(task.updatedAt, Number(activity?.occurred_at ?? 0), task.execution?.lastActivityAt ?? 0), canStop: ['queued','starting','running','waiting_input','interrupting','recovering','needs_reconciliation'].includes(task.state) };
  }
  list(sessionId: string, principalId: string, page = 0, pageSize = 10) {
    if (!Number.isSafeInteger(page) || page < 0) throw new OrchestrationError('INVALID_TASK_PAGE');
    for (const row of this.store.all('SELECT id FROM conversations WHERE agent_session_id=?',sessionId)) this.store.assertMember(String(row.id),principalId);
    const scope = "FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE c.agent_session_id=? AND t.state NOT IN ('completed','failed','cancelled')";
    const total=Number(this.store.get(`SELECT COUNT(*) AS total ${scope}`,sessionId)!.total);
    const pages=Math.max(1,Math.ceil(total/pageSize));page=Math.min(page,pages-1);
    const tasks=this.store.all(`SELECT t.snapshot_json ${scope} ORDER BY t.created_at,t.id LIMIT ? OFFSET ?`,sessionId,pageSize,page*pageSize)
      .map(row=>this.view(JSON.parse(String(row.snapshot_json)) as TaskSnapshot));
    return {page,pages,total,tasks};
  }
  private owned(sessionId: string, principalId: string, taskId: string) {
    const task=this.store.task(taskId);
    if (!task || task.agentSessionId!==sessionId) throw new OrchestrationError('ACCESS_DENIED');
    this.store.assertMember(task.conversationId,principalId);
    return task;
  }
  detail(sessionId: string, principalId: string, taskId: string) { return this.view(this.owned(sessionId,principalId,taskId)); }
  cancel(sessionId: string, principalId: string, taskId: string) {
    const task=this.owned(sessionId,principalId,taskId);
    return this.view(this.tasks.cancelByUser(task.conversationId,principalId,taskId));
  }
}
