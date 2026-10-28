import fs from 'fs';
import os from 'os';
import path from 'path';
import { HistoryDB } from '../../../src/history/db';
import { curateOnce } from '../../../src/agent/skill-learning/curator';
import { SKILL_LEARNING_DEFAULTS } from '../../../src/agent/skill-learning/config';
import { loadWorkspace, workspaceRecomposer } from '../../../src/agent/workspace-loader';
import type { SkillRegistry } from '../../../src/skills/loader';
import { SkillLearningManager, skillLearningHostHooks, skillCatalogUsage } from '../../../src/agent/skill-learning';
const DAY = 86400000;
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'review614-fixture-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
    const ws = path.join(root, 'workspace');
    fs.mkdirSync(path.join(ws, 'skills', 'sample'), { recursive: true });
    for (const f of ['AGENTS.md', 'SOUL.md', 'USER.md'])
        fs.writeFileSync(path.join(ws, f), 'fixture');
    const file = path.join(ws, 'skills', 'sample', 'SKILL.md');
    const write = (pin?: boolean) => fs.writeFileSync(file, `---\nname: sample\ndescription: sample flow\norigin: auto\n${pin === undefined ? '' : `pinned: ${pin}\n`}---\nbody\n`);
    write(false);
    const db = HistoryDB.forDir(root, 'fixture');
    db.recordSkillCreated({ name: 'sample', origin: 'auto', createdAt: 0, createdFromSession: null, pinned: 0 });
    const sweep = (now: number) => curateOnce({ db, workspaceDir: ws, agentId: 'fixture', cfg: SKILL_LEARNING_DEFAULTS, now });
    return { ws, file, write, db, sweep };
}
test.each([false, undefined])('unpinning SKILL.md (%s) lets the curator prune a stale unused skill', (pin) => {
    const f = fixture();
    f.write(true);
    f.sweep(40 * DAY);
    expect(f.db.getSkillStat('sample')?.pinned).toBe(1);
    f.write(pin);
    expect(f.sweep(41 * DAY).pruned).toEqual(['sample']);
});
test('archive refuses a symlink at the day-directory level', () => {
    const f = fixture();
    const now = 40 * DAY;
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const archive = path.join(f.ws, 'skills', '.archive');
    fs.mkdirSync(archive);
    fs.symlinkSync(outside, path.join(archive, new Date(now).toISOString().slice(0, 10)));
    f.sweep(now);
    expect(fs.existsSync(path.join(outside, 'sample'))).toBe(false);
    expect(fs.existsSync(f.file)).toBe(true);
});
test.each([true, false])('daily sweep (enabled=%s) refreshes a menu when an unused skill crosses seven days without a file change', async (enabled) => {
    const f = fixture();
    let now = 6 * DAY;
    let registry: SkillRegistry = { skills: new Map() };
    const recompose = workspaceRecomposer(f.ws, () => loadWorkspace(f.ws, { skillUsage: skillCatalogUsage(f.db, now) }), u => { registry = u.skillRegistry!; });
    await recompose();
    const refreshMenu = jest.fn(async () => { await recompose(); });
    const manager = new SkillLearningManager({ db: f.db, workspaceDir: f.ws, agentId: 'fixture', now: () => now, globalCfg: { enabled }, ...skillLearningHostHooks({ registry: () => registry, discoverInstalled: async () => [], refreshMenu }) });
    now = 8 * DAY;
    manager.curateNow();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(refreshMenu).toHaveBeenCalledTimes(1);
    await refreshMenu.mock.results[0]!.value;
    expect(registry.hiddenUntilUsed?.has('sample')).toBe(true);
    expect(fs.readFileSync(path.join(f.ws, 'CLAUDE.md'), 'utf8')).not.toContain('/sample:');
});
test('the scheduled curator refreshes the catalog even with learning disabled', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const refreshMenu = jest.fn(async () => { });
    const manager = new SkillLearningManager({
        db: f.db, workspaceDir: f.ws, agentId: 'fixture', globalCfg: { enabled: false },
        ...skillLearningHostHooks({ registry: () => ({ skills: new Map() }), discoverInstalled: async () => [], refreshMenu }),
    });
    const stop = manager.startCurator();
    try {
        await jest.advanceTimersByTimeAsync(DAY);
        expect(refreshMenu).toHaveBeenCalledTimes(1);
    }
    finally {
        stop();
        jest.useRealTimers();
    }
});

