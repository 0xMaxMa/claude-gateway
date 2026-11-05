import { promises as fsp } from 'fs';
import * as path from 'path';
import type { CwdResolution, CwdResolver, CwdUnavailableReason, SessionCwd } from '../session/cwd';
import type { GatewayConfig, Logger } from '../types';
import { pathWithin } from '../utils/paths';
import { err, ok, Result } from '../utils/result';
import { readStatusSummary } from '../git/read';
import { remoteHostname } from '../git/status';
import { filesEnabled, resolveFilesRoot } from './config';
import { resolveDir } from './fs';
import { findHold } from './holds';
import { FilesErrorCode, parseRelPath, RelPath } from './paths';

/** A branch name the note may carry verbatim. Git allows far more, and the note is a prompt. */
const PLAIN_BRANCH_RE = /^[\w./-]{1,100}$/;

const UNAVAILABLE: Partial<Record<FilesErrorCode, CwdUnavailableReason>> = {
  not_found: 'not_found',
  path_escape: 'outside_root',
  not_a_directory: 'not_a_directory',
  permission_denied: 'permission_denied',
};

/**
 * Session working folders under `gateway.files.root`. A cwd is any folder under the root except the root itself, named
 * by a path the files API accepts. It is stored as an absolute path and resolved again at every spawn and turn.
 */
export function createCwdResolver(config: GatewayConfig, logger: Logger): CwdResolver {
  const root = () => resolveFilesRoot(config);

  /** The root-relative path of `abs`, under the real root or the configured spelling of it. */
  async function relUnderRoot(abs: string): Promise<Result<{ realRoot: string; rel: RelPath }, CwdUnavailableReason | 'invalid'>> {
    const realRoot = await fsp.realpath(root()).catch(() => null);
    if (!realRoot) return err('not_found');
    const base = [realRoot, root()].find((r) => pathWithin(r, abs));
    if (base === undefined) return err('outside_root');
    const rel = parseRelPath(path.relative(base, abs).split(path.sep).join('/'));
    return rel.ok ? ok({ realRoot, rel: rel.value }) : err('invalid');
  }

  /** Exact match on the real folder, no inheritance into subfolders, and never through a symlink alias. */
  function trusted(realRoot: string, rel: RelPath, dir: string): boolean {
    if (dir !== path.join(realRoot, rel)) return false;
    return (config.gateway.files?.trusted ?? []).some((entry) => path.join(realRoot, entry) === dir);
  }

  async function resolveAt(abs: string): Promise<Result<SessionCwd, CwdUnavailableReason | 'invalid'>> {
    if (!filesEnabled(config)) return err('disabled');
    const where = await relUnderRoot(abs);
    if (!where.ok) return where;
    const { realRoot, rel } = where.value;
    const dir = await resolveDir(root(), rel);
    if (!dir.ok) return err(UNAVAILABLE[dir.error] ?? 'internal');
    const hold = findHold(dir.value);
    if (hold) return err('deleting');
    const st = await fsp.stat(dir.value).catch(() => null);
    if (!st) return err('not_found');
    const stored = path.join(realRoot, rel);
    return ok({
      path: stored,
      dir: dir.value,
      trusted: trusted(realRoot, rel, dir.value),
      identity: `${st.dev}:${st.ino}`,
      location: `You are working in the folder ${rel} at ${dir.value}.`,
    });
  }

  return {
    async parse(raw) {
      // A trailing slash is refused in both forms, as the files API refuses it, so one folder has one spelling.
      if (typeof raw !== 'string' || raw === '' || raw.includes('\0') || (raw.length > 1 && raw.endsWith('/'))) return err('invalid');
      if (!filesEnabled(config)) return err('disabled');
      if (path.isAbsolute(raw)) return path.normalize(raw) === raw ? resolveAt(raw) : err('invalid');
      const rel = parseRelPath(raw);
      if (!rel.ok) return err('invalid');
      const realRoot = await fsp.realpath(root()).catch(() => null);
      return resolveAt(path.join(realRoot ?? root(), rel.value));
    },

    async resolve(abs): Promise<CwdResolution> {
      if (!path.isAbsolute(abs)) return err('outside_root');
      const resolved = await resolveAt(path.normalize(abs));
      return resolved.ok || resolved.error !== 'invalid' ? (resolved as CwdResolution) : err('outside_root');
    },

    async note(cwd) {
      const status = await readStatusSummary(cwd.dir, logger).catch(() => null);
      if (!status?.ok) return cwd.location;
      const s = status.value;
      const host = s.remote ? remoteHostname(s.remote.url) : null;
      const git = [
        ...(s.branch === null ? ['detached HEAD'] : PLAIN_BRANCH_RE.test(s.branch) ? [`branch ${s.branch}`] : []),
        `${s.change_count} ${s.change_count === 1 ? 'change' : 'changes'}`,
        ...(host ? [`remote ${host}`] : []),
      ];
      return `${cwd.location} Git: ${git.join(', ')}.`;
    },
  };
}
