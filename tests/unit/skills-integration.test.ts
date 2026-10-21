import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadWorkspace } from '../../src/agent/workspace-loader';
import { skillCatalog, resolveNamedSkill } from '../../src/orchestration/skills';

function makeTmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-integration-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Test Agent\nid: test\n');
  return dir;
}

function writeSkill(baseDir: string, name: string, frontmatter: string): void {
  const skillDir = path.join(baseDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}`);
}

describe('Skills integration with workspace-loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('SI-1: workspace with skills injects AVAILABLE SKILLS section into system prompt', async () => {
    const skillsDir = path.join(tmpDir, 'skills');
    writeSkill(skillsDir, 'github', 'name: github\ndescription: GitHub operations\nmetadata:\n  openclaw:\n    emoji: "🐙"');

    const result = await loadWorkspace(tmpDir);
    expect(result.systemPrompt).toContain('--- AVAILABLE SKILLS ---');
    expect(result.systemPrompt).toContain('/github: GitHub operations [🐙]');
    expect(result.systemPrompt).toContain('**Workspace Skills**');
  });

  it('SI-1b: skillUsage keeps a never-used old auto skill out of the prompt but in the registry', async () => {
    const skillsDir = path.join(tmpDir, 'skills');
    writeSkill(skillsDir, 'learned', 'name: learned\ndescription: "learned flow"\norigin: auto\ncreatedAt: 0');
    writeSkill(skillsDir, 'handmade', 'name: handmade\ndescription: Handmade flow');

    const result = await loadWorkspace(tmpDir, { skillUsage: { now: 30 * 24 * 60 * 60 * 1000, stats: new Map([['learned', { timesLoaded: 0, createdAt: 0, lastUsedAt: null }]]) } });
    expect(result.systemPrompt).not.toContain('/learned:');
    expect(result.systemPrompt).toContain('/handmade: Handmade flow');
    expect(result.skillRegistry?.skills.has('learned')).toBe(true); // still invocable by /learned
  });

  it('SI-1c: the orchestration skill catalog leaves out the same hidden auto skills', async () => {
    const skillsDir = path.join(tmpDir, 'skills');
    writeSkill(skillsDir, 'learned', 'name: learned\ndescription: "learned flow"\norigin: auto\ncreatedAt: 0');
    writeSkill(skillsDir, 'handmade', 'name: handmade\ndescription: Handmade flow');

    const result = await loadWorkspace(tmpDir, { skillUsage: { now: 30 * 24 * 60 * 60 * 1000, stats: new Map([['learned', { timesLoaded: 0, createdAt: 0, lastUsedAt: null }]]) } });
    const catalog = skillCatalog(result.skillRegistry);
    expect(catalog).not.toContain('"learned"');
    expect(catalog).toContain('"handmade"');
    expect(resolveNamedSkill('learned', '', result.skillRegistry)?.name).toBe('learned'); // still spawnable by name
  });

  it('SI-2: workspace without skills does not inject AVAILABLE SKILLS section', async () => {
    const result = await loadWorkspace(tmpDir);
    expect(result.systemPrompt).not.toContain('--- AVAILABLE SKILLS ---');
  });

  it('SI-3: AVAILABLE SKILLS section appears between USER PROFILE and LONG-TERM MEMORY', async () => {
    const skillsDir = path.join(tmpDir, 'skills');
    writeSkill(skillsDir, 'test-skill', 'name: test-skill\ndescription: A test skill');

    const result = await loadWorkspace(tmpDir);
    const userIdx = result.systemPrompt.indexOf('--- USER PROFILE ---');
    const skillsIdx = result.systemPrompt.indexOf('--- AVAILABLE SKILLS ---');
    const memoryIdx = result.systemPrompt.indexOf('--- LONG-TERM MEMORY ---');

    expect(userIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(skillsIdx);
    expect(skillsIdx).toBeLessThan(memoryIdx);
  });

  it('SI-4: loads module skills when mcpToolsDir is provided', async () => {
    const mcpTools = path.join(tmpDir, 'mcp-tools');
    writeSkill(path.join(mcpTools, 'telegram', 'skills'), 'access', 'name: access\ndescription: Manage access');

    const result = await loadWorkspace(tmpDir, { mcpToolsDir: mcpTools });
    expect(result.systemPrompt).toContain('/telegram:access: Manage access');
    expect(result.systemPrompt).toContain('**Module Skills**');
  });

  it('SI-5: loads shared skills when sharedSkillsDir is provided', async () => {
    const shared = path.join(tmpDir, 'shared');
    writeSkill(shared, 'summarize', 'name: summarize\ndescription: Summarize text\nmetadata:\n  openclaw:\n    emoji: "📋"');

    const result = await loadWorkspace(tmpDir, { sharedSkillsDir: shared });
    expect(result.systemPrompt).toContain('/summarize: Summarize text [📋]');
    expect(result.systemPrompt).toContain('**Shared Skills**');
  });

  it('SI-6: workspace skills override shared skills with same name', async () => {
    const skillsDir = path.join(tmpDir, 'skills');
    const shared = path.join(tmpDir, 'shared');
    writeSkill(skillsDir, 'github', 'name: github\ndescription: Workspace github');
    writeSkill(shared, 'github', 'name: github\ndescription: Shared github');

    const result = await loadWorkspace(tmpDir, { sharedSkillsDir: shared });
    expect(result.systemPrompt).toContain('Workspace github');
    expect(result.systemPrompt).not.toContain('Shared github');
  });
});
