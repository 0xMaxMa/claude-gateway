import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../../src/history/db';
import { curateOnce, TELEMETRY_RETENTION_DAYS } from '../../../src/agent/skill-learning/curator';
import { SKILL_LEARNING_DEFAULTS } from '../../../src/agent/skill-learning/config';
import type { ResolvedSkillLearningCfg } from '../../../src/agent/skill-learning/types';

const DAY = 24 * 60 * 60 * 1000;

function setup(): { db: HistoryDB; ws: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-curator-'));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(path.join(ws, 'skills'), { recursive: true });
  return { db: HistoryDB.forAgent(dir, `agent-${Math.random().toString(36).slice(2)}`), ws, dir };
}

function seedSkill(db: HistoryDB, ws: string, name: string, opts: { origin: 'auto' | 'user'; createdAt: number; timesLoaded: number; lastUsedAt?: number; pinned?: boolean }): void {
  fs.mkdirSync(path.join(ws, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(ws, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: "x"\norigin: ${opts.origin}\n---\nbody\n`, 'utf-8');
  db.recordSkillCreated({ name, origin: opts.origin, createdAt: opts.createdAt, createdFromSession: 's', pinned: opts.pinned ? 1 : 0 });
  for (let i = 0; i < opts.timesLoaded; i++) db.bumpSkillLoaded(name, opts.lastUsedAt ?? opts.createdAt);
}

const cfg = (over: Partial<ResolvedSkillLearningCfg> = {}): ResolvedSkillLearningCfg => ({ ...SKILL_LEARNING_DEFAULTS, ...over });
const exists = (ws: string, name: string) => fs.existsSync(path.join(ws, 'skills', name, 'SKILL.md'));

describe('curator.curateOnce', () => {
  it('prunes an auto skill that is BOTH unused and stale', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    seedSkill(db, ws, 'stale', { origin: 'auto', createdAt: now - 45 * DAY, timesLoaded: 0 }); // old + unused
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).toContain('stale');
    expect(exists(ws, 'stale')).toBe(false);
    expect(db.getSkillStat('stale')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps an auto skill that is old but USED (not both conditions)', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    seedSkill(db, ws, 'used', { origin: 'auto', createdAt: now - 45 * DAY, timesLoaded: 5 });
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).not.toContain('used');
    expect(exists(ws, 'used')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a young unused skill (stale condition false)', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    seedSkill(db, ws, 'young', { origin: 'auto', createdAt: now - 5 * DAY, timesLoaded: 0 });
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).not.toContain('young');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('NEVER prunes a non-auto (user) skill, even if unused + stale', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    seedSkill(db, ws, 'handcraft', { origin: 'user', createdAt: now - 100 * DAY, timesLoaded: 0 });
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).not.toContain('handcraft');
    expect(exists(ws, 'handcraft')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('NEVER prunes a pinned auto skill', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    seedSkill(db, ws, 'pinned', { origin: 'auto', createdAt: now - 100 * DAY, timesLoaded: 0, pinned: true });
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).not.toContain('pinned');
    expect(exists(ws, 'pinned')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('enforces maxAutoSkills cap by evicting least-recently-used', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    // all young + used (survive stale-prune), so only the cap applies
    seedSkill(db, ws, 'a1', { origin: 'auto', createdAt: now, timesLoaded: 5, lastUsedAt: now - 3 * DAY });
    seedSkill(db, ws, 'a2', { origin: 'auto', createdAt: now, timesLoaded: 5, lastUsedAt: now - 1 * DAY });
    seedSkill(db, ws, 'a3', { origin: 'auto', createdAt: now, timesLoaded: 5, lastUsedAt: now - 10 * DAY }); // oldest use
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ maxAutoSkills: 2, minUsesToKeep: 2, maxAgeDays: 0 }), now });
    expect(r.evicted).toEqual(['a3']); // LRU
    expect(exists(ws, 'a3')).toBe(false);
    expect(exists(ws, 'a1')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('NEVER deletes an ADOPTED skill (stat row says auto, on-disk origin flipped to user)', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    // Auto skill the user later adopted: stat row still origin=auto, but the
    // on-disk SKILL.md was edited to origin:user. It is stale + unused.
    fs.mkdirSync(path.join(ws, 'skills', 'adopted'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'skills', 'adopted', 'SKILL.md'), '---\nname: adopted\ndescription: "x"\norigin: user\n---\nbody\n', 'utf-8');
    db.recordSkillCreated({ name: 'adopted', origin: 'auto', createdAt: now - 45 * DAY, createdFromSession: 's', pinned: 0 });

    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).not.toContain('adopted');
    expect(exists(ws, 'adopted')).toBe(true); // user's file survives
    expect(db.getSkillStat('adopted')).toBeNull(); // stale stat row dropped
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cap eviction does NOT evict a brand-new never-used skill before an old used one', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    seedSkill(db, ws, 'newbie', { origin: 'auto', createdAt: now, timesLoaded: 0 }); // never used, just created
    seedSkill(db, ws, 'veteran', { origin: 'auto', createdAt: now - 50 * DAY, timesLoaded: 1, lastUsedAt: now - 50 * DAY });
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ maxAutoSkills: 1, minUsesToKeep: 0, maxAgeDays: 0 }), now });
    expect(r.evicted).toEqual(['veteran']); // old-used evicted, new one kept
    expect(exists(ws, 'newbie')).toBe(true);
    expect(exists(ws, 'veteran')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('disabled: no skill prune, but telemetry retention still runs', () => {
    const { db, ws, dir } = setup();
    const now = 200 * DAY;
    seedSkill(db, ws, 'stale', { origin: 'auto', createdAt: now - 45 * DAY, timesLoaded: 0 });
    db.insertTurnMetric({ sessionId: 's', turnIdx: 0, ts: now - (TELEMETRY_RETENTION_DAYS + 10) * DAY, toolCalls: 1, durationMs: 0, tokensIn: 0, tokensOut: 0, recoveryFired: 0, skillsLoaded: null, intentHash: 'x', enabled: 0 });
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ enabled: false, minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).toEqual([]); // no skill prune when disabled
    expect(exists(ws, 'stale')).toBe(true);
    expect(r.telemetryRowsRemoved).toBe(1); // old turn row pruned regardless
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
