import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Pre-write hasTrustDialogAccepted: true for the given workspace path into
 * ~/.claude.json before spawning Claude Code so the trust-folder dialog never appears.
 * Safe to call repeatedly — skips the disk write if the flag is already set.
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
  }

  if (typeof data.projects !== 'object' || data.projects === null) {
    data.projects = {};
  }
  const projects = data.projects as Record<string, Record<string, unknown>>;
  if (!projects[cwd]) projects[cwd] = {};

  if (projects[cwd].hasTrustDialogAccepted === true) return;

  projects[cwd].hasTrustDialogAccepted = true;
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
 * Returns false on any error (missing binary, parse failure, etc.).
 */
export function checkAuthStatus(claudeBin = 'claude'): { loggedIn: boolean; authMethod?: string } {
  try {
    const out = execSync(`${claudeBin} auth status`, { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(out.trim()) as { loggedIn?: boolean; authMethod?: string };
    return { loggedIn: parsed.loggedIn === true, authMethod: parsed.authMethod };
  } catch {
    return { loggedIn: false };
  }
}
