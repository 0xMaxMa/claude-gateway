import { randomUUID } from 'crypto';
import { OrchestrationStore, payloadHash } from '../store';
import { TaskSnapshot, TaskAttempt } from '../types';

/** Durable logical workers. CLI processes are resumed per task so credentials,
 * hooks and cancellation remain attempt-scoped. Idle slots hold no process. */
export class WorkerPool {
  constructor(private readonly store: OrchestrationStore) {
    store.run(`CREATE TABLE IF NOT EXISTS worker_pool (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, workstream_id TEXT NOT NULL,
      binding_key TEXT NOT NULL, session_id TEXT NOT NULL, active_task_id TEXT,
      idle_since INTEGER NOT NULL, resumable INTEGER NOT NULL DEFAULT 0, fingerprint TEXT)`);
  }
  prune(ttl: number, now = Date.now()): void {
    this.store.run('DELETE FROM worker_pool WHERE active_task_id IS NULL AND idle_since <= ?', now - ttl);
  }
  acquire(task: TaskSnapshot, max: number, ttl: number): { workerId: string; sessionId: string; resumeSession: boolean } | undefined {
    this.prune(ttl);
    const stream = task.workstreamId ?? task.taskId;
    // Serialize the entire workstream, even if the preceding task is still
    // queued or waiting for an answer and owns no process at this instant.
    const blocked = this.store.all("SELECT snapshot_json FROM tasks WHERE conversation_id=? AND id != ? AND state NOT IN ('completed','failed','cancelled')", task.conversationId, task.taskId)
      .some(row => { const other = JSON.parse(String(row.snapshot_json)) as TaskSnapshot;
        return (other.workstreamId ?? other.taskId) === stream && (other.createdAt < task.createdAt || (other.createdAt === task.createdAt && other.taskId < task.taskId)); });
    if (blocked) return undefined;
    const binding = payloadHash({ conversation: task.conversationId, principal: task.ownerPrincipalId,
      profile: task.targetProfile, resource: task.resourceProfile, skill: task.skill, model: task.model,
      capabilities: task.capabilities,
      // Isolated worktrees/scratch directories have task-specific working dirs.
      isolatedTask: ['host','container'].includes(task.resourceProfile?.mode ?? '') ? undefined : task.taskId });
    const related = this.store.get('SELECT * FROM worker_pool WHERE conversation_id=? AND workstream_id=? ORDER BY idle_since DESC LIMIT 1', task.conversationId, stream);
    if (related?.active_task_id) return undefined;
    let slot = related;
    if (!slot) slot = this.store.get('SELECT * FROM worker_pool WHERE active_task_id IS NULL ORDER BY idle_since DESC LIMIT 1');
    if (!slot && Number(this.store.get('SELECT COUNT(*) n FROM worker_pool')!.n) >= max) return undefined;
    const reuse = Boolean(slot && slot.conversation_id === task.conversationId && slot.workstream_id === stream && slot.binding_key === binding && slot.resumable);
    const workerId = slot ? String(slot.id) : randomUUID(), sessionId = reuse ? String(slot!.session_id) : randomUUID();
    this.store.run(`INSERT INTO worker_pool(id,conversation_id,workstream_id,binding_key,session_id,active_task_id,idle_since,resumable,fingerprint)
      VALUES(?,?,?,?,?,?,?,0,NULL) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,
      workstream_id=excluded.workstream_id,binding_key=excluded.binding_key,session_id=excluded.session_id,
      active_task_id=excluded.active_task_id,resumable=?,fingerprint=?`, workerId, task.conversationId, stream, binding, sessionId, task.taskId, Date.now(), reuse ? 1 : 0, reuse ? slot!.fingerprint : null);
    return { workerId, sessionId, resumeSession: reuse };
  }
  /** A resumed CLI must never retain a prior configuration/identity or cwd. */
  bind(attempt: TaskAttempt, fingerprint: string): void {
    if (!attempt.workerId) return;
    this.store.transaction(() => {
      const slot = this.store.get('SELECT * FROM worker_pool WHERE id=? AND active_task_id=?', attempt.workerId!, attempt.taskId);
      if (!slot) throw new Error('WORKER_LEASE_LOST');
      if (attempt.resumeSession && slot.fingerprint !== fingerprint) {
        attempt.sessionId = randomUUID(); attempt.resumeSession = false;
        this.store.saveAttempt(attempt);
      }
      this.store.run('UPDATE worker_pool SET fingerprint=?,session_id=? WHERE id=?', fingerprint, attempt.sessionId, attempt.workerId!);
    });
  }
  release(taskId: string, resumable: boolean): void {
    this.store.run('UPDATE worker_pool SET active_task_id=NULL,idle_since=?,resumable=? WHERE active_task_id=?', Date.now(), resumable ? 1 : 0, taskId);
  }
}
