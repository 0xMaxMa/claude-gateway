import { Router, Request, Response } from 'express';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import type { CustomConnectorsStore } from '../connectors/custom-connectors-store';
import { customSecretKey } from '../connectors/custom';
import { setSecret } from '../connectors/token-env';
import { resolveGatewayPublicUrl } from '../config/public-url';
import {
  discoverOAuthMetadata,
  resolveClientId,
  generatePkce,
  buildAuthorizeUrl,
  exchangeCode,
} from '../connectors/mcp-oauth';
import { pendingOAuthStore, type PendingOAuthStore } from '../connectors/pending-oauth-store';
import {
  refreshTokenSecretKey,
  clientIdSecretKey,
  expiresAtSecretKey,
} from '../connectors/oauth-refresh-sweep';

type AuthedRequest = Request & { apiKey: ApiKey };

/**
 * Generic OAuth 2.1 + PKCE flow for "custom" connectors marked
 * `oauth: true` (see CustomConnectorEntry) — e.g. Firecrawl's
 * `https://mcp.firecrawl.dev/v2/mcp-oauth`. This is the gateway-owned
 * counterpart to services/api's google_connector.go/github_connector.go: the
 * whole dance (discovery, DCR, PKCE, token exchange, refresh) happens here,
 * inside the user's own VM — services/api never sees the resulting token.
 *
 * Two routers, deliberately NOT combined into one:
 *   - createOauthConnectorsRouter(): admin-gated, mounted under /api like every
 *     other connector-management route (`POST /v1/connectors/custom/:id/oauth/start`).
 *   - createOauthCallbackRouter(): PUBLIC, no auth — this is the URL the OAuth
 *     provider redirects the end user's own browser to
 *     (`GET /oauth/mcp/callback`), which has no API key to present. Its
 *     security rests on the single-use, TTL'd, unguessable `state` value
 *     (see pending-oauth-store.ts), the same posture cliPairingStore already
 *     uses for its own unauthenticated browser-facing routes.
 */
