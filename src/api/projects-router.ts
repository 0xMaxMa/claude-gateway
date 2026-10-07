import { NextFunction, Request, Response, Router } from 'express';
import { ApiKey, GatewayConfig } from '../types';
import { expandHome } from '../utils/paths';
import { createApiAuthMiddleware, canAccessPod } from './auth';
import { defineRoute } from './route-registry';
import { createProject, listDir, listProjects, readFileContent } from '../projects/fs';
import { commitAll, fetchRemote, getStatus, getSummaries, GitError, GitErrorCode, initRepo, parseCommitRequest, parseIdentity, pullFastForward, pushBranch, setIdentity } from '../projects/git';
import { parseProjectName, parseRelPath, ProjectName, ProjectsErrorCode, Result } from '../projects/paths';

type AuthedRequest = Request & { apiKey: ApiKey };

const ERRORS: Record<ProjectsErrorCode | GitErrorCode, { status: number; message: string }> = {
  invalid_name: { status: 400, message: 'Invalid project name' },
  invalid_path: { status: 400, message: 'Invalid path' },
  not_a_directory: { status: 400, message: 'Not a directory' },
  not_a_file: { status: 400, message: 'Not a regular file' },
  path_escape: { status: 403, message: 'Path resolves outside the project' },
  permission_denied: { status: 403, message: 'Permission denied' },
  forbidden_key: { status: 403, message: 'API key not permitted for this operation' },
  not_found: { status: 404, message: 'Not found' },
  project_exists: { status: 409, message: 'Project already exists' },
  internal: { status: 500, message: 'Internal error' },
  not_a_git_repo: { status: 409, message: 'Project is not a git repository' },
  already_a_git_repo: { status: 409, message: 'Project is already a git repository' },
  nothing_to_commit: { status: 409, message: 'Nothing to commit' },
  message_required: { status: 400, message: 'A commit message is required' },
  identity_missing: { status: 409, message: 'Git user.name and user.email are not set' },
  identity_already_set: { status: 409, message: 'Git identity is already configured' },
  invalid_identity: { status: 400, message: 'Invalid git name or email' },
  sensitive_files: { status: 409, message: 'Untracked files look like secrets' },
  conflicts_present: { status: 409, message: 'Resolve merge conflicts first' },
  operation_in_progress: { status: 409, message: 'A merge, rebase or similar operation is in progress' },
  not_fast_forward: { status: 409, message: 'Branch has diverged from its upstream' },
  dirty_would_overwrite: { status: 409, message: 'Local changes would be overwritten' },
  no_remote: { status: 409, message: 'No git remote is configured' },
  no_upstream: { status: 409, message: 'Branch has no upstream' },
  detached_head: { status: 409, message: 'HEAD is detached' },
  auth_failed: { status: 502, message: 'The git remote refused the credentials' },
  network: { status: 502, message: 'Could not reach the git remote' },
  timeout: { status: 504, message: 'Git took too long' },
  hook_failed: { status: 422, message: 'A git hook rejected the commit' },
  busy: { status: 409, message: 'Another git operation is running on this project' },
  index_locked: { status: 409, message: 'The git index is locked' },
  git_failed: { status: 500, message: 'Git failed' },
};

function fail(res: Response, error: ProjectsErrorCode | GitError): void {
  const body = typeof error === 'string' ? { code: error } : error;
  const { status, message } = ERRORS[body.code];
  res.status(status).json({ error: message, ...body });
}

function respond<T>(res: Response, result: Result<T, ProjectsErrorCode | GitError>, status = 200): void {
  if (result.ok) res.status(status).json(result.value);
  else fail(res, result.error);
}

function requirePod(req: Request, res: Response, next: NextFunction): void {
  if (canAccessPod((req as AuthedRequest).apiKey)) next();
  else fail(res, 'forbidden_key');
}

