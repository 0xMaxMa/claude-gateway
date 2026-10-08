import { GatewayConfig } from '../types';
import { expandHome } from '../utils/paths';
import { resolveProjectDir } from './fs';
import { getStatus } from './git';
import { remoteHostname } from './git-status';
import { err, ok, ProjectName, ProjectsErrorCode, Result } from './paths';

/** `gateway.projects.root`, which loadConfig has already validated. */
export function resolveProjectsRoot(config: GatewayConfig): string {
  return expandHome(config.gateway.projects?.root ?? '~/projects');
}

export type ProjectChatError =
  | { code: 'project_unsupported_agent'; reason: 'container' | 'orchestrated' }
  | { code: 'project_not_found' }
  | { code: 'project_unavailable'; reason: ProjectsErrorCode };

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
  return ok({ name, dir: dir.value, trusted: config.gateway.projects?.trusted?.includes(name) ?? false });
}

/**
 * One line telling the agent where it works: the project, its folder and, when git answers
 * within the read timeout, branch, change count and remote host. Never a remote URL, which
 * can carry a token.
 */
export async function projectContext(config: GatewayConfig, project: ProjectCwd): Promise<string> {
  const where = `You are working in project ${project.name} at ${project.dir}.`;
  const status = await getStatus(resolveProjectsRoot(config), project.name).catch(() => null);
  if (!status?.ok) return where;
  const s = status.value;
  const host = s.remote ? remoteHostname(s.remote.url) : null;
  const git = [
    s.branch ? `branch ${s.branch}` : 'detached HEAD',
    `${s.change_count} ${s.change_count === 1 ? 'change' : 'changes'}`,
    ...(host ? [`remote ${host}`] : []),
  ];
  return `${where} Git: ${git.join(', ')}.`;
}
