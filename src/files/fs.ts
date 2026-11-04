import { execFile } from 'child_process';
import { Dirent, promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { hardenedGit } from '../git/runner';
import { findHold } from './holds';
import { EntryName, errnoToCode, FilesErrorCode, joinRel, parseEntryName, pathSegments, RelPath, resolveInside } from './paths';
import { err, ok, Result } from '../utils/result';
import type { Logger } from '../types';

const GIT_INIT_TIMEOUT_MS = 10_000;
/** How long one folder's size may take. A folder that runs longer is listed with `size: null`. */
const DU_TIMEOUT_MS = 8_000;
/** How long a measured size stays fresh, so a repeated list does not walk every folder again. */
const SIZE_TTL_MS = 60_000;
const execFileAsync = promisify(execFile);
const sizeCache = new Map<string, { at: number; size: number | null }>();
/** The measurement under way per folder, so concurrent lists share one `du` instead of each starting another. */
const sizeInFlight = new Map<string, Promise<number | null>>();

export interface Entry {
  name: EntryName;
  /** Relative to the root. */
  path: RelPath;
  /** Absolute: the real folder that was listed, joined with the name. */
  abs: string;
  type: 'dir';
  modified_at: string;
  is_git: boolean;
  /** Bytes the folder occupies on disk, as `du -s -B1 -x` counts them. Null when the measurement ran out of time. */
  size: number | null;
}

/** Why a folder under the listed one is not an entry. */
export type SkipReason = 'invalid_name' | 'symlink_outside_root' | 'not_a_directory';

export interface SkippedEntry {
  name: string;
  reason: SkipReason;
}

export interface DirListing {
  /** The real root; the configured spelling when the root does not exist. */
  root: string;
  /** false only when the root itself does not exist. A read never creates it. */
  exists: boolean;
  path: RelPath;
  abs: string;
  entries: Entry[];
  /** Root filesystem capacity in bytes; absent if statfs fails or a value cannot fit safely in JSON. */
  filesystem?: { total: number; free: number; available: number };
  /** Folders and links the list left out, at most SKIPPED_LIMIT, sorted by name. Absent when there are none. */
  skipped?: SkippedEntry[];
  /** Hidden `.deleting-*` folders a failed delete left behind, at most SKIPPED_LIMIT, sorted. Absent when there are none. */
  leftovers?: string[];
}

export const SKIPPED_LIMIT = 50;

const DELETING_LEFTOVER_RE = /^\.deleting-/;

export interface CreatedEntry {
  entry: Entry;
  warning?: string;
}

type FsResult<T> = Result<T, FilesErrorCode>;

async function realRootOf(root: string): Promise<FsResult<string>> {
  try {
    return ok(await fsp.realpath(root));
  } catch (e) {
    return err(errnoToCode(e));
  }
}

/** The root `GET /v1/files` reports: its real path, or the configured spelling while it does not exist. Null when it cannot be read. */
export async function reportedRoot(root: string): Promise<string | null> {
  const realRoot = await realRootOf(root);
  if (realRoot.ok) return realRoot.value;
  return realRoot.error === 'not_found' ? root : null;
}

/**
 * Bytes under a folder, measured with `du` on the real path. `du` exits non-zero when part of the tree is unreadable
 * but still prints the total, so that total is used. Only a folder with no total at all, or one past the time limit,
 * reports null.
 */
export function folderSize(realDir: string): Promise<number | null> {
  const hit = sizeCache.get(realDir);
  if (hit && Date.now() - hit.at < SIZE_TTL_MS) return Promise.resolve(hit.size);
  const pending = sizeInFlight.get(realDir);
  if (pending) return pending;
  const measured = measureFolder(realDir).finally(() => sizeInFlight.delete(realDir));
  sizeInFlight.set(realDir, measured);
  return measured;
}

async function measureFolder(realDir: string): Promise<number | null> {
  let size: number | null = null;
  try {
    const { stdout } = await execFileAsync('du', ['-s', '-B1', '-x', realDir], { timeout: DU_TIMEOUT_MS });
    size = parseDuTotal(stdout);
  } catch (e) {
    size = parseDuTotal((e as { stdout?: string }).stdout ?? '');
  }
  sizeCache.set(realDir, { at: Date.now(), size });
  return size;
}

export function parseDuTotal(stdout: string): number | null {
  const n = Number.parseInt(stdout.split('\t')[0] ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

async function describeEntry(dirAbs: string, rel: RelPath, realDir: string, name: EntryName): Promise<Entry> {
  const st = await fsp.stat(realDir);
  const isGit = await fsp.lstat(path.join(realDir, '.git')).then(() => true, () => false);
  const size = await folderSize(realDir);
  return { name, path: joinRel(rel, name), abs: path.join(dirAbs, name), type: 'dir', modified_at: st.mtime.toISOString(), is_git: isGit, size };
}

/**
 * The real directory `rel` names under `root`, through any symlink that stays inside. The root itself is refused
 * unless `allowRoot`, and so is a link such as `all -> .`, which would make one entry span every other one.
 */
export async function resolveDir(root: string, rel: RelPath, allowRoot = false): Promise<FsResult<string>> {
  const realRoot = await realRootOf(root);
  if (!realRoot.ok) return realRoot;
  const dir = await resolveInside(realRoot.value, rel);
  if (!dir.ok) return dir;
  if (dir.value === realRoot.value && !allowRoot) return err('path_escape');
  const st = await fsp.stat(dir.value).catch(() => null);
  if (!st) return err('not_found');
  return st.isDirectory() ? dir : err('not_a_directory');
}

/** {@link resolveDir} without any symlink on the way: `symlink_in_path` when the real folder is not `root/rel` as spelled. */
export async function resolveRealDir(root: string, rel: RelPath): Promise<FsResult<string>> {
  const dir = await resolveDir(root, rel);
  if (!dir.ok) return dir;
  const realRoot = await realRootOf(root);
  if (!realRoot.ok) return realRoot;
  return dir.value === path.join(realRoot.value, rel) ? dir : err('symlink_in_path');
}

/** Bounds the open file handles a large folder costs one list request. */
const LIST_CONCURRENCY = 16;

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The directories directly under `rel`: real folders and links to folders that stay inside the root. Files are left out. */
export async function listDir(root: string, rel: RelPath, includeHidden = false): Promise<FsResult<DirListing>> {
  const realRoot = await realRootOf(root);
  if (!realRoot.ok) {
    return realRoot.error === 'not_found' && rel === ''
      ? ok({ root, exists: false, path: rel, abs: root, entries: [] })
      : realRoot;
  }
  const dir = await resolveDir(root, rel, true);
  if (!dir.ok) return dir;
  let filesystem: DirListing['filesystem'];
  if (rel === '') {
    try {
      const stats = await fsp.statfs(realRoot.value, { bigint: true });
      const bytes = [stats.blocks, stats.bfree, stats.bavail].map((blocks) => Number(blocks * BigInt(stats.bsize)));
      if (bytes.every((value) => Number.isSafeInteger(value) && value >= 0)) filesystem = { total: bytes[0], free: bytes[1], available: bytes[2] };
    } catch { /* Capacity is optional when statfs is unavailable. */ }
  }
  let dirents: Dirent[];
  try {
    dirents = await fsp.readdir(dir.value, { withFileTypes: true });
  } catch (e) {
    return err(errnoToCode(e));
  }

  const described = await mapLimit(
    dirents,
    LIST_CONCURRENCY,
    async (d): Promise<{ entry: Entry } | { skipped: SkippedEntry } | { leftover: string } | null> => {
      if (!(d.isDirectory() || d.isSymbolicLink())) return null;
      if (d.isDirectory() && DELETING_LEFTOVER_RE.test(d.name)) return { leftover: d.name };
      // Hidden entries are opt-in; delete trash remains excluded in either mode.
      const name = parseEntryName(d.name, includeHidden);
      if (!name.ok) return { skipped: { name: d.name, reason: 'invalid_name' } };
      const child = await resolveDir(root, joinRel(rel, name.value));
      if (!child.ok) {
        const reason = child.error === 'path_escape' ? 'symlink_outside_root' : child.error === 'not_a_directory' ? 'not_a_directory' : null;
        return reason ? { skipped: { name: d.name, reason } } : null;
      }
      // Vanished or unreadable between readdir and stat: not listable.
      const entry = await describeEntry(dir.value, rel, child.value, name.value).catch(() => null);
      return entry ? { entry } : null;
    },
  );
  const entries: Entry[] = [];
  const skipped: SkippedEntry[] = [];
  const leftovers: string[] = [];
  for (const item of described) {
    if (item && 'entry' in item) entries.push(item.entry);
    else if (item && 'skipped' in item) skipped.push(item.skipped);
    else if (item) leftovers.push(item.leftover);
  }
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  entries.sort((a, b) => byName(a.name, b.name));
  skipped.sort((a, b) => byName(a.name, b.name));
  leftovers.sort(byName);
  return ok({
    root: realRoot.value,
    exists: true,
    path: rel,
    abs: dir.value,
    entries,
    ...(filesystem ? { filesystem } : {}),
    ...(skipped.length > 0 ? { skipped: skipped.slice(0, SKIPPED_LIMIT) } : {}),
    ...(leftovers.length > 0 ? { leftovers: leftovers.slice(0, SKIPPED_LIMIT) } : {}),
  });
}

/** execFile rejects with a numeric exit code, or an errno string when git could not be spawned. */
type GitInitError = Error & {
  code?: number | string;
  signal?: NodeJS.Signals | null;
};

/** Built only from the exit status: git's stderr can carry paths and config the client must not see. */
function gitInitWarning(e: GitInitError): string {
  if (e.signal) return `git init failed (signal ${e.signal})`;
  if (typeof e.code === 'number') return `git init failed (exit code ${e.code})`;
  if (typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code)) return `git init failed (${e.code})`;
  return 'git init failed';
}

/** Tail of the mkdir chain per parent folder; the gateway is the only process creating entries there. */
const createQueues = new Map<string, Promise<unknown>>();

function serializeCreate<T>(parent: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(parent);
  const run = (createQueues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  createQueues.set(key, tail);
  void tail.then(() => {
    if (createQueues.get(key) === tail) createQueues.delete(key);
  });
  return run;
}

/** The real parent folder of a new entry. A missing root is created, as the first mkdir on a fresh pod needs; a missing deeper parent is not. */
async function parentOf(root: string, parentRel: RelPath): Promise<FsResult<string>> {
  // As DELETE does: a new folder never lands through a symlinked parent, where it would appear under two names.
  if (parentRel !== '') return resolveRealDir(root, parentRel);
  try {
    await fsp.mkdir(root, { recursive: true });
  } catch (e) {
    // A recursive mkdir only fails with EEXIST when the root is a non-directory.
    return err((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'not_a_directory' : errnoToCode(e));
  }
  return realRootOf(root);
}

type MakeDirError = FilesErrorCode | 'deleting';

async function makeOneDir(parent: string, dir: string, name: EntryName): Promise<Result<void, MakeDirError>> {
  // Case-folding filesystems already answer EEXIST; this makes Linux agree so a client never gets "Site" and "site"
  // side by side. The check and mkdir run serialized per parent so concurrent case variants cannot both pass the
  // check; the atomic mkdir stays the authority for exact-name races.
  try {
    const lower = name.toLowerCase();
    if ((await fsp.readdir(parent)).some((n) => n.toLowerCase() === lower)) return err('already_exists');
    // A delete removing the parent must not see a new folder appear inside.
    const hold = findHold(dir);
    if (hold) return err('deleting');
    await fsp.mkdir(dir);
    return ok(undefined);
  } catch (e) {
    return err(errnoToCode(e));
  }
}

/** Creates exactly one new directory, `rel`, whose parent must already exist under the root. */
export async function makeDir(root: string, rel: RelPath, gitInit: boolean, logger: Logger): Promise<Result<CreatedEntry, MakeDirError>> {
  const segments = pathSegments(rel);
  const name = segments.pop();
  if (name === undefined) return err('invalid_path');
  const parentRel = segments.join('/') as RelPath;
  const parent = await parentOf(root, parentRel);
  if (!parent.ok) return parent;
  const dir = path.join(parent.value, name);
  const made = await serializeCreate(parent.value, () => makeOneDir(parent.value, dir, name));
  if (!made.ok) return made;

  let warning: string | undefined;
  if (gitInit) {
    try {
      const { argv, env } = hardenedGit(dir, ['init', '-q', '--', dir]);
      await promisify(execFile)('git', argv, { cwd: dir, timeout: GIT_INIT_TIMEOUT_MS, env });
    } catch (e) {
      warning = gitInitWarning(e as GitInitError);
      logger.warn(`files: git init in ${dir} failed: ${(e as Error).message}`);
    }
  }

  try {
    return ok({ entry: await describeEntry(parent.value, parentRel, await fsp.realpath(dir), name), warning });
  } catch (e) {
    return err(errnoToCode(e));
  }
}
