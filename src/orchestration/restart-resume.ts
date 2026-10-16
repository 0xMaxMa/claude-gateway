/** Automatic resumes after gateway shutdowns per task; one more interruption reports a blocker. */
export const MAX_RESTART_RESUMES = 3;

/** Worker brief for an attempt that resumes a task interrupted by a gateway shutdown. */
export function restartResumeBrief(resumes: number, lastProgress?: string): string {
  return `Resumed after a gateway restart (automatic resume ${resumes} of ${MAX_RESTART_RESUMES}). A gateway shutdown interrupted the previous attempt of this same task. The user's authorization for this task still stands; continue it now without asking whether to continue. ` +
    'First verify how far the work actually got: files and the working tree, git branch and commits, pushes, tags, PR and CI status, releases, deployments and any other external side effects. ' +
    'Report that verified state with task_report_progress, then finish only the remaining authorized steps. Never repeat a completed side effect (merge, push, tag, release, publish, deploy, delete, send); confirm it from its real state instead. ' +
    'Do not ask the user whether to continue and do not tell them to type "continue". Ask only for a genuinely missing fact or new consent outside the original authorization.' +
    (lastProgress ? `\nLast progress reported before the interruption (historical; verify it, do not trust it): ${JSON.stringify(lastProgress)}` : '');
}

/** Report-turn rule: work interrupted by a restart is resumed by the gateway, never by asking the user. */
export const INTERRUPTED_WORK_REPORT_RULE = 'Never ask the user whether to continue work they already authorized, and never tell them to type "continue" (or "ต่อ") so that work resumes. ' +
  `The gateway resumes a task interrupted by a gateway shutdown automatically, up to ${MAX_RESTART_RESUMES} times; report such a task as resuming. ` +
  'If it ended with GATEWAY_SHUTDOWN_REPEATED, report the verified progress and that repeated gateway shutdowns are the blocker.';
