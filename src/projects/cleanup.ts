import { randomUUID } from "crypto";
import { promises as fsp } from "fs";
import * as path from "path";
import { isProjectDeleting } from "./chat";
import {
  CONCURRENCY,
  DiskSys,
  OVERALL_TIMEOUT_MS,
  PROJECT_TIMEOUT_MS,
} from "./disk";
import { listProjects, mapLimit, resolveProjectDir } from "./fs";
import { projectsInfo, projectsWarn } from "./log";
import {
  err,
  ok,
  parseProjectName,
  ProjectName,
  ProjectsErrorCode,
  Result,
} from "./paths";
import type { ProjectDir } from "./running";

export type CleanupKind = "node_modules" | "venv";

interface Removable {
  kind: CleanupKind;
  /** A file at the project root that says the project's own tools create this folder. */
  rootMarker: (fileName: string) => boolean;
  /** A file the folder must hold to be what its name says, or null. */
  inner: string | null;
  /** The first lockfile present at the root picks the command; `fallback` when none is. */
  restore: readonly (readonly [lockfile: string, command: string])[];
  fallback: string | null;
}

const PYTHON_MARKERS: ReadonlySet<string> = new Set([
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "setup.py",
]);

const isPythonMarker = (name: string) =>
  PYTHON_MARKERS.has(name) ||
  (name.startsWith("requirements") && name.endsWith(".txt"));

function venv(folder: string): Removable {
  return {
    kind: "venv",
    rootMarker: isPythonMarker,
    inner: "pyvenv.cfg",
    restore: [
      ["uv.lock", "uv sync"],
      [
        "requirements.txt",
        `python3 -m venv ${folder} && ${folder}/bin/pip install -r requirements.txt`,
      ],
      ["poetry.lock", "poetry install"],
    ],
    fallback: null,
  };
}

/** Folders Free up space may remove, only at the top of a project. Key order is the order they are listed in. */
const REMOVABLE = {
  node_modules: {
    kind: "node_modules",
    rootMarker: (name) => name === "package.json",
    inner: null,
    restore: [
      ["package-lock.json", "npm ci"],
      ["pnpm-lock.yaml", "pnpm install"],
      ["yarn.lock", "yarn install"],
      ["bun.lock", "bun install"],
      ["bun.lockb", "bun install"],
    ],
    fallback: "npm install",
  },
  ".venv": venv(".venv"),
  venv: venv("venv"),
} satisfies Record<string, Removable>;

export type CleanupFolder = keyof typeof REMOVABLE;
export const CLEANUP_FOLDERS = Object.keys(REMOVABLE) as CleanupFolder[];
const FOLDER_SET: ReadonlySet<string> = new Set(CLEANUP_FOLDERS);

/** A removed folder is renamed to this prefix first; what a failed rm leaves is swept by the next cleanup. */
export const LEFTOVER_PREFIX = ".pod-cleanup-";

export type CleanupSkip = "running" | "chat_active" | "deleting";

export interface CleanupDeps {
  root: string;
  disk: DiskSys;
  /** The real folders among `dirs` that something listens from or a start is booting in. */
  running(dirs: ProjectDir[]): Promise<ReadonlySet<string>>;
  chatTurnActive(name: ProjectName): boolean | Promise<boolean>;
}

interface ProjectFiles {
  dir: string;
  dev: number;
  files: ReadonlySet<string>;
}

/** The project's real folder when it is its own folder under the root; a symlinked project is an alias and is skipped. */
async function ownDir(root: string, name: ProjectName): Promise<string | null> {
  const dir = await resolveProjectDir(root, name);
  if (!dir.ok) return null;
  const realRoot = await fsp.realpath(root).catch(() => null);
  return dir.value === path.join(realRoot ?? "", name) ? dir.value : null;
}

async function readProjectFiles(dir: string): Promise<ProjectFiles | null> {
  try {
    const st = await fsp.lstat(dir);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    return { dir, dev: st.dev, files: new Set(files) };
  } catch {
    return null;
  }
}

/** The folder's path when it may be removed right now: a real directory, not a link, on the project's own filesystem. */
async function eligible(
  p: ProjectFiles,
  folder: CleanupFolder,
): Promise<string | null> {
  const r: Removable = REMOVABLE[folder];
  if (![...p.files].some(r.rootMarker)) return null;
  const target = path.join(p.dir, folder);
  try {
    const st = await fsp.lstat(target);
    if (!st.isDirectory() || st.dev !== p.dev) return null;
    if ((await fsp.realpath(target)) !== target) return null;
    if (r.inner && !(await fsp.lstat(path.join(target, r.inner))).isFile())
      return null;
    return target;
  } catch {
    return null;
  }
}

