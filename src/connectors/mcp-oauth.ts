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

/**
 * Every request here goes to a third-party server the gateway does not control, on
 * paths that run inside a 60s periodic sweep (see oauth-refresh-sweep.ts) and inside
 * admin HTTP handlers. Node's fetch has no default timeout, so a provider that accepts
 * the connection and then never responds would hang the caller indefinitely — the
 * sweep's in-flight guard would then skip every subsequent tick, and refresh would
 * stop happening at all. Bounded here so a hang surfaces as an ordinary failure.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One request, timed out, with redirect-following DISABLED.
 *
 * Node's fetch defaults to `redirect: 'follow'`, and a followed redirect goes
 * wherever the answering server names — without passing through
 * `assertFetchableUrl`, which only ever sees the URL we ASK for. A single 302 to
 * `http://169.254.169.254/` therefore lands past the guard the rest of this module
 * is built around: the check has to run per hop, not once per call. Nothing here
 * calls raw `fetch` any more; the two wrappers below are the only ways out.
 */
function fetchNoRedirect(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/**
 * Enough hops for the redirects a real deployment actually serves — a bare host to
 * its canonical one, a trailing-slash normalisation — and few enough that a
 * redirect loop costs three round trips instead of twenty.
 */
const MAX_REDIRECT_HOPS = 3;

/**
 * `fetchNoRedirect`, following up to `MAX_REDIRECT_HOPS` redirects and re-running
 * `assertFetchableUrl` on every `Location` before going there.
 *
 * Used for the discovery walk and the DCR registration POST — requests that carry no
 * credential, where refusing all redirects outright would break providers that
 * legitimately serve their well-known documents off a canonical host. The token
 * endpoint does NOT use this; see `tokenRequest`.
 */
async function fetchFollowingCheckedRedirects(
  url: string,
  what: string,
  init?: RequestInit,
): Promise<Response> {
  let target = url;
  let nextInit = init;
  for (let hop = 0; ; hop++) {
    const resp = await fetchNoRedirect(target, nextInit);
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get('location');
    // A 3xx with no Location is a malformed response, not a redirect — hand it back
    // and let the caller's own status check produce the error.
    if (!location) return resp;
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new Error(
        `Fetching the ${what} exceeded ${MAX_REDIRECT_HOPS} redirects — giving up at ${target}.`,
      );
    }
    // A relative Location is legal (RFC 9110 §10.2.2) and resolves against the URL
    // just requested, so resolve first and validate the absolute result.
    target = assertFetchableUrl(new URL(location, target).toString(), `${what} redirect target`);
    // RFC 9110 §15.4: only 307/308 preserve the method and body. 301/302/303 on a
    // POST become a bodiless GET, which is what every other client does too.
    nextInit =
      resp.status === 307 || resp.status === 308
        ? init
        : { ...init, method: 'GET', body: undefined };
  }
}

/**
 * Gate every URL discovery hands us before the gateway fetches it or POSTs a
 * credential to it.
 *
 * The admin picks the MCP server URL. It does NOT pick what comes back from it: the
 * `resource_metadata` URL arrives in that server's own WWW-Authenticate header, the
 * `authorization_servers[0]` issuer arrives in the document that URL returns, and the
 * authorize/token/registration endpoints arrive in the document after that. Three
 * hops downstream, the remote server is choosing what this process connects to —
 * which is a request-forgery primitive pointed at whatever the gateway's VM can
 * reach but the internet cannot (a metadata service, an admin port on 127.0.0.1,
 * a neighbour on the LAN).
 *
 * Requiring TLS is most of the fix on its own: cloud metadata services and internal
 * admin ports overwhelmingly speak plain http, and a host that does terminate TLS
 * proves nothing about the token — but a plain-http token endpoint would receive the
 * refresh_token in cleartext, which is worth refusing on its own merits.
 *
 * This is a narrowing, not a boundary: an attacker-controlled https host on the LAN
 * still passes. The trust boundary is still the admin key that added the connector.
 */
