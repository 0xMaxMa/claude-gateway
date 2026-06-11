import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Pre-write hasTrustDialogAccepted: true for the given workspace path and
 * hasCompletedOnboarding: true at root into ~/.claude.json before spawning
 * Claude Code so the trust-folder and theme/onboarding dialogs never appear.
 * Safe to call repeatedly — skips the disk write if both flags are already set.
 *
 * @param cwd            Workspace directory path (the key in projects map).
 * @param claudeJsonPath Override for the config file path (used in tests).
 */
export function preTrustWorkspace(cwd: string, claudeJsonPath?: string): void {
  const configPath = claudeJsonPath ?? path.join(os.homedir(), '.claude.json');
  const tmpPath = `${configPath}.tmp`;

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[pty-shell] WARN could not read ${configPath}: ${(err as Error).message}\n`);
    }
    // ENOENT → start from empty object, file will be created below
  }

  if (typeof data.projects !== 'object' || data.projects === null) {
    data.projects = {};
  }
  const projects = data.projects as Record<string, Record<string, unknown>>;
  if (!projects[cwd]) projects[cwd] = {};

  const alreadyTrusted = projects[cwd].hasTrustDialogAccepted === true;
  const alreadyOnboarded = data.hasCompletedOnboarding === true;
  if (alreadyTrusted && alreadyOnboarded) return; // both set — skip write

  projects[cwd].hasTrustDialogAccepted = true;
  data.hasCompletedOnboarding = true;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    process.stderr.write(`[pty-shell] WARN could not write ${configPath}: ${(err as Error).message}\n`);
  }
}
