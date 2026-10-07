import { execFile } from 'child_process';
import { constants as fsConstants, Dirent, promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import {
  err,
  errnoToCode,
  isInside,
  joinRel,
  ok,
  parseProjectName,
  ProjectName,
  ProjectsErrorCode,
  RelPath,
  resolveInside,
  Result,
} from './paths';

const execFileAsync = promisify(execFile);

const FILE_SIZE_LIMIT = 1024 * 1024;
export const TREE_ENTRY_LIMIT = 2000;
const BINARY_SNIFF_BYTES = 8192;
const GIT_INIT_TIMEOUT_MS = 10_000;

export interface Project {
  name: ProjectName;
  path: string;
  modified_at: string;
  is_git: boolean;
}

export type SymlinkTargetKind = 'file' | 'dir' | 'outside' | 'dangling';

export type FileEntry =
  | { kind: 'dir'; name: string; path: RelPath; modified_at: string }
  | { kind: 'file'; name: string; path: RelPath; size: number; modified_at: string }
  | { kind: 'symlink'; name: string; path: RelPath; target_kind: SymlinkTargetKind }
  | { kind: 'other'; name: string; path: RelPath };

export type FileContent =
  | { kind: 'text'; path: RelPath; size: number; modified_at: string; content: string }
  | { kind: 'binary'; path: RelPath; size: number; modified_at: string }
  | { kind: 'too_large'; path: RelPath; size: number; modified_at: string; limit: number };

export interface ProjectList {
  root: string;
  exists: boolean;
  projects: Project[];
}

export interface DirListing {
  path: RelPath;
  entries: FileEntry[];
  truncated: boolean;
}

export interface CreatedProject {
  project: Project;
  warning?: string;
}

type FsResult<T> = Result<T, ProjectsErrorCode>;

async function realRootOf(root: string): Promise<FsResult<string>> {
  try {
    return ok(await fsp.realpath(root));
  } catch (e) {
    return err(errnoToCode(e));
  }
}

async function describeProject(root: string, realDir: string, name: ProjectName): Promise<Project> {
  const st = await fsp.stat(realDir);
  const isGit = await fsp.lstat(path.join(realDir, '.git')).then(
    () => true,
    () => false,
  );
  return { name, path: path.join(root, name), modified_at: st.mtime.toISOString(), is_git: isGit };
}

async function resolveProjectDir(root: string, name: ProjectName): Promise<FsResult<string>> {
  const realRoot = await realRootOf(root);
  if (!realRoot.ok) return realRoot;
  const dir = await resolveInside(realRoot.value, name);
  if (!dir.ok) return dir;
  const st = await fsp.stat(dir.value).catch(() => null);
  if (!st) return err('not_found');
  return st.isDirectory() ? dir : err('not_a_directory');
}

export async function listProjects(root: string): Promise<FsResult<ProjectList>> {
  const realRoot = await realRootOf(root);
  if (!realRoot.ok) {
    return realRoot.error === 'not_found' ? ok({ root, exists: false, projects: [] }) : realRoot;
  }
  let dirents: Dirent[];
  try {
    dirents = await fsp.readdir(realRoot.value, { withFileTypes: true });
  } catch (e) {
    return err(errnoToCode(e));
  }

  const projects: Project[] = [];
  for (const d of dirents) {
    // Names the other routes would reject are hidden so every listed project can be opened.
    const name = parseProjectName(d.name);
    if (!name.ok || !(d.isDirectory() || d.isSymbolicLink())) continue;
    const dir = await resolveProjectDir(root, name.value);
    if (!dir.ok) continue;
    try {
      projects.push(await describeProject(realRoot.value, dir.value, name.value));
    } catch {
      // Vanished or unreadable between readdir and stat: not listable.
    }
  }
  projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return ok({ root: realRoot.value, exists: true, projects });
}

/** execFile rejects with a numeric exit code, or an errno string when git could not be spawned. */
type GitInitError = Error & { code?: number | string; signal?: NodeJS.Signals | null };

/** Built only from the exit status: git's stderr can carry paths and config the client must not see. */
function gitInitWarning(e: GitInitError): string {
  if (e.signal) return `git init failed (signal ${e.signal})`;
  if (typeof e.code === 'number') return `git init failed (exit code ${e.code})`;
  if (typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code)) return `git init failed (${e.code})`;
  return 'git init failed';
}