function requireWrite(req: Request, res: Response, next: NextFunction): void {
  const key = (req as AuthedRequest).apiKey;
  if (key.admin || key.write === true) next();
  else fail(res, 'forbidden_key');
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    fn(req, res).catch(() => fail(res, 'internal'));
  };
}

/** `gateway.projects.root`, which loadConfig has already validated. */
export function resolveProjectsRoot(config: GatewayConfig): string {
  return expandHome(config.gateway.projects?.root ?? '~/projects');
}

/**
 * Pod-wide project browsing under `root`. Every route needs a key that can see
 * all agents, since projects are not agent-scoped.
 */
export function createProjectsRouter(apiKeys: ApiKey[], root: string): Router {
  const router = Router();
  const auth = createApiAuthMiddleware(apiKeys);

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects', auth: 'key', summary: 'List projects under the configured projects root', cli: null },
    auth,
    requirePod,
    handle(async (_req, res) => respond(res, await listProjects(root))),
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/projects', auth: 'key', summary: 'Create a project directory', cli: null },
    auth,
    requirePod,
    requireWrite,
    handle(async (req, res) => {
      const body = (req.body ?? {}) as { name?: unknown; git_init?: unknown };
      const name = parseProjectName(body.name);
      if (!name.ok) return fail(res, name.error);
      respond(res, await createProject(root, name.value, body.git_init === true), 201);
    }),
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/:name/tree', auth: 'key', summary: 'List one directory level of a project', cli: null },
    auth,
    requirePod,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      const rel = parseRelPath(req.query.path);
      if (!rel.ok) return fail(res, rel.error);
      respond(res, await listDir(root, name.value, rel.value));
    }),
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/:name/file', auth: 'key', summary: 'Read a file from a project', cli: null },
    auth,
    requirePod,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      const rel = parseRelPath(req.query.path);
      if (!rel.ok) return fail(res, rel.error);
      respond(res, await readFileContent(root, name.value, rel.value));
    }),
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/git-summary', auth: 'key', summary: 'Git sync summary for every project that is a repository', cli: null },
    auth,
    requirePod,
    handle(async (_req, res) => respond(res, await getSummaries(root))),
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/:name/git', auth: 'key', summary: 'Git status of a project', cli: null },
    auth,
    requirePod,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      respond(res, await getStatus(root, name.value));
    }),
  );

  const mutations: Array<{
    action: string;
    summary: string;
    status: number;
    run: (name: ProjectName, body: unknown) => Promise<Result<unknown, ProjectsErrorCode | GitError>>;
  }> = [
    { action: 'init', summary: 'Initialise a git repository in a project', status: 201, run: (name) => initRepo(root, name) },
    { action: 'fetch', summary: "Fetch and prune the project's git remote", status: 200, run: (name) => fetchRemote(root, name) },
    {
      action: 'identity',
      summary: 'Set the repository-local git user.name and user.email',
      status: 200,
      run: async (name, body) => {
        const id = parseIdentity(body);
        return id.ok ? setIdentity(root, name, id.value) : id;
      },
    },
    {
      action: 'commit',
      summary: 'Stage every change in a project and commit it',
      status: 201,
      run: async (name, body) => {
        const req = parseCommitRequest(body);
        return req.ok ? commitAll(root, name, req.value) : req;
      },
    },
    { action: 'pull', summary: 'Fast-forward a project to its upstream', status: 200, run: (name) => pullFastForward(root, name) },
    { action: 'push', summary: 'Push a project branch without force', status: 200, run: (name) => pushBranch(root, name) },
  ];

  for (const m of mutations) {
    defineRoute(
      router,
      { method: 'POST', path: `/v1/projects/:name/git/${m.action}`, auth: 'key', summary: m.summary, cli: null },
      auth,
      requirePod,
      requireWrite,
      handle(async (req, res) => {
        const name = parseProjectName(req.params.name);
        if (!name.ok) return fail(res, name.error);
        respond(res, await m.run(name.value, req.body), m.status);
      }),
    );
  }

  return router;
}
