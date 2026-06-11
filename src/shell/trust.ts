import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Pre-write flags into ~/.claude.json before spawning Claude Code so no startup dialogs appear.
 *
 * All flags live in a single file (~/.claude.json), matching Claude Code's GlobalConfig:
 *
 *   Top-level keys (read by getGlobalConfig()):
 *     hasCompletedOnboarding = true  → skips the theme/style picker (showSetupScreens check)
 *     theme = "dark"                 → satisfies the !config.theme condition in the same check
 *
 *   projects[cwd] entry:
 *     hasTrustDialogAccepted = true  → suppresses the workspace trust dialog
 *     projectOnboardingSeenCount = 1 → suppresses the per-project onboarding flow
 *
 * Writes are atomic (tmp+rename) and skipped if all flags are already set.
 * The configPath parameter is exposed for testing only.
 */
export function preTrustWorkspace(
  cwd: string,
  claudeJsonPath?: string,
): void {
  _writeClaudeJsonFlags(cwd, claudeJsonPath ?? path.join(os.homedir(), '.claude.json'));
}

function _writeClaudeJsonFlags(cwd: string, configPath: string): void {
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

  const projectFlagsOk =
    projects[cwd].hasTrustDialogAccepted === true &&
    typeof projects[cwd].projectOnboardingSeenCount === 'number' &&
    (projects[cwd].projectOnboardingSeenCount as number) > 0;
  const globalFlagsOk =
    data.hasCompletedOnboarding === true &&
    typeof data.theme === 'string' &&
    (data.theme as string).length > 0;

  if (projectFlagsOk && globalFlagsOk) return;

  if (!projectFlagsOk) {
    projects[cwd].hasTrustDialogAccepted = true;
    projects[cwd].projectOnboardingSeenCount = 1;
  }
  if (!globalFlagsOk) {
    data.hasCompletedOnboarding = true;
    if (!data.theme) data.theme = 'dark';
  }

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    process.stderr.write(`[pty-shell] WARN could not write ${configPath}: ${(err as Error).message}\n`);
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
