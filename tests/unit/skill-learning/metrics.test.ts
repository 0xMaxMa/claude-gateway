import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../../src/history/db';
import { computeRollup } from '../../../src/agent/skill-learning/metrics';

function freshDb(): { db: HistoryDB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-metrics-'));
  return { db: HistoryDB.forAgent(dir, `agent-${Math.random().toString(36).slice(2)}`), dir };
}

const t = (over: Partial<Parameters<HistoryDB['insertTurnMetric']>[0]>) => ({
  sessionId: 's', turnIdx: 0, ts: 1000, toolCalls: 0, durationMs: 0, tokensIn: 0, tokensOut: 0,
  recoveryFired: 0, skillsLoaded: null, intentHash: 'kw:x', enabled: 1, ...over,
});

describe('metrics.computeRollup', () => {
  it('adoption funnel counts stickiness (>=3 uses) among auto skills', () => {
    const { db, dir } = freshDb();
    db.recordSkillCreated({ name: 'sticky', origin: 'auto', createdAt: 1, createdFromSession: 's', pinned: 0 });
    for (let i = 0; i < 3; i++) db.bumpSkillLoaded('sticky', 10);
    db.recordSkillCreated({ name: 'noise', origin: 'auto', createdAt: 1, createdFromSession: 's', pinned: 0 });
    const r = computeRollup(db, 'a', 9999);
    expect(r.adoption.autoSkills).toBe(2);
    expect(r.adoption.loadedAtLeast3).toBe(1);
    expect(r.adoption.stickyPct).toBe(50);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cohort A/B splits turns by the enabled column', () => {
    const { db, dir } = freshDb();
    db.insertTurnMetric(t({ enabled: 1, toolCalls: 3 }));
    db.insertTurnMetric(t({ enabled: 1, toolCalls: 5, turnIdx: 1 }));
    db.insertTurnMetric(t({ enabled: 0, toolCalls: 9, turnIdx: 2 }));
    const r = computeRollup(db, 'a', 9999);
    expect(r.cohort.enabledTurns).toBe(2);
    expect(r.cohort.disabledTurns).toBe(1);
    expect(r.cohort.disabledMedianToolCalls).toBe(9);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('net-token ledger = saved(by-reuse) - spent(reviewing)', () => {
    const { db, dir } = freshDb();
    // cluster kw:x: a "before" turn (no skill) costs 100 tokens; an "after" turn (skill loaded) costs 40 → saved 60
    db.insertTurnMetric(t({ intentHash: 'kw:x', tokensIn: 100, tokensOut: 0, skillsLoaded: null }));
    db.insertTurnMetric(t({ intentHash: 'kw:x', tokensIn: 40, tokensOut: 0, skillsLoaded: JSON.stringify(['s']), turnIdx: 1 }));
    db.insertReviewRun({ sessionId: 's', ts: 1, triggerReason: 'tool-calls', outcome: 'create', tokensSpent: 25 });
    const r = computeRollup(db, 'a', 9999);
    expect(r.netTokens.savedByReuse).toBe(60);
    expect(r.netTokens.spentReviewing).toBe(25);
    expect(r.netTokens.net).toBe(35);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('empty store yields a well-formed zeroed rollup with null (not 0) medians', () => {
    const { db, dir } = freshDb();
    const r = computeRollup(db, 'a', 123);
    expect(r.adoption.autoSkills).toBe(0);
    expect(r.adoption.stickyPct).toBe(0);
    expect(r.netTokens.net).toBe(0);
    expect(r.generatedAt).toBe(123);
    // No turns ⇒ medians are null (distinct from a measured 0), so a consumer
    // never reads "skills cut cost to zero" from an empty baseline.
    expect(r.costDelta.medianTokensBefore).toBeNull();
    expect(r.costDelta.medianTokensAfter).toBeNull();
    expect(r.costDelta.medianToolCallsBefore).toBeNull();
    expect(r.cohort.enabledMedianToolCalls).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a populated cohort still reports a numeric (non-null) median', () => {
    const { db, dir } = freshDb();
    db.insertTurnMetric(t({ enabled: 1, toolCalls: 4, skillsLoaded: JSON.stringify(['s']) }));
    const r = computeRollup(db, 'a', 9999);
    expect(r.costDelta.medianToolCallsAfter).toBe(4); // has data ⇒ number, not null
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
