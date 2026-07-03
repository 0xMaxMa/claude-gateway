/**
 * Unified public webhook ingress.
 *
 * All external, unauthenticated webhooks (LINE today; more later) enter through a
 * single route `/webhooks/:app/:agentId?` and are dispatched to a per-app handler
 * by the `:app` path segment. Mounted BEFORE express.json() so each handler sees
 * the raw request bytes it needs for signature validation.
 *
 * The whole `/webhooks/*` zone bypasses the gateway's API-key auth (it is mounted
 * outside the /api routers, exactly like the old LINE mount) AND Traefik's
 * ForwardAuth (a single `/gateway/webhooks` bypass router upstream). Therefore
 * EVERY app handler MUST authenticate its own requests (e.g. LINE's HMAC
 * signature) as its first step — there is no ambient auth on this path.
 *
 * Adding a new webhook app = register one entry in `handlers` below; no Traefik or
 * getpod change is needed once the `/gateway/webhooks` ingress exists.
 */
import express, { Router, type Request, type Response } from 'express';
import type { AgentRunner } from '../agent/runner';
import { createLineWebhookHandler, type LineWebhookOptions } from './line-webhook-router';

const MAX_BODY_BYTES = 256 * 1024; // pre-auth body cap

/**
 * A per-app webhook handler. `verify` answers provider URL-verification probes
 * (GET / empty POST); `handlePost` processes a signed inbound POST. Each handler
 * is responsible for authenticating the request itself.
 */
export interface WebhookAppHandler {
  verify(req: Request, res: Response): void;
  handlePost(req: Request, res: Response): Promise<void>;
}

/**
 * Options forwarded to app handlers. Only LINE has options today (test-only base
 * URL overrides); generalize to a per-app map when a second app needs its own.
 */
export type WebhooksOptions = LineWebhookOptions;

export function createWebhooksRouter(
  agents: Map<string, AgentRunner>,
  logDir: string,
  opts: WebhooksOptions = {},
): Router {
  const router = Router();
  const rawBody = express.raw({ type: '*/*', limit: MAX_BODY_BYTES });

  const handlers: Record<string, WebhookAppHandler> = {
    line: createLineWebhookHandler(agents, logDir, opts),
  };

  const resolve = (req: Request, res: Response): WebhookAppHandler | null => {
    const app = req.params.app;
    // Object.prototype.hasOwnProperty guards against `app` being a prototype-chain
    // key (e.g. "__proto__", "constructor", "toString") — those resolve `handlers[app]`
    // to a truthy non-handler object, which would bypass the 404 below and then throw
    // on the missing verify/handlePost call.
    const handler = Object.prototype.hasOwnProperty.call(handlers, app) ? handlers[app] : undefined;
    if (!handler) {
      res.status(404).json({ error: `unknown webhook app: ${app}` });
      return null;
    }
    return handler;
  };

  const dispatchGet = (req: Request, res: Response): void => {
    const handler = resolve(req, res);
    if (handler) handler.verify(req, res);
  };
  const dispatchPost = (req: Request, res: Response): void => {
    const handler = resolve(req, res);
    if (handler) void handler.handlePost(req, res);
  };

  router.get('/:app', dispatchGet);
  router.get('/:app/:agentId', dispatchGet);
  router.post('/:app', rawBody, dispatchPost);
  router.post('/:app/:agentId', rawBody, dispatchPost);

  return router;
}
