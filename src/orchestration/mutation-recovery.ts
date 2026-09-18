/** Match recovered mutations within one decision. This only controls reporting;
 * authorization and admission still run before any command can commit. */
export interface MutationAttempt { actionId: string; tool: string; args: Record<string, unknown>; committed?: boolean; errorCode?: string; intendedUpdateTaskId?: string; }
export function retryableMutation(tool: string, code?: string): boolean {
  return tool === 'task_spawn' ? ['INVALID_INPUT','UNKNOWN_SKILL','ACKNOWLEDGEMENT_REQUIRED'].includes(code ?? '')
    : tool === 'task_update' && ['INVALID_INPUT','REVISION_CONFLICT','ACKNOWLEDGEMENT_REQUIRED'].includes(code ?? '');
}
function updateIdentity(a: Record<string, unknown>): string | undefined {
  if (typeof a.task_id !== 'string' || !a.task_id || typeof a.instruction !== 'string' || !a.instruction.trim()) return;
  return JSON.stringify([a.task_id,a.instruction,a.mode]);
}
function spawnIdentity(a: Record<string, unknown>): string | undefined {
  if (typeof a.title !== 'string' || !a.title.trim()) return;
  // Titles and predecessor IDs do not identify a unique assignment. The brief
  // must match too unless the caller explicitly references the rejected action.
  const continuation = typeof a.continue_task_id === 'string' && a.continue_task_id ? a.continue_task_id : null;
  if (typeof a.instructions !== 'string' || !a.instructions.trim()) return;
  return JSON.stringify([a.title, continuation, a.instructions,
    a.continuation_policy ?? 'after_success', a.context_refs ?? []]);
}
export function unresolvedMutations(attempts: MutationAttempt[]): boolean {
  return attempts.some((attempt, index) => {
    if (attempt.committed) return false;
    // Update intake forbids spawning even a continuation of the selected task.
    // A later committed update of that exact task is the corrected operation.
    // Use the intake target captured at rejection, never a later intake choice.
    if (attempt.tool === 'task_spawn' && attempt.errorCode === 'INTAKE_TASK_MISMATCH' &&
        attempt.intendedUpdateTaskId && attempt.args.continue_task_id === attempt.intendedUpdateTaskId) {
      return !attempts.slice(index + 1).some(next => next.actionId !== attempt.actionId &&
        next.committed && next.tool === 'task_update' && next.args.task_id === attempt.intendedUpdateTaskId);
    }
    if (!retryableMutation(attempt.tool, attempt.errorCode)) return true;
    const identify = attempt.tool === 'task_update' ? updateIdentity : spawnIdentity;
    const identity = identify(attempt.args);
    // Invalid required fields cannot form an identity, but the bridge's explicit
    // retry reference still identifies the rejected command being corrected.
    return !attempts.slice(index + 1).some(next => next.actionId !== attempt.actionId &&
      next.committed && next.tool === attempt.tool &&
      (attempt.tool !== 'task_update' || !attempt.args.task_id || next.args.task_id === attempt.args.task_id) &&
      (next.args.retry_of === attempt.actionId || (identity !== undefined && identify(next.args) === identity)));
  });
}
