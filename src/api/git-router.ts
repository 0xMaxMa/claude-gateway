import { Request, Response, Router } from 'express';
import { ApiKey, Logger } from '../types';
import { createApiAuthMiddleware } from './auth';
import { guardAsyncRoutes } from './async-guard';
import { defineRoute } from './route-registry';
import { FILES_ERRORS } from './files-router';
import { getStatus, getSummaries, GitError, GitErrorCode } from '../git/read';
import { FilesErrorCode, parseRelPath, RelPath } from '../files/paths';
import { Result } from '../utils/result';

type Failure = FilesErrorCode | GitErrorCode | GitError;
function fail(res: Response, error: Failure): void {
  const body = typeof error === 'string' ? { code: error } : error;
  const { status, message } = FILES_ERRORS[body.code];
  res.status(status).json({ error: message, ...body });
}
function respond<T>(res: Response, result: Result<T, Failure>): void {
  if (result.ok) res.json(result.value);
  else fail(res, result.error);
}
function queryPath(req: Request): Result<RelPath, 'invalid_path' | 'invalid_name'> {
  return parseRelPath(req.query.path ?? '');
}
export function createGitRouter(apiKeys: ApiKey[], root: string, logger: Logger): Router {
  const router = guardAsyncRoutes(Router(), (req, res, err) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    logger.error(`git: ${req.method} ${req.path} failed: ${err instanceof Error ? err.name : typeof err}${typeof code === 'string' ? ` ${code}` : ''}`);
    if (res.headersSent) res.end();
    else fail(res, 'internal');
  });
  const auth = createApiAuthMiddleware(apiKeys);
  defineRoute(
    router,
    { method: 'GET', path: '/v1/git/status', auth: 'key', summary: 'Git status of a folder under the files root', cli: null },
    auth,
    async (req: Request, res: Response) => {
      const rel = queryPath(req);
      if (!rel.ok) return fail(res, rel.error);
      if (rel.value === '') return fail(res, 'invalid_path');
      respond(res, await getStatus(root, rel.value, logger));
    },
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/git/summary', auth: 'key', summary: 'Git sync summary of every repository directly under a path of the files root', cli: null },
    auth,
    async (req: Request, res: Response) => {
      const rel = queryPath(req);
      if (!rel.ok) return fail(res, rel.error);
      respond(res, await getSummaries(root, rel.value, logger));
    },
  );

  return router;
}
