import fs from 'fs';
import path from 'path';
import os from 'os';
import { syncSharedSkills } from '../../src/skills/sync';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sync-'));
}

function writeSharedSkill(sharedDir: string, name: string, content = `---\nname: ${name}\ndescription: "${name} skill"\n---\n# ${name}`): void {
  const skillDir = path.join(sharedDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
}

function readPersonalSkill(personalDir: string, name: string): string {
  return fs.readFileSync(path.join(personalDir, name, 'SKILL.md'), 'utf-8');
}

function hasMarker(personalDir: string, name: string): boolean {
  return fs.existsSync(path.join(personalDir, name, '.shared'));
}

describe('syncSharedSkills', () => {
  let sharedDir: string;
  let personalDir: string;

  beforeEach(() => {
    sharedDir = makeTmpDir();
    personalDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(sharedDir, { recursive: true, force: true });
    fs.rmSync(personalDir, { recursive: true, force: true });
  });

  // SS1: copies a new shared skill to personal dir
  it('SS1: copies new shared skill to personal dir', () => {
    writeSharedSkill(sharedDir, 'my-skill');
    syncSharedSkills(sharedDir, personalDir);

    expect(fs.existsSync(path.join(personalDir, 'my-skill', 'SKILL.md'))).toBe(true);
    expect(readPersonalSkill(personalDir, 'my-skill')).toContain('my-skill');
  });

  // SS2: writes .shared marker alongside synced SKILL.md
  it('SS2: writes .shared marker for each synced skill', () => {
    writeSharedSkill(sharedDir, 'foo');
    syncSharedSkills(sharedDir, personalDir);

    expect(hasMarker(personalDir, 'foo')).toBe(true);
  });

  // SS3: updates skill content when shared SKILL.md changes
  it('SS3: updates skill when content changes', () => {
    writeSharedSkill(sharedDir, 'bar', '---\nname: bar\ndescription: "v1"\n---\n# v1');
    syncSharedSkills(sharedDir, personalDir);
    expect(readPersonalSkill(personalDir, 'bar')).toContain('v1');

    // Update shared skill
    fs.writeFileSync(path.join(sharedDir, 'bar', 'SKILL.md'), '---\nname: bar\ndescription: "v2"\n---\n# v2', 'utf-8');
    syncSharedSkills(sharedDir, personalDir);
    expect(readPersonalSkill(personalDir, 'bar')).toContain('v2');
  });

  // SS4: removes stale skill from personal dir when deleted from shared
  it('SS4: removes stale synced skill from personal dir', () => {
    writeSharedSkill(sharedDir, 'to-delete');
    writeSharedSkill(sharedDir, 'keep');
    syncSharedSkills(sharedDir, personalDir);

    expect(fs.existsSync(path.join(personalDir, 'to-delete'))).toBe(true);

    // Remove from shared
    fs.rmSync(path.join(sharedDir, 'to-delete'), { recursive: true, force: true });
    syncSharedSkills(sharedDir, personalDir);

    expect(fs.existsSync(path.join(personalDir, 'to-delete'))).toBe(false);
    expect(fs.existsSync(path.join(personalDir, 'keep', 'SKILL.md'))).toBe(true);
  });

  // SS5: does NOT remove skills in personal dir without .shared marker (user-created)
  it('SS5: does not remove user-created skills (no .shared marker)', () => {
    // Create a user-owned skill in personal dir (no .shared marker)
    const userSkillDir = path.join(personalDir, 'user-skill');
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), '# user owned', 'utf-8');

    // sharedDir has no skills
    syncSharedSkills(sharedDir, personalDir);

    // User-owned skill must survive
    expect(fs.existsSync(path.join(personalDir, 'user-skill', 'SKILL.md'))).toBe(true);
  });

  // SS6: does not rewrite file when content is unchanged (mtime stability)
  it('SS6: does not overwrite file when content unchanged', () => {
    writeSharedSkill(sharedDir, 'stable');
    syncSharedSkills(sharedDir, personalDir);

    const destFile = path.join(personalDir, 'stable', 'SKILL.md');
    const mtimeBefore = fs.statSync(destFile).mtimeMs;

    // Sync again with same content
    syncSharedSkills(sharedDir, personalDir);
    const mtimeAfter = fs.statSync(destFile).mtimeMs;

    expect(mtimeAfter).toBe(mtimeBefore);
  });

  // SS7: handles non-existent sharedSkillsDir gracefully (no crash)
  it('SS7: handles missing sharedSkillsDir gracefully', () => {
    const missing = path.join(os.tmpdir(), 'does-not-exist-' + Date.now());
    expect(() => syncSharedSkills(missing, personalDir)).not.toThrow();
  });

  // SS8: syncs multiple skills in one pass
  it('SS8: syncs multiple skills', () => {
    writeSharedSkill(sharedDir, 'alpha');
    writeSharedSkill(sharedDir, 'beta');
    writeSharedSkill(sharedDir, 'gamma');
    syncSharedSkills(sharedDir, personalDir);

    expect(fs.existsSync(path.join(personalDir, 'alpha', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(personalDir, 'beta', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(personalDir, 'gamma', 'SKILL.md'))).toBe(true);
  });
});
