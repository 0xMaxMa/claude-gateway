import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadSkills, renderSkillsSection, type SkillRegistry } from '../../src/skills/loader';
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
  });
});