test('R1 temporary symlink cannot overwrite an external file', () => {
    const f = fixture();
    const outside = path.join(root, 'external');
    fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, f.file + '.tmp');
    const { applyProposal } = require('../../../src/agent/skill-learning/writer');
    applyProposal({ action: 'create', name: 'sample', desc: 'flow', body: 'new' }, { workspaceDir: f.ws, sessionId: 's', now: 1, mode: 'auto', existing: [] });
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
});
test('R3 restored suffix uses invocation identity and preserves usage', () => {
    const f = fixture();
    fs.renameSync(path.dirname(f.file), path.dirname(f.file) + '-123');
    f.db.bumpSkillLoaded('sample', 40 * DAY);
    f.db.bumpSkillLoaded('sample', 40 * DAY);
    f.sweep(41 * DAY);
    expect(f.db.getSkillStat('sample-123')).toBeNull();
    expect(fs.existsSync(path.dirname(f.file) + '-123/SKILL.md')).toBe(true);
});
test.each(['missing', 'user'])('R4 %s rows do not evict valid skills', kind => {
    const f = fixture();
    f.db.recordSkillCreated({ name: 'ghost', origin: 'auto', createdAt: 100, createdFromSession: null, pinned: 0 });
    if (kind === 'user') {
        fs.mkdirSync(path.join(f.ws, 'skills/ghost'));
        fs.writeFileSync(path.join(f.ws, 'skills/ghost/SKILL.md'), '---\nname: ghost\ndescription: user\n---\nbody');
    }
    const r = curateOnce({ db: f.db, workspaceDir: f.ws, agentId: 'a', cfg: { ...SKILL_LEARNING_DEFAULTS, maxAgeDays: 0, maxAutoSkills: 1 }, now: 1000 });
    expect(r.evicted).toEqual([]);
    expect(fs.existsSync(f.file)).toBe(true);
});
test.each(['file', 'symlink', 'permission'])('R5 %s archive day failure still caps menu', async kind => {
    const f = fixture();
    const now = 1000;
    const day = path.join(f.ws, 'skills/.archive/1970-01-01');
    fs.mkdirSync(path.dirname(day));
    if (kind === 'file') fs.writeFileSync(day, 'blocked');
    if (kind === 'symlink') fs.symlinkSync(root, day);
    const spy = kind === 'permission' ? jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EACCES'); }) : undefined;
    fs.cpSync(path.dirname(f.file), path.join(f.ws, 'skills/second'), { recursive: true });
    fs.writeFileSync(path.join(f.ws, 'skills/second/SKILL.md'), fs.readFileSync(f.file, 'utf8').replace('name: sample', 'name: second'));
    const cfg = { ...SKILL_LEARNING_DEFAULTS, maxAgeDays: 0, maxAutoSkills: 1 };
    try { curateOnce({ db: f.db, workspaceDir: f.ws, agentId: 'a', cfg, now }); } finally { spy?.mockRestore(); }
    const u = await loadWorkspace(f.ws, { skillUsage: skillCatalogUsage(f.db, now, { workspaceDir: f.ws, cfg }) });
    expect(u.skillRegistry!.hiddenUntilUsed!.size).toBe(1);
});
test('R6 untracked auto skills count toward menu cap', async () => {
    const f = fixture();
    f.db.deleteSkillStat('sample');
    const u = await loadWorkspace(f.ws, { skillUsage: { stats: new Map(), now: 100, maxListedAutoSkills: 0 } });
    expect(u.skillRegistry!.hiddenUntilUsed!.has('sample')).toBe(true);
});
test('R7 failed refresh retries on next skill use', async () => {
    const registry: SkillRegistry = { skills: new Map(), hiddenUntilUsed: new Set(['sample']) };
    const refreshMenu = jest.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
    const hooks = skillLearningHostHooks({ registry: () => registry, refreshMenu, discoverInstalled: async () => [] });
    hooks.onSkillsLoaded(['sample']);
    await new Promise<void>(r => setImmediate(r));
    hooks.onSkillsLoaded(['sample']);
    await new Promise<void>(r => setImmediate(r));
    expect(refreshMenu).toHaveBeenCalledTimes(2);
});
