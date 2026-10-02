import type {TaskSnapshot} from '../types';

export const AUTOMATION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export interface AutomationSession {
  status: 'active' | 'idle' | 'blocked' | 'closed';
  idleTimeoutMs: number;
  idleSince?: number;
  closedAt?: number;
  closedReason?: 'user' | 'agent' | 'supervisor' | 'idle_timeout';
}
/** Round outcomes stay on the task/attempt. The conversation with the device outlives a round.
 * Expiry is derived from a persisted timestamp, so reads/restarts never renew it or run inference. */
export function automationSession(task: TaskSnapshot, now = Date.now()): AutomationSession | undefined {
  if (!['browser','computer'].includes(task.gatewayTarget?.adapter ?? '')) return;
  const prior = task.automationSession;
  if (prior?.status === 'closed') return prior;
  const idleTimeoutMs = prior?.idleTimeoutMs ?? AUTOMATION_IDLE_TIMEOUT_MS;
  if (['cancelled','cancel_requested'].includes(task.state)) return {status:'closed',idleTimeoutMs,closedAt:task.cancellation?.requestedAt ?? task.updatedAt,closedReason:task.cancellation?.requestedBy ?? 'agent'};
  const status = task.state === 'needs_reconciliation' || (task.state === 'failed' && task.computerReport?.status === 'blocked') ? 'blocked' :
    ['completed','failed'].includes(task.state) || (task.state === 'waiting_input' && !task.activeAttemptId) ? 'idle' : 'active';
  if (status === 'active') return {status,idleTimeoutMs};
  const idleSince = prior?.idleSince ?? task.updatedAt;
  // A user-driven conversation stays open while it waits for their next command;
  // a failed round expires like any other, whoever controlled it.
  if ((task.automationController !== 'user' || task.state === 'failed') && now - idleSince >= idleTimeoutMs) return {status:'closed',idleTimeoutMs,idleSince,closedAt:idleSince+idleTimeoutMs,closedReason:'idle_timeout'};
  return {status,idleTimeoutMs,idleSince};
}
/** The task waits for the owner's next direct command (a settled or paused round). */
export function pausedForCommand(task: TaskSnapshot): boolean {
  return task.state==='waiting_input'&&!task.activeAttemptId&&(task.executionControl?.phase==='paused'||['THINKING_WAITING_INPUT','COMMAND_WAITING_INPUT','COMPLETION_CANDIDATE','VERIFICATION_FAILED'].includes(task.computerReport?.reason??task.browserReport?.reason??''));
}
/**
 * A settled round the owner's next command replaces: finished, failed or
 * cancelled for any reason (timeout, Jev failure, low confidence...), or waiting
 * on a question such as FIELD_TEXT_REQUIRED, which the new command supersedes.
 * Never an outcome that may have acted without a receipt: that is reconciled first.
 */
export function stoppedForCommand(task: TaskSnapshot): boolean {
  if(task.activeAttemptId||!['completed','failed','waiting_input'].includes(task.state))return false;
  const browser=task.browserReport,computer=task.computerReport;
  if(browser?.reason==='OUTCOME_UNKNOWN'||browser?.lastAction?.outcome==='unknown')return false;
  if(computer?.status==='needs_reconciliation')return false;
  // A device action whose result is unknown, or execution cut off mid-way. A Jev
  // decision failure (JEV_OUTCOME_UNKNOWN, JEV_INVALID_RESPONSE) ran nothing.
  const uncertain=/^(?:COMPUTER_|BROWSER_)?(?:OUTCOME_UNKNOWN|EXECUTION_INTERRUPTED)$/;
  return !uncertain.test(computer?.reason??'')&&!uncertain.test(task.failure?.code??'');
}
/** Whether the owner's next direct command would run on this task (see TaskService.controlByUser). */
export function acceptsDirectCommand(task: TaskSnapshot): boolean {
  if(automationSession(task)?.status==='closed')return false;
  return ['queued','starting','running','interrupting'].includes(task.state)||pausedForCommand(task)||stoppedForCommand(task);
}
export function syncAutomationSession(task: TaskSnapshot, now = Date.now()): void {
  // A just-finished round starts its own idle period, independent of its duration.
  if (task.automationSession?.status === 'active' && ['completed','failed','waiting_input','needs_reconciliation'].includes(task.state)) {
    task.automationSession.idleSince = now;
  }
  task.automationSession = automationSession(task,now);
}
