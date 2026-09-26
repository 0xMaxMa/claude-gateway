import { Router, Request, Response } from 'express';
import { ApiKey } from '../types';
import type { ChatChannel } from '../history/types';
import { createApiAuthMiddleware } from './auth';
import { GATEWAY_VERSION } from './gateway-version';

/**
 * Capability manifest — the single place that declares which optional features
 * this gateway build supports, so clients can feature-detect instead of pinning
 * to a version number.
 *
 * Contract (documented in website/api/system.md → "GET /api/v1/capabilities"):
 *   - keys are additive-only and never change meaning; dropping a feature means
 *     dropping its key, not flipping its value,
 *   - a missing key means "unsupported", and a 404 on the endpoint itself means
 *     the gateway predates capability discovery and supports none of these.
 *
 * Add a new capability here (plus its website/api/system.md entry); never inline a feature list
 * in a route handler.
 */

/**
 * Channels whose sessions accept a message injected by another client via
 * `POST /api/v1/agents/:id/chats/:chatId/sessions/:sessionId/messages` — the
 * injected text is delivered into the channel conversation and echoed back to
 * the channel's users. Values are the gateway's own channel identifiers
 * ({@link ChatChannel}), the same strings a session reports as its channel.
 * Only list a channel once the echo path actually works for it.
 */
export const CROSS_CHANNEL_MESSAGE_CHANNELS: readonly ChatChannel[] = ['telegram'];

export interface CapabilitiesResponse {
  /** Gateway version from package.json. Informational — clients should key off `capabilities`, not parse this. */
  version: string;
  capabilities: {
    cross_channel_message: ChatChannel[];
  };
}

export function buildCapabilitiesResponse(version: string = GATEWAY_VERSION): CapabilitiesResponse {
  return {
    version,
    capabilities: {
      cross_channel_message: [...CROSS_CHANNEL_MESSAGE_CHANNELS],
    },
  };
}

/**
 * `GET /api/v1/capabilities`. Requires an API key when keys are configured — the
 * response carries the gateway version, which `/health` deliberately withholds
 * from unauthenticated callers, so this route sits behind the same auth as the
 * rest of `/api/v1`.
 */
export function createCapabilitiesRouter(apiKeys?: ApiKey[]): Router {
  const router = Router();
  if (apiKeys?.length) {
    router.use(createApiAuthMiddleware(apiKeys));
  }
  router.get('/v1/capabilities', (_req: Request, res: Response) => {
    res.json(buildCapabilitiesResponse());
  });
  return router;
}
