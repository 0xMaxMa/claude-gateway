import { promises as fsp } from 'fs';
import * as path from 'path';

/** The projects root when gateway.projects.root is not set. */
export const DEFAULT_PROJECTS_ROOT = '~/projects';

export type ProjectName = string & { readonly __brand: 'ProjectName' };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });

export type ProjectsErrorCode =
  | 'invalid_name'
  | 'not_a_directory'
  | 'path_escape'
  | 'permission_denied'
  | 'forbidden_key'
  | 'not_found'
  | 'project_exists'
  | 'internal';

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseProjectName(raw: unknown): Result<ProjectName, 'invalid_name'> {
  if (typeof raw !== 'string' || !PROJECT_NAME_RE.test(raw)) {
    return err('invalid_name');
  }
  return ok(raw as ProjectName);
}

const ERRNO_CODES: Record<string, ProjectsErrorCode> = {
  ENOENT: 'not_found',
  ENOTDIR: 'not_a_directory',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EEXIST: 'project_exists',
  // Only reachable through a symlink loop, which never resolves inside the root.
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
