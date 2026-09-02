import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandHome, loadCliConfig } from './http-client';

/**
 * Locating and listing the gateway's log directory, shared by every reader.
 *
 * `debug-bundle` owned this privately and `gateway logs` needs the same three
 * behaviours — the `--logDir` → config → default precedence, the literal `~`
 * the shipped config template writes, and an errno instead of a silent empty
 * listing. Two copies of that would drift, and the tilde bug is what a drifted
 * copy looks like: `readdirSync('~/…')` throws ENOENT, which reads exactly like
 * "the directory is empty".
 */

/** The config file stores `logDir` exactly as written, and the shipped template
 *  writes `~/.claude-gateway/logs`. The server expands that itself on boot, so
 *  the literal tilde survives on disk and only bites a reader that forgets to
 *  expand it. */
export function resolveLogDir(flags: Record<string, string | boolean>): string {
  if (typeof flags.logDir === 'string') return expandHome(flags.logDir);
  const cfg = loadCliConfig(typeof flags.config === 'string' ? flags.config : undefined);
  if (cfg.logDir) return expandHome(cfg.logDir);
  return path.join(os.homedir(), '.claude-gateway', 'logs');
}

/**
 * The reason an explicitly passed `--config` did not contribute a `logDir`, or
 * undefined when there is nothing to say.
 *
 * `loadCliConfig` answers `{}` for a file that is missing, unreadable or
 * malformed — it cannot distinguish them, and for most commands that is the
 * right shape. Here it is not: the caller then silently resolves the *default*
 * log directory and reports "no log file at <default path>", naming a directory
 * the operator never asked about while the typo in `--config` goes unmentioned.
 * That is the same class of failure as the unexpanded `~`, arriving by a
 * different route.
 *
 * Only an explicit `--config` is worth complaining about. The default config
 * being absent is ordinary — a fresh install has no config yet, and the default
 * log directory is the correct answer for it.
 */
export function explicitConfigWarning(flags: Record<string, string | boolean>): string | undefined {
  if (typeof flags.logDir === 'string') return undefined; // --logDir wins; config was never consulted
  if (typeof flags.config !== 'string') return undefined;
  const file = expandHome(flags.config);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return `Warning: --config ${file} could not be read (${e.code ?? e.message}); falling back to the default log directory`;
  }
  try {
    JSON.parse(raw);
  } catch (err) {
    return `Warning: --config ${file} is not valid JSON (${(err as Error).message}); falling back to the default log directory`;
  }
  return undefined;
}

export interface LogDirListing {
  names: string[];
  /** Set when the directory could not be read at all — never "no logs found". */
  error?: string;
}

/**
 * Every entry in `dir`, or the reason it could not be read.
 *
 * The read used to be wrapped in a bare `catch { return [] }`, which reported
 * every failure as "no logs found". That is how the unexpanded `~` stayed
 * invisible: an ENOENT on a path that was never resolved looked exactly like an
 * empty directory, and a permission problem still would. The caller needs the
 * errno to say anything useful, so it is returned rather than eaten.
 */
export function readLogDir(dir: string): LogDirListing {
  try {
    return { names: fs.readdirSync(dir) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { names: [], error: `${dir} does not exist` };
    if (e.code === 'ENOTDIR') return { names: [], error: `${dir} is not a directory` };
    return { names: [], error: `${dir} could not be read (${e.code ?? e.message})` };
  }
}

/** Session logs in `dir` with their mtimes, or the reason the directory could
 *  not be read. Session loggers are created as `<agent>:session:<uuid>`, so the
 *  name carries the marker this filters on. */
export function listSessionLogs(dir: string): { logs: Array<{ file: string; mtimeMs: number }>; error?: string } {
  const listing = readLogDir(dir);
  if (listing.error) return { logs: [], error: listing.error };
  const logs = listing.names
    .filter((n) => n.endsWith('.log') && /session/i.test(n))
    .map((n) => {
      const file = path.join(dir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        /* ignore */
      }
      return { file, mtimeMs };
    });
  return { logs };
}

/**
 * Stream ids that have a live `<id>.log` in `dir`, sorted.
 *
 * Rotated generations (`<id>.log.1`) are deliberately excluded: they are not
 * separate streams, and offering one as an `--agent` value would name a target
 * that rotation can rename out from under the reader at any moment.
 */
export function listLogStreamIds(dir: string): { ids: string[]; error?: string } {
  const listing = readLogDir(dir);
  if (listing.error) return { ids: [], error: listing.error };
  const ids = listing.names
    .filter((n) => n.endsWith('.log'))
    .map((n) => n.slice(0, -'.log'.length))
    .sort();
  return { ids };
}
