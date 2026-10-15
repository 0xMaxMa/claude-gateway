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
/** The agent's own goal run: its spawn text opens a session the user drives
 * (revision 1, no user command yet). Later revisions are the user's own commands. */
export function agentGoalRun(task: TaskSnapshot): boolean {
  return task.automationController==='user'&&task.revision===1&&task.executionControl?.revision!==1;
}
/** agentGoalRun as a trusted SQL fragment over a tasks row alias; a parity test keeps them equal. */
export const agentGoalRunSql=(alias:string)=>`(json_extract(${alias}.snapshot_json,'$.automationController')='user' AND json_extract(${alias}.snapshot_json,'$.revision')=1
  AND COALESCE(json_extract(${alias}.snapshot_json,'$.executionControl.revision'),0)!=1)`;
/** The agent's goal run ended in waiting_input after its step run, with no question
 * pending for the owner: every step ran, one had no visible effect, or one was not
 * executed (low confidence, unclear, an ambiguous or rejected target). The run is over
 * and the agent that spawned it owns the next move. A question the owner answers is
 * recorded on the task (a worker question, a missing field value, a high-impact
 * action awaiting yes or no); that and a user pause stay silent.
 * Pod-jinawong 2.0.20, task 7eebb836: all 4 steps ran and the video played, yet
 * waiting_input is not notified under user control, so the agent never answered. */
export function agentStepRunEnded(task: TaskSnapshot): boolean {
  const report=task.computerReport??task.browserReport;
  return agentGoalRun(task)&&task.state==='waiting_input'&&!task.activeAttemptId&&!task.pendingQuestion&&task.executionControl?.phase!=='paused'
    &&report?.reason==='COMMAND_WAITING_INPUT'&&!!report.stepRun&&!report.fieldRequest&&!task.computerReport?.lastAction?.confirm;
}
/** agentStepRunEnded as a trusted SQL fragment over a tasks row alias; a parity test keeps them equal.
 * Always 0 or 1: a NULL from a missing report field would turn NOT(...) in the mailbox NULL too. */
export const agentStepRunEndedSql=(alias:string)=>{
  const field=(path:string)=>`json_extract(${alias}.snapshot_json,'${path}')`;
  const report=`COALESCE(${field('$.computerReport')},${field('$.browserReport')})`;
  return `COALESCE((${agentGoalRunSql(alias)} AND ${alias}.state='waiting_input'
  AND ${field('$.activeAttemptId')} IS NULL AND ${field('$.pendingQuestion')} IS NULL AND COALESCE(${field('$.executionControl.phase')},'')!='paused'
  AND json_extract(${report},'$.reason')='COMMAND_WAITING_INPUT' AND json_extract(${report},'$.stepRun') IS NOT NULL
  AND json_extract(${report},'$.fieldRequest') IS NULL AND NOT COALESCE(${field('$.computerReport.lastAction.confirm')},0)),0)`;
};
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
