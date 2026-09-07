import { Router, Request, Response, NextFunction } from 'express';
import { ApiKey } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import type { CustomConnectorsStore } from '../connectors/custom-connectors-store';
import { customSecretKey, isValidConnectorId } from '../connectors/custom';
import { getSecret, setSecret, updateSecrets } from '../connectors/token-env';
import { resolveGatewayPublicUrl } from '../config/public-url';
import {
  discoverOAuthMetadata,
  resolveClientId,
  resolveScope,
  generatePkce,
  buildAuthorizeUrl,
  exchangeCode,
} from '../connectors/mcp-oauth';
import { pendingOAuthStore, type PendingOAuthStore } from '../connectors/pending-oauth-store';
import type { AgentRunner } from '../agent/runner';
import {
  refreshTokenSecretKey,
  clientIdSecretKey,
  expiresAtSecretKey,
  tokenGenerationSecretKey,
  refreshFailCountSecretKey,
  refreshTransientCountSecretKey,
  refreshBackoffUntilSecretKey,
  dcrClientIdSecretKey,
  clientRedirectUriSecretKey,
} from '../connectors/oauth-refresh-sweep';

type AuthedRequest = Request & { apiKey: ApiKey };

// This route is PUBLIC (see module doc comment) and some of what lands in its
// plain-HTML fallback pages is not ours to trust: `error` is a raw query
// param off an unauthenticated request, and a token-exchange failure message
// can embed a token endpoint's own raw JSON response body (see mcp-oauth.ts's
// tokenRequest()) — reachable via an admin-added custom connector whose
// token endpoint is attacker-controlled. Escape before ever interpolating
// into an `<h1>`.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * RFC 6749 §4.1.2.1 error codes are short ASCII tokens (`access_denied`,
 * `invalid_scope`, …). `escapeHtml` covers this value on the way into our own
 * fallback page, but `fail()` also forwards it OUT — as `connector_oauth_error` on
 * the configured return URL — into a downstream app whose rendering is not ours to
 * vouch for, and it arrives from the query string of an unauthenticated public
 * route. URL-encoding makes it a well-formed parameter, not a safe one. Anything
 * outside the token shape becomes a generic code before it leaves this process; the
 * provider's own words still reach the operator, on the page and in the log.
 */
const OAUTH_ERROR_CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function safeErrorCode(raw: string): string {
  return OAUTH_ERROR_CODE_RE.test(raw) ? raw : 'provider_error';
}

