/**
 * Generic OAuth 2.1 + PKCE (+ optional Dynamic Client Registration) support for
 * "custom" MCP connectors whose only auth option is a real OAuth sign-in (no
 * static API key) — e.g. Firecrawl's `https://mcp.firecrawl.dev/v2/mcp-oauth`.
 *
 * This module never touches Express or the pending-flow store — pure discovery
 * + token functions, unit-testable with plain HTTP mocks. See
 * `pending-oauth-store.ts` for the in-flight-flow state and
 * `api/oauth-connectors-router.ts` for the HTTP endpoints that glue this
 * together with `connectors/custom.ts`'s existing secret storage.
 *
 * Empirically verified against production Firecrawl (2026-09, this repo's own
 * throwaway PoC — see git history / PR description, not reproduced here):
 * DCR genuinely works with an arbitrary redirect_uri (no pre-registration
 * needed), and the RFC 8707 `resource` parameter is REQUIRED on both the
 * authorize request and the token exchange — omitting it yields a token that
 * exchanges fine but is rejected by the MCP endpoint itself
 * ("OAUTH_CONNECTION_INVALID"). Always pass `resource` through this module's
 * functions; never make it optional.
 */

import crypto from 'crypto';

export interface OAuthMetadata {
  /** The MCP server URL this metadata was discovered for — also the RFC 8707 `resource`. */
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Absent when the AS doesn't advertise RFC 7591 Dynamic Client Registration. */
  registrationEndpoint?: string;
  scopesSupported: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** Parse `resource_metadata="<url>"` out of a WWW-Authenticate header value. */
function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null;
  const m = header.match(/resource_metadata="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Discover OAuth metadata for an MCP server by probing it unauthenticated
 * (expects a 401 advertising `resource_metadata`, per RFC 9728), then walking
 * protected-resource metadata → authorization-server metadata (RFC 8414).
 * Throws a descriptive error at whichever step fails — callers surface it
 * to the admin as "can't set up OAuth for this URL", not a generic 500.
 */
export async function discoverOAuthMetadata(mcpUrl: string): Promise<OAuthMetadata> {
  const probe = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  if (probe.status !== 401) {
    throw new Error(
      `Expected a 401 challenge from ${mcpUrl} (got ${probe.status}) — this server may not require OAuth, or isn't an MCP server at all.`,
    );
  }
  const resourceMetadataUrl = parseResourceMetadataUrl(probe.headers.get('www-authenticate'));
  if (!resourceMetadataUrl) {
    throw new Error(
      `${mcpUrl} returned 401 but no "resource_metadata" in its WWW-Authenticate header — can't discover its OAuth server.`,
    );
  }

  const prm = await fetch(resourceMetadataUrl).then((r) => {
    if (!r.ok) throw new Error(`Protected-resource metadata fetch failed: ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  });
  const authServers: unknown = prm.authorization_servers;
  if (!Array.isArray(authServers) || typeof authServers[0] !== 'string') {
    throw new Error(`${resourceMetadataUrl} has no authorization_servers listed.`);
  }
  const issuer = new URL(authServers[0]);

  // RFC 8414 §3.1: well-known path is inserted before the issuer's own path
  // component (usually empty, as it is for Firecrawl).
  const asMetaUrl = new URL(
    `/.well-known/oauth-authorization-server${issuer.pathname === '/' ? '' : issuer.pathname}`,
    issuer.origin,
  );
  const asMeta = await fetch(asMetaUrl.toString()).then((r) => {
    if (!r.ok) throw new Error(`Authorization-server metadata fetch failed: ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  });

  if (typeof asMeta.authorization_endpoint !== 'string' || typeof asMeta.token_endpoint !== 'string') {
    throw new Error(`${asMetaUrl} is missing authorization_endpoint/token_endpoint.`);
  }

  return {
    resource: mcpUrl,
    authorizationEndpoint: asMeta.authorization_endpoint,
    tokenEndpoint: asMeta.token_endpoint,
    registrationEndpoint:
      typeof asMeta.registration_endpoint === 'string' ? asMeta.registration_endpoint : undefined,
    scopesSupported: Array.isArray(asMeta.scopes_supported) ? asMeta.scopes_supported : [],
  };
}

/**
 * Register a public (no client_secret) client via RFC 7591 DCR. Throws if the
 * server rejects it — callers fall back to a per-connector static client_id
 * (an env var an admin configured by hand) when this isn't available at all,
 * see `resolveClientId` below.
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<string> {
  const resp = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: clientName,
    }),
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || typeof body.client_id !== 'string') {
    throw new Error(`Dynamic client registration failed (${resp.status}): ${JSON.stringify(body)}`);
  }
  return body.client_id;
}

/**
 * Resolve a client_id for `metadata`: try DCR first, fall back to a static
 * `MCP_OAUTH_CLIENT_ID__<connectorId>` env var (an admin-configured client_id
 * for a provider that advertises no registration_endpoint at all).
 */
export async function resolveClientId(
  metadata: OAuthMetadata,
  connectorId: string,
  redirectUri: string,
): Promise<string> {
  if (metadata.registrationEndpoint) {
    return registerClient(metadata.registrationEndpoint, redirectUri, `claude-gateway (${connectorId})`);
  }
  const envKey = `MCP_OAUTH_CLIENT_ID__${connectorId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;
  const staticClientId = process.env[envKey];
  if (!staticClientId) {
    throw new Error(
      `${metadata.authorizationEndpoint}'s server advertises no Dynamic Client Registration, and no ${envKey} env var is set as a fallback.`,
    );
  }
  return staticClientId;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): PkcePair {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return base64url(crypto.randomBytes(16));
}

export function buildAuthorizeUrl(opts: {
  metadata: OAuthMetadata;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(opts.metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scope);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', opts.state);
  // Required — see this file's module doc comment. Never omit.
  url.searchParams.set('resource', opts.metadata.resource);
  return url.toString();
}

async function tokenRequest(tokenEndpoint: string, body: URLSearchParams): Promise<TokenResponse> {
  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const parsed = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || typeof parsed.access_token !== 'string') {
    throw new Error(`Token request failed (${resp.status}): ${JSON.stringify(parsed)}`);
  }
  return {
    access_token: parsed.access_token,
    token_type: typeof parsed.token_type === 'string' ? parsed.token_type : 'bearer',
    expires_in: typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined,
    refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
  };
}

export function exchangeCode(opts: {
  metadata: OAuthMetadata;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  return tokenRequest(
    opts.metadata.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      code_verifier: opts.codeVerifier,
      resource: opts.metadata.resource, // required — see module doc comment
    }),
  );
}

export function refreshAccessToken(opts: {
  metadata: OAuthMetadata;
  clientId: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  return tokenRequest(
    opts.metadata.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      resource: opts.metadata.resource, // required — see module doc comment
    }),
  );
}
