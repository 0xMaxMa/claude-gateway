import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;

/**
 * Express 4 ignores the promise an async handler returns, so a throw after the first `await` would reach the
 * process-level unhandledRejection handler, which shuts the gateway down. Route the rejection to the response
 * instead: 500 JSON, or a closed socket once headers are out.
 */
export type RouteFailure = (req: Request, res: Response, err: unknown) => void;

const answer500: RouteFailure = (req, res, err) => {
  console.error(`[api] ${req.method} ${req.path} failed: ${(err as Error)?.stack ?? String(err)}`);
  if (res.headersSent) { res.end(); return; }
  res.status(500).json({ error: 'Internal error' });
};

function guard(fn: RequestHandler, fail: RouteFailure): RequestHandler {
  if (fn.length > 3 || typeof (fn as unknown as { stack?: unknown }).stack !== 'undefined') return fn;
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const out = fn(req, res, next) as unknown;
      if (out && typeof (out as Promise<unknown>).catch === 'function') (out as Promise<unknown>).catch((err) => fail(req, res, err));
    } catch (err) {
      fail(req, res, err);
    }
  };
}

/**
 * Make every handler later registered on `router` answer a throw or a rejection through `fail` instead of crashing.
 * The default logs the stack to the console and answers 500 `{ error: 'Internal error' }`.
 */
export function guardAsyncRoutes<R extends Router>(router: R, fail: RouteFailure = answer500): R {
  for (const method of METHODS) {
    const original = (router as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.bind(router);
    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(...args.map((a) => (typeof a === 'function' ? guard(a as RequestHandler, fail) : Array.isArray(a) ? a.map((f) => (typeof f === 'function' ? guard(f as RequestHandler, fail) : f)) : a)));
  }
  return router;
}
