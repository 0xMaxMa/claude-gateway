import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseSkill, extractFrontmatter, type SkillDefinition, type ParseSkillOptions } from './parser';

/**
 * Progressive disclosure: auto-learned skills (`origin: auto`) can proliferate up
 * to the curator cap (default 20), and each full description in the CLAUDE.md
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

/** One `skill_stats` row as the menu sees it: load count, last use + the curator's age clock. */
export interface SkillUsageStat {
  timesLoaded: number;
  createdAt: number | null;
  lastUsedAt: number | null;
}

/** Usage that decides which auto skills the menu shows (from `skill_stats`). */
export interface SkillCatalogUsage {
  now: number;
  stats: ReadonlyMap<string, SkillUsageStat>;
  /**
   * Set when the curator cannot archive (an unusable skills/.archive): the menu then lists at
   * most this many unpinned auto skills, most recently used first, instead of the curator.
   */
  maxListedAutoSkills?: number;
}

/** LRU clock shared with the curator: last use, or creation for a never-used skill. */
export function lastActivity(s: { lastUsedAt: number | null; createdAt: number | null }): number {
  return s.lastUsedAt ?? s.createdAt ?? 0;
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
  // Age comes from the stat row (the clock the curator prunes by; a restored skill is
  // re-tracked with a fresh one). No row or no creation time: unknown, keep it listed.
  const stat = usage.stats.get(key);
  if (fm['pinned'] === true || !stat || stat.timesLoaded > 0 || stat.createdAt == null) return false;
  return usage.now - stat.createdAt > AUTO_SKILL_CATALOG_GRACE_DAYS * DAY_MS;
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
  /** Auto skills left out of the skills menu and the orchestration catalog (still invocable by name). */
  hiddenUntilUsed?: Set<string>;
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

/** `p` as the shell resolves it from `cwd`: `~/x`, `$HOME/x` and `${HOME}/x` are home-expanded. */
function shellPath(cwd: string, p: string): string {
  const expanded = p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, os.homedir());
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.join(cwd, expanded);
}

/** Shell commands that only read a file; a SKILL.md they name is a skill being followed. */
const SHELL_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'nl', 'sed', 'awk', 'view']);

/** The script inside `bash -lc '…'` / `sh -c "…"` (how Codex runs every command), or undefined. */
function shellWrapperScript(command: string): string | undefined {
  const wrapped = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-\w*c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return wrapped?.[2];
}

/**
 * SKILL.md paths a tool call reads on its own (not through the Skill tool): a Read's
 * `file_path`, or paths a shell read command names — Codex, and some agents, read files
 * through Bash, Codex inside `bash -lc '…'`. Only reading commands count (`cat`, `sed -n`,
 * `head`…): a SKILL.md that is diffed, grepped, edited or removed is not a skill in use.
 * A shell path is home-expanded and joined to the last `cd` before it
 * (`cd skills/x && cat SKILL.md`). Paths stay absolute or relative; see `skillsAtPaths`.
 */