export async function createProject(
  root: string,
  name: ProjectName,
  gitInit: boolean,
): Promise<FsResult<CreatedProject>> {
  const dir = path.join(root, name);
  try {
    await fsp.mkdir(root, { recursive: true });
  } catch (e) {
    // A recursive mkdir only fails with EEXIST when the root is a non-directory.
    return err((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'not_a_directory' : errnoToCode(e));
  }
  try {
    await fsp.mkdir(dir);
  } catch (e) {
    return err(errnoToCode(e));
  }

  let warning: string | undefined;
  if (gitInit) {
    try {
      // GIT_DIR, GIT_WORK_TREE and friends would aim git init at another repository.
      // env is built from process.env explicitly: jest gives tests a copy that child_process ignores.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
      await execFileAsync('git', ['init', '-q', '--', dir], { cwd: dir, timeout: GIT_INIT_TIMEOUT_MS, env });
    } catch (e) {
      warning = gitInitWarning(e as GitInitError);
      console.warn(`projects: git init in ${dir} failed: ${(e as Error).message}`);
    }
  }

  try {
    const project = await describeProject(root, await fsp.realpath(dir), name);
    return ok({ project, warning });
  } catch (e) {
    return err(errnoToCode(e));
  }
}

async function symlinkTargetKind(realProjectDir: string, linkPath: string): Promise<SymlinkTargetKind> {
  let real: string;
  try {
    real = await fsp.realpath(linkPath);
  } catch {
    return 'dangling';
  }
  if (!isInside(realProjectDir, real)) return 'outside';
  const st = await fsp.stat(real).catch(() => null);
  if (!st) return 'dangling';
  return st.isDirectory() ? 'dir' : 'file';
}

async function toEntry(realProjectDir: string, realDir: string, rel: RelPath, d: Dirent): Promise<FileEntry | null> {
  const abs = path.join(realDir, d.name);
  const entryPath = joinRel(rel, d.name);
  if (d.isSymbolicLink()) {
    return { kind: 'symlink', name: d.name, path: entryPath, target_kind: await symlinkTargetKind(realProjectDir, abs) };
  }
  if (!d.isDirectory() && !d.isFile()) return { kind: 'other', name: d.name, path: entryPath };
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) return null;
  const modified_at = st.mtime.toISOString();
  return d.isDirectory()
    ? { kind: 'dir', name: d.name, path: entryPath, modified_at }
    : { kind: 'file', name: d.name, path: entryPath, size: st.size, modified_at };
}

export async function listDir(root: string, name: ProjectName, rel: RelPath): Promise<FsResult<DirListing>> {
  const projectDir = await resolveProjectDir(root, name);
  if (!projectDir.ok) return projectDir;
  const dir = await resolveInside(projectDir.value, rel);
  if (!dir.ok) return dir;

  let dirents: Dirent[];
  try {
    dirents = await fsp.readdir(dir.value, { withFileTypes: true });
  } catch (e) {
    return err(errnoToCode(e));
  }
  // A path component may have been swapped for a symlink between realpath and readdir.
  const after = await resolveInside(projectDir.value, rel);
  if (!after.ok) return after;
  if (after.value !== dir.value) return err('path_escape');

  // Sort and cap on dirent data first so a huge directory costs one lstat per kept entry.
  dirents.sort((a, b) => {
    const byKind = Number(b.isDirectory()) - Number(a.isDirectory());
    if (byKind !== 0) return byKind;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const kept = dirents.slice(0, TREE_ENTRY_LIMIT);
  const entries = (await Promise.all(kept.map((d) => toEntry(projectDir.value, dir.value, rel, d)))).filter(
    (e): e is FileEntry => e !== null,
  );
  return ok({ path: rel, entries, truncated: dirents.length > TREE_ENTRY_LIMIT });
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeText(buf: Buffer): string | null {
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  try {
    return utf8.decode(buf);
  } catch {
    return null;
  }
}

/**
 * Where the open fd really points, so a parent directory swapped for a symlink
 * after realpath is caught. Needs /proc; other platforms keep only the realpath check.
 */
async function openedInside(handle: fsp.FileHandle, realProjectDir: string): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  const opened = await fsp.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  return opened !== null && isInside(realProjectDir, opened);
}

export async function readFileContent(root: string, name: ProjectName, rel: RelPath): Promise<FsResult<FileContent>> {
  const projectDir = await resolveProjectDir(root, name);
  if (!projectDir.ok) return projectDir;
  const file = await resolveInside(projectDir.value, rel);
  if (!file.ok) return file;

  let handle: fsp.FileHandle;
  try {
    // O_NONBLOCK so a FIFO fails the isFile check instead of blocking open() until a writer appears.
    handle = await fsp.open(file.value, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    return err(errnoToCode(e));
  }
  try {
    if (!(await openedInside(handle, projectDir.value))) return err('path_escape');
    const st = await handle.stat();
    if (!st.isFile()) return err('not_a_file');
    const meta = { path: rel, size: st.size, modified_at: st.mtime.toISOString() };
    if (st.size > FILE_SIZE_LIMIT) return ok({ kind: 'too_large', ...meta, limit: FILE_SIZE_LIMIT });

    const buf = Buffer.alloc(st.size);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const content = decodeText(buf.subarray(0, filled));
    return ok(content === null ? { kind: 'binary', ...meta } : { kind: 'text', ...meta, content });
  } catch (e) {
    return err(errnoToCode(e));
  } finally {
    await handle.close();
  }
}
