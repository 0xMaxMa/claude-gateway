import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Pre-write two flags before spawning Claude Code so no startup dialogs appear:
 *
 *   ~/.claude.json          projects[cwd].hasTrustDialogAccepted = true
 *                           → suppresses the workspace trust dialog
 *
 *   ~/.claude/settings.json hasCompletedOnboarding = true
 *                           → suppresses the theme/style picker dialog
 *
 * Both writes are atomic (tmp+rename) and skip the disk write if the flag is
 * already set. Paths can be overridden for testing.
 */
export function preTrustWorkspace(
  cwd: string,
  claudeJsonPath?: string,
  settingsJsonPath?: string,
): void {
  _writeTrustFlag(cwd, claudeJsonPath ?? path.join(os.homedir(), '.claude.json'));
  _writeOnboardingFlag(settingsJsonPath ?? path.join(os.homedir(), '.claude', 'settings.json'));
}

function _writeTrustFlag(cwd: string, configPath: string): void {
  const tmpPath = `${configPath}.tmp`;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[pty-shell] WARN could not read ${configPath}: ${(err as Error).message}\n`);
    }
  }

  if (typeof data.projects !== 'object' || data.projects === null) {
    data.projects = {};
  }
  const projects = data.projects as Record<string, Record<string, unknown>>;
  if (!projects[cwd]) projects[cwd] = {};
  if (
    projects[cwd].hasTrustDialogAccepted === true &&
    typeof projects[cwd].projectOnboardingSeenCount === 'number' &&
    (projects[cwd].projectOnboardingSeenCount as number) > 0
  ) return;

  projects[cwd].hasTrustDialogAccepted = true;
  projects[cwd].projectOnboardingSeenCount = 1;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    process.stderr.write(`[pty-shell] WARN could not write ${configPath}: ${(err as Error).message}\n`);
  }
}

function _writeOnboardingFlag(settingsPath: string): void {
  const tmpPath = `${settingsPath}.tmp`;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[pty-shell] WARN could not read ${settingsPath}: ${(err as Error).message}\n`);
    }
  }

  if (data.hasCompletedOnboarding === true) return;

  data.hasCompletedOnboarding = true;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, settingsPath);
  } catch (err) {
    process.stderr.write(`[pty-shell] WARN could not write ${settingsPath}: ${(err as Error).message}\n`);
  }
}

/**
 * Check whether Claude Code is authenticated.
 * Runs `claude auth status` and parses the JSON output.
 * Returns { loggedIn: false } on any error (missing binary, parse failure, etc.).
 *
 * Uses spawnSync with an args array — avoids shell interpolation of claudeBin.
 */
export function checkAuthStatus(claudeBin = 'claude'): { loggedIn: boolean; authMethod?: string } {
  const result = spawnSync(claudeBin, ['auth', 'status'], {
    timeout: 10_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return { loggedIn: false };
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { loggedIn?: boolean; authMethod?: string };
    return { loggedIn: parsed.loggedIn === true, authMethod: parsed.authMethod };
  } catch {
    return { loggedIn: false };
  }
}
