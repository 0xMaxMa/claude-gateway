import fs from 'fs';
import path from 'path';
import { parseSkill, extractFrontmatter, type SkillDefinition, type ParseSkillOptions } from './parser';

/**
 * Progressive disclosure: auto-learned skills (`origin: auto`) can proliferate up
 * to the curator cap (default 50), and each full description in the CLAUDE.md
 * menu costs context on every turn. Truncate the menu line for auto skills to
 * this many chars — the full body still loads when the skill is invoked.
 * Human/module/shared skills are curated and bounded, so they are never trimmed.
 */
export const AUTO_SKILL_MENU_DESC_MAX = 80;

/**
 * Hide-until-used: an auto skill that is past this age and has never been loaded
 * is left out of the menu (it stays invocable by /name). A new skill gets this
 * many days on the menu to be picked up first.
 */
export const AUTO_SKILL_CATALOG_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Load counts that decide which auto skills the menu shows (from `skill_stats`). */
export interface SkillCatalogUsage {
  now: number;
  timesLoaded: ReadonlyMap<string, number>;
}

/** The frontmatter of an auto-learned workspace skill; undefined for any other skill. */
function autoFrontmatter(skill: SkillDefinition): Record<string, unknown> | undefined {
  if (skill.source !== 'workspace') return undefined;
  try {
    const fm = extractFrontmatter(skill.content)?.frontmatter;
    return fm && fm['origin'] === 'auto' ? fm : undefined;
  } catch {
    return undefined;
  }
}

function hiddenUntilUsed(key: string, fm: Record<string, unknown>, usage: SkillCatalogUsage): boolean {
  if (fm['pinned'] === true || (usage.timesLoaded.get(key) ?? 0) > 0) return false;
  const createdAt = typeof fm['createdAt'] === 'number' ? fm['createdAt'] : 0;
  return usage.now - createdAt > AUTO_SKILL_CATALOG_GRACE_DAYS * DAY_MS;
}

/** Menu description for one skill — compacted only for auto-learned skills. */
function menuDescription(skill: SkillDefinition, isAuto: boolean): string {
  if (!isAuto) return skill.description;
  const d = skill.description.trim();
  if (d.length <= AUTO_SKILL_MENU_DESC_MAX) return d;
  return d.slice(0, AUTO_SKILL_MENU_DESC_MAX - 1).trimEnd() + '…';
}

export interface SkillRegistry {
  cliSkills?: import('../orchestration/cli-skills').CliSkill[];
  cliDiscoveryError?: string;
  extensionServers?: string[];
  extensionNotices?: string[];
  skills: Map<string, SkillDefinition>;
}

export interface LoadSkillsOptions {
  workspaceDir: string;
  mcpToolsDir?: string;
  sharedSkillsDir?: string;
  logger?: { warn: (msg: string) => void };
}

/**
 * Scan a directory for skill subdirectories containing SKILL.md.
 * Each subdirectory name is the skill name used for directory-based discovery.
 */