function restoreCommand(
  folder: CleanupFolder,
  files: ReadonlySet<string>,
): string | null {
  const r: Removable = REMOVABLE[folder];
  return r.restore.find(([lock]) => files.has(lock))?.[1] ?? r.fallback;
}

async function skipOf(
  deps: CleanupDeps,
  name: ProjectName,
  dir: string,
  running: ReadonlySet<string>,
): Promise<CleanupSkip | null> {
  if (isProjectDeleting(dir)) return "deleting";
  if (running.has(dir)) return "running";
  if (await deps.chatTurnActive(name)) return "chat_active";
  return null;
}

export interface CleanupFolderView {
  path: CleanupFolder;
  kind: CleanupKind;
  bytes: number | null;
  restore: string | null;
}

export interface CleanupProjectView {
  name: ProjectName;
  skipped: CleanupSkip | null;
  folders: CleanupFolderView[];
}

export interface CleanupPreview {
  supported: boolean;
  projects: CleanupProjectView[];
  /** Bytes of the folders in projects that are not skipped. */
  totalBytes: number;
  computedAt: string;
}

async function measure(
  disk: DiskSys,
  dir: string,
  deadline: number,
): Promise<number | null> {
  const left = deadline - Date.now();
  if (left <= 0) return null;
  return (await disk.du(dir, Math.min(PROJECT_TIMEOUT_MS, left))).bytes;
}

/** What a cleanup would remove now, project by project. Reads only. */
export async function previewCleanup(
  deps: CleanupDeps,
): Promise<Result<CleanupPreview, ProjectsErrorCode>> {
  if (deps.disk.platform === "win32") {
    return ok({
      supported: false,
      projects: [],
      totalBytes: 0,
      computedAt: new Date().toISOString(),
    });
  }
  const list = await listProjects(deps.root);
  if (!list.ok) return list;
  const scanned = await mapLimit(
    list.value.projects,
    CONCURRENCY,
    async ({ name }) => {
      const dir = await ownDir(deps.root, name);
      const p = dir && (await readProjectFiles(dir));
      if (!p) return null;
      const folders: CleanupFolder[] = [];
      for (const f of CLEANUP_FOLDERS)
        if (await eligible(p, f)) folders.push(f);
      return folders.length > 0 ? { name, p, folders } : null;
    },
  );
  const found = scanned.filter((s) => s !== null);
  const running = await deps.running(
    found.map(({ name, p }) => ({ name, dir: p.dir })),
  );
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  const projects = await mapLimit(
    found,
    CONCURRENCY,
    async ({ name, p, folders }): Promise<CleanupProjectView> => ({
      name,
      skipped: await skipOf(deps, name, p.dir, running),
      folders: await Promise.all(
        folders.map(async (f) => ({
          path: f,
          kind: REMOVABLE[f].kind,
          bytes: await measure(deps.disk, path.join(p.dir, f), deadline),
          restore: restoreCommand(f, p.files),
        })),
      ),
    }),
  );
  const totalBytes = projects
    .filter((p) => p.skipped === null)
    .flatMap((p) => p.folders)
    .reduce((sum, f) => sum + (f.bytes ?? 0), 0);
  return ok({
    supported: true,
    projects,
    totalBytes,
    computedAt: new Date().toISOString(),
  });
}

export interface CleanupItem {
  project: ProjectName;
  folders: CleanupFolder[];
}

export const MAX_CLEANUP_ITEMS = 200;
export const MAX_CLEANUP_BODY_BYTES = 64 * 1024;

/** The request body, strictly: duplicate projects merge, duplicate folders collapse. Errors are messages for a 400. */
export function parseCleanupRequest(
  body: unknown,
): Result<CleanupItem[], string> {
  if (Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_CLEANUP_BODY_BYTES)
    return err("The request body is larger than 64 KiB");
  const items = (body as { items?: unknown } | null)?.items;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > MAX_CLEANUP_ITEMS
  )
    return err(`items must be an array of 1 to ${MAX_CLEANUP_ITEMS} entries`);
  const merged = new Map<ProjectName, Set<CleanupFolder>>();
  for (const [i, item] of items.entries()) {
    const { project, folders } = (item ?? {}) as {
      project?: unknown;
      folders?: unknown;
    };
    const name = parseProjectName(project);
    if (!name.ok) return err(`items[${i}].project is not a valid project name`);
    if (!Array.isArray(folders) || folders.length === 0)
      return err(`items[${i}].folders must be a non-empty array`);
    const set = merged.get(name.value) ?? new Set<CleanupFolder>();
    for (const f of folders) {
      if (typeof f !== "string" || !FOLDER_SET.has(f))
        return err(
          `items[${i}].folders may hold only ${CLEANUP_FOLDERS.join(", ")}`,
        );
      set.add(f as CleanupFolder);
    }
    merged.set(name.value, set);
  }
  return ok(
    [...merged].map(([project, set]) => ({ project, folders: [...set] })),
  );
}

