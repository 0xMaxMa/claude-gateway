import {
  resolveSkillLearningConfig,
  isValidTimezone,
  SKILL_LEARNING_DEFAULTS,
} from '../../../src/agent/skill-learning/config';

describe('resolveSkillLearningConfig — precedence (agent > global > default)', () => {
  it('returns built-in defaults when nothing is set', () => {
    expect(resolveSkillLearningConfig(undefined, undefined)).toEqual(SKILL_LEARNING_DEFAULTS);
    expect(resolveSkillLearningConfig()).toEqual(SKILL_LEARNING_DEFAULTS);
  });

  it('global overrides defaults', () => {
    const r = resolveSkillLearningConfig(undefined, { enabled: false, minToolCalls: 8 });
    expect(r.enabled).toBe(false);
    expect(r.minToolCalls).toBe(8);
    expect(r.mode).toBe('auto'); // untouched default
  });

  it('agent override wins over global', () => {
    const r = resolveSkillLearningConfig({ enabled: true, mode: 'propose' }, { enabled: false, mode: 'auto' });
    expect(r.enabled).toBe(true);
    expect(r.mode).toBe('propose');
  });

  it('a false agent value is honored (not treated as unset)', () => {
    const r = resolveSkillLearningConfig({ enabled: false }, { enabled: true });
    expect(r.enabled).toBe(false);
  });

  it('mixes agent + global + default per-field', () => {
    const r = resolveSkillLearningConfig({ minToolCalls: 3 }, { maxAutoSkills: 10 });
    expect(r.minToolCalls).toBe(3); // agent
    expect(r.maxAutoSkills).toBe(10); // global
    expect(r.pruneHour).toBe(SKILL_LEARNING_DEFAULTS.pruneHour); // default
  });

  it('notify defaults true and honors a false override at either level', () => {
    expect(resolveSkillLearningConfig().notify).toBe(true);
    expect(resolveSkillLearningConfig({ notify: false }, { notify: true }).notify).toBe(false); // agent wins
    expect(resolveSkillLearningConfig(undefined, { notify: false }).notify).toBe(false); // global
  });

  it('normalizes an invalid pruneTimezone to UTC (never passes garbage to consumers)', () => {
    expect(resolveSkillLearningConfig({ pruneTimezone: 'Not/AZone' }).pruneTimezone).toBe('UTC');
    expect(resolveSkillLearningConfig(undefined, { pruneTimezone: '' }).pruneTimezone).toBe('UTC');
    expect(resolveSkillLearningConfig({ pruneTimezone: 'Asia/Bangkok' }).pruneTimezone).toBe('Asia/Bangkok'); // valid preserved
  });

  it('gateway.timezone is the shared fallback when neither override sets pruneTimezone (issue #462)', () => {
    expect(resolveSkillLearningConfig(undefined, undefined, 'Asia/Bangkok').pruneTimezone).toBe('Asia/Bangkok');
  });

  it('a per-feature pruneTimezone (agent or global) still wins over gateway.timezone', () => {
    expect(resolveSkillLearningConfig({ pruneTimezone: 'America/New_York' }, undefined, 'Asia/Bangkok').pruneTimezone).toBe(
      'America/New_York',
    );
    expect(resolveSkillLearningConfig(undefined, { pruneTimezone: 'Europe/London' }, 'Asia/Bangkok').pruneTimezone).toBe(
      'Europe/London',
    );
  });

  it('an invalid gateway.timezone falls back to UTC, not to the invalid string', () => {
    expect(resolveSkillLearningConfig(undefined, undefined, 'Not/AZone').pruneTimezone).toBe('UTC');
  });

  it('an invalid per-feature pruneTimezone falls through to gateway.timezone, not straight to UTC', () => {
    expect(resolveSkillLearningConfig({ pruneTimezone: 'Not/AZone' }, undefined, 'Asia/Bangkok').pruneTimezone).toBe(
      'Asia/Bangkok',
    );
    expect(resolveSkillLearningConfig(undefined, { pruneTimezone: 'Not/AZone' }, 'Asia/Bangkok').pruneTimezone).toBe(
      'Asia/Bangkok',
    );
  });
});

describe('isValidTimezone', () => {
  it('accepts a real IANA zone', () => {
    expect(isValidTimezone('Asia/Bangkok')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });
  it('rejects garbage / empty / undefined', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(undefined)).toBe(false);
  });
});
