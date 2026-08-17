import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../../src/history/db';
import { intentHash, signalsFromTurns, startOfDayMs } from '../../../src/agent/skill-learning/telemetry';

function freshDb(): { db: HistoryDB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-telemetry-'));
  return { db: HistoryDB.forAgent(dir, 'agent-x'), dir };
}

const turn = (over: Partial<Parameters<HistoryDB['insertTurnMetric']>[0]> = {}) => ({
  sessionId: 's1',
  turnIdx: 0,
  ts: 1000,
  toolCalls: 3,
  durationMs: 500,
  tokensIn: 100,
  tokensOut: 50,
  recoveryFired: 0,
  skillsLoaded: null,
  intentHash: 'kw:x',
  enabled: 1,
  ...over,
});

describe('HistoryDB turn_metrics', () => {
  it('round-trips a row with the right shape', () => {
    const { db, dir } = freshDb();
    db.insertTurnMetric(turn({ toolCalls: 7, skillsLoaded: JSON.stringify(['a']) }));
    const rows = db.getTurnMetricsForSession('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolCalls: 7, tokensIn: 100, tokensOut: 50, enabled: 1, skillsLoaded: '["a"]' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('listTurnMetrics filters by since-ts', () => {
    const { db, dir } = freshDb();
    db.insertTurnMetric(turn({ ts: 100 }));
    db.insertTurnMetric(turn({ ts: 5000, turnIdx: 1 }));
    expect(db.listTurnMetrics(0)).toHaveLength(2);
    expect(db.listTurnMetrics(1000)).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('HistoryDB skill_stats', () => {
  it('recordSkillCreated + bumpSkillLoaded track provenance & usage', () => {
    const { db, dir } = freshDb();
    db.recordSkillCreated({ name: 'learned', origin: 'auto', createdAt: 10, createdFromSession: 's1', pinned: 0 });
    db.bumpSkillLoaded('learned', 20);
    db.bumpSkillLoaded('learned', 30);
    const s = db.getSkillStat('learned')!;
    expect(s.origin).toBe('auto');
    expect(s.timesLoaded).toBe(2);
    expect(s.lastUsedAt).toBe(30);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bumpSkillLoaded of an unknown skill upserts as user (never mis-tags auto)', () => {
    const { db, dir } = freshDb();
    db.bumpSkillLoaded('some-user-skill', 5);
    expect(db.getSkillStat('some-user-skill')!.origin).toBe('user');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('setSkillPinned + deleteSkillStat work', () => {
    const { db, dir } = freshDb();
    db.recordSkillCreated({ name: 'p', origin: 'auto', createdAt: 1, createdFromSession: 's', pinned: 0 });
    db.setSkillPinned('p', true);
    expect(db.getSkillStat('p')!.pinned).toBe(1);
    db.deleteSkillStat('p');
    expect(db.getSkillStat('p')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('HistoryDB skill_review_runs + retention', () => {
  it('counts + sums review runs and prunes telemetry by cutoff', () => {
    const { db, dir } = freshDb();
    db.insertReviewRun({ sessionId: 's', ts: 1000, triggerReason: 'tool-calls', outcome: 'create', tokensSpent: 200 });
    db.insertReviewRun({ sessionId: 's', ts: 5000, triggerReason: 'recovery', outcome: 'none', tokensSpent: 50 });
    expect(db.countReviewRunsSince(0)).toBe(2);
    expect(db.countReviewRunsSince(2000)).toBe(1);
    db.insertTurnMetric(turn({ ts: 100 }));
    db.insertTurnMetric(turn({ ts: 9000, turnIdx: 1 }));
    const removed = db.pruneTelemetry(2000); // drops the ts=100 turn + ts=1000 review
    expect(removed).toBe(2);
    expect(db.listTurnMetrics(0)).toHaveLength(1);
    expect(db.countReviewRunsSince(0)).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('telemetry helpers', () => {
  it('intentHash clusters slash-commands by command token', () => {
    expect(intentHash('/deploy prod now')).toBe('cmd:deploy');
    expect(intentHash('/deploy staging')).toBe('cmd:deploy');
  });
  it('intentHash makes a keyword signature for prose', () => {
    expect(intentHash('please fix the login bug')).toBe('kw:fix-login-bug');
  });
  it('intentHash → misc on empty', () => {
    expect(intentHash('   ')).toBe('misc');
  });
  it('signalsFromTurns folds max tool-calls + any recovery', () => {
    const s = signalsFromTurns([
      { ...turn({ toolCalls: 2 }) } as never,
      { ...turn({ toolCalls: 9, recoveryFired: 1 }) } as never,
    ]);
    expect(s.toolCalls).toBe(9);
    expect(s.recoveryFired).toBe(true);
  });
});

describe('startOfDayMs — timezone-correct daily window', () => {
  // 2026-08-16T20:00:00Z. In Asia/Bangkok (UTC+7) this is 2026-08-17T03:00 local,
  // so the local day is the 17th and its midnight is 2026-08-16T17:00:00Z.
  const now = Date.UTC(2026, 7, 16, 20, 0, 0);

  it('returns true LOCAL midnight for a +7 timezone (not UTC midnight)', () => {
    expect(startOfDayMs(now, 'Asia/Bangkok')).toBe(Date.UTC(2026, 7, 16, 17, 0, 0));
  });

  it('returns UTC midnight for UTC', () => {
    expect(startOfDayMs(now, 'UTC')).toBe(Date.UTC(2026, 7, 16, 0, 0, 0));
  });

  it('is always <= now and within the last 24h', () => {
    for (const tz of ['Asia/Bangkok', 'UTC', 'America/New_York']) {
      const s = startOfDayMs(now, tz);
      expect(s).toBeLessThanOrEqual(now);
      expect(now - s).toBeLessThan(24 * 60 * 60 * 1000);
    }
  });
});