/**
 * Loopback only — deliberately NOT config/public-url's `isLocalHostname`.
 *
 * That predicate answers a different question, for a value with a different
 * provenance: whether the ADMIN's own `gateway.publicUrl` is a local address, so
 * the UI can decide whether to show it as reachable. Widening it to `.internal`
 * and `.local` is right there and wrong here — the hostname reaching this
 * function was chosen three hops downstream by the remote MCP server, and
 * `metadata.google.internal` (GCE), `metadata.internal`, and any mDNS `.local`
 * name on the LAN are exactly the plain-http targets the https requirement above
 * exists to refuse. Loopback is the only reason to relax it: a developer running
 * an AS on 127.0.0.1 is talking to a socket no other host can reach.
 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || /^127\./.test(host) || host === '::1' || host === '[::1]';
}

function assertFetchableUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Discovery returned a ${what} that is not a valid URL: ${raw}`);
  }
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url.toString();
  throw new Error(
    `Discovery returned a ${what} the gateway will not call: ${url.protocol}//${url.host}` +
      ` — OAuth endpoints must use https (plain http is allowed only for localhost).`,
  );
}

export interface OAuthMetadata {
  /** The MCP server URL this metadata was discovered for — also the RFC 8707 `resource`. */
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Absent when the AS doesn't advertise RFC 7591 Dynamic Client Registration. */
  registrationEndpoint?: string;
  /**
   * Scopes to request for this resource: the protected-resource metadata's list
   * when it publishes one, else the authorization server's. Empty when neither
   * does — see `resolveScope` for what gets sent then.
   */
  scopesSupported: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * A token endpoint that answered, and answered with a refusal.
 *
 * The distinction this class exists to draw is between "the grant is dead" and
 * "we couldn't reach the provider just now". The refresh sweep gives up on a
 * connector after a few consecutive failures and deletes its stored credentials,
 * which is right for the first case and destructive for the second — a fifteen
 * minute provider outage is an ordinary event and must not cost the user their
 * sign-in. Only an explicit OAuth error response can be classified, so only this
 * error type carries `isPermanent`; anything else the sweep sees (a DNS failure,
 * a socket timeout, a 502, a discovery step that returned the wrong shape) is
 * treated as retryable by default.
 */
export class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** RFC 6749 §5.2 `error` code from the response body, when it had one. */
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'OAuthTokenError';
  }

  /**
   * True when the authorization server has told us this grant will never work
   * again. Deliberately a small allowlist rather than "any 4xx": a 400 with no
   * recognisable `error` code, or a 429, says more about this request than about
   * the grant, and retrying costs nothing but a backoff.
   */
  get isPermanent(): boolean {
    return (
      this.status >= 400 &&
      this.status < 500 &&
      (this.errorCode === 'invalid_grant' ||
        this.errorCode === 'invalid_client' ||
        this.errorCode === 'unauthorized_client' ||
        this.errorCode === 'invalid_scope')
    );
  }
}

/** Parse `resource_metadata="<url>"` out of a WWW-Authenticate header value. */
function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null;
  const m = header.match(/resource_metadata="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * A metadata document's string list, or undefined when it has no such list at all.
 *
 * Filtered element by element, not merely checked for being an array: these
 * documents come from a host we do not control, and `scopesSupported` is
 * `join(' ')`ed straight into the `scope` query parameter of a URL the admin's own
 * browser is then sent to. A `scopes_supported: ["read", 42, null, {"a":1}]` —
 * malformed, but served with a 200 — produced `read 42 null [object Object]`, which
 * the AS rejects as invalid_scope with nothing to say where the garbage came from.
 * Dropping the non-strings asks for the scopes it did understand.
 *
 * The undefined/[] distinction is load-bearing at the one call site: a document
 * that OMITS the list has said nothing and defers to the next document, while one
 * that publishes an empty list has said "none", and that is an answer.
 */
function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((s): s is string => typeof s === 'string');
}

/**
 * Discover OAuth metadata for an MCP server by probing it unauthenticated
 * (expects a 401 advertising `resource_metadata`, per RFC 9728), then walking
 * protected-resource metadata → authorization-server metadata (RFC 8414).
 * Throws a descriptive error at whichever step fails — callers surface it
 * to the admin as "can't set up OAuth for this URL", not a generic 500.
 */
