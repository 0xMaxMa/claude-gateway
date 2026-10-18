import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadSkills, renderSkillsSection, hiddenAutoSkills, AUTO_SKILL_MENU_DESC_MAX, AUTO_SKILL_CATALOG_GRACE_DAYS, type SkillRegistry } from '../../src/skills/loader';
import type { SkillDefinition } from '../../src/skills/parser';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-loader-'));
}

function writeSkill(dir: string, name: string, frontmatter: string, body = '# Instructions'): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`);
}

describe('Skill Loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadSkills', () => {
    it('L1: workspace skill overrides shared skill with same name', () => {
      const workspace = path.join(tmpDir, 'workspace');
      const shared = path.join(tmpDir, 'shared');
      fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
      fs.mkdirSync(shared, { recursive: true });

      writeSkill(path.join(workspace, 'skills'), 'github', 'name: github\ndescription: Workspace github');
      writeSkill(shared, 'github', 'name: github\ndescription: Shared github');

      const registry = loadSkills({
        workspaceDir: workspace,
        sharedSkillsDir: shared,
      });

      expect(registry.skills.size).toBe(1);
      const skill = registry.skills.get('github');
      expect(skill).toBeDefined();
      expect(skill!.description).toBe('Workspace github');
      expect(skill!.source).toBe('workspace');
    });

    it('L2: no skills directories returns empty registry', () => {
      const workspace = path.join(tmpDir, 'empty-workspace');
      fs.mkdirSync(workspace, { recursive: true });

      const registry = loadSkills({ workspaceDir: workspace });
      expect(registry.skills.size).toBe(0);
    });

    it('L3: module skills are prefixed with module name', () => {
      const workspace = path.join(tmpDir, 'workspace');
      const mcpTools = path.join(tmpDir, 'mcp', 'gateway', 'tools');
      fs.mkdirSync(workspace, { recursive: true });

      // Create telegram module with 2 skills
      const telegramSkills = path.join(mcpTools, 'telegram', 'skills');
      writeSkill(telegramSkills, 'access', 'name: access\ndescription: Manage Telegram access');
      writeSkill(telegramSkills, 'configure', 'name: configure\ndescription: Configure Telegram bot');

      const registry = loadSkills({
        workspaceDir: workspace,
        mcpToolsDir: mcpTools,
      });

      expect(registry.skills.size).toBe(2);
      expect(registry.skills.has('telegram:access')).toBe(true);
      expect(registry.skills.has('telegram:configure')).toBe(true);
      expect(registry.skills.get('telegram:access')!.modulePrefix).toBe('telegram');
    });

    it('L4: shared skills dir does not exist returns empty without crash', () => {
      const workspace = path.join(tmpDir, 'workspace');
      fs.mkdirSync(workspace, { recursive: true });

      const warnings: string[] = [];
      const registry = loadSkills({
        workspaceDir: workspace,
        sharedSkillsDir: '/nonexistent/shared-skills',
        logger: { warn: (msg: string) => warnings.push(msg) },
      });

      expect(registry.skills.size).toBe(0);
      // No crash, no error
    });

    it('loads skills from all three sources with correct priority', () => {
      const workspace = path.join(tmpDir, 'workspace');
      const mcpTools = path.join(tmpDir, 'mcp-tools');
      const shared = path.join(tmpDir, 'shared');
      fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });

      // Workspace skill
      writeSkill(path.join(workspace, 'skills'), 'my-skill', 'name: my-skill\ndescription: From workspace');
      // Module skill
      writeSkill(path.join(mcpTools, 'telegram', 'skills'), 'access', 'name: access\ndescription: Telegram access');
      // Shared skill
      writeSkill(shared, 'summarize', 'name: summarize\ndescription: Summarize text');

      const registry = loadSkills({
        workspaceDir: workspace,
        mcpToolsDir: mcpTools,
        sharedSkillsDir: shared,
      });

      expect(registry.skills.size).toBe(3);
      expect(registry.skills.get('my-skill')!.source).toBe('workspace');
      expect(registry.skills.get('telegram:access')!.source).toBe('module');
      expect(registry.skills.get('summarize')!.source).toBe('shared');
    });

    it('warns about missing binary dependencies', () => {
      const workspace = path.join(tmpDir, 'workspace');
      fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });

      writeSkill(
        path.join(workspace, 'skills'),
        'needs-bins',
        'name: needs-bins\ndescription: Needs binary\nmetadata:\n  openclaw:\n    requires:\n      bins: ["nonexistent-binary-xyz"]',
      );

      const warnings: string[] = [];
      loadSkills({
        workspaceDir: workspace,
        logger: { warn: (msg: string) => warnings.push(msg) },
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('nonexistent-binary-xyz');
    });

    it('skips hidden directories and node_modules', () => {
      const workspace = path.join(tmpDir, 'workspace');
      const skillsDir = path.join(workspace, 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });

      writeSkill(skillsDir, '.hidden-skill', 'name: hidden\ndescription: Should be hidden');
      writeSkill(skillsDir, 'node_modules', 'name: nm\ndescription: Should be skipped');
      writeSkill(skillsDir, 'valid-skill', 'name: valid-skill\ndescription: Valid skill');

      const registry = loadSkills({ workspaceDir: workspace });
      expect(registry.skills.size).toBe(1);
      expect(registry.skills.has('valid-skill')).toBe(true);
    });

    it('skips directories without SKILL.md', () => {
      const workspace = path.join(tmpDir, 'workspace');
      const skillsDir = path.join(workspace, 'skills');
      const emptySkillDir = path.join(skillsDir, 'empty-skill');
      fs.mkdirSync(emptySkillDir, { recursive: true });
      // No SKILL.md written

      const registry = loadSkills({ workspaceDir: workspace });
      expect(registry.skills.size).toBe(0);
    });

    it('skips SKILL.md with invalid frontmatter', () => {
      const workspace = path.join(tmpDir, 'workspace');
      const skillsDir = path.join(workspace, 'skills');
      const badDir = path.join(skillsDir, 'bad-skill');
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(path.join(badDir, 'SKILL.md'), 'No frontmatter here');

      const registry = loadSkills({ workspaceDir: workspace });
      expect(registry.skills.size).toBe(0);
    });
  });

  describe('renderSkillsSection', () => {
    function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
      return {
        name: 'test',
        description: 'Test skill',
        content: '',
        filePath: '/test/SKILL.md',
        source: 'workspace',
        userInvocable: true,
        ...overrides,
      };
    }

    it('S1: renders skills section when registry has skills', () => {
      const registry: SkillRegistry = {
        skills: new Map([
          ['github', makeSkill({ name: 'github', description: 'GitHub ops', emoji: '🐙', source: 'workspace' })],
          ['telegram:access', makeSkill({ name: 'access', description: 'Manage access', emoji: '🔒', source: 'module', modulePrefix: 'telegram' })],
          ['summarize', makeSkill({ name: 'summarize', description: 'Summarize text', emoji: '📋', source: 'shared' })],
        ]),
      };

      const section = renderSkillsSection(registry);
      expect(section).toContain('/github: GitHub ops [🐙]');
      expect(section).toContain('/telegram:access: Manage access [🔒]');
      expect(section).toContain('/summarize: Summarize text [📋]');
      expect(section).toContain('**Workspace Skills**');
      expect(section).toContain('**Module Skills**');
      expect(section).toContain('**Shared Skills**');
    });

    it('S2: returns empty string when registry is empty', () => {
      const registry: SkillRegistry = { skills: new Map() };
      expect(renderSkillsSection(registry)).toBe('');
    });

    it('S3: groups skills by source in correct sections', () => {
      const registry: SkillRegistry = {
        skills: new Map([
          ['ws-skill', makeSkill({ name: 'ws-skill', description: 'Workspace', source: 'workspace' })],
          ['mod:skill', makeSkill({ name: 'skill', description: 'Module', source: 'module', modulePrefix: 'mod' })],
        ]),
      };

      const section = renderSkillsSection(registry);
      const wsIdx = section.indexOf('**Workspace Skills**');
      const modIdx = section.indexOf('**Module Skills**');
      expect(wsIdx).toBeGreaterThan(-1);
      expect(modIdx).toBeGreaterThan(-1);
      expect(wsIdx).toBeLessThan(modIdx);
      expect(section).not.toContain('**Shared Skills**');
    });

    it('excludes skills with userInvocable: false', () => {
      const registry: SkillRegistry = {
        skills: new Map([
          ['visible', makeSkill({ name: 'visible', description: 'Visible', userInvocable: true })],
          ['hidden', makeSkill({ name: 'hidden', description: 'Hidden', userInvocable: false })],
        ]),
      };

      const section = renderSkillsSection(registry);
      expect(section).toContain('/visible');
      expect(section).not.toContain('/hidden');
    });

    describe('progressive disclosure — auto-learned skills (planning-62)', () => {
      const autoFM = (desc: string) => `---\nname: x\ndescription: "${desc}"\norigin: auto\n---\n\nbody`;
      const humanFM = (desc: string) => `---\nname: x\ndescription: "${desc}"\n---\n\nbody`;
      const longDesc = 'A'.repeat(200);

      function lineFor(section: string, key: string): string {
        return section.split('\n').find((l) => l.startsWith(`/${key}:`)) ?? '';
      }

      it('truncates a long auto (origin:auto) workspace skill description to the cap', () => {
        const registry: SkillRegistry = {
          skills: new Map([
            ['auto-skill', makeSkill({ name: 'auto-skill', description: longDesc, source: 'workspace', content: autoFM(longDesc) })],
          ]),
        };
        const line = lineFor(renderSkillsSection(registry), 'auto-skill');
        expect(line).toContain('…');
        expect(line.length).toBeLessThan(longDesc.length);
        const body = line.slice('/auto-skill: '.length).replace(/…$/, '');
        expect(body.length).toBeLessThanOrEqual(AUTO_SKILL_MENU_DESC_MAX);
      });

      it('does NOT truncate a human workspace skill even with a long description', () => {
        const registry: SkillRegistry = {
          skills: new Map([
            ['human-skill', makeSkill({ name: 'human-skill', description: longDesc, source: 'workspace', content: humanFM(longDesc) })],
          ]),
        };
        expect(renderSkillsSection(registry)).toContain(`/human-skill: ${longDesc}`);
      });

      it('leaves a short auto description unchanged (no ellipsis)', () => {
        const registry: SkillRegistry = {
          skills: new Map([
            ['auto-skill', makeSkill({ name: 'auto-skill', description: 'quick runbook', source: 'workspace', content: autoFM('quick runbook') })],
          ]),
        };
        const section = renderSkillsSection(registry);
        expect(section).toContain('/auto-skill: quick runbook');
        expect(section).not.toContain('…');
      });

      it('never truncates module/shared skills (auto provenance is workspace-only)', () => {
        const registry: SkillRegistry = {
          skills: new Map([
            ['mod:auto', makeSkill({ name: 'auto', description: longDesc, source: 'module', modulePrefix: 'mod', content: autoFM(longDesc) })],
          ]),
        };
        expect(renderSkillsSection(registry)).toContain(`/mod:auto: ${longDesc}`);
      });
    });

    describe('hide-until-used — never-loaded auto skills stay out of the catalog', () => {
      const DAY = 24 * 60 * 60 * 1000;
      const now = 1000 * DAY;
      const old = now - (AUTO_SKILL_CATALOG_GRACE_DAYS + 1) * DAY;
      const fm = (extra: string) => `---\nname: x\ndescription: "d"\n${extra}\n---\n\nbody`;
      const ws = (name: string, content: string, source: SkillDefinition['source'] = 'workspace') =>
        [name, makeSkill({ name, description: 'd', source, content })] as const;
      const registry: SkillRegistry = {
        skills: new Map([
          ws('auto-unused', fm(`origin: auto\ncreatedAt: ${old}`)),
          ws('auto-used', fm(`origin: auto\ncreatedAt: ${old}`)),
          ws('auto-young', fm(`origin: auto\ncreatedAt: ${now - DAY}`)),
          ws('auto-pinned', fm(`origin: auto\ncreatedAt: ${old}\npinned: true`)),
          ws('auto-no-date', fm('origin: auto')),
          ws('user-unused', fm(`createdAt: ${old}`)),
          ws('shared-unused', fm(`origin: auto\ncreatedAt: ${old}`), 'shared'),
        ]),
      };
      const stat = (createdAt: number | null, timesLoaded = 0) => ({ createdAt, timesLoaded, lastUsedAt: null as number | null });
      const usage = {
        now,
        stats: new Map([
          ['auto-unused', stat(old)], ['auto-used', stat(old, 3)], ['auto-young', stat(now - DAY)], ['auto-pinned', stat(old)],
          ['auto-no-date', stat(old)], ['user-unused', stat(old)], ['shared-unused', stat(old)],
        ]),
      };
      const withHidden = (u: typeof usage): SkillRegistry => ({ ...registry, hiddenUntilUsed: hiddenAutoSkills(registry, u) });

      it('hides an old auto skill that was never loaded and says how many were hidden', () => {
        const section = renderSkillsSection(withHidden(usage));
        expect(section).not.toContain('/auto-unused:');
        expect(section).not.toContain('/auto-no-date:');
        expect(section).toContain('2 auto-learned skills are hidden until used');
      });

      it('keeps used, young and pinned auto skills, and every non-auto skill', () => {
        const section = renderSkillsSection(withHidden(usage));
        for (const key of ['auto-used', 'auto-young', 'auto-pinned', 'user-unused', 'shared-unused']) {
          expect(section).toContain(`/${key}:`);
        }
      });

      it('keeps an old auto skill with no stat row listed (restored from the archive)', () => {
        const restored = renderSkillsSection(withHidden({ now, stats: new Map([['auto-used', stat(old, 3)]]) }));
        expect(restored).toContain('/auto-unused:');
        expect(restored).not.toContain('hidden until used');
      });

      it('measures the grace window from the stat row, not the frontmatter createdAt', () => {
        // Frontmatter says old, but the curator re-tracked it today (restored): it gets a fresh grace window.
        const hidden = hiddenAutoSkills(registry, { now, stats: new Map([['auto-unused', stat(now - DAY)], ['auto-no-date', stat(now - DAY)]]) });
        expect(hidden.size).toBe(0);
        // A row without a creation time (counted before it was tracked) is unknown age: keep it listed.
        expect(hiddenAutoSkills(registry, { now, stats: new Map([['auto-unused', stat(null)]]) }).size).toBe(0);
      });

      it('with a menu cap (unusable archive) hides the least-recently-used listed auto skills above it', () => {
        const capped = {
          now,
          maxListedAutoSkills: 1,
          stats: new Map([
            ['auto-unused', stat(old)],
            ['auto-used', { ...stat(old, 3), lastUsedAt: now - 2 * DAY }],
            ['auto-young', stat(now - DAY)],
            ['auto-pinned', stat(old)],
            ['user-unused', stat(old)],
          ]),
        };
        const hidden = hiddenAutoSkills(registry, capped);
        // auto-unused: never used; auto-used (used 2 days ago) is older than auto-young (created yesterday).
        expect([...hidden].sort()).toEqual(['auto-unused', 'auto-used']);
        const section = renderSkillsSection({ ...registry, hiddenUntilUsed: hidden });
        expect(section).toContain('/auto-young:');
        expect(section).toContain('/auto-pinned:');
        expect(section).toContain('/user-unused:');
        expect(section).toContain('2 auto-learned skills are hidden until used');
      });

      it('honors the registry hidden set and shows everything without one', () => {
        expect(renderSkillsSection({ ...registry, hiddenUntilUsed: new Set(['auto-young']) })).not.toContain('/auto-young:');
        const section = renderSkillsSection(registry);
        expect(section).toContain('/auto-unused:');
        expect(section).not.toContain('hidden until used');
      });
    });
  });
});
