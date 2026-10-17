import type { TaskAttempt, TaskSnapshot } from './types';

/** Automatic resumes after gateway shutdowns per task; one more interruption reports a blocker. */
export const MAX_RESTART_RESUMES = 3;

/** Startup resumes a GATEWAY_SHUTDOWN failure settled by a gateway without restart resume only
 * this recently; an older one has already been reported and must not come back on its own. */
export const ORPHANED_SHUTDOWN_WINDOW_MS = 10 * 60_000;

/** Gateway-managed tasks recover through their controller; a subagent is re-spawned by its resumed parent. */
export function restartResumable(task: Pick<TaskSnapshot, 'gatewayTarget' | 'parentTaskId'>): boolean {
  return !task.gatewayTarget && !task.parentTaskId;
}

/** Mark a running task whose worker may outlive this gateway. A stop, a cancellation or a pending
 * question keeps its own handling; only work that was executing resumes. */
export function markRestartRecovery(task: TaskSnapshot): void {
  if (!restartResumable(task) || !['starting', 'running'].includes(task.state) || task.cancellation || task.pendingQuestion) return;
  task.restartRecovery = task.latestProgress?.source === 'worker' ? { lastProgress: task.latestProgress.text } : {};
}

/** Re-queue already-authorized work interrupted by a gateway restart as a new attempt of the same
 * task (#603), or fail it as a blocker once the per-revision cap is spent. */
export function resumeAfterRestart(task: TaskSnapshot, attempt: TaskAttempt, lastProgressHint?: string): boolean {
  const previous = task.restartResume?.revision === attempt.revision ? task.restartResume : undefined;
  const count = (previous?.count ?? 0) + 1;
  if (count > MAX_RESTART_RESUMES) {
    task.state = 'failed';
    if (task.restartResume) task.restartResume.pending = false;
    attempt.failure = task.failure = { code: 'GATEWAY_SHUTDOWN_REPEATED', message: `Gateway restarts interrupted this task ${count} times; automatic resume stopped after ${MAX_RESTART_RESUMES} resumes. Existing changes are retained; any follow-up must verify them first and must not blindly repeat side effects.`, observedAt: Date.now() };
    return false;
  }
  task.state = 'queued';
  task.restartResume = { count, revision: attempt.revision, pending: true,
    lastProgress: task.latestProgress?.source === 'worker' ? task.latestProgress.text : lastProgressHint ?? previous?.lastProgress };
  return true;
}

/** Worker brief for an attempt that resumes a task interrupted by a gateway shutdown. */
export function restartResumeBrief(resumes: number, lastProgress?: string): string {
  return `Resumed after a gateway restart (automatic resume ${resumes} of ${MAX_RESTART_RESUMES}). A gateway shutdown interrupted the previous attempt of this same task. The user's authorization for this task still stands; continue it now without asking whether to continue. ` +
    'First verify how far the work actually got: files and the working tree, git branch and commits, pushes, tags, PR and CI status, releases, deployments and any other external side effects. ' +
    'Report that verified state with task_report_progress, then finish only the remaining authorized steps. Never repeat a completed side effect (merge, push, tag, release, publish, deploy, delete, send); confirm it from its real state instead. ' +
    'Do not ask the user whether to continue and do not tell them to type "continue". Ask only for a genuinely missing fact or new consent outside the original authorization.' +
    (lastProgress ? `\nLast progress reported before the interruption (historical; verify it, do not trust it): ${JSON.stringify(lastProgress)}` : '');
}

/** Report-turn rule: work interrupted by a restart is resumed by the gateway, never by asking the user. */
export const INTERRUPTED_WORK_REPORT_RULE = 'For work interrupted by a gateway restart, never ask the user whether to continue it and never tell them to type "continue" (or "ต่อ") so that it resumes; the user already authorized it. ' +
  'A task the gateway re-queued after a restart (state queued with restartResume.pending) resumes automatically; report it as resuming. Do not claim that any other task resumes. ' +
  'For a task that ended with GATEWAY_SHUTDOWN_REPEATED or CLEANUP_UNCONFIRMED, report the verified progress and that concrete blocker.';