export type CleanupReason =
  | CleanupSkip
  | "not_eligible"
  | "not_found"
  | "unsupported"
  | "rename_failed"
  | "remove_failed";

export interface CleanupOutcome {
  project: ProjectName;
  folder: CleanupFolder;
  state: "removed" | "skipped" | "failed";
  bytes: number | null;
  reason?: CleanupReason;
}

export interface CleanupReport {
  results: CleanupOutcome[];
  freedBytes: number;
}

async function sweepLeftovers(dir: string): Promise<void> {
  const entries = await fsp
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(LEFTOVER_PREFIX)) continue;
    await fsp
      .rm(path.join(dir, e.name), { recursive: true, force: true })
      .catch((x: Error) =>
        projectsWarn(
          `projects: cleanup could not remove ${e.name} in ${dir}: ${x.message}`,
        ),
      );
  }
}

async function cleanFolder(
  deps: CleanupDeps,
  name: ProjectName,
  dir: string,
  folder: CleanupFolder,
): Promise<CleanupOutcome> {
  const outcome = (
    state: CleanupOutcome["state"],
    bytes: number | null,
    reason?: CleanupReason,
  ): CleanupOutcome => ({
    project: name,
    folder,
    state,
    bytes,
    ...(reason ? { reason } : {}),
  });
  const before = await readProjectFiles(dir);
  const target = before && (await eligible(before, folder));
  if (!target) return outcome("skipped", null, "not_eligible");
  const bytes = (await deps.disk.du(target, PROJECT_TIMEOUT_MS)).bytes;
  // du can take seconds: the project's state and the folder itself are checked again just before the rename.
  const skip = await skipOf(
    deps,
    name,
    dir,
    await deps.running([{ name, dir }]),
  );
  if (skip) return outcome("skipped", null, skip);
  const now = await readProjectFiles(dir);
  if (!now || (await eligible(now, folder)) !== target)
    return outcome("skipped", null, "not_eligible");
  const trash = path.join(dir, `${LEFTOVER_PREFIX}${randomUUID()}`);
  try {
    await fsp.rename(target, trash);
  } catch (e) {
    projectsWarn(
      `projects: cleanup could not rename ${target}: ${(e as Error).message}`,
    );
    return outcome("failed", null, "rename_failed");
  }
  try {
    await fsp.rm(trash, { recursive: true, force: true });
  } catch (e) {
    projectsWarn(
      `projects: cleanup could not remove ${trash}: ${(e as Error).message}`,
    );
    return outcome("failed", null, "remove_failed");
  }
  projectsInfo(
    `projects: cleanup removed ${folder} from ${name} (${bytes ?? "unknown"} bytes)`,
    { project: name, folder, bytes },
  );
  return outcome("removed", bytes);
}

async function cleanProject(
  deps: CleanupDeps,
  { project, folders }: CleanupItem,
): Promise<CleanupOutcome[]> {
  const skipAll = (reason: CleanupReason): CleanupOutcome[] =>
    folders.map((folder) => ({
      project,
      folder,
      state: "skipped",
      bytes: null,
      reason,
    }));
  if (deps.disk.platform === "win32") return skipAll("unsupported");
  const dir = await ownDir(deps.root, project);
  if (!dir) return skipAll("not_found");
  const skip = await skipOf(
    deps,
    project,
    dir,
    await deps.running([{ name: project, dir }]),
  );
  if (skip) return skipAll(skip);
  await sweepLeftovers(dir);
  const out: CleanupOutcome[] = [];
  for (const folder of folders)
    out.push(await cleanFolder(deps, project, dir, folder));
  return out;
}

let cleaning = false;

/**
 * Removes the requested folders that are still eligible, one project at a time. Eligibility is decided here again,
 * never taken from the client. Null when another cleanup is already running in this process.
 */
export async function runCleanup(
  deps: CleanupDeps,
  items: CleanupItem[],
): Promise<CleanupReport | null> {
  if (cleaning) return null;
  cleaning = true;
  try {
    const results: CleanupOutcome[] = [];
    for (const item of items) results.push(...(await cleanProject(deps, item)));
    const freedBytes = results
      .filter((r) => r.state === "removed")
      .reduce((sum, r) => sum + (r.bytes ?? 0), 0);
    return { results, freedBytes };
  } finally {
    cleaning = false;
  }
}
