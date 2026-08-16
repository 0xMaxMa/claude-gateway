import { shouldReview } from '../../../src/agent/skill-learning/trigger';
import { SKILL_LEARNING_DEFAULTS } from '../../../src/agent/skill-learning/config';
import type { ResolvedSkillLearningCfg, SessionSignals, DailyBudget } from '../../../src/agent/skill-learning/types';

const cfg = (over: Partial<ResolvedSkillLearningCfg> = {}): ResolvedSkillLearningCfg => ({
  ...SKILL_LEARNING_DEFAULTS,
  ...over,
});
const sig = (over: Partial<SessionSignals> = {}): SessionSignals => ({
  toolCalls: 0,
  recoveryFired: false,
  userCorrection: false,
  ...over,
});
const budget = (over: Partial<DailyBudget> = {}): DailyBudget => ({ spent: 0, cap: 20, ...over });

describe('skill-learning trigger.shouldReview', () => {
  it('fires on tool-calls >= minToolCalls (reason tool-calls)', () => {
    expect(shouldReview(sig({ toolCalls: 5 }), cfg({ minToolCalls: 5 }), budget())).toEqual({
      review: true,
      reason: 'tool-calls',
    });
  });

  it('does NOT fire just below the minToolCalls boundary', () => {
    expect(shouldReview(sig({ toolCalls: 4 }), cfg({ minToolCalls: 5 }), budget())).toEqual({
      review: false,
      reason: null,
    });
  });

  it('fires on recovery when reviewOnError implied (recovery signal)', () => {
    expect(shouldReview(sig({ recoveryFired: true }), cfg({ minToolCalls: 99 }), budget())).toEqual({
      review: true,
      reason: 'recovery',
    });
  });

  it('fires on user-correction', () => {
    expect(shouldReview(sig({ userCorrection: true }), cfg({ minToolCalls: 99 }), budget())).toEqual({
      review: true,
      reason: 'user-correction',
    });
  });

  it('tool-calls reason wins over recovery + correction (deterministic priority)', () => {
    expect(
      shouldReview(sig({ toolCalls: 10, recoveryFired: true, userCorrection: true }), cfg({ minToolCalls: 5 }), budget()),
    ).toEqual({ review: true, reason: 'tool-calls' });
  });

  it('disabled config blocks everything', () => {
    expect(shouldReview(sig({ toolCalls: 100, recoveryFired: true }), cfg({ enabled: false }), budget())).toEqual({
      review: false,
      reason: null,
    });
  });

  it('daily cap exhausted blocks review', () => {
    expect(shouldReview(sig({ toolCalls: 100 }), cfg({ minToolCalls: 5 }), budget({ spent: 20, cap: 20 }))).toEqual({
      review: false,
      reason: null,
    });
  });

  it('cap <= 0 disables reviewing entirely', () => {
    expect(shouldReview(sig({ toolCalls: 100 }), cfg({ minToolCalls: 5 }), budget({ spent: 0, cap: 0 }))).toEqual({
      review: false,
      reason: null,
    });
  });

  it('no signal qualifies → no review', () => {
    expect(shouldReview(sig({ toolCalls: 1 }), cfg({ minToolCalls: 5 }), budget())).toEqual({
      review: false,
      reason: null,
    });
  });
});