export function createOauthConnectorsRouter(
  apiKeys: ApiKey[] | undefined,
  gatewayConfig: { gateway?: { publicUrl?: unknown } } | undefined,
  store: CustomConnectorsStore,
  pendingStore: PendingOAuthStore = pendingOAuthStore,
): Router {
  const router = Router();
  if (apiKeys?.length) router.use(createApiAuthMiddleware(apiKeys));

  function requireAdmin(req: Request, res: Response): boolean {
    if (!apiKeys?.length) return true;
    if (!isAdmin((req as AuthedRequest).apiKey)) {
      res.status(403).json({ error: 'Connector management requires an admin API key' });
      return false;
    }
    return true;
  }

  router.post('/v1/connectors/custom/:id/oauth/start', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;

    const entry = (await store.read())[id];
    if (!entry) {
      res.status(404).json({ error: `Unknown connector '${id}'` });
      return;
    }
    if (!entry.oauth) {
      res.status(400).json({ error: `Connector '${id}' was not added with oauth: true` });
      return;
    }
    const mcpUrl = entry.config.url;
    if (typeof mcpUrl !== 'string') {
      res.status(400).json({ error: `Connector '${id}'.config.url is missing` });
      return;
    }

    const publicUrl = resolveGatewayPublicUrl(gatewayConfig?.gateway?.publicUrl);
    if (!publicUrl) {
      res.status(500).json({
        error:
          'This gateway has no valid gateway.publicUrl configured — OAuth sign-in needs a reachable HTTPS callback URL.',
      });
      return;
    }
    const redirectUri = `${publicUrl}/oauth/mcp/callback`;

    try {
      const metadata = await discoverOAuthMetadata(mcpUrl);
      const clientId = await resolveClientId(metadata, id, redirectUri);
      const { codeVerifier, codeChallenge } = generatePkce();
      const state = pendingStore.create({ connectorId: id, metadata, clientId, redirectUri, codeVerifier });
      const scope = metadata.scopesSupported.length > 0 ? metadata.scopesSupported.join(' ') : 'offline_access';
      const authorizeUrl = buildAuthorizeUrl({
        metadata,
        clientId,
        redirectUri,
        scope,
        codeChallenge,
        state,
      });
      res.json({ authorizeUrl });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  return router;
}

/** See this file's module doc comment — mounted directly on the Express app,
 *  NOT under any auth middleware, at `/oauth/mcp/callback`. */
export function createOauthCallbackRouter(
  pendingStore: PendingOAuthStore = pendingOAuthStore,
  returnUrl?: string,
): Router {
  const router = Router();
  // This gateway is a generic, product-agnostic fork — it has no business
  // hardcoding a downstream product's own domain (e.g. app.getpod.ai).
  // Whoever deploys it can opt into an auto-redirect by setting
  // gateway.oauthReturnUrl in config.json; absent that, the plain "close this
  // tab" message below is the safe default. Validated once, at router
  // construction — a malformed value degrades to "not configured" rather
  // than injecting a broken redirect into every future callback response.
  let validReturnUrl: string | undefined;
  if (returnUrl) {
    try {
      validReturnUrl = new URL(returnUrl).toString();
    } catch {
      console.error(`oauth-connectors-router: gateway.oauthReturnUrl "${returnUrl}" is not a valid URL — ignoring it`);
    }
  }

  // No interstitial "Connected!" page + timed meta-refresh here on purpose —
  // that just makes the user wait and watch a flash of gateway-branded HTML
  // before landing back in the app. A real HTTP redirect goes straight to
  // validReturnUrl with nothing to look at in between — on EVERY terminal
  // outcome, not just success (a denied/expired/failed sign-in used to leave
  // the user stranded on a bare, unbranded gateway page with no way back).
  // The plain HTML pages below are only for the unconfigured (self-hosted,
  // no oauthReturnUrl) case, where there's nowhere else to send the browser.
  const CLOSE_TAB_PAGE = '<h1>Connected — you can close this tab.</h1>';

  /** Terminal-failure response: redirect back with the reason as a query
   *  param when the app knows where "back" is, else render it in place. */
  function fail(res: Response, status: number, message: string, errorCode: string): void {
    if (validReturnUrl) {
      const url = new URL(validReturnUrl);
      url.searchParams.set('connector_oauth_error', errorCode);
      res.redirect(302, url.toString());
      return;
    }
    res.status(status).send(`<h1>${message}</h1>`);
  }

  router.get('/oauth/mcp/callback', async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const providerError = typeof req.query.error === 'string' ? req.query.error : '';

    const flow = state ? pendingStore.consume(state) : null;
    if (!flow) {
      fail(
        res,
        400,
        'This sign-in link expired or was already used. Go back to GetPod and click Connect again.',
        'expired_link',
      );
      return;
    }
    if (providerError) {
      fail(res, 400, `Sign-in failed: ${providerError}`, providerError);
      return;
    }
    if (!code) {
      fail(res, 400, 'Sign-in failed: no authorization code returned.', 'missing_code');
      return;
    }

    try {
      const token = await exchangeCode({
        metadata: flow.metadata,
        clientId: flow.clientId,
        redirectUri: flow.redirectUri,
        code,
        codeVerifier: flow.codeVerifier,
      });
      setSecret(customSecretKey(flow.connectorId, 'access_token'), token.access_token);
      setSecret(clientIdSecretKey(flow.connectorId), flow.clientId);
      if (token.refresh_token) setSecret(refreshTokenSecretKey(flow.connectorId), token.refresh_token);
      setSecret(
        expiresAtSecretKey(flow.connectorId),
        String(Date.now() + (token.expires_in ?? 3600) * 1000),
      );
      if (validReturnUrl) {
        res.redirect(302, validReturnUrl);
        return;
      }
      res.send(CLOSE_TAB_PAGE);
    } catch (err) {
      fail(res, 502, `Sign-in failed: ${(err as Error).message}`, 'exchange_failed');
    }
  });

  return router;
}
