import { NextFunction, Request, Response, Router } from 'express';
import * as os from 'os';
import * as path from 'path';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, canAccessPod } from './auth';
import { defineRoute } from './route-registry';
import { createProject, listDir, listProjects, readFileContent } from '../projects/fs';
import { parseProjectName, parseRelPath, ProjectsErrorCode, Result } from '../projects/paths';

type AuthedRequest = Request & { apiKey: ApiKey };

const ERRORS: Record<ProjectsErrorCode, { status: number; message: string }> = {
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
};

function fail(res: Response, code: ProjectsErrorCode): void {
  const { status, message } = ERRORS[code];
  res.status(status).json({ error: message, code });
}

function respond<T>(res: Response, result: Result<T, ProjectsErrorCode>, status = 200): void {
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
 * Pod-wide project browsing under `root` (default `~/projects`). Every route
 * needs a key that can see all agents, since projects are not agent-scoped.
 */
export function createProjectsRouter(
  apiKeys: ApiKey[],
  root: string = path.join(os.homedir(), 'projects'),
): Router {
  const router = Router();
  const auth = createApiAuthMiddleware(apiKeys);

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects', auth: 'key', summary: 'List projects under ~/projects', cli: null },
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

  return router;
}
