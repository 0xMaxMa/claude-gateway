import { Router, Request, Response } from 'express';
import { ApiKey } from '../types';
import { createApiAuthMiddleware } from './auth';
import { getRegisteredRoutes } from './route-registry';

/**
 * Exposes the route manifest (every route registered via defineRoute) so tools —
 * chiefly the `claude-gateway` CLI's `doctor`/validation — can cross-check that
 * the binary's generated command set matches the server it is talking to.
 *
 * The CLI itself is generated offline from the same manifest (scripts/gen-cli.ts),
 * so this endpoint is for verification, not for building the command tree at
 * runtime. Requires a valid API key.
 */
export function createMetaRouter(apiKeys?: ApiKey[]): Router {
  const router = Router();
  if (apiKeys?.length) {
    router.use(createApiAuthMiddleware(apiKeys));
  }
  router.get('/v1/_meta/routes', (_req: Request, res: Response) => {
    res.json({ routes: getRegisteredRoutes() });
  });
  return router;
}