export async function discoverOAuthMetadata(mcpUrl: string): Promise<OAuthMetadata> {
  const probe = await fetchFollowingCheckedRedirects(mcpUrl, 'MCP server URL', {
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

  const prm = await fetchFollowingCheckedRedirects(
    assertFetchableUrl(resourceMetadataUrl, 'resource_metadata URL'),
    'protected-resource metadata',
  ).then((r) => {
    if (!r.ok) throw new Error(`Protected-resource metadata fetch failed: ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  });
  const authServers: unknown = prm.authorization_servers;
  if (!Array.isArray(authServers) || typeof authServers[0] !== 'string') {
    throw new Error(`${resourceMetadataUrl} has no authorization_servers listed.`);
  }
  const issuer = new URL(assertFetchableUrl(authServers[0], 'authorization server issuer'));

  // RFC 8414 §3.1: well-known path is inserted before the issuer's own path
  // component (usually empty, as it is for Firecrawl).
  const asMetaUrl = new URL(
    `/.well-known/oauth-authorization-server${issuer.pathname === '/' ? '' : issuer.pathname}`,
    issuer.origin,
  );
  const asMeta = await fetchFollowingCheckedRedirects(
    asMetaUrl.toString(),
    'authorization-server metadata',
  ).then((r) => {
    if (!r.ok) throw new Error(`Authorization-server metadata fetch failed: ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  });

  if (typeof asMeta.authorization_endpoint !== 'string' || typeof asMeta.token_endpoint !== 'string') {
    throw new Error(`${asMetaUrl} is missing authorization_endpoint/token_endpoint.`);
  }

  return {
    resource: mcpUrl,
    // Validated here rather than at each use: the authorize endpoint becomes a
    // redirect the admin's own browser follows, the token endpoint receives the
    // refresh_token, and the registration endpoint receives a DCR POST. All three
    // are values this last document chose.
    authorizationEndpoint: assertFetchableUrl(asMeta.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: assertFetchableUrl(asMeta.token_endpoint, 'token_endpoint'),
    registrationEndpoint:
      typeof asMeta.registration_endpoint === 'string'
        ? assertFetchableUrl(asMeta.registration_endpoint, 'registration_endpoint')
        : undefined,
    // The RESOURCE's list first, the authorization server's only as a fallback.
    // These two documents answer different questions: RFC 9728 §2's
    // `scopes_supported` is the scopes needed to reach THIS MCP server, while RFC
    // 8414 §2's is every scope the AS issues for every resource behind it. Asking
    // for the second is asking the admin to grant this gateway the union of an
    // entire provider's privileges — and on an AS whose global list contains
    // scopes this client may not have, it is also an `invalid_scope` refusal that
    // fails the sign-in outright. The AS list stays as the fallback because a
    // provider that publishes no per-resource scopes is a provider this gateway
    // already signs into today.
    scopesSupported: stringsOf(prm.scopes_supported) ?? stringsOf(asMeta.scopes_supported) ?? [],
  };
}

/**
 * How long a discovered OAuth metadata document is reused. Long enough that a
 * connector refreshing on the hour never re-discovers, short enough that a
 * provider that moves its endpoints is picked up the same day without a restart.
 */
const METADATA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Hard ceiling on cached documents, enforced on top of the TTL.
 *
 * The TTL alone bounds how *stale* an entry can be, not how many there are: an
 * expired entry for a URL nobody ever discovers again is never looked up, so its
 * `expiresAt` check never runs and it sits in the Map for the process lifetime.
 * Every connector edit that changes a URL, and every deleted connector, leaves one
 * behind. Small leak, unbounded shape — so entries are pruned on write and the map
 * is capped.
 *
 * The cap is generous relative to any plausible connector count; it exists so the
 * map cannot grow without limit if `mcpUrl` ever becomes attacker-influenced, not
 * to keep a real install under it.
 */
const MAX_METADATA_CACHE_ENTRIES = 256;

const metadataCache = new Map<string, { metadata: OAuthMetadata; expiresAt: number }>();

/**
 * Drop expired entries, then oldest-first until the map is under the cap.
 *
 * Every entry gets the same TTL, so Map insertion order (which `keys()` preserves)
 * is also expiry order — the first key is always the one closest to expiring, and
 * evicting it costs at most one re-discovery.
 */
function pruneMetadataCache(now: number): void {
  for (const [url, entry] of metadataCache) {
    if (entry.expiresAt <= now) metadataCache.delete(url);
  }
  while (metadataCache.size > MAX_METADATA_CACHE_ENTRIES) {
    const oldest = metadataCache.keys().next();
    if (oldest.done) break;
    metadataCache.delete(oldest.value);
  }
}

/**
 * `discoverOAuthMetadata` with a process-local cache, for the background refresh
 * sweep.
 *
 * Discovery costs three round trips — an MCP probe that is *expected* to 401, then
 * protected-resource metadata, then authorization-server metadata — to obtain a
 * document that changes about never. Paying that on every refresh is not just waste:
 * each of those three requests is another way for a refresh to fail, and a failed
 * refresh is what eventually makes the sweep give up and delete the connector's
 * credentials. Fewer moving parts on the periodic path means fewer spurious failures.
 *
 * Only the sweep uses this. An admin-initiated `oauth/start` still calls
 * `discoverOAuthMetadata` directly: that is the moment a human is waiting to find out
 * whether this URL works at all, so it should see today's truth, not a cached answer
 * from before they fixed their provider's configuration.
 */
export async function discoverOAuthMetadataCached(mcpUrl: string): Promise<OAuthMetadata> {
  const hit = metadataCache.get(mcpUrl);
  if (hit && hit.expiresAt > Date.now()) return hit.metadata;

  const metadata = await discoverOAuthMetadata(mcpUrl);
  // delete-then-set: re-`set`ting an existing key keeps its ORIGINAL position in a
  // Map, which would leave a freshly-refreshed entry at the front of the eviction
  // order. Re-inserting puts it back where its new expiry belongs.
  metadataCache.delete(mcpUrl);
  const now = Date.now();
  metadataCache.set(mcpUrl, { metadata, expiresAt: now + METADATA_CACHE_TTL_MS });
  pruneMetadataCache(now);
  return metadata;
}

/** Drop every cached metadata document. For tests, and for a forced re-discovery. */
export function clearOAuthMetadataCache(): void {
  metadataCache.clear();
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
  const resp = await fetchFollowingCheckedRedirects(registrationEndpoint, 'registration_endpoint', {
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

/**
 * The `scope` to send with an authorization request for `metadata`.
 *
 * An admin-set `MCP_OAUTH_SCOPES__<connectorId>` (space-separated) wins, for the
 * same reason `MCP_OAUTH_CLIENT_ID__<connectorId>` exists above: discovery is the
 * provider's story about itself, and when that story is wrong the sign-in fails at
 * the provider with an `invalid_scope` the operator cannot otherwise do anything
 * about. Some servers publish a scope the client is not entitled to; some grant a
 * refresh_token only when `offline_access` is asked for and never advertise it.
 * Both are one env var away from working, instead of a code change away.
 *
 * `offline_access` is the fallback when nothing is discovered or configured: the
 * refresh sweep needs a refresh_token, and an authorization request carrying no
 * scope at all gets whatever the provider's default happens to be.
 */
export function resolveScope(metadata: OAuthMetadata, connectorId: string): string {
  const envKey = `MCP_OAUTH_SCOPES__${connectorId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;
  const override = process.env[envKey]?.trim();
  if (override) return override;
  return metadata.scopesSupported.length > 0 ? metadata.scopesSupported.join(' ') : 'offline_access';
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

/**
 * Keys whose values are credentials, never diagnostics. A token endpoint's response
 * body is reported verbatim in `tokenRequest`'s error message, and that message
 * travels further than a stack trace: oauth-refresh-sweep.ts logs it on every failed
 * refresh, and oauth-connectors-router.ts renders it into the callback page and the
 * 502 body an admin sees in their browser.
 *
 * The reachable case is not an RFC 6749 §5.2 error body — those carry no tokens. It
 * is the OTHER half of the throw condition: a 200 whose `access_token` is missing or
 * not a string. A provider that returns `{"access_token": null, "refresh_token": "…"}`,
 * or nests the token one level down, or 200s with a partial body on a bad day, hands
 * us a live refresh_token and we print it. Redacting is cheap; a refresh_token in a
 * log file is not revocable by us.
 */
const SECRET_RESPONSE_KEYS = new Set(['access_token', 'refresh_token', 'id_token']);

/** The token endpoint's response, safe to put in an error message. Shape and error
 *  fields are preserved — those are the diagnostic — and only the values that are
 *  credentials are replaced. */
function redactTokenResponse(parsed: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    safe[k] = SECRET_RESPONSE_KEYS.has(k) && v != null ? '[redacted]' : v;
  }
  return JSON.stringify(safe);
}

async function tokenRequest(tokenEndpoint: string, body: URLSearchParams): Promise<TokenResponse> {
  const resp = await fetchNoRedirect(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  // Alone among the requests in this file, a redirect here is refused rather than
  // re-validated and followed. This body carries the authorization code plus its PKCE
  // verifier, or the refresh_token: a 307 re-POSTs that verbatim to wherever the
  // authorization server names, which is how a token endpoint that passed
  // `assertFetchableUrl` at discovery time hands the gateway's live credential to a
  // host of its choosing. Validating the target would not help — there is no
  // destination for which forwarding this body is the right answer.
  //
  // Classified as transient (status < 400, so `isPermanent` is false): an AS that has
  // started answering 302 here is misconfigured or mid-migration, and the sweep must
  // back off rather than delete a grant that is probably still good.
  if (resp.status >= 300 && resp.status < 400) {
    throw new OAuthTokenError(
      `Token request to ${tokenEndpoint} was answered with a ${resp.status} redirect` +
        ` — the gateway does not forward credentials across redirects.`,
      resp.status,
    );
  }
  const parsed = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || typeof parsed.access_token !== 'string') {
    throw new OAuthTokenError(
      `Token request failed (${resp.status}): ${redactTokenResponse(parsed)}`,
      resp.status,
      typeof parsed.error === 'string' ? parsed.error : undefined,
    );
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
