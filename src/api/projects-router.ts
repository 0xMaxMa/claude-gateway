import * as path from 'path';
import { NextFunction, Request, Response, Router } from 'express';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, canAccessPod } from './auth';
import { defineRoute } from './route-registry';
import { createProject, listDir, resolveProjectDir, listProjects, readFileContent } from '../projects/fs';
import { commitAll, fetchRemote, getStatus, getSummaries, GitError, GitErrorCode, initRepo, parseCommitRequest, parseIdentity, pullFastForward, pushBranch, setIdentity } from '../projects/git';
import { listRunning, ProjectDir, RunningErrorCode, scanProjects, StopLimiter, stopRunning, Sys, systemSys } from '../projects/running';
import { planStart, PORT_MIN, readStartFacts, startProject, StartError, StartErrorCode, StartGuard, Launcher, systemLauncher } from '../projects/start';
import { DeleteErrorCode, removeProject } from '../projects/delete';
import { parseProjectName, parseRelPath, ProjectName, ProjectsErrorCode, Result } from '../projects/paths';

type AuthedRequest = Request & { apiKey: ApiKey };

const MAX_RUNNING_PROJECTS = 200;

const ERRORS: Record<ProjectsErrorCode | GitErrorCode | RunningErrorCode | StartErrorCode | DeleteErrorCode, { status: number; message: string }> = {
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
  sensitive_files: { status: 409, message: 'New files look like secrets' },
  invalid_allow_sensitive: { status: 400, message: 'allow_sensitive must be an array of paths' },
  conflicts_present: { status: 409, message: 'Resolve merge conflicts first' },
  operation_in_progress: { status: 409, message: 'A merge, rebase or similar operation is in progress' },
  not_fast_forward: { status: 409, message: 'Branch has diverged from its upstream' },
  remote_rejected: { status: 409, message: 'The git remote refused the update' },
  dirty_would_overwrite: { status: 409, message: 'Local changes would be overwritten' },
  no_remote: { status: 409, message: 'No git remote is configured' },
  no_upstream: { status: 409, message: 'Branch has no upstream' },
  upstream_mismatch: { status: 409, message: 'Branch tracks an upstream with a different name' },
  no_commits: { status: 409, message: 'Branch has no commits to publish' },
  detached_head: { status: 409, message: 'HEAD is detached' },
  auth_failed: { status: 502, message: 'The git remote refused the credentials' },
  network: { status: 502, message: 'Could not reach the git remote' },
  timeout: { status: 504, message: 'Git took too long' },
  hook_failed: { status: 422, message: 'A git hook rejected the commit' },
  busy: { status: 409, message: 'Another git operation is running on this project' },
  index_locked: { status: 409, message: 'The git index is locked' },
  git_failed: { status: 500, message: 'Git failed' },
  nothing_running: { status: 409, message: 'Nothing is running in this project' },
  invalid_port: { status: 400, message: 'port must be an integer between 1 and 65535' },
  no_start_command: { status: 422, message: 'The project files do not say how to start it' },
  already_running: { status: 409, message: 'Something is already running in this project' },
  port_in_use: { status: 409, message: 'That port is in use' },
  no_free_port: { status: 409, message: 'No free port between 3000 and 3099' },
  start_failed: { status: 502, message: 'The project exited before it started listening' },
  start_timeout: { status: 504, message: 'The project did not start listening in time' },
  confirm_mismatch: { status: 400, message: 'confirm must be the exact project name' },
  project_running: { status: 409, message: 'Stop what is running in this project first' },
};

function fail(res: Response, error: ProjectsErrorCode | RunningErrorCode | DeleteErrorCode | GitError | StartError): void {
  const body = typeof error === 'string' ? { code: error } : error;
  const { status, message } = ERRORS[body.code];
  res.status(status).json({ error: message, ...body });
}

function respond<T>(res: Response, result: Result<T, ProjectsErrorCode | RunningErrorCode | DeleteErrorCode | GitError | StartError>, status = 200): void {
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

/**
 * Pod-wide project browsing under `root`. Every route needs a key that can see
 * all agents, since projects are not agent-scoped.
 */
export interface RunningDeps {
  sys: Sys;
  limiter: StopLimiter;
  launcher?: Launcher;
  starts?: StartGuard;
  /** Where start logs go and how long a start waits; set by tests. */
  logDir?: string;
  startWaitMs?: number;
}

export function createProjectsRouter(
  apiKeys: ApiKey[],
  root: string,
  running: RunningDeps = { sys: systemSys(), limiter: new StopLimiter() },
): Router {
  const launcher = running.launcher ?? systemLauncher;
  const starts = running.starts ?? new StartGuard();
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
    { method: 'DELETE', path: '/v1/projects/:name', auth: 'key', summary: 'Delete a project folder and everything in it', cli: null },
    auth,
    requirePod,
    requireWrite,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      if ((req.body ?? {}).confirm !== name.value) return fail(res, 'confirm_mismatch');
      const dir = await resolveProjectDir(root, name.value);
      if (!dir.ok) return fail(res, dir.error);
      const listening = await listRunning(running.sys, dir.value);
      if (listening.processes.length > 0) return fail(res, 'project_running');
      respond(res, await removeProject(root, name.value));
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
    { method: 'GET', path: '/v1/projects/running', auth: 'key', summary: 'Processes listening from inside each project', cli: null },
    auth,
    requirePod,
    handle(async (_req, res) => {
      const list = await listProjects(root);
      if (!list.ok) return fail(res, list.error);
      const dirs: ProjectDir[] = [];
      for (const p of list.value.projects.slice(0, MAX_RUNNING_PROJECTS)) {
        const dir = await resolveProjectDir(root, p.name);
        if (dir.ok) dirs.push({ name: p.name, dir: dir.value });
      }
      res.json(await scanProjects(running.sys, dirs));
    }),
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

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/:name/running', auth: 'key', summary: 'Processes listening on a port from inside a project', cli: null },
    auth,
    requirePod,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      const dir = await resolveProjectDir(root, name.value);
      if (!dir.ok) return fail(res, dir.error);
      const plan = planStart(await readStartFacts(dir.value));
      res.json({ ...(await listRunning(running.sys, dir.value)), start: plan ? { command: plan.display(PORT_MIN) } : null });
    }),
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/projects/:name/running/stop', auth: 'key', summary: "Stop the processes listening from inside a project", cli: null },
    auth,
    requirePod,
    requireWrite,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      const port = (req.body ?? {}).port;
      if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return fail(res, 'invalid_port');
      const dir = await resolveProjectDir(root, name.value);
      if (!dir.ok) return fail(res, dir.error);
      if (!running.limiter.take(name.value)) {
        const now = await listRunning(running.sys, dir.value);
        res.json({ stopped: [], remaining: now.processes.map(({ port: p, pids }) => ({ port: p, pids })) });
        return;
      }
      respond(res, await stopRunning(running.sys, dir.value, port));
    }),
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/projects/:name/running/start', auth: 'key', summary: 'Start a project the way its own files say, on a free port', cli: null },
    auth,
    requirePod,
    requireWrite,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      const port = (req.body ?? {}).port;
      const dir = await resolveProjectDir(root, name.value);
      if (!dir.ok) return fail(res, dir.error);
      const result = await starts.run(name.value, () =>
        startProject(running.sys, launcher, {
          realProject: dir.value,
          name: name.value,
          port,
          waitMs: running.startWaitMs,
          logPath: running.logDir ? path.join(running.logDir, `${name.value}.log`) : undefined,
        }),
      );
      if (result === null) return fail(res, { code: 'already_running' });
      respond(res, result);
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
