import { promises as fsp } from 'fs';
import * as path from 'path';
import { GatewayConfig } from '../types';
import { expandHome } from '../utils/paths';
import { resolveProjectDir } from './fs';
import { getStatusSummary } from './git';
import { remoteHostname } from './git-status';
import { DEFAULT_PROJECTS_ROOT, err, ok, ProjectName, ProjectsErrorCode, resolveInside, Result } from './paths';

/** `gateway.projects.root`, which loadConfig has already validated. */
export function resolveProjectsRoot(config: GatewayConfig): string {
  return expandHome(config.gateway.projects?.root ?? DEFAULT_PROJECTS_ROOT);
}

/** Why an agent cannot chat in a project: its process or its workers would not run in the folder. */
export type ProjectUnsupportedReason = 'container' | 'workspace_mode' | 'codex';

export type ProjectChatError =
  | { code: 'project_unsupported_agent'; reason: ProjectUnsupportedReason }
  | { code: 'project_not_found' }
  | { code: 'projects_disabled' }
  | { code: 'project_unavailable'; reason: ProjectsErrorCode | 'project_deleting' };

/** The uppercase send-time form: a turn that cannot run because its project failed to resolve. */
export function projectUnavailableError(error: ProjectChatError): Error {
  const reason = error.code === 'project_not_found' ? 'not_found' : error.code === 'projects_disabled' ? 'projects_disabled' : error.reason;
  return Object.assign(new Error(`Project folder is unavailable (${reason})`), { code: 'PROJECT_UNAVAILABLE', reason });
}

export const PROJECT_CHAT_ERRORS: Record<ProjectChatError['code'], { status: number; message: string }> = {
  project_unsupported_agent: { status: 409, message: 'This agent cannot chat in a project' },
  project_not_found: { status: 404, message: 'Project not found' },
  projects_disabled: { status: 409, message: 'Projects are disabled on this gateway' },
  project_unavailable: { status: 409, message: 'Project folder is no longer available' },
};

/** Where a project-bound chat runs, and whether the project's own settings may load. */
export interface ProjectCwd {
  name: ProjectName;
  dir: string;
  trusted: boolean;
  /** `dev:ino` of the folder, so a project deleted and recreated under the same name reads as moved. */
  identity: string;
}

/** loadConfig sets `enabled: false` when the default root would expose HOME or the config dir. */
export function projectsEnabled(config: GatewayConfig): boolean {
  return config.gateway.projects?.enabled !== false;
}

const deletingProjects = new Set<string>();

/**
 * Marks `name` as being deleted, so no chat turn or worker starts in it between the delete guard and the rename.
 * Returns the release function, or null when another delete already holds the name.
 */
export function markProjectDeleting(name: ProjectName): (() => void) | null {
  if (deletingProjects.has(name)) return null;
  deletingProjects.add(name);
  return () => void deletingProjects.delete(name);
}

export async function resolveProjectCwd(config: GatewayConfig, name: ProjectName): Promise<Result<ProjectCwd, ProjectChatError>> {
  if (!projectsEnabled(config)) return err({ code: 'projects_disabled' });
  if (deletingProjects.has(name)) return err({ code: 'project_unavailable', reason: 'project_deleting' });
  const dir = await resolveProjectDir(resolveProjectsRoot(config), name);
  if (!dir.ok) {
    return err(dir.error === 'not_found' ? { code: 'project_not_found' } : { code: 'project_unavailable', reason: dir.error });
  }
  const st = await fsp.stat(dir.value).catch(() => null);
  if (!st) return err({ code: 'project_not_found' });
  return ok({ name, dir: dir.value, trusted: await projectTrusted(config, name), identity: `${st.dev}:${st.ino}` });
}

/** Named in gateway.projects.trusted, and its folder is a real directory, not a symlink. */
export async function projectTrusted(config: GatewayConfig, name: string): Promise<boolean> {
  if (!config.gateway.projects?.trusted?.includes(name)) return false;
  const realRoot = await fsp.realpath(resolveProjectsRoot(config)).catch(() => null);
  if (!realRoot) return false;
  const dir = path.join(realRoot, name);
  return (await fsp.realpath(dir).catch(() => null)) === dir;
}

/** Whether a bound chat's folder still resolves: `missing` when deleted or renamed, `unavailable` when it escapes the root or is not a folder. */
export type ProjectState = 'available' | 'missing' | 'unavailable';

/** How every session response reports its project. */
export interface SessionProjectView {
  project: string | null;
  trusted: boolean;
  projectState: ProjectState | null;
}

export async function sessionProjectView(config: GatewayConfig, project: string | undefined): Promise<SessionProjectView> {
  if (!project) return { project: null, trusted: false, projectState: null };
  const resolved = await resolveProjectCwd(config, project as ProjectName);
  if (resolved.ok) return { project, trusted: resolved.value.trusted, projectState: 'available' };
  return { project, trusted: false, projectState: resolved.error.code === 'project_not_found' ? 'missing' : 'unavailable' };
}

/** `requested`, relative to or absolute under the project folder, resolved through symlinks; path_escape if it leaves. */
export function resolveInProject(dir: string, requested: string): Promise<Result<string, ProjectsErrorCode>> {
  return resolveInside(dir, path.relative(dir, path.resolve(dir, requested)));
}

/** The part of the project note that never changes during a chat. */
export function projectLocation(project: ProjectCwd): string {
  return `You are working in project ${project.name} at ${project.dir}.`;
}

/** A branch name the note may carry verbatim. Git allows far more, and the note is a prompt. */
const PLAIN_BRANCH_RE = /^[\w./-]{1,100}$/;

/**
 * One line telling the agent where it works: the project, its folder and, when git answers
 * within the read timeout, branch, change count and remote host. Never a remote URL, which
 * can carry a token, and never a branch name outside the whitelist.
 */
export async function projectContext(config: GatewayConfig, project: ProjectCwd): Promise<string> {
  const where = projectLocation(project);
  const status = await getStatusSummary(resolveProjectsRoot(config), project.name).catch(() => null);
  if (!status?.ok) return where;
  const s = status.value;
  const host = s.remote ? remoteHostname(s.remote.url) : null;
  const git = [
    ...(s.branch === null ? ['detached HEAD'] : PLAIN_BRANCH_RE.test(s.branch) ? [`branch ${s.branch}`] : []),
    `${s.change_count} ${s.change_count === 1 ? 'change' : 'changes'}`,
    ...(host ? [`remote ${host}`] : []),
  ];
  return `${where} Git: ${git.join(', ')}.`;
}
