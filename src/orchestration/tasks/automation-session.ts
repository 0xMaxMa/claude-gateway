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
/** A finished or cleanly stopped round that the owner's next command restarts. Never an uncertain outcome. */
export function stoppedForCommand(task: TaskSnapshot): boolean {
  if(task.activeAttemptId)return false;
  if(task.state==='completed')return true;
  if(task.state!=='failed')return false;
  if(task.gatewayTarget?.adapter==='browser')return task.browserReport?.status==='blocked' &&
    task.browserReport.reason!=='OUTCOME_UNKNOWN' && !task.browserReport.providerFailure &&
    task.browserReport.lastAction?.outcome!=='unknown';
  return task.gatewayTarget?.adapter==='computer'&&task.computerReport?.status==='blocked'&&((task.computerReport.reason==='COMPUTER_USE_FAILED'&&task.computerReport.steps===0&&task.computerReport.evaluations===0)||/^THINKING_(?:HTTP_[0-9]{3}|[A-Z_]{1,64})$/.test(task.computerReport.reason)||['JEV_PROVIDER_UNAVAILABLE','JEV_DEADLINE_EXCEEDED','JEV_RATE_LIMITED','JEV_QUOTA_EXCEEDED','JEV_MODEL_UNAVAILABLE','JEV_AUTHENTICATION_FAILED','JEV_INVALID_CONFIG','JEV_DISABLED','JEV_QUEUE_FULL','LOW_CONFIDENCE','COMPLETION_NOT_ESTABLISHED','LOOP_CYCLE_BUDGET','TIMEOUT','NO_SUPPORTED_ACTION','ACTION_BUDGET','THINKING_WAITING_INPUT','THINKING_SCREENSHOT_REQUIRED','COMPUTER_SCREENSHOT_STALE','COMPUTER_SCREENSHOT_UNAVAILABLE','SCREEN_RECORDING_PERMISSION_REQUIRED','SCREENSHOT_CAPTURE_FAILED','SCREENSHOT_WINDOW_UNAVAILABLE','SCREENSHOT_SENSITIVE_CONTENT','SCREENSHOT_UNSUPPORTED','SCREENSHOT_TOO_LARGE','NATIVE_PROCESS_EXITED','NATIVE_REQUEST_TIMEOUT','NATIVE_START_FAILED','NATIVE_IO_ERROR','INVALID_NATIVE_RESPONSE','COMPUTER_ACCESS_DENIED','COMPUTER_ACCESS_STOPPED','COMPUTER_ACCESS_UNAVAILABLE','COMPUTER_ACCESS_TIMEOUT'].includes(task.computerReport.reason));
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