/**
 * Generic OAuth 2.1 + PKCE flow for connectors whose credential this gateway owns
 * (`credentialOwner: 'gateway'` — see ConnectorCredentialOwner) — e.g. Firecrawl's
 * `https://mcp.firecrawl.dev/v2/mcp-oauth`. This is the gateway-owned
 * counterpart to an external control plane's own OAuth handlers (which produce
 * 'external' entries via /oauth/receive): the whole dance (discovery, DCR,
 * PKCE, token exchange, refresh) happens here, inside the user's own VM —
 * no external service ever sees the resulting token.
 *
 * Two routers, deliberately NOT combined into one:
 *   - createOauthConnectorsRouter(): admin-gated, mounted under /api like every
 *     other connector-management route (`POST /v1/connectors/custom/:id/oauth/start`).
 *   - createOauthCallbackRouter(): PUBLIC, no auth — this is the URL the OAuth
 *     provider redirects the end user's own browser to
 *     (`GET /oauth/mcp/callback`), which has no API key to present. Its
 *     security rests on the single-use, TTL'd, unguessable `state` value
 *     (see pending-oauth-store.ts), the same posture cliPairingStore already
 *     uses for its own unauthenticated browser-facing routes — plus a re-read of
 *     the connector before it commits anything, because `state` proves which
 *     browser started the flow and nothing about what happened to the connector
 *     while that browser sat on the provider's consent screen.
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

  // Same shape check as connectors-router.ts's — see its `router.param('id')` comment.
  // Here the id is also looked up in `store`, so this is defence in depth rather than
  // the only guard, but it keeps the 400-vs-404 distinction honest.
  router.param('id', (req: Request, res: Response, next: NextFunction, id: string) => {
    if (!isValidConnectorId(id)) {
      res.status(400).json({ error: `Invalid connector id '${id}'` });
      return;
    }
    next();
  });

  router.post('/v1/connectors/custom/:id/oauth/start', async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = req.params.id;

    // Read and validate inside a try, for the reason connectors-router.ts's
    // /connect route states at length: `store.read()` does no runtime shape
    // validation — `config` is required by the TypeScript type and by nothing
    // else — so an entry hand-written into config.json without it turns
    // `entry.config.url` into a TypeError, and on Express 4 a rejected async
    // handler escapes to index.ts's `unhandledRejection` hook, which calls
    // emergencyShutdown(). A malformed entry must cost this caller a 500, not
    // every agent on the box. Kept separate from the try below, which reports
    // 502: that one covers the third-party AS, and a broken local entry is not
    // an upstream failure.
    let mcpUrl: string;
    try {
      const entry = (await store.read())[id];
      if (!entry) {
        res.status(404).json({ error: `Unknown connector '${id}'` });
        return;
      }
      if (entry.credentialOwner !== 'gateway') {
        res.status(400).json({
          error:
            entry.credentialOwner === 'external'
              ? `Connector '${id}' has its credential owned externally — its token is pushed in via POST /v1/connectors/${id}/oauth/receive, not signed in for here`
              : `Connector '${id}' was not added with oauth: true`,
        });
        return;
      }
      const url = entry.config?.url;
      if (typeof url !== 'string') {
        res.status(400).json({ error: `Connector '${id}'.config.url is missing` });
        return;
      }
      mcpUrl = url;
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
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
      // Reuse a client this connector already registered via DCR, rather
      // than minting (and orphaning, at the provider) a brand-new one on
      // every Connect click — including retries after an abandoned attempt.
      // Only valid while the redirect_uri it was registered with still
      // matches; a changed gateway.publicUrl invalidates the cache.
      //
      // Falls back to the live client_id so a connector that registered before
      // the DCR cache had a key of its own keeps reusing it, instead of orphaning
      // one more registration at the provider on the first Connect after upgrade.
      // Both reads only — see dcrClientIdSecretKey for why start never WRITES the
      // key the sweep refreshes with.
      const cachedClientId = getSecret(dcrClientIdSecretKey(id)) ?? getSecret(clientIdSecretKey(id));
      const cachedRedirectUri = getSecret(clientRedirectUriSecretKey(id));
      let clientId: string;
      if (cachedClientId && cachedRedirectUri === redirectUri) {
        clientId = cachedClientId;
      } else {
        clientId = await resolveClientId(metadata, id, redirectUri);
        setSecret(dcrClientIdSecretKey(id), clientId);
        setSecret(clientRedirectUriSecretKey(id), redirectUri);
      }
      const { codeVerifier, codeChallenge } = generatePkce();
      const state = pendingStore.create({ connectorId: id, metadata, clientId, redirectUri, codeVerifier });
      const scope = resolveScope(metadata, id);
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

/**
 * Both paths, for the same reason share-router.ts registers
 * `['/shared/:token', '/gateway/shared/:token']`.
 *
 * `resolveGatewayPublicUrl` REQUIRES the configured publicUrl to end in `/gateway`,
 * so the redirect_uri handed to the provider is always
 * `<origin>/gateway/oauth/mcp/callback`. Behind Traefik that prefix is stripped
 * before the request reaches Express and the bare path matches. In the direct-path
 * deployment the same function explicitly permits (`http://localhost` / `127.*` /
 * `*.internal` / `*.local` + `/gateway`) nothing strips it — there is no prefix
 * middleware anywhere in this app — so the provider redirected the user's own
 * browser to a path with no route. The result was a bare 404 and a pending flow
 * left to expire silently: the sign-in fails, and the one page the user sees says
 * nothing about why.
 */
const CALLBACK_PATHS = ['/oauth/mcp/callback', '/gateway/oauth/mcp/callback'];

