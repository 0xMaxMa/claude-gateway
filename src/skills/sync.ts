import * as fs from 'fs';
import * as path from 'path';

/**
 * Syncs shared skills to the personal Claude skills directory (~/.claude/skills/).
 * Skills synced from shared are marked with a .shared sentinel file so stale
 * entries can be cleaned up when they are removed from shared-skills.
 */
export function syncSharedSkills(
  sharedSkillsDir: string,
  personalSkillsDir: string,
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void },
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
    const destFile = path.join(destDir, 'SKILL.md');
    const markerFile = path.join(destDir, '.shared');

    try {
      fs.mkdirSync(destDir, { recursive: true });

      // Only write if content differs (avoids spurious mtime updates)
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
        logger?.info('syncSharedSkills: synced skill', { name: skillName });
      }

      // Ensure .shared marker exists
      if (!fs.existsSync(markerFile)) {
        fs.writeFileSync(markerFile, '', 'utf-8');
      }
    } catch (err) {
      logger?.warn('syncSharedSkills: failed to sync skill', {
        name: skillName,
        error: (err as Error).message,
      });
    }
  }
}
