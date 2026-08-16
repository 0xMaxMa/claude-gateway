/**
 * Trigger gating — the pure decision of whether a finished session qualifies
 * for a background skill-learning review. No I/O; fully unit-testable.
 *
 * Gate order (planning-62 Component 2): enabled → daily budget → rules.
 * Any rule true ⇒ review, unless disabled or the daily cap is spent.
 */

import type {
  ResolvedSkillLearningCfg,
  SessionSignals,
  DailyBudget,
  TriggerDecision,
} from './types';

/**
 * Decide whether to run the reviewer for a session.
 *
 * Rules (any true ⇒ review):
 *   - sig.toolCalls >= cfg.minToolCalls
 *   - sig.recoveryFired            (error-recovery signal)
 *   - sig.userCorrection           (user-correction heuristic)
 *
 * Short-circuits, in order:
 *   1. cfg.enabled === false        ⇒ never review
 *   2. budget.cap <= 0              ⇒ reviewing disabled
 *   3. budget.spent >= budget.cap   ⇒ daily cap exhausted
 */
export function shouldReview(
  sig: SessionSignals,
  cfg: ResolvedSkillLearningCfg,
  budget: DailyBudget,
): TriggerDecision {
  const none: TriggerDecision = { review: false, reason: null };

  if (!cfg.enabled) return none;
  if (budget.cap <= 0) return none;
  if (budget.spent >= budget.cap) return none;

  // Rules — first matching reason wins (deterministic priority: tool-calls > recovery > correction).
  if (cfg.minToolCalls > 0 && sig.toolCalls >= cfg.minToolCalls) {
    return { review: true, reason: 'tool-calls' };
  }
  if (sig.recoveryFired) {
    return { review: true, reason: 'recovery' };
  }
  if (sig.userCorrection) {
    return { review: true, reason: 'user-correction' };
  }

  return none;
}
