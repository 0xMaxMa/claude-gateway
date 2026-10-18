import { execFile } from "child_process";
import { projectsWarn } from './log';
import { Dirent, promises as fsp } from "fs";
import * as path from "path";
import { promisify } from "util";
import { hardenedGit } from "./git-runner";
import { readStack, type Stack } from "./stack";
import {
  err,
  errnoToCode,
  ok,
  parseProjectName,
  ProjectName,
  ProjectsErrorCode,
  resolveInside,
  Result,
} from "./paths";

const GIT_INIT_TIMEOUT_MS = 10_000;

export interface Project {
  name: ProjectName;
  path: string;
  modified_at: string;
  is_git: boolean;
  /** Best guess at the project's stack from its root files; null when nothing marks one. */
  stack: Stack | null;
}

/** Why a folder under the root is not a project. */
export type SkipReason = 'invalid_name' | 'symlink_outside_root' | 'not_a_directory';

export interface SkippedEntry {
  name: string;
  reason: SkipReason;
}

export interface ProjectList {
  root: string;
  exists: boolean;
  projects: Project[];
  /** Folders and links the list left out, at most SKIPPED_LIMIT, sorted by name. Absent when there are none. */
  skipped?: SkippedEntry[];
  /** Hidden `.deleting-*` folders a failed delete left behind, at most SKIPPED_LIMIT, sorted. Absent when there are none. */
  leftovers?: string[];
}

export const SKIPPED_LIMIT = 50;

const DELETING_LEFTOVER_RE = /^\.deleting-/;

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

async function describeProject(
  root: string,
  realDir: string,
  name: ProjectName,
): Promise<Project> {
  const st = await fsp.stat(realDir);
  const isGit = await fsp.lstat(path.join(realDir, ".git")).then(
    () => true,
    () => false,
  );
  return {
    name,
    path: path.join(root, name),
    modified_at: st.mtime.toISOString(),
    is_git: isGit,
    stack: await readStack(realDir),
  };
}

export async function resolveProjectDir(
  root: string,
  name: ProjectName,
): Promise<FsResult<string>> {
  const realRoot = await realRootOf(root);
  if (!realRoot.ok) return realRoot;
  const dir = await resolveInside(realRoot.value, name);
  if (!dir.ok) return dir;
  // A link such as `all -> .` would make one project span every other project.
  if (dir.value === realRoot.value) return err("path_escape");
  const st = await fsp.stat(dir.value).catch(() => null);
  if (!st) return err("not_found");
  return st.isDirectory() ? dir : err("not_a_directory");
}

/** Bounds the open file handles a large root costs one list request. */
const LIST_CONCURRENCY = 16;

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

export async function listProjects(
  root: string,
): Promise<FsResult<ProjectList>> {
  const realRoot = await realRootOf(root);
  if (!realRoot.ok) {
    return realRoot.error === "not_found"
      ? ok({ root, exists: false, projects: [] })
      : realRoot;
  }
  let dirents: Dirent[];
  try {
    dirents = await fsp.readdir(realRoot.value, { withFileTypes: true });
  } catch (e) {
    return err(errnoToCode(e));
  }

  const described = await mapLimit(
    dirents,
    LIST_CONCURRENCY,
    async (d): Promise<{ project: Project } | { skipped: SkippedEntry } | { leftover: string } | null> => {
      if (!(d.isDirectory() || d.isSymbolicLink())) return null;
      if (d.isDirectory() && DELETING_LEFTOVER_RE.test(d.name)) return { leftover: d.name };
      // Names the other routes would reject are hidden so every listed project can be opened.
      const name = parseProjectName(d.name);
      if (!name.ok) return { skipped: { name: d.name, reason: "invalid_name" } };
      const dir = await resolveProjectDir(root, name.value);
      if (!dir.ok) {
        const reason = dir.error === "path_escape" ? "symlink_outside_root" : dir.error === "not_a_directory" ? "not_a_directory" : null;
        return reason ? { skipped: { name: d.name, reason } } : null;
      }
      // Vanished or unreadable between readdir and stat: not listable.
      const project = await describeProject(realRoot.value, dir.value, name.value).catch(() => null);
      return project ? { project } : null;
    },
  );
  const projects: Project[] = [];
  const skipped: SkippedEntry[] = [];
  const leftovers: string[] = [];
  for (const item of described) {
    if (item && "project" in item) projects.push(item.project);
    else if (item && "skipped" in item) skipped.push(item.skipped);
    else if (item) leftovers.push(item.leftover);
  }
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  projects.sort((a, b) => byName(a.name, b.name));
  skipped.sort((a, b) => byName(a.name, b.name));
  leftovers.sort(byName);
  return ok({
    root: realRoot.value,
    exists: true,
    projects,
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
  if (typeof e.code === "number")
    return `git init failed (exit code ${e.code})`;
  if (typeof e.code === "string" && /^E[A-Z]+$/.test(e.code))
    return `git init failed (${e.code})`;
  return "git init failed";
}

/** Tail of the create chain per root; the gateway is the only process creating projects there. */
const createQueues = new Map<string, Promise<unknown>>();

function serializeCreate<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const run = (createQueues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  createQueues.set(key, tail);
  void tail.then(() => {
    if (createQueues.get(key) === tail) createQueues.delete(key);
  });
  return run;
}

async function makeProjectDir(
  root: string,
  dir: string,
  name: ProjectName,
): Promise<FsResult<void>> {
  try {
    await fsp.mkdir(root, { recursive: true });
  } catch (e) {
    // A recursive mkdir only fails with EEXIST when the root is a non-directory.
    return err(
      (e as NodeJS.ErrnoException).code === "EEXIST"
        ? "not_a_directory"
        : errnoToCode(e),
    );
  }
  // Case-folding filesystems already answer EEXIST; this makes Linux agree so a
  // client never gets "Site" and "site" side by side. The check and mkdir run
  // serialized per root so concurrent case variants cannot both pass the check;
  // the atomic mkdir stays the authority for exact-name races.
  try {
    const lower = name.toLowerCase();
    if ((await fsp.readdir(root)).some((n) => n.toLowerCase() === lower)) {
      return err("project_exists");
    }
    await fsp.mkdir(dir);
    return ok(undefined);
  } catch (e) {
    return err(errnoToCode(e));
  }
}

export async function createProject(
  root: string,
  name: ProjectName,
  gitInit: boolean,
): Promise<FsResult<CreatedProject>> {
  const dir = path.join(root, name);
  const made = await serializeCreate(root, () =>
    makeProjectDir(root, dir, name),
  );
  if (!made.ok) return made;

  let warning: string | undefined;
  if (gitInit) {
    try {
      const { argv, env } = hardenedGit(dir, ["init", "-q", "--", dir]);
      await promisify(execFile)("git", argv, {
        cwd: dir,
        timeout: GIT_INIT_TIMEOUT_MS,
        env,
      });
    } catch (e) {
      warning = gitInitWarning(e as GitInitError);
      projectsWarn(
        `projects: git init in ${dir} failed: ${(e as Error).message}`,
      );
    }
  }

  try {
    const project = await describeProject(
      await fsp.realpath(root),
      await fsp.realpath(dir),
      name,
    );
    return ok({ project, warning });
  } catch (e) {
    return err(errnoToCode(e));
  }
}
