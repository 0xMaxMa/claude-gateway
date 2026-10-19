import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;

/**
 * Express 4 ignores the promise an async handler returns, so a throw after the first `await` would reach the
 * process-level unhandledRejection handler, which shuts the gateway down. Route the rejection to the response
 * instead: 500 JSON, or a closed socket once headers are out.
 */
function guard(fn: RequestHandler): RequestHandler {
  if (fn.length > 3 || typeof (fn as unknown as { stack?: unknown }).stack !== 'undefined') return fn;
  const fail = (req: Request, res: Response, err: unknown): void => {
    console.error(`[api] ${req.method} ${req.path} failed: ${(err as Error)?.stack ?? String(err)}`);
    if (res.headersSent) { res.end(); return; }
    res.status(500).json({ error: 'Internal error' });
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const out = fn(req, res, next) as unknown;
      if (out && typeof (out as Promise<unknown>).catch === 'function') (out as Promise<unknown>).catch((err) => fail(req, res, err));
    } catch (err) {
      fail(req, res, err);
    }
  };
}

/** Make every handler later registered on `router` answer a throw or a rejection with a 500 instead of crashing. */
export function guardAsyncRoutes<R extends Router>(router: R): R {
  for (const method of METHODS) {
    const original = (router as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.bind(router);
    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(...args.map((a) => (typeof a === 'function' ? guard(a as RequestHandler) : Array.isArray(a) ? a.map((f) => (typeof f === 'function' ? guard(f as RequestHandler) : f)) : a)));
  }
  return router;
}
