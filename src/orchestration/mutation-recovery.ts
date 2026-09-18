/** Match only corrected spawn validation failures within one decision. No inference,
 * replay or authorization change: the later action must have actually committed. */
export interface MutationAttempt { actionId: string; tool: string; args: Record<string, unknown>; committed?: boolean; errorCode?: string; }
function spawnIdentity(a: Record<string, unknown>): string | undefined {
  if (typeof a.title !== 'string' || !a.title.trim()) return;
  // A continuation identifies existing work. For new work the brief must also
  // match exactly; a successful unrelated task cannot clear a rejected command.
  const continuation = typeof a.continue_task_id === 'string' && a.continue_task_id ? a.continue_task_id : null;
  if (!continuation && (typeof a.instructions !== 'string' || !a.instructions.trim())) return;
  return JSON.stringify([a.title, continuation, continuation ? null : a.instructions,
    a.continuation_policy ?? 'after_success', a.context_refs ?? []]);
}
export function unresolvedMutations(attempts: MutationAttempt[]): boolean {
  return attempts.some((attempt, index) => {
    if (attempt.committed) return false;
    if (attempt.tool !== 'task_spawn' || !['INVALID_INPUT','UNKNOWN_SKILL','ACKNOWLEDGEMENT_REQUIRED'].includes(attempt.errorCode ?? '')) return true;
    const identity = spawnIdentity(attempt.args);
    return !identity || !attempts.slice(index + 1).some(next => next.actionId !== attempt.actionId &&
      next.committed && next.tool === 'task_spawn' && spawnIdentity(next.args) === identity);
  });
}