function scanSkillDir(
  dir: string,
  source: SkillDefinition['source'],
  modulePrefix?: string,
): SkillDefinition[] {
  if (!fs.existsSync(dir)) return [];

  const skills: SkillDefinition[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const skillDir = path.join(dir, entry);
    const skillFile = path.join(skillDir, 'SKILL.md');

    try {
      const stat = fs.statSync(skillDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    if (!fs.existsSync(skillFile)) continue;

    try {
      const raw = fs.readFileSync(skillFile, 'utf-8');
      const opts: ParseSkillOptions = { filePath: skillFile, source, modulePrefix };
      const skill = parseSkill(raw, opts);
      if (skill) skills.push(skill);
    } catch {
      // Skip unreadable files
    }
  }

  return skills;
}

/**
 * Scan MCP tool module directories for skills.
 * Structure: mcpToolsDir/{module}/skills/{skill-name}/SKILL.md
 * Skills are prefixed with {module}: in the registry.
 */
function scanModuleSkills(mcpToolsDir: string): SkillDefinition[] {
  if (!fs.existsSync(mcpToolsDir)) return [];

  const skills: SkillDefinition[] = [];
  let modules: string[];
  try {
    modules = fs.readdirSync(mcpToolsDir).sort();
  } catch {
    return [];
  }

  for (const mod of modules) {
    if (mod.startsWith('.') || mod === 'node_modules') continue;
    const skillsDir = path.join(mcpToolsDir, mod, 'skills');
    const moduleSkills = scanSkillDir(skillsDir, 'module', mod);
    skills.push(...moduleSkills);
  }

  return skills;
}

/**
 * Check if required binaries are available in PATH.
 */
function checkBinAvailability(bins: string[]): string[] {
  const missing: string[] = [];
  const pathDirs = (process.env.PATH || '').split(path.delimiter);

  for (const bin of bins) {
    const found = pathDirs.some((dir) => {
      try {
        const binPath = path.join(dir, bin);
        fs.accessSync(binPath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (!found) missing.push(bin);
  }

  return missing;
}

/**
 * Load all skills from workspace, module, and shared directories.
 * Priority: workspace > module > shared (workspace overrides same-name skills).
 */
export function loadSkills(opts: LoadSkillsOptions): SkillRegistry {
  const registry = new Map<string, SkillDefinition>();
  const log = opts.logger || { warn: () => {} };

  // 1. Shared skills (lowest priority, loaded first)
  if (opts.sharedSkillsDir) {
    const shared = scanSkillDir(opts.sharedSkillsDir, 'shared');
    for (const skill of shared) {
      registry.set(skill.name, skill);
    }
  }

  // 2. Module skills (middle priority)
  if (opts.mcpToolsDir) {
    const moduleSkills = scanModuleSkills(opts.mcpToolsDir);
    for (const skill of moduleSkills) {
      const key = skill.modulePrefix ? `${skill.modulePrefix}:${skill.name}` : skill.name;
      registry.set(key, skill);
    }
  }

  // 3. Workspace skills (highest priority, overrides shared)
  const workspaceSkillsDir = path.join(opts.workspaceDir, 'skills');
  const workspaceSkills = scanSkillDir(workspaceSkillsDir, 'workspace');
  for (const skill of workspaceSkills) {
    registry.set(skill.name, skill);
  }

  // Warn about missing binary dependencies
  for (const [key, skill] of registry) {
    if (skill.requires?.bins) {
      const missing = checkBinAvailability(skill.requires.bins);
      if (missing.length > 0) {
        log.warn(`Skill "${key}" requires missing binaries: ${missing.join(', ')}`);
      }
    }
  }

  return { skills: registry };
}

/**
 * Render the AVAILABLE SKILLS section for the system prompt.
 * Groups skills by source: workspace, module, shared. With `usage`, never-used
 * auto skills past the grace window are hidden (see AUTO_SKILL_CATALOG_GRACE_DAYS).
 */
export function renderSkillsSection(registry: SkillRegistry, usage?: SkillCatalogUsage): string {
  if (registry.skills.size === 0) return '';

  const workspace: string[] = [];
  const module: string[] = [];
  const shared: string[] = [];
  let hidden = 0;

  for (const [key, skill] of registry.skills) {
    if (!skill.userInvocable) continue;
    const autoFm = autoFrontmatter(skill);
    if (autoFm && usage && hiddenUntilUsed(key, autoFm, usage)) {
      hidden++;
      continue;
    }

    const emoji = skill.emoji ? ` [${skill.emoji}]` : '';
    const line = `/${key}: ${menuDescription(skill, autoFm !== undefined)}${emoji}`;

    if (skill.source === 'workspace') workspace.push(line);
    else if (skill.source === 'module') module.push(line);
    else shared.push(line);
  }

  if (workspace.length === 0 && module.length === 0 && shared.length === 0 && hidden === 0) return '';

  const sections: string[] = [];
  sections.push('Use /skill-name [args] to invoke a skill\n');

  if (workspace.length > 0 || hidden > 0) {
    sections.push('**Workspace Skills**');
    sections.push(...workspace);
    if (hidden > 0) sections.push(`(${hidden} auto-learned skills are hidden until first used; they live in skills/ and still run by /name)`);
    sections.push('');
  }
  if (module.length > 0) {
    sections.push('**Module Skills**');
    sections.push(...module);
    sections.push('');
  }
  if (shared.length > 0) {
    sections.push('**Shared Skills**');
    sections.push(...shared);
    sections.push('');
  }

  return sections.join('\n').trimEnd();
}
