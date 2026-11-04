import { promises as fsp } from 'fs';
import * as path from 'path';
import { pathWithin } from '../utils/paths';
import { err, ok, Result } from '../utils/result';

/** The files root when gateway.files.root is not set. */
export const DEFAULT_FILES_ROOT = '~/projects';

/** One path segment that passed {@link ENTRY_NAME_RE}. */
export type EntryName = string & { readonly __brand: 'EntryName' };

/** A path under the files root: `''` for the root itself, else entry names joined by `/`. */
export type RelPath = string & { readonly __brand: 'RelPath' };

export type FilesErrorCode =
  | 'invalid_path'
  | 'invalid_name'
  | 'not_a_directory'
  | 'path_escape'
  | 'symlink_in_path'
  | 'cross_device'
  | 'permission_denied'
  | 'forbidden_key'
  | 'not_found'
  | 'already_exists'
  | 'internal';

/**
 * Ordinary routes use entry names without a dot prefix. Delete may opt into hidden names but still refuses trash.
 */
const ENTRY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MAX_PATH_DEPTH = 32;

export function parseEntryName(raw: unknown, allowHidden = false): Result<EntryName, 'invalid_name'> {
  const visible = typeof raw === 'string' && ENTRY_NAME_RE.test(raw);
  const hidden = allowHidden && typeof raw === 'string' && /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(raw) && !raw.startsWith('.deleting-');
  if (!visible && !hidden) {
    return err('invalid_name');
  }
  return ok(raw as EntryName);
}

/** `invalid_path` for a non-string, an absolute path, an empty segment or too many segments; `invalid_name` for a segment the name rule refuses. */
export function parseRelPath(raw: unknown, allowHidden = false): Result<RelPath, 'invalid_path' | 'invalid_name'> {
  if (typeof raw !== 'string') return err('invalid_path');
  if (raw === '') return ok(raw as RelPath);
  const segments = raw.split('/');
  if (segments.length > MAX_PATH_DEPTH || segments.some((s) => s === '')) return err('invalid_path');
  return segments.every((s) => parseEntryName(s, allowHidden).ok) ? ok(raw as RelPath) : err('invalid_name');
}

export function pathSegments(rel: RelPath): EntryName[] {
  return rel === '' ? [] : (rel.split('/') as EntryName[]);
}

export function joinRel(rel: RelPath, name: EntryName): RelPath {
  return (rel === '' ? name : `${rel}/${name}`) as RelPath;
}

const ERRNO_CODES: Record<string, FilesErrorCode> = {
  ENOENT: 'not_found',
  ENOTDIR: 'not_a_directory',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EEXIST: 'already_exists',
  EXDEV: 'cross_device',
  // Only reachable through a symlink loop, which never resolves inside the root.
  ELOOP: 'path_escape',
};

export function errnoToCode(e: unknown): FilesErrorCode {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return (code && ERRNO_CODES[code]) || 'internal';
}

/** `a` and `b` are the same folder, or one holds the other. Both must be real paths. */
export function overlaps(a: string, b: string): boolean {
  return pathWithin(a, b) || pathWithin(b, a);
}

/**
 * Resolve `rel` under `realRoot` (which must already be a realpath) following
 * every symlink, and refuse anything whose real location is outside the root.
 */
export async function resolveInside(
  realRoot: string,
  rel: string,
): Promise<Result<string, FilesErrorCode>> {
  let real: string;
  try {
    real = await fsp.realpath(path.join(realRoot, rel));
  } catch (e) {
    return err(errnoToCode(e));
  }
  return pathWithin(realRoot, real) ? ok(real) : err('path_escape');
}
