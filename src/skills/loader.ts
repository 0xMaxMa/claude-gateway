import fs from 'fs';
import path from 'path';
import { parseSkill, type SkillDefinition, type ParseSkillOptions } from './parser';

export interface SkillRegistry {
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
 * Groups skills by source: workspace, module, shared.
 */
export function renderSkillsSection(registry: SkillRegistry): string {
  if (registry.skills.size === 0) return '';

  const workspace: string[] = [];
  const module: string[] = [];
  const shared: string[] = [];

  for (const [key, skill] of registry.skills) {
    if (!skill.userInvocable) continue;

    const emoji = skill.emoji ? ` [${skill.emoji}]` : '';
    const line = `/${key}: ${skill.description}${emoji}`;

    if (skill.source === 'workspace') workspace.push(line);
    else if (skill.source === 'module') module.push(line);
    else shared.push(line);
  }

  if (workspace.length === 0 && module.length === 0 && shared.length === 0) return '';

  const sections: string[] = [];
  sections.push('Use /skill-name [args] to invoke a skill\n');

  if (workspace.length > 0) {
    sections.push('**Workspace Skills**');
    sections.push(...workspace);
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
