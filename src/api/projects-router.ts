import * as path from 'path';
import { NextFunction, Request, Response, Router } from 'express';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin, PROJECTS_ADMIN_REQUIRED } from './auth';
import { defineRoute } from './route-registry';
import { createProject, listDir, resolveProjectDir, listProjects, readFileContent } from '../projects/fs';
import { getStatus, getSummaries, GitError, GitErrorCode } from '../projects/git';
import { listRunning, ProjectDir, RunningErrorCode, scanProjects, StopLimiter, stopRunning, Sys, systemSys } from '../projects/running';
import { planStart, PORT_MIN, readStartFacts, startProject, StartError, StartErrorCode, StartGuard, Launcher, systemLauncher } from '../projects/start';
import { DeleteErrorCode, removeProject } from '../projects/delete';
import { isProjectDeleting, markProjectDeleting } from '../projects/chat';
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
  forbidden_key: { status: 403, message: PROJECTS_ADMIN_REQUIRED.error },
  not_found: { status: 404, message: 'Not found' },
  project_exists: { status: 409, message: 'Project already exists' },
  internal: { status: 500, message: 'Internal error' },
  not_a_git_repo: { status: 409, message: 'Project is not a git repository' },
  git_unsafe_owner: { status: 409, message: "Git refuses this repository because another user owns it. Run `git config --global --add safe.directory <path>` as the gateway's user, or fix the owner." },
  git_unreadable: { status: 409, message: 'This is a git repository the gateway cannot read safely: check its permissions, its config, and any filter drivers it defines' },
  timeout: { status: 504, message: 'Git took too long' },
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
  project_deleting: { status: 409, message: 'The project is being deleted' },
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

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (isAdmin((req as AuthedRequest).apiKey)) next();
  else fail(res, 'forbidden_key');
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    fn(req, res).catch(() => fail(res, 'internal'));
  };
}

/**
 * Pod-wide project routes under `root`. Every route needs an admin key, since
 * projects are not agent-scoped and they read, run and delete files on the pod.
 */
export interface RunningDeps {
  sys: Sys;
  limiter: StopLimiter;
  launcher?: Launcher;
  starts?: StartGuard;
  /** Where start logs go and how long a start waits; set by tests. */
  logDir?: string;
  startWaitMs?: number;
  /** A chat bound to the project has a turn running, whose agent process works inside the folder. */
  chatTurnActive?: (name: ProjectName) => boolean | Promise<boolean>;
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
    { method: 'GET', path: '/v1/projects', auth: 'admin', summary: 'List projects under the configured projects root', cli: null },
    auth,
    requireAdmin,
    handle(async (_req, res) => respond(res, await listProjects(root))),
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/projects', auth: 'admin', summary: 'Create a project directory', cli: null },
    auth,
    requireAdmin,
    handle(async (req, res) => {
      const body = (req.body ?? {}) as { name?: unknown; git_init?: unknown };
      const name = parseProjectName(body.name);
      if (!name.ok) return fail(res, name.error);
      respond(res, await createProject(root, name.value, body.git_init === true), 201);
    }),
  );

  defineRoute(
    router,
    { method: 'DELETE', path: '/v1/projects/:name', auth: 'admin', summary: 'Delete a project folder and everything in it', cli: null },
    auth,
    requireAdmin,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      if ((req.body ?? {}).confirm !== name.value) return fail(res, 'confirm_mismatch');
      const dir = await resolveProjectDir(root, name.value);
      if (!dir.ok) return fail(res, dir.error);
      const busy = async () =>
        (await listRunning(running.sys, dir.value)).processes.length > 0 || starts.has(dir.value) || Boolean(await running.chatTurnActive?.(name.value));
      // Checked before the mark, so a turn that began earlier is seen here and never refused by the mark.
      if (await busy()) return fail(res, 'project_running');
      const release = markProjectDeleting(dir.value);
      if (!release) return fail(res, 'project_running');
      try {
        if (await busy()) return fail(res, 'project_running');
        respond(res, await removeProject(root, name.value));
      } finally {
        release();
      }
    }),
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/:name/tree', auth: 'admin', summary: 'List one directory level of a project', cli: null },
    auth,
    requireAdmin,
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
    { method: 'GET', path: '/v1/projects/:name/file', auth: 'admin', summary: 'Read a file from a project', cli: null },
    auth,
    requireAdmin,
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
    { method: 'GET', path: '/v1/projects/git-summary', auth: 'admin', summary: 'Git sync summary for every project that is a repository', cli: null },
    auth,
    requireAdmin,
    handle(async (_req, res) => respond(res, await getSummaries(root))),
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/running', auth: 'admin', summary: 'Processes listening from inside each project', cli: null },
    auth,
    requireAdmin,
    handle(async (_req, res) => {
      const list = await listProjects(root);
      if (!list.ok) return fail(res, list.error);
      const dirs: ProjectDir[] = [];
      const truncated = list.value.projects.length > MAX_RUNNING_PROJECTS;
      for (const p of list.value.projects.slice(0, MAX_RUNNING_PROJECTS)) {
        const dir = await resolveProjectDir(root, p.name);
        if (dir.ok) dirs.push({ name: p.name, dir: dir.value });
      }
      res.json({ ...(await scanProjects(running.sys, dirs)), truncated });
    }),
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/:name/git', auth: 'admin', summary: 'Git status of a project', cli: null },
    auth,
    requireAdmin,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      respond(res, await getStatus(root, name.value));
    }),
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/:name/running', auth: 'admin', summary: 'Processes listening on a port from inside a project', cli: null },
    auth,
    requireAdmin,
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
    { method: 'POST', path: '/v1/projects/:name/running/stop', auth: 'admin', summary: "Stop the processes listening from inside a project", cli: null },
    auth,
    requireAdmin,
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
    { method: 'POST', path: '/v1/projects/:name/running/start', auth: 'admin', summary: 'Start a project the way its own files say, on a free port', cli: null },
    auth,
    requireAdmin,
    handle(async (req, res) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      const port = (req.body ?? {}).port;
      const dir = await resolveProjectDir(root, name.value);
      if (!dir.ok) return fail(res, dir.error);
      if (isProjectDeleting(dir.value)) return fail(res, 'project_deleting');
      const result = await starts.run(dir.value, () =>
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

  return router;
}
