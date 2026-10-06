import { promises as fsp } from 'fs';
import * as path from 'path';

export type ProjectName = string & { readonly __brand: 'ProjectName' };
/** POSIX path relative to a project dir; `""` is the project dir itself. */
export type RelPath = string & { readonly __brand: 'RelPath' };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });

export type ProjectsErrorCode =
  | 'invalid_name'
  | 'invalid_path'
  | 'not_a_directory'
  | 'not_a_file'
  | 'path_escape'
  | 'permission_denied'
  | 'forbidden_key'
  | 'not_found'
  | 'project_exists'
  | 'internal';

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_REL_PATH = 4096;

export function parseProjectName(raw: unknown): Result<ProjectName, 'invalid_name'> {
  if (typeof raw !== 'string' || !PROJECT_NAME_RE.test(raw)) {
    return err('invalid_name');
  }
  return ok(raw as ProjectName);
}

export function parseRelPath(raw: unknown): Result<RelPath, 'invalid_path'> {
  if (raw === undefined || raw === '') return ok('' as RelPath);
  if (typeof raw !== 'string' || raw.length > MAX_REL_PATH) return err('invalid_path');
  if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) return err('invalid_path');
  if (raw.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return err('invalid_path');
  return ok(raw as RelPath);
}

export function joinRel(dir: RelPath, name: string): RelPath {
  return (dir === '' ? name : `${dir}/${name}`) as RelPath;
}

const ERRNO_CODES: Record<string, ProjectsErrorCode> = {
  ENOENT: 'not_found',
  ENOTDIR: 'not_a_directory',
  EISDIR: 'not_a_file',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EEXIST: 'project_exists',
  ENAMETOOLONG: 'invalid_path',
  // Only reachable via a symlink: a loop, or O_NOFOLLOW meeting a link swapped
  // in after realpath. Either way the request tried to leave the real path.
  ELOOP: 'path_escape',
};

export function errnoToCode(e: unknown): ProjectsErrorCode {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return (code && ERRNO_CODES[code]) || 'internal';
}

export function isInside(realRoot: string, realTarget: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/**
 * Resolve `rel` under `realRoot` (which must already be a realpath) following
 * every symlink, and refuse anything whose real location is outside the root.
 */
export async function resolveInside(
  realRoot: string,
  rel: string,
): Promise<Result<string, ProjectsErrorCode>> {
  let real: string;
  try {
    real = await fsp.realpath(path.join(realRoot, rel));
  } catch (e) {
    return err(errnoToCode(e));
  }
  return isInside(realRoot, real) ? ok(real) : err('path_escape');
}
