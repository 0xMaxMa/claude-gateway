import { promises as fsp } from 'fs';
import * as path from 'path';
import { GatewayConfig } from '../types';
import { expandHome } from '../utils/paths';
import { resolveProjectDir } from './fs';
import { getStatusSummary } from './git';
import { remoteHostname } from './git-status';
import { err, ok, ProjectName, ProjectsErrorCode, resolveInside, Result } from './paths';

/** `gateway.projects.root`, which loadConfig has already validated. */
export function resolveProjectsRoot(config: GatewayConfig): string {
  return expandHome(config.gateway.projects?.root ?? '~/projects');
}

/** Why an agent cannot chat in a project: its process or its workers would not run in the folder. */
export type ProjectUnsupportedReason = 'container' | 'workspace_mode' | 'codex';

export type ProjectChatError =
  | { code: 'project_unsupported_agent'; reason: ProjectUnsupportedReason }
  | { code: 'project_not_found' }
  | { code: 'project_unavailable'; reason: ProjectsErrorCode };

/** The uppercase send-time form: a turn that cannot run because its project failed to resolve. */
export function projectUnavailableError(error: ProjectChatError): Error {
  const reason = error.code === 'project_not_found' ? 'not_found' : error.reason;
  return Object.assign(new Error(`Project folder is unavailable (${reason})`), { code: 'PROJECT_UNAVAILABLE', reason });
}

export const PROJECT_CHAT_ERRORS: Record<ProjectChatError['code'], { status: number; message: string }> = {
  project_unsupported_agent: { status: 409, message: 'This agent cannot chat in a project' },
  project_not_found: { status: 404, message: 'Project not found' },
  project_unavailable: { status: 409, message: 'Project folder is no longer available' },
};

/** Where a project-bound chat runs, and whether the project's own settings may load. */
export interface ProjectCwd {
  name: ProjectName;
  dir: string;
  trusted: boolean;
}

export async function resolveProjectCwd(config: GatewayConfig, name: ProjectName): Promise<Result<ProjectCwd, ProjectChatError>> {
  const dir = await resolveProjectDir(resolveProjectsRoot(config), name);
  if (!dir.ok) {
    return err(dir.error === 'not_found' ? { code: 'project_not_found' } : { code: 'project_unavailable', reason: dir.error });
  }
  return ok({ name, dir: dir.value, trusted: await projectTrusted(config, name) });
}

/** Named in gateway.projects.trusted, and its folder is a real directory, not a symlink. */
export async function projectTrusted(config: GatewayConfig, name: string): Promise<boolean> {
  if (!config.gateway.projects?.trusted?.includes(name)) return false;
  const dir = path.join(resolveProjectsRoot(config), name);
  return (await fsp.realpath(dir).catch(() => null)) === dir;
}

/** How every session response reports its project. */
export interface SessionProjectView {
  project: string | null;
  trusted: boolean;
}

export async function sessionProjectView(config: GatewayConfig, project: string | undefined): Promise<SessionProjectView> {
  return project ? { project, trusted: await projectTrusted(config, project) } : { project: null, trusted: false };
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