/** See this file's module doc comment — mounted directly on the Express app,
 *  NOT under any auth middleware, at `/oauth/mcp/callback`.
 *
 *  `agents` (all live AgentRunners) lets a completed sign-in restart the sessions
 *  already using the connector, exactly as POST /v1/connectors/:id/oauth/receive
 *  does for a pushed token. Without it the user finishes the OAuth dance, sees the
 *  connector go green, and then finds the agent they are talking to still has no
 *  such tool — its MCP subprocess was spawned with no token and cannot be
 *  hot-patched (see session/process.ts's writeMcpConfig). */
export function createOauthCallbackRouter(
  store: CustomConnectorsStore,
  pendingStore: PendingOAuthStore = pendingOAuthStore,
  returnUrl?: string,
  agents?: Map<string, AgentRunner>,
): Router {
  const router = Router();
  // This gateway is a generic, product-agnostic fork — it has no business
  // hardcoding a downstream product's own domain (e.g. app.example.com).
  // Whoever deploys it can opt into an auto-redirect by setting
  // gateway.oauthReturnUrl in config.json; absent that, the plain "close this
  // tab" message below is the safe default. Validated once, at router
  // construction — a malformed value degrades to "not configured" rather
  // than injecting a broken redirect into every future callback response.
  let validReturnUrl: string | undefined;
  if (returnUrl) {
    try {
      const parsed = new URL(returnUrl);
      // Scheme-gated, not merely parseable. `new URL()` accepts every scheme
      // there is — `javascript:`, `data:`, `file:`, `intent:` — and this value's
      // whole purpose is to become the `Location` of a 302 sent to the end
      // user's own browser, on a route that is PUBLIC and reachable by anyone
      // who can hit the gateway. A `javascript:` return URL is a stored XSS
      // primitive aimed at every user who ever finishes (or abandons) a sign-in,
      // and `file:` points the browser at the operator's own disk. Nothing an
      // OAuth flow needs to return to is anything but http(s), so requiring it
      // costs no real deployment anything.
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        console.error(
          `oauth-connectors-router: gateway.oauthReturnUrl "${returnUrl}" is not an http(s) URL — ignoring it`,
        );
      } else {
        validReturnUrl = parsed.toString();
      }
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
    res.status(status).send(`<h1>${escapeHtml(message)}</h1>`);
  }

  /** Is this id still a connector whose credential THIS gateway owns? */
  async function isGatewayOwned(connectorId: string): Promise<boolean> {
    return (await store.read())[connectorId]?.credentialOwner === 'gateway';
  }

  /** Terminal response for a connector that went away (or changed owner) mid-flow. */
  function failGone(res: Response): void {
    fail(
      res,
      409,
      'This connector was removed or handed to another owner while you were signing in — nothing was stored. Add it again and reconnect.',
      'connector_gone',
    );
  }

  router.get(CALLBACK_PATHS, async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const providerError = typeof req.query.error === 'string' ? req.query.error : '';

    const flow = state ? pendingStore.consume(state) : null;
    if (!flow) {
      fail(
        res,
        400,
        'This sign-in link expired or was already used. Go back and click Connect again.',
        'expired_link',
      );
      return;
    }
    if (providerError) {
      // The message keeps the provider's own words (escaped on the way into our
      // HTML) — on a self-hosted install that page is the only diagnostic the admin
      // gets. Only the code, which leaves for someone else's app, is clamped.
      fail(res, 400, `Sign-in failed: ${providerError}`, safeErrorCode(providerError));
      return;
    }
    if (!code) {
      fail(res, 400, 'Sign-in failed: no authorization code returned.', 'missing_code');
      return;
    }

    try {
      // The flow was authorised against the connector as it stood when
      // /oauth/start ran, and `state` only proves this browser is the one that
      // started it. It says nothing about the connector still existing, or the
      // gateway still being the party that owns its credential — and the window
      // is a full FLOW_TTL_MS (see pending-oauth-store.ts) of the user sitting
      // on the provider's consent screen. Two things can land inside it:
      //
      //   - DELETE /v1/connectors/:id, which clears the credentials precisely so
      //     a live refresh_token cannot resurrect a connector the admin just
      //     disconnected. Writing this token set would do exactly that.
      //   - POST /v1/connectors/:id/oauth/receive, which can hand the id over to
      //     'external'. The sweep skips a non-'gateway' entry and DELETE only
      //     clears internal keys for a 'gateway' one, so the CUSTOMINT__* keys
      //     written here would be orphans nothing ever collects.
      //
      // Checked once here — before spending a code on a token nothing will
      // keep — and again after the exchange, which is the check that actually
      // closes the race. `store.read()` degrades to {} rather than throwing
      // (see custom-connectors-store.ts), so an unreadable config fails closed.
      if (!(await isGatewayOwned(flow.connectorId))) {
        failGone(res);
        return;
      }
      const token = await exchangeCode({
        metadata: flow.metadata,
        clientId: flow.clientId,
        redirectUri: flow.redirectUri,
        code,
        codeVerifier: flow.codeVerifier,
      });
      // Authoritative re-check: either of the two actions above could have landed
      // during the exchange round trip, which is the race the pre-check cannot
      // see. Discarding the token here loses nothing the caller can miss — it was
      // never stored, and reconnecting mints a fresh one.
      if (!(await isGatewayOwned(flow.connectorId))) {
        failGone(res);
        return;
      }
      // One rewrite for the whole result — a crash between separate writes
      // could leave an access_token filed with no expiry, which the refresh
      // sweep then reads as "due now" on every tick.
      updateSecrets(
        {
          [customSecretKey(flow.connectorId, 'access_token')]: token.access_token,
          [clientIdSecretKey(flow.connectorId)]: flow.clientId,
          ...(token.refresh_token
            ? { [refreshTokenSecretKey(flow.connectorId)]: token.refresh_token }
            : {}),
          [expiresAtSecretKey(flow.connectorId)]: String(
            Date.now() + (token.expires_in ?? 3600) * 1000,
          ),
          // Bumped so the background refresh sweep (oauth-refresh-sweep.ts) can
          // tell, after its own two-network-round-trip refresh, whether a fresher
          // token landed here in the meantime — and if so, discard its own
          // now-stale result instead of clobbering this one.
          [tokenGenerationSecretKey(flow.connectorId)]: String(Date.now()),
        },
        // A completed sign-in is as much a fresh start as the sweep's own
        // successful refresh, and has to clear the same bookkeeping. Leaving it
        // behind meant a connector the user had just reconnected was still
        // serving a backoff of up to six hours — so its brand-new one-hour token
        // expired unrefreshed — while status reported the old failure streak
        // against it. Worst of the three: a permanent count already sitting at 2
        // turned the very next refusal into credential deletion, one tick after
        // a successful sign-in.
        [
          refreshFailCountSecretKey(flow.connectorId),
          refreshTransientCountSecretKey(flow.connectorId),
          refreshBackoffUntilSecretKey(flow.connectorId),
          // `client_id` above is written unconditionally; `refresh_token` only
          // when this response carried one. An AS is entitled to omit it (RFC
          // 6749 §6, and it happens routinely whenever the granted scopes don't
          // include `offline_access`), and without this removal the old one
          // survived — leaving refresh_token R1, issued to client C1, sitting
          // beside the new client_id C2. The sweep then POSTs that mismatched
          // pair, the AS answers `invalid_client`, which is classified permanent,
          // and three ticks later it deletes the sign-in that just succeeded.
          // The two values are one credential: they are replaced together or not
          // at all.
          ...(token.refresh_token ? [] : [refreshTokenSecretKey(flow.connectorId)]),
        ],
      );

      // The connector only just became resolvable; a session spawned before
      // this holds an MCP config without it. Failure to restart must not turn a
      // successful sign-in into an error page — the token IS stored — so this
      // is logged, not surfaced.
      if (agents) {
        await Promise.all(
          [...agents.values()].map((runner) =>
            runner.restartSessionsUsingConnector(flow.connectorId).catch((e: Error) => {
              console.error(
                `oauth-connectors-router: restart for connector=${flow.connectorId} failed: ${e.message}`,
              );
            }),
          ),
        );
      }

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
