import * as fs from 'fs';
import * as path from 'path';

type SyncLogger = { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };

function writeSkillFile(
  srcFile: string,
  destDir: string,
  markerName: string,
  logger?: SyncLogger,
  logName?: string,
): void {
  try {
    fs.mkdirSync(destDir, { recursive: true });

    const destFile = path.join(destDir, 'SKILL.md');
    const markerFile = path.join(destDir, markerName);

    const newContent = fs.readFileSync(srcFile, 'utf-8');
    let existing = '';
    try {
      existing = fs.readFileSync(destFile, 'utf-8');
    } catch {
      // file doesn't exist yet
    }

    if (newContent !== existing) {
      const tmp = destFile + '.tmp';
      fs.writeFileSync(tmp, newContent, 'utf-8');
      fs.renameSync(tmp, destFile);
      logger?.info('syncSkills: synced skill', { name: logName ?? path.basename(destDir) });
    }

    if (!fs.existsSync(markerFile)) {
      fs.writeFileSync(markerFile, '', 'utf-8');
    }
  } catch (err) {
    logger?.warn('syncSkills: failed to sync skill', {
      name: logName ?? path.basename(destDir),
      error: (err as Error).message,
    });
  }
}

/**
 * Syncs shared skills to the personal Claude skills directory (~/.claude/skills/).
 * Skills synced from shared are marked with a .shared sentinel file so stale
 * entries can be cleaned up when they are removed from shared-skills.
 */
export function syncSharedSkills(
  sharedSkillsDir: string,
  personalSkillsDir: string,
  logger?: SyncLogger,
): void {
  // Enumerate skills currently in shared-skills/
  const sharedNames = new Set<string>();
  if (fs.existsSync(sharedSkillsDir)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(sharedSkillsDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const skillMd = path.join(sharedSkillsDir, entry, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        sharedNames.add(entry);
      }
    }
  }

  // Ensure personal skills directory exists
  try {
    fs.mkdirSync(personalSkillsDir, { recursive: true });
  } catch {
    logger?.warn('syncSharedSkills: failed to create personalSkillsDir', { personalSkillsDir });
    return;
  }

  // Remove stale synced entries (those with .shared marker no longer in shared-skills)
  let existingEntries: string[] = [];
  try {
    existingEntries = fs.readdirSync(personalSkillsDir);
  } catch {
    // ignore
  }
  for (const entry of existingEntries) {
    if (entry.startsWith('.')) continue;
    const markerFile = path.join(personalSkillsDir, entry, '.shared');
    if (fs.existsSync(markerFile) && !sharedNames.has(entry)) {
      try {
        fs.rmSync(path.join(personalSkillsDir, entry), { recursive: true, force: true });
        logger?.info('syncSharedSkills: removed stale skill', { name: entry });
      } catch {
        logger?.warn('syncSharedSkills: failed to remove stale skill', { name: entry });
      }
    }
  }

  // Copy/update skills from shared-skills to personal skills dir
  for (const skillName of sharedNames) {
    const srcFile = path.join(sharedSkillsDir, skillName, 'SKILL.md');
    const destDir = path.join(personalSkillsDir, skillName);
    writeSkillFile(srcFile, destDir, '.shared', logger, skillName);
  }
}

/**
 * Syncs module skills from MCP tool directories to the personal Claude skills directory.
 * Structure: mcpToolsDir/{module}/skills/{skill-name}/SKILL.md
 * Synced skills are written as {module}:{skill-name} in personalSkillsDir and
 * marked with a .module sentinel for stale cleanup.
 */
export function syncModuleSkills(
  mcpToolsDir: string,
  personalSkillsDir: string,
  logger?: SyncLogger,
): void {
  if (!fs.existsSync(mcpToolsDir)) return;

  // Enumerate current module skills: module → Set<skill-name>
  const moduleSkillKeys = new Set<string>();
  let modules: string[];
  try {
    modules = fs.readdirSync(mcpToolsDir).sort();
  } catch {
    return;
  }

  for (const mod of modules) {
    if (mod.startsWith('.') || mod === 'node_modules') continue;
    const skillsDir = path.join(mcpToolsDir, mod, 'skills');
    if (!fs.existsSync(skillsDir)) continue;

    let skillEntries: string[];
    try {
      skillEntries = fs.readdirSync(skillsDir).sort();
    } catch {
      continue;
    }

    for (const skillName of skillEntries) {
      if (skillName.startsWith('.')) continue;
      const skillMd = path.join(skillsDir, skillName, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        moduleSkillKeys.add(`${mod}:${skillName}`);
      }
    }
  }

  // Ensure personal skills directory exists
  try {
    fs.mkdirSync(personalSkillsDir, { recursive: true });
  } catch {
    logger?.warn('syncModuleSkills: failed to create personalSkillsDir', { personalSkillsDir });
    return;
  }

  // Remove stale module-synced entries
  let existingEntries: string[] = [];
  try {
    existingEntries = fs.readdirSync(personalSkillsDir);
  } catch {
    // ignore
  }
  for (const entry of existingEntries) {
    if (entry.startsWith('.')) continue;
    const markerFile = path.join(personalSkillsDir, entry, '.module');
    if (fs.existsSync(markerFile) && !moduleSkillKeys.has(entry)) {
      try {
        fs.rmSync(path.join(personalSkillsDir, entry), { recursive: true, force: true });
        logger?.info('syncModuleSkills: removed stale skill', { name: entry });
      } catch {
        logger?.warn('syncModuleSkills: failed to remove stale skill', { name: entry });
      }
    }
  }

  // Copy/update module skills to personal skills dir as "{module}:{skill-name}"
  for (const key of moduleSkillKeys) {
    const [mod, skillName] = key.split(':');
    const srcFile = path.join(mcpToolsDir, mod, 'skills', skillName, 'SKILL.md');
    const destDir = path.join(personalSkillsDir, key);
    writeSkillFile(srcFile, destDir, '.module', logger, key);
  }
}