export function skillFileRefs(block: { name?: unknown; input?: unknown }): string[] {
  const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
  if (block.name === 'Read' && typeof input['file_path'] === 'string') {
    return path.basename(input['file_path']) === 'SKILL.md' ? [input['file_path']] : [];
  }
  if (block.name !== 'Bash' || typeof input['command'] !== 'string') return [];
  const command = shellWrapperScript(input['command']) ?? input['command'];
  const refs: string[] = [];
  let cwd = '';
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const cd = /^\s*cd\s+(['"]?)([^\s'"]+)\1\s*$/.exec(segment);
    if (cd) {
      cwd = shellPath(cwd, cd[2]!);
      continue;
    }
    const [cmd = '', ...args] = segment.trim().split(/\s+/);
    const reader = path.basename(cmd);
    const writes = /^-[a-zA-Z]*i|^--in-place/;
    if (!SHELL_READERS.has(reader) || (reader === 'sed' && args.some((a) => writes.test(a))) || />\s*\S*SKILL\.md/.test(segment)) continue;
    for (const ref of segment.match(/[^\s'"`;|&<>()=]*SKILL\.md(?![\w.-])/g) ?? []) {
      if (path.basename(ref) === 'SKILL.md') refs.push(shellPath(cwd, ref));
    }
  }
  return refs.slice(0, 32);
}

/** Where a container agent sees its workspace (`docker run -v <workspace>:/workspace`). */
const CONTAINER_WORKSPACE = '/workspace';

/**
 * Registry skills whose SKILL.md is one of `refs`. An absolute ref must be the file — or,
 * for a workspace skill, the same file under /workspace, where a container agent reads
 * it; a relative one (cwd unknown) matches any skill file it is a path suffix of, so an
 * ambiguous read counts as use and keeps the skill listed rather than hiding it.
 */
export function skillsAtPaths(refs: readonly string[], registry: SkillRegistry): string[] {
  const out = new Set<string>();
  for (const ref of refs) {
    const rel = path.normalize(ref);
    if (!path.isAbsolute(ref) && (!rel.includes(path.sep) || rel.startsWith('..'))) continue;
    for (const [key, def] of registry.skills) {
      if (!def.filePath) continue;
      const file = path.resolve(def.filePath);
      if (path.isAbsolute(ref) ? file === path.resolve(ref) || containerPath(def) === path.posix.normalize(ref) : file.endsWith(path.sep + rel)) out.add(key);
    }
  }
  return [...out];
}

/** A workspace skill's SKILL.md as a container agent sees it (`/workspace/skills/<dir>/SKILL.md`). */
function containerPath(def: SkillDefinition): string | undefined {
  if (def.source !== 'workspace' || !def.filePath) return undefined;
  const [dir, file] = [path.basename(path.dirname(def.filePath)), path.basename(def.filePath)];
  return path.posix.join(CONTAINER_WORKSPACE, 'skills', dir, file);
}

/**
 * Keys of the never-used auto skills past the grace window (see AUTO_SKILL_CATALOG_GRACE_DAYS),
 * plus, under `maxListedAutoSkills`, the least-recently-used listed ones above that cap.
 */
export function hiddenAutoSkills(registry: SkillRegistry, usage: SkillCatalogUsage): Set<string> {
  const hidden = new Set<string>();
  const listed: Array<[string, SkillUsageStat]> = [];
  for (const [key, skill] of registry.skills) {
    const fm = autoFrontmatter(skill);
    if (!skill.userInvocable || !fm) continue;
    const stat = usage.stats.get(key);
    if (hiddenUntilUsed(key, fm, usage)) hidden.add(key);
    else if (stat && fm['pinned'] !== true) listed.push([key, stat]);
  }
  const overflow = usage.maxListedAutoSkills === undefined ? 0 : listed.length - usage.maxListedAutoSkills;
  if (overflow > 0) {
    listed.sort(([, a], [, b]) => lastActivity(a) - lastActivity(b));
    for (const [key] of listed.slice(0, overflow)) hidden.add(key);
  }
  return hidden;
}

/**
 * Render the AVAILABLE SKILLS section for the system prompt.
 * Groups skills by source: workspace, module, shared. Skills in
 * `registry.hiddenUntilUsed` are left out (see AUTO_SKILL_CATALOG_GRACE_DAYS).
 */
export function renderSkillsSection(registry: SkillRegistry): string {
  if (registry.skills.size === 0) return '';

  const workspace: string[] = [];
  const module: string[] = [];
  const shared: string[] = [];
  const hiddenKeys = registry.hiddenUntilUsed ?? new Set<string>();
  const hidden = hiddenKeys.size;

  for (const [key, skill] of registry.skills) {
    if (!skill.userInvocable || hiddenKeys.has(key)) continue;
    const autoFm = autoFrontmatter(skill);

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
    if (hidden > 0) sections.push(`(${hidden} auto-learned skills are hidden until used; they live in skills/ and still run by /name)`);
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
