import { agentJitterMs } from '../../src/agent/dreaming';
import { resolveDreamingConfig, DREAMING_DEFAULTS } from '../../src/agent/dreaming/config';

describe('planning-68 — per-agent dream jitter', () => {
  it('JIT-1: window 0 → 0 (feature disabled)', () => {
    expect(agentJitterMs('claude-founder', 0)).toBe(0);
    expect(agentJitterMs('any-agent', -5)).toBe(0); // negative guarded to 0
  });

  it('JIT-2: same agentId → the SAME offset (deterministic, stable across reschedules)', () => {
    const a = agentJitterMs('claude-founder', 30);
    const b = agentJitterMs('claude-founder', 30);
    expect(a).toBe(b);
  });

  it('JIT-3: offset always within [0, window*60_000)', () => {
    const windowMs = 30 * 60_000;
    for (const id of ['a', 'claude-founder', 'gang-leader', 'iori', 'z'.repeat(64)]) {
      const j = agentJitterMs(id, 30);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(windowMs);
    }
  });

  it('JIT-4 (proven-red anchor): distinct agentIds spread — do NOT all collapse to one offset', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `agent-${i}`);
    const offsets = new Set(ids.map((id) => agentJitterMs(id, 30)));
    // A real hash spreads them; a neutralized jitter would put all 20 on one value.
    expect(offsets.size).toBeGreaterThan(10);
  });

  it('JIT-5: NaN / non-finite window → 0', () => {
    expect(agentJitterMs('x', Number.NaN)).toBe(0);
    expect(agentJitterMs('x', Infinity as unknown as number)).toBe(0);
  });
});

describe('planning-68 — staggerWindowMinutes config', () => {
  it('CFG-1: default is 30', () => {
    expect(DREAMING_DEFAULTS.staggerWindowMinutes).toBe(30);
    expect(resolveDreamingConfig().staggerWindowMinutes).toBe(30);
  });

  it('CFG-2: honored when in range; per-agent wins over global', () => {
    expect(resolveDreamingConfig({ staggerWindowMinutes: 0 }).staggerWindowMinutes).toBe(0);
    expect(
      resolveDreamingConfig({ staggerWindowMinutes: 10 }, { staggerWindowMinutes: 45 }).staggerWindowMinutes,
    ).toBe(10);
  });

  it('CFG-3: out-of-range (>55 or negative) falls back to the default', () => {
    expect(resolveDreamingConfig({ staggerWindowMinutes: 999 }).staggerWindowMinutes).toBe(30);
    expect(resolveDreamingConfig({ staggerWindowMinutes: -5 }).staggerWindowMinutes).toBe(30);
  });
});

describe('#351 — dreamMinute config', () => {
  it('MIN-1: default is 0', () => {
    expect(DREAMING_DEFAULTS.dreamMinute).toBe(0);
    expect(resolveDreamingConfig().dreamMinute).toBe(0);
  });

  it('MIN-2: honored 0..59; per-agent wins over global', () => {
    expect(resolveDreamingConfig({ dreamMinute: 30 }).dreamMinute).toBe(30);
    expect(resolveDreamingConfig({ dreamMinute: 59 }).dreamMinute).toBe(59);
    expect(resolveDreamingConfig({ dreamMinute: 15 }, { dreamMinute: 45 }).dreamMinute).toBe(15);
  });

  it('MIN-3: out-of-range / non-number falls back to 0 (no NaN scheduler)', () => {
    expect(resolveDreamingConfig({ dreamMinute: 60 }).dreamMinute).toBe(0);
    expect(resolveDreamingConfig({ dreamMinute: -1 }).dreamMinute).toBe(0);
    expect(resolveDreamingConfig({ dreamMinute: NaN }).dreamMinute).toBe(0);
    expect(resolveDreamingConfig({ dreamMinute: 'abc' as unknown as number }).dreamMinute).toBe(0);
  });
});
