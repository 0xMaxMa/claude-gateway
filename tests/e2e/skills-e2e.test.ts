/**
 * E2E tests for Agent Skills — Phase 2
 *
 * Tests the full flow through MCP tool handlers:
 * - skill_create → file on disk → loadable by skill registry
 * - skill_delete → file removed → removed from registry
 * - skill_install → fetch from URL → file on disk → loadable
 * - Hot-reload: file change → watcher fires → registry updated
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillsModule } from '../../mcp/tools/skills/module';
import { loadSkills, renderSkillsSection } from '../../src/skills/loader';
import { watchSkills } from '../../src/skills/watcher';
import { detectSkillCommand, formatSkillContext } from '../../src/skills/invoker';
import { waitForCondition } from '../helpers/wait-for';

let tmpDir: string;
let workspaceDir: string;
let sharedSkillsDir: string;
let mod: SkillsModule;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-e2e-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  sharedSkillsDir = path.join(tmpDir, 'shared-skills');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(sharedSkillsDir, { recursive: true });

  process.env.GATEWAY_WORKSPACE_DIR = workspaceDir;
  process.env.GATEWAY_SHARED_SKILLS_DIR = sharedSkillsDir;

  mod = new SkillsModule();
});

afterEach(() => {
  delete process.env.GATEWAY_WORKSPACE_DIR;
  delete process.env.GATEWAY_SHARED_SKILLS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('E2E: Skill Creation', () => {
  it('E2E-SK-01: skill_create → file exists → registry loads it → invocable', async () => {
    // Step 1: Create skill via MCP tool
    const createResult = await mod.handleTool('skill_create', {
      name: 'my-e2e-skill',
      description: 'E2E test skill',
      content: '# E2E Skill\n\nRun: $ARGUMENTS',
    });

    expect(createResult.isError).toBeUndefined();
    expect(createResult.content[0].text).toContain('my-e2e-skill');
    expect(createResult.content[0].text).toContain('created');

    // Step 2: Verify file on disk
    const skillFile = path.join(workspaceDir, 'skills', 'my-e2e-skill', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);
    const content = fs.readFileSync(skillFile, 'utf-8');
    expect(content).toContain('name: my-e2e-skill');
    expect(content).toContain('E2E test skill');

    // Step 3: Load registry and verify skill appears
    const registry = loadSkills({ workspaceDir });
    expect(registry.skills.has('my-e2e-skill')).toBe(true);
    const skill = registry.skills.get('my-e2e-skill')!;
    expect(skill.description).toBe('E2E test skill');
    expect(skill.source).toBe('workspace');

    // Step 4: Verify skill is invocable
    const invocation = detectSkillCommand('/my-e2e-skill do something', registry);
    expect(invocation).not.toBeNull();
    expect(invocation!.skillKey).toBe('my-e2e-skill');
    expect(invocation!.args).toBe('do something');
    expect(invocation!.content).toContain('Run: do something');

    // Step 5: Verify renders in system prompt section
    const section = renderSkillsSection(registry);
    expect(section).toContain('/my-e2e-skill');
    expect(section).toContain('E2E test skill');
  });

  it('E2E-SK-02: skill_create shared scope → accessible from any workspace', async () => {
    const createResult = await mod.handleTool('skill_create', {
      name: 'shared-e2e',
      description: 'Shared E2E skill',
      content: 'Shared instructions',
      scope: 'shared',
    });

    expect(createResult.isError).toBeUndefined();

    // Verify file in shared dir
    const skillFile = path.join(sharedSkillsDir, 'shared-e2e', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);

    // Load from a different workspace — should still find the shared skill
    const otherWorkspace = path.join(tmpDir, 'other-workspace');
    fs.mkdirSync(otherWorkspace, { recursive: true });

    const registry = loadSkills({
      workspaceDir: otherWorkspace,
      sharedSkillsDir,
    });

    expect(registry.skills.has('shared-e2e')).toBe(true);
    expect(registry.skills.get('shared-e2e')!.source).toBe('shared');
  });

  it('E2E-SK-03: skill_create duplicate → error, no overwrite', async () => {
    await mod.handleTool('skill_create', {
      name: 'dup-e2e',
      description: 'First version',
      content: 'First content',
    });

    const dupResult = await mod.handleTool('skill_create', {
      name: 'dup-e2e',
      description: 'Second version',
      content: 'Second content',
    });

    expect(dupResult.isError).toBe(true);
    expect(dupResult.content[0].text).toContain('already exists');

    // Verify original content preserved
    const file = path.join(workspaceDir, 'skills', 'dup-e2e', 'SKILL.md');
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('First content');
  });

  it('E2E-SK-04: skill_create with invalid name → error', async () => {
    const result = await mod.handleTool('skill_create', {
      name: 'Invalid Name!',
      description: 'Bad',
      content: 'Content',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid skill name');
  });
});

describe('E2E: Skill Deletion', () => {
  it('E2E-SK-05: skill_create → skill_delete → registry empty', async () => {
    // Create
    await mod.handleTool('skill_create', {
      name: 'to-delete-e2e',
      description: 'Will be deleted',
      content: 'Temporary content',
    });

    // Verify exists in registry
    let registry = loadSkills({ workspaceDir });
    expect(registry.skills.has('to-delete-e2e')).toBe(true);

    // Delete
    const deleteResult = await mod.handleTool('skill_delete', {
      name: 'to-delete-e2e',
    });
    expect(deleteResult.isError).toBeUndefined();
    expect(deleteResult.content[0].text).toContain('deleted');

    // Verify gone from disk
    const skillDir = path.join(workspaceDir, 'skills', 'to-delete-e2e');
    expect(fs.existsSync(skillDir)).toBe(false);

    // Verify gone from registry
    registry = loadSkills({ workspaceDir });
    expect(registry.skills.has('to-delete-e2e')).toBe(false);
  });

  it('E2E-SK-06: skill_delete non-existent → error', async () => {
    const result = await mod.handleTool('skill_delete', {
      name: 'ghost-skill',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

describe('E2E: Skill Install from URL', () => {
  it('E2E-SK-07: skill_install from valid URL → file on disk → registry loads', async () => {
    // Use a real GitHub raw URL for a known SKILL.md
    // We'll use a small, stable community skill
    const url = 'https://raw.githubusercontent.com/openclaw/skills/main/skills/steipete/gog/SKILL.md';

    const result = await mod.handleTool('skill_install', {
      url,
      scope: 'workspace',
    });

    // If network fails, skip gracefully
    if (result.isError && result.content[0].text.includes('fetch')) {
      console.log('Skipping E2E-SK-07: network unavailable');
      return;
    }

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('installed');

    // Verify file on disk (skill name comes from frontmatter)
    const skillsDir = path.join(workspaceDir, 'skills');
    const entries = fs.readdirSync(skillsDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // Load registry
    const registry = loadSkills({ workspaceDir });
    expect(registry.skills.size).toBeGreaterThanOrEqual(1);
  });

  it('E2E-SK-08: skill_install with github.com URL auto-converts to raw', async () => {
    // Use a GitHub tree URL (not raw)
    const url = 'https://github.com/openclaw/skills/tree/main/skills/steipete/gog';

    const result = await mod.handleTool('skill_install', {
      url,
      scope: 'workspace',
    });

    // If network fails, skip gracefully
    if (result.isError && result.content[0].text.includes('fetch')) {
      console.log('Skipping E2E-SK-08: network unavailable');
      return;
    }

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('installed');
  });

  it('E2E-SK-09: skill_install with name override', async () => {
    const url = 'https://raw.githubusercontent.com/openclaw/skills/main/skills/steipete/gog/SKILL.md';

    const result = await mod.handleTool('skill_install', {
      url,
      scope: 'workspace',
      name: 'my-custom-name',
    });

    if (result.isError && result.content[0].text.includes('fetch')) {
      console.log('Skipping E2E-SK-09: network unavailable');
      return;
    }

    expect(result.isError).toBeUndefined();

    // Verify file saved under custom directory name
    const skillFile = path.join(workspaceDir, 'skills', 'my-custom-name', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);

    // Registry key uses the frontmatter name (gog), not the directory name
    // The file exists on disk under my-custom-name/ but the parser reads
    // name from frontmatter. Verify the skill is loadable.
    const registry = loadSkills({ workspaceDir });
    // The skill is loaded — key is the frontmatter name
    expect(registry.skills.size).toBeGreaterThanOrEqual(1);
    // The skill content should be the gog skill
    const entries = [...registry.skills.values()];
    const installed = entries.find(s => s.filePath.includes('my-custom-name'));
    expect(installed).toBeDefined();
  });

  it('E2E-SK-10: skill_install duplicate without force → error', async () => {
    // Pre-create a skill
    await mod.handleTool('skill_create', {
      name: 'gog',
      description: 'Existing',
      content: 'Original',
    });

    const url = 'https://raw.githubusercontent.com/openclaw/skills/main/skills/steipete/gog/SKILL.md';

    const result = await mod.handleTool('skill_install', {
      url,
      scope: 'workspace',
    });

    if (result.isError && result.content[0].text.includes('fetch')) {
      console.log('Skipping E2E-SK-10: network unavailable');
      return;
    }

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');

    // Verify original content preserved
    const file = path.join(workspaceDir, 'skills', 'gog', 'SKILL.md');
    expect(fs.readFileSync(file, 'utf-8')).toContain('Original');
  });

  it('E2E-SK-11: skill_install duplicate with force → overwrites', async () => {
    // Pre-create
    await mod.handleTool('skill_create', {
      name: 'gog',
      description: 'Existing',
      content: 'Original',
    });

    const url = 'https://raw.githubusercontent.com/openclaw/skills/main/skills/steipete/gog/SKILL.md';

    const result = await mod.handleTool('skill_install', {
      url,
      scope: 'workspace',
      force: true,
    });

    if (result.isError && result.content[0].text.includes('fetch')) {
      console.log('Skipping E2E-SK-11: network unavailable');
      return;
    }

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('installed');

    // Verify content replaced
    const file = path.join(workspaceDir, 'skills', 'gog', 'SKILL.md');
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('Original');
  });

  it('E2E-SK-12: skill_install with HTTP URL → rejected', async () => {
    const result = await mod.handleTool('skill_install', {
      url: 'http://example.com/SKILL.md',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTPS');
  });
});

describe('E2E: Skill Hot-Reload', () => {
  it('E2E-SK-13: skill_create → watcher detects → registry updated', async () => {
    const skillsDir = path.join(workspaceDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    let reloadCount = 0;
    let latestRegistry = loadSkills({ workspaceDir });

    const watcher = watchSkills({
      dirs: [skillsDir],
      onChange: () => {
        reloadCount++;
        latestRegistry = loadSkills({ workspaceDir });
      },
      debounceMs: 50,
    });

    // chokidar runs with ignoreInitial, so a write that lands before its scan
    // finishes produces no event at all — await the readiness it exposes.
    await watcher.ready;

    // Create skill via MCP tool (writes file to disk)
    await mod.handleTool('skill_create', {
      name: 'hot-reload-test',
      description: 'Hot reload test',
      content: 'Test hot reload',
    });

    // Wait for the reload rather than for 600ms of wall clock.
    await waitForCondition(() => reloadCount >= 1);

    await watcher.close();

    expect(reloadCount).toBeGreaterThanOrEqual(1);
    expect(latestRegistry.skills.has('hot-reload-test')).toBe(true);
  });

  it('E2E-SK-14: skill_delete → watcher detects → registry cleared', async () => {
    // Pre-create a skill
    await mod.handleTool('skill_create', {
      name: 'to-hot-delete',
      description: 'Will be hot-deleted',
      content: 'Content',
    });

    const skillsDir = path.join(workspaceDir, 'skills');

    let reloadCount = 0;
    let latestRegistry = loadSkills({ workspaceDir });
    expect(latestRegistry.skills.has('to-hot-delete')).toBe(true);

    const watcher = watchSkills({
      dirs: [skillsDir],
      onChange: () => {
        reloadCount++;
        latestRegistry = loadSkills({ workspaceDir });
      },
      debounceMs: 50,
    });

    await watcher.ready;

    // Delete via MCP tool
    await mod.handleTool('skill_delete', {
      name: 'to-hot-delete',
    });

    await waitForCondition(() => reloadCount >= 1);

    await watcher.close();

    expect(reloadCount).toBeGreaterThanOrEqual(1);
    expect(latestRegistry.skills.has('to-hot-delete')).toBe(false);
  });

  it('E2E-SK-15: full lifecycle: create → invoke → delete → gone', async () => {
    // Create
    const createResult = await mod.handleTool('skill_create', {
      name: 'lifecycle-test',
      description: 'Full lifecycle',
      content: '# Lifecycle\n\nArgs: $ARGUMENTS\n\nDo the thing.',
    });
    expect(createResult.isError).toBeUndefined();

    // Load and invoke
    let registry = loadSkills({ workspaceDir });
    const invocation = detectSkillCommand('/lifecycle-test hello world', registry);
    expect(invocation).not.toBeNull();
    expect(invocation!.args).toBe('hello world');

    const context = formatSkillContext(invocation!);
    expect(context).toContain('lifecycle-test');
    expect(context).toContain('Args: hello world');

    // Delete
    const deleteResult = await mod.handleTool('skill_delete', {
      name: 'lifecycle-test',
    });
    expect(deleteResult.isError).toBeUndefined();

    // Verify gone
    registry = loadSkills({ workspaceDir });
    const gone = detectSkillCommand('/lifecycle-test hello', registry);
    expect(gone).toBeNull();
  });
});
