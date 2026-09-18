/** Match only corrected spawn validation failures within one decision. No inference,
 * replay or authorization change: the later action must have actually committed. */
export interface MutationAttempt { actionId: string; tool: string; args: Record<string, unknown>; committed?: boolean; errorCode?: string; }
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
    if (attempt.tool !== 'task_spawn' || !['INVALID_INPUT','UNKNOWN_SKILL','ACKNOWLEDGEMENT_REQUIRED'].includes(attempt.errorCode ?? '')) return true;
    const identity = spawnIdentity(attempt.args);
    // Invalid required fields cannot form an identity, but the bridge's explicit
    // retry reference still identifies the rejected command being corrected.
    return !attempts.slice(index + 1).some(next => next.actionId !== attempt.actionId &&
      next.committed && next.tool === 'task_spawn' && (next.args.retry_of === attempt.actionId ||
        (identity !== undefined && spawnIdentity(next.args) === identity)));
  });
}
