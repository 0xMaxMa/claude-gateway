import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../../src/history/db';
import { curateOnce, TELEMETRY_RETENTION_DAYS, ARCHIVE_DIRNAME, ARCHIVE_RETENTION_DAYS } from '../../../src/agent/skill-learning/curator';
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
  it('archives a pruned skill under skills/.archive/<date>/ instead of deleting it', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    seedSkill(db, ws, 'stale', { origin: 'auto', createdAt: now - 45 * DAY, timesLoaded: 0 });
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).toEqual(['stale']);
    expect(exists(ws, 'stale')).toBe(false);
    const archived = path.join(ws, 'skills', ARCHIVE_DIRNAME, new Date(now).toISOString().slice(0, 10), 'stale', 'SKILL.md');
    expect(fs.readFileSync(archived, 'utf-8')).toContain('origin: auto');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a skill archived twice on the same day keeps both copies', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    seedSkill(db, ws, 'dup', { origin: 'auto', createdAt: now - 45 * DAY, timesLoaded: 0 });
    curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    seedSkill(db, ws, 'dup', { origin: 'auto', createdAt: now - 45 * DAY, timesLoaded: 0 });
    curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now: now + 1 });
    const day = path.join(ws, 'skills', ARCHIVE_DIRNAME, new Date(now).toISOString().slice(0, 10));
    expect(fs.readdirSync(day).length).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('NEVER archives an auto skill pinned in its on-disk frontmatter', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    seedSkill(db, ws, 'fmpinned', { origin: 'auto', createdAt: now - 45 * DAY, timesLoaded: 0 });
    fs.writeFileSync(path.join(ws, 'skills', 'fmpinned', 'SKILL.md'), '---\nname: fmpinned\ndescription: "x"\norigin: auto\npinned: true\n---\nbody\n', 'utf-8');
    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).toEqual([]);
    expect(exists(ws, 'fmpinned')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('NEVER moves a directory without an origin:auto SKILL.md, or a symlinked one', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    // Stat row says auto, but the directory holds no SKILL.md (user content).
    fs.mkdirSync(path.join(ws, 'skills', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'skills', 'notes', 'keep.txt'), 'mine', 'utf-8');
    db.recordSkillCreated({ name: 'notes', origin: 'auto', createdAt: now - 45 * DAY, createdFromSession: 's', pinned: 0 });
    // Stat row says auto, but the directory is a symlink to a skill elsewhere.
    const outside = path.join(dir, 'outside', 'linked');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: linked\ndescription: "x"\norigin: auto\n---\nbody\n', 'utf-8');
    fs.symlinkSync(outside, path.join(ws, 'skills', 'linked'));
    db.recordSkillCreated({ name: 'linked', origin: 'auto', createdAt: now - 45 * DAY, createdFromSession: 's', pinned: 0 });

    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).toEqual([]);
    expect(fs.readFileSync(path.join(ws, 'skills', 'notes', 'keep.txt'), 'utf-8')).toBe('mine');
    expect(fs.lstatSync(path.join(ws, 'skills', 'linked')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(outside, 'SKILL.md'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('expires archive days older than the retention window, even when disabled', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    const archive = path.join(ws, 'skills', ARCHIVE_DIRNAME);
    const day = (offset: number) => new Date(now - offset * DAY).toISOString().slice(0, 10);
    for (const d of [day(ARCHIVE_RETENTION_DAYS + 1), day(ARCHIVE_RETENTION_DAYS - 1)]) {
      fs.mkdirSync(path.join(archive, d, 'old-skill'), { recursive: true });
    }
    fs.mkdirSync(path.join(archive, 'not-a-date'), { recursive: true });
    curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ enabled: false }), now });
    expect(fs.readdirSync(archive).sort()).toEqual([day(ARCHIVE_RETENTION_DAYS - 1), 'not-a-date'].sort());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('NEVER follows a symlinked skills/.archive out of the workspace (no move, no expiry)', () => {
    const { db, ws, dir } = setup();
    const now = 100 * DAY;
    const outside = path.join(dir, 'outside-archive');
    const oldDay = new Date(now - (ARCHIVE_RETENTION_DAYS + 1) * DAY).toISOString().slice(0, 10);
    fs.mkdirSync(path.join(outside, oldDay), { recursive: true });
    fs.symlinkSync(outside, path.join(ws, 'skills', ARCHIVE_DIRNAME));
    seedSkill(db, ws, 'stale', { origin: 'auto', createdAt: now - 45 * DAY, timesLoaded: 0 });

    const r = curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ minUsesToKeep: 2, maxAgeDays: 30 }), now });
    expect(r.pruned).toEqual([]);
    expect(exists(ws, 'stale')).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([oldDay]);
    expect(db.getSkillStat('stale')).not.toBeNull(); // retried once the archive is a real dir
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps an archive day for the full retention window, measured from the end of that UTC day', () => {
    const { db, ws, dir } = setup();
    const archivedAt = 100 * DAY + DAY - 60_000; // 23:59 UTC
    const day = new Date(archivedAt).toISOString().slice(0, 10);
    const archive = path.join(ws, 'skills', ARCHIVE_DIRNAME);
    fs.mkdirSync(path.join(archive, day, 's'), { recursive: true });
    curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ enabled: false }), now: archivedAt + ARCHIVE_RETENTION_DAYS * DAY - 1 });
    expect(fs.existsSync(path.join(archive, day))).toBe(true);
    curateOnce({ db, workspaceDir: ws, agentId: 'a', cfg: cfg({ enabled: false }), now: 101 * DAY + ARCHIVE_RETENTION_DAYS * DAY + 1 });
    expect(fs.existsSync(path.join(archive, day))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
