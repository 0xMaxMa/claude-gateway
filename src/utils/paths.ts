import * as os from 'os';
import * as path from 'path';

/**
 * Expand a leading `~` to the home directory.
 *
 * A `~` reaches the gateway unexpanded whenever a path is not read through a
 * shell: config files (`gateway.logDir` is written as `~/.claude-gateway/logs`
 * by the shipped template), environment variables set in a unit file or a
 * Dockerfile, and `--flag` values. Leaving it literal turns into an ENOENT that
 * reads like "the directory is empty" rather than "the path was never
 * resolved" — the shape of the `debug-bundle` bug found in review.
 *
 * There were four copies of this, on both the server and the CLI side. This
 * module has no imports beyond `os`/`path` precisely so the server entry point
 * can use it without pulling in the CLI.
 */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * True when `target` is `root` or lies inside it. Uses `path.relative`, so it
 * follows the host's separators and, on Windows, its case-insensitive
 * comparison and per-drive roots; a `startsWith(root + '/')` check does
 * neither. Both paths should already be resolved (e.g. with `realpath`).
 */
export function pathWithin(root: string, target: string, api: path.PlatformPath = path): boolean {
  const rel = api.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + api.sep) && !api.isAbsolute(rel);
}
