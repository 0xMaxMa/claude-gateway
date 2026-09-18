import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where Claude Code's user-scoped config lives, and how to read it.
 *
 * Three separate call sites need this file — the model catalog's `env`-block
 * lookup, the user-scoped MCP server list, and the credentials forwarded into
 * an app-agent container — and each one that hardcodes `~/.claude` silently
 * ignores an operator who relocated the directory with `CLAUDE_CONFIG_DIR`.
 * Centralizing it here is the same move `claude-bin.ts` made for the binary:
 * one resolver, so the next call site cannot reintroduce the bug.
 *
 * For the container credentials that gap is not cosmetic. Reading a path that
 * does not exist forwards no credential at all, which reproduces the exact
 * "Not logged in" failure the forwarding was added to prevent.
 */

/**
 * Claude Code's config directory: `CLAUDE_CONFIG_DIR` when set, `~/.claude`
 * otherwise. Mirrors the CLI's own resolution order.
 */
export function claudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
}

/** Absolute path of the user-scoped `settings.json`. */
export function claudeSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(claudeConfigDir(env, homeDir), 'settings.json');
}

/**
 * cwd → Claude Code project-dir slug. Verified against v2.1.274 by running the CLI in
 * `/tmp/Rp_dot.test dir` and reading back the directory it created (`-tmp-Rp-dot-test-dir`):
 * every character outside `[A-Za-z0-9-]` becomes `-`, one dash per character, and letter
 * case is preserved. `/` and `.` are the common cases, but `_` and spaces convert too —
 * an agent id containing one would otherwise resolve to a slug that does not exist.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Where Claude Code stores the transcript of one session: `<config>/projects/<slug>/<id>.jsonl`.
 * This is the file `--resume <id>` reads, so its presence is what decides whether a session
 * can be resumed at all.
 */
export function transcriptPath(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(claudeConfigDir(env, homeDir), 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Parsed `settings.json`, or null when it is absent, unreadable, or not valid
 * JSON — all three are ordinary states, not errors, so callers fall back to
 * whatever other source they have.
 *
 * Only a plain object is returned. The file is operator-edited and therefore
 * untrusted: a top-level array, string or number parses fine but would make a
 * caller's property access read array indices or silently yield undefined.
 */
export function readClaudeSettings(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(claudeSettingsPath(env, homeDir), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The `env` block of `settings.json`, or an empty object when absent.
 *
 * Claude Code applies this block internally rather than exporting it, so a
 * value set only there is invisible to `process.env` and has to be read from
 * the file. Same untrusted-input rule as above: a non-object `env` is treated
 * as absent rather than indexed into.
 */
export function claudeSettingsEnv(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Record<string, unknown> {
  const raw = readClaudeSettings(env, homeDir)?.env;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}
