/**
 * Unit tests for connectors/mcp-oauth.ts — the generic OAuth 2.1 + PKCE (+ DCR)
 * helpers behind connectors whose credential this gateway owns (Firecrawl etc.).
 *
 * The `resource` (RFC 8707) assertions in the authorize/token tests are a
 * deliberate regression guard: a live PoC against production Firecrawl this
 * session found that OMITTING `resource` yields a token that exchanges fine
 * but is rejected by the MCP endpoint itself ("OAUTH_CONNECTION_INVALID") —
 * never let it silently disappear from these calls again.
 */

import {
  discoverOAuthMetadata,
  registerClient,
  resolveClientId,
  resolveScope,
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  OAuthTokenError,
  type OAuthMetadata,
} from '../../src/connectors/mcp-oauth';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.MCP_OAUTH_CLIENT_ID__FIRECRAWL;
  delete process.env.MCP_OAUTH_SCOPES__FIRECRAWL;
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

describe('generatePkce / generateState', () => {
  it('produces a base64url code_verifier and a matching S256 code_challenge', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).not.toBe(codeVerifier);
    // Same verifier always yields the same challenge (pure function of the verifier).
    const crypto = require('crypto');
    const expected = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(codeChallenge).toBe(expected);
  });

  it('generateState produces distinct values each call', () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe('discoverOAuthMetadata', () => {
  const MCP_URL = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
  const PRM_URL = 'https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth';

  it('walks probe 401 -> protected-resource metadata -> authorization-server metadata', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
          token_endpoint: 'https://www.firecrawl.dev/api/oauth/token',
          registration_endpoint: 'https://www.firecrawl.dev/api/oauth/register',
          scopes_supported: ['firecrawl:global', 'offline_access'],
        }),
      );

    const meta = await discoverOAuthMetadata(MCP_URL);
    expect(meta).toEqual({
      resource: MCP_URL,
      authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
      tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
      registrationEndpoint: 'https://www.firecrawl.dev/api/oauth/register',
      scopesSupported: ['firecrawl:global', 'offline_access'],
    });
    // URL-only: every outbound OAuth fetch now carries an AbortSignal.timeout,
    // so the init object is no longer absent on the two GETs. The walk ORDER is
    // what this asserts; the signal itself is asserted separately below.
    expect(mockFetch.mock.calls[1][0]).toBe(PRM_URL);
    expect(mockFetch.mock.calls[2][0]).toBe('https://www.firecrawl.dev/.well-known/oauth-authorization-server');
    for (const [, init] of mockFetch.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('throws a clear error when the probe does not return 401', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(/Expected a 401/);
  });

  it('throws when the 401 has no resource_metadata in WWW-Authenticate', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(401, {}, { 'www-authenticate': 'Bearer error="invalid_token"' }));
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(/no "resource_metadata"/);
  });

  it('registration_endpoint is undefined (not thrown) when the AS advertises none', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://auth.example.com'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        }),
      );
    const meta = await discoverOAuthMetadata(MCP_URL);
    expect(meta.registrationEndpoint).toBeUndefined();
    expect(meta.scopesSupported).toEqual([]);
  });
});

/**
 * The admin chooses the MCP server URL. It does not choose what that server answers
 * with — and every URL after the first probe is the remote side's choice: the
 * `resource_metadata` URL comes from its WWW-Authenticate header, the issuer from the
 * document that returns, and the three endpoints from the document after that.
 *
 * Unchecked, that is a request-forgery primitive aimed at whatever the gateway's VM
 * can reach and the internet cannot, and a token endpoint on plain http would receive
 * the refresh_token in cleartext. Each test below drives ONE hop to an http:// host
 * and asserts the gateway refuses rather than fetches.
 */
describe('discoverOAuthMetadata refuses non-https URLs handed to it by the remote server', () => {
  const MCP_URL = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
  const PRM_URL = 'https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth';

  it('rejects a resource_metadata URL pointing at a cloud metadata service', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        401,
        {},
        { 'www-authenticate': 'Bearer resource_metadata="http://169.254.169.254/latest/meta-data/"' },
      ),
    );
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(
      /resource_metadata URL the gateway will not call/,
    );
    // The point is that it never went: one call (the probe), not two.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an authorization_servers issuer on plain http', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['http://10.0.0.5:8080'] }));
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(
      /authorization server issuer the gateway will not call/,
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a token_endpoint on plain http — that request carries the refresh_token', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://auth.example.com'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'http://auth.example.com/token',
        }),
      );
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(
      /token_endpoint the gateway will not call/,
    );
  });

  it('still allows plain http on localhost, so a self-hosted dev AS keeps working', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['http://localhost:9000'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'http://localhost:9000/authorize',
          token_endpoint: 'http://localhost:9000/token',
        }),
      );
    const meta = await discoverOAuthMetadata(MCP_URL);
    expect(meta.tokenEndpoint).toBe('http://localhost:9000/token');
  });

  /**
   * Regression (round 10). The http exemption used to be `isLocalHostname` from
   * config/public-url — a predicate written for a different value with a different
   * provenance (the admin's own `gateway.publicUrl`, where "is this a local
   * address?" is a UI question), and it accepts any `.internal` or `.local`
   * suffix.
   *
   * That is precisely the set of names the https requirement exists to refuse
   * here: `metadata.google.internal` IS the GCE metadata service — the same
   * endpoint the 169.254.169.254 test above guards, reachable under a name that
   * sailed through. `.local` covers every mDNS name on the LAN. The hostname
   * reaching this check was chosen three hops downstream by the remote MCP
   * server; loopback is the only address it cannot use to reach anything.
   */
  it.each([
    ['metadata.google.internal', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['metadata.internal', 'http://metadata.internal/token'],
    ['an mDNS .local name on the LAN', 'http://nas.local:8080/'],
  ])('rejects plain http to %s — a local-sounding name is not loopback', async (_label, url) => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${url}"` }),
    );
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(
      /resource_metadata URL the gateway will not call/,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('still allows plain http on 127.0.0.1 and [::1]', async () => {
    for (const host of ['127.0.0.1:9000', '[::1]:9000']) {
      mockFetch.mockReset();
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: [`http://${host}`] }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            authorization_endpoint: `http://${host}/authorize`,
            token_endpoint: `http://${host}/token`,
          }),
        );
      const meta = await discoverOAuthMetadata(MCP_URL);
      expect(meta.tokenEndpoint).toBe(`http://${host}/token`);
    }
  });
});

/**
 * The hop the URL validator never used to see.
 *
 * `assertFetchableUrl` gates the URL the gateway ASKS for. Node's fetch then followed
 * redirects by default, so the answering server picked where the request actually
 * landed — a 302 to `http://169.254.169.254/` reached the cloud metadata service
 * having passed every check in the file, and a 307 off the token endpoint re-POSTed
 * the refresh_token, in cleartext, to a host of the provider's choosing.
 *
 * These drive a redirect at each fetch in the module and assert the gateway either
 * re-validates the target or refuses to go at all.
 */
describe('redirects are validated per hop, not followed blindly', () => {
  const MCP_URL = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
  const PRM_URL = 'https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth';

  const redirect = (status: number, location: string) =>
    jsonResponse(status, {}, { location });

  it('refuses a probe redirect to a cloud metadata service instead of following it', async () => {
    mockFetch.mockResolvedValueOnce(redirect(302, 'http://169.254.169.254/latest/meta-data/'));
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(
      /MCP server URL redirect target the gateway will not call/,
    );
    // Never went: one call (the redirect itself), not two.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a protected-resource-metadata redirect onto a plain-http LAN host', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(redirect(301, 'http://10.0.0.5:8080/prm'));
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(
      /protected-resource metadata redirect target the gateway will not call/,
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('refuses an authorization-server-metadata redirect onto a plain-http LAN host', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://auth.example.com'] }))
      // A LAN host, not 127.0.0.1: plain http on localhost stays deliberately
      // allowed here exactly as it is for a directly-discovered endpoint (see the
      // "self-hosted dev AS" test above). The redirect path must not be stricter
      // than the direct one, or it becomes a second, inconsistent policy.
      .mockResolvedValueOnce(redirect(302, 'http://10.0.0.5:9200/_cluster/health'));
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(
      /authorization-server metadata redirect target the gateway will not call/,
    );
  });

  it('follows a redirect the validator accepts, and re-issues at the new URL', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      // The canonical-host hop a real provider serves.
      .mockResolvedValueOnce(redirect(301, 'https://cdn.firecrawl.dev/prm.json'))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://auth.example.com'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        }),
      );
    const meta = await discoverOAuthMetadata(MCP_URL);
    expect(meta.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(mockFetch.mock.calls[2][0]).toBe('https://cdn.firecrawl.dev/prm.json');
  });

  it('resolves a relative Location against the URL just requested, then validates it', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(redirect(302, '/moved/prm.json'))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://auth.example.com'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        }),
      );
    await discoverOAuthMetadata(MCP_URL);
    expect(mockFetch.mock.calls[2][0]).toBe('https://mcp.firecrawl.dev/moved/prm.json');
  });

  it('gives up on a redirect loop rather than spinning', async () => {
    mockFetch.mockResolvedValue(redirect(302, 'https://mcp.firecrawl.dev/loop'));
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(/exceeded 3 redirects/);
    // The initial request plus MAX_REDIRECT_HOPS follow-ups, then it stops.
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('downgrades a redirected POST to a bodiless GET on 302, and preserves it on 307', async () => {
    mockFetch
      .mockResolvedValueOnce(redirect(302, 'https://mcp.firecrawl.dev/moved'))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(/Expected a 401/);
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ method: 'GET', body: undefined });

    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(redirect(307, 'https://mcp.firecrawl.dev/moved'))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(discoverOAuthMetadata(MCP_URL)).rejects.toThrow(/Expected a 401/);
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).method).toBe('initialize');
  });

  it('registerClient validates a DCR redirect target too', async () => {
    mockFetch.mockResolvedValueOnce(redirect(307, 'http://169.254.169.254/register'));
    await expect(
      registerClient('https://as.example.com/register', 'https://x/callback', 'x'),
    ).rejects.toThrow(/registration_endpoint redirect target the gateway will not call/);
  });

  it('never follows a redirect off the token endpoint — that body is the credential', async () => {
    const metadata: OAuthMetadata = {
      resource: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
      authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
      tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
      scopesSupported: [],
    };
    // 307 is the dangerous one: it preserves the method AND the body, so a followed
    // hop would re-POST `refresh_token=fcr_LIVE` to the attacker's host verbatim.
    mockFetch.mockResolvedValueOnce(redirect(307, 'https://exfil.example.com/collect'));

    const err = await refreshAccessToken({
      metadata,
      clientId: 'dyn_abc',
      refreshToken: 'fcr_LIVE',
    }).catch((e: Error) => e);

    expect((err as Error).message).toMatch(/does not forward credentials across redirects/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Transient, not permanent — a misconfigured AS must not cost the user their
    // grant three sweep ticks later.
    expect((err as OAuthTokenError).isPermanent).toBe(false);
  });

  it('every outbound request disables fetch-level redirect following', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://auth.example.com'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        }),
      );
    await discoverOAuthMetadata(MCP_URL);
    for (const [, init] of mockFetch.mock.calls) {
      expect(init.redirect).toBe('manual');
    }
  });
});

describe('registerClient / resolveClientId', () => {
  it('registerClient posts DCR params and returns the issued client_id', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { client_id: 'dyn_abc123' }));
    const clientId = await registerClient(
      'https://www.firecrawl.dev/api/oauth/register',
      'https://pod.example.com/gateway/oauth/mcp/callback',
      'claude-gateway (firecrawl)',
    );
    expect(clientId).toBe('dyn_abc123');
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.redirect_uris).toEqual(['https://pod.example.com/gateway/oauth/mcp/callback']);
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('registerClient throws with the response body when DCR is rejected', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_redirect_uri' }));
    await expect(
      registerClient('https://as.example.com/register', 'https://x/callback', 'x'),
    ).rejects.toThrow(/invalid_redirect_uri/);
  });

  const metaWithDcr: OAuthMetadata = {
    resource: 'https://mcp.example.com/oauth',
    authorizationEndpoint: 'https://as.example.com/authorize',
    tokenEndpoint: 'https://as.example.com/token',
    registrationEndpoint: 'https://as.example.com/register',
    scopesSupported: [],
  };
  const metaWithoutDcr: OAuthMetadata = { ...metaWithDcr, registrationEndpoint: undefined };

  it('resolveClientId uses DCR when registration_endpoint is present', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { client_id: 'dyn_xyz' }));
    const id = await resolveClientId(metaWithDcr, 'firecrawl', 'https://x/callback');
    expect(id).toBe('dyn_xyz');
  });

  it('resolveClientId falls back to MCP_OAUTH_CLIENT_ID__<CONNECTOR_ID> when no registration_endpoint', async () => {
    process.env.MCP_OAUTH_CLIENT_ID__FIRECRAWL = 'static-client-id';
    const id = await resolveClientId(metaWithoutDcr, 'firecrawl', 'https://x/callback');
    expect(id).toBe('static-client-id');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolveClientId throws a clear error when no DCR and no static fallback configured', async () => {
    await expect(resolveClientId(metaWithoutDcr, 'firecrawl', 'https://x/callback')).rejects.toThrow(
      /MCP_OAUTH_CLIENT_ID__FIRECRAWL/,
    );
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes response_type, client_id, redirect_uri, scope, PKCE params, state, AND resource', () => {
    const metadata: OAuthMetadata = {
      resource: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
      authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
      tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
      scopesSupported: [],
    };
    const url = new URL(
      buildAuthorizeUrl({
        metadata,
        clientId: 'dyn_abc',
        redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
        scope: 'firecrawl:global offline_access',
        codeChallenge: 'challenge123',
        state: 'state456',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://www.firecrawl.dev/api/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('dyn_abc');
    expect(url.searchParams.get('redirect_uri')).toBe('https://pod.example.com/gateway/oauth/mcp/callback');
    expect(url.searchParams.get('scope')).toBe('firecrawl:global offline_access');
    expect(url.searchParams.get('code_challenge')).toBe('challenge123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state456');
    // Regression guard — see file doc comment.
    expect(url.searchParams.get('resource')).toBe('https://mcp.firecrawl.dev/v2/mcp-oauth');
  });
});

describe('exchangeCode / refreshAccessToken', () => {
  const metadata: OAuthMetadata = {
    resource: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
    tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
    scopesSupported: [],
  };

  it('exchangeCode posts grant_type=authorization_code with the PKCE verifier AND resource', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: 'fco_1',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'fcr_1',
        scope: 'firecrawl:global offline_access',
      }),
    );
    const token = await exchangeCode({
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      code: 'the-code',
      codeVerifier: 'the-verifier',
    });
    expect(token.access_token).toBe('fco_1');
    expect(token.refresh_token).toBe('fcr_1');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(metadata.tokenEndpoint);
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    // Regression guard — see file doc comment.
    expect(body.get('resource')).toBe(metadata.resource);
  });

  it('exchangeCode throws with the error body when the token endpoint rejects', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
    await expect(
      exchangeCode({
        metadata,
        clientId: 'dyn_abc',
        redirectUri: 'https://x/callback',
        code: 'bad-code',
        codeVerifier: 'v',
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  /**
   * The throw condition has two halves. An RFC 6749 §5.2 error body is the harmless
   * one — it carries no tokens. The other half is a 200 whose `access_token` is not a
   * string, and THAT body can carry a live refresh_token beside it.
   *
   * The resulting message does not stay put: oauth-refresh-sweep.ts prints it on every
   * failed refresh, and oauth-connectors-router.ts renders it into the callback page
   * and the 502 an admin reads in their browser. A refresh_token in a log file is not
   * a token this gateway can revoke.
   */
  it('redacts credentials out of the error body while keeping the shape diagnostic', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: null,
        refresh_token: 'fcr_LIVE_SECRET',
        id_token: 'idt_LIVE_SECRET',
        error_description: 'token issuance degraded',
      }),
    );
    const err = await refreshAccessToken({
      metadata,
      clientId: 'dyn_abc',
      refreshToken: 'fcr_1',
    }).catch((e: Error) => e);

    expect((err as Error).message).not.toContain('fcr_LIVE_SECRET');
    expect((err as Error).message).not.toContain('idt_LIVE_SECRET');
    // Still says what went wrong, and which keys were present — that is the
    // diagnostic, and redacting the whole body would throw it away.
    expect((err as Error).message).toContain('refresh_token');
    expect((err as Error).message).toContain('[redacted]');
    expect((err as Error).message).toContain('token issuance degraded');
  });

  it('leaves an absent credential key as null rather than reporting a redacted one', async () => {
    // `[redacted]` has to mean "a value was here". Stamping it over a null would
    // tell an admin a refresh_token was returned when the missing refresh_token is
    // the very thing they are debugging.
    mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant', refresh_token: null }));
    const err = await refreshAccessToken({
      metadata,
      clientId: 'dyn_abc',
      refreshToken: 'fcr_1',
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('"refresh_token":null');
    expect((err as Error).message).not.toContain('[redacted]');
  });

  it('refreshAccessToken posts grant_type=refresh_token with the refresh token AND resource', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'fco_2', token_type: 'bearer', expires_in: 3600, refresh_token: 'fcr_2' }),
    );
    const token = await refreshAccessToken({
      metadata,
      clientId: 'dyn_abc',
      refreshToken: 'fcr_1',
    });
    expect(token.access_token).toBe('fco_2');

    const [, init] = mockFetch.mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('fcr_1');
    expect(body.get('resource')).toBe(metadata.resource);
  });
});

/**
 * What lands in the `scope` of the authorize URL the admin's own browser follows.
 *
 * Two documents publish a `scopes_supported`, and they do not mean the same thing:
 * RFC 9728 §2's (protected-resource metadata) is what THIS MCP server needs, RFC
 * 8414 §2's (authorization-server metadata) is every scope the AS issues for every
 * resource behind it. Sending the second asks the admin to grant this gateway a
 * whole provider's privileges, and on an AS whose global list holds scopes this
 * client is not entitled to it is an `invalid_scope` that kills the sign-in.
 */
describe('scope selection', () => {
  const MCP_URL = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
  const PRM_URL = 'https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth';

  /** probe 401 -> protected-resource metadata -> authorization-server metadata. */
  function mockDiscovery(prm: Record<string, unknown>, asMeta: Record<string, unknown>) {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'], ...prm }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
          token_endpoint: 'https://www.firecrawl.dev/api/oauth/token',
          ...asMeta,
        }),
      );
  }

  it('prefers the resource’s own scopes over the authorization server’s global list', async () => {
    mockDiscovery(
      { scopes_supported: ['firecrawl:global', 'offline_access'] },
      { scopes_supported: ['firecrawl:global', 'offline_access', 'admin:billing', 'org:delete'] },
    );
    const meta = await discoverOAuthMetadata(MCP_URL);
    expect(meta.scopesSupported).toEqual(['firecrawl:global', 'offline_access']);
  });

  // The control for the test above: a provider that publishes no per-resource
  // scopes is a provider this gateway signs into today, and must keep doing so.
  it('falls back to the authorization server’s list when the resource publishes none', async () => {
    mockDiscovery({}, { scopes_supported: ['firecrawl:global', 'offline_access'] });
    const meta = await discoverOAuthMetadata(MCP_URL);
    expect(meta.scopesSupported).toEqual(['firecrawl:global', 'offline_access']);
  });

  // Omitting the key defers to the next document; publishing `[]` is an answer.
  it('treats an empty resource list as “no scopes”, not as “ask the AS”', async () => {
    mockDiscovery({ scopes_supported: [] }, { scopes_supported: ['admin:billing'] });
    const meta = await discoverOAuthMetadata(MCP_URL);
    expect(meta.scopesSupported).toEqual([]);
  });

  it('drops non-string entries instead of stringifying them into the scope', async () => {
    mockDiscovery({}, { scopes_supported: ['read', 42, null, { a: 1 }, 'offline_access'] });
    const meta = await discoverOAuthMetadata(MCP_URL);
    expect(meta.scopesSupported).toEqual(['read', 'offline_access']);
    // The point of the filter: `[42, null, {a:1}].join(' ')` is
    // `42 null [object Object]`, which the AS refuses as invalid_scope.
    expect(resolveScope(meta, 'firecrawl')).toBe('read offline_access');
  });

  const metadata: OAuthMetadata = {
    resource: MCP_URL,
    authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
    tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
    scopesSupported: ['firecrawl:global'],
  };

  it('resolveScope sends the discovered scopes when nothing is configured', () => {
    expect(resolveScope(metadata, 'firecrawl')).toBe('firecrawl:global');
  });

  it('resolveScope falls back to offline_access when nothing was discovered', () => {
    expect(resolveScope({ ...metadata, scopesSupported: [] }, 'firecrawl')).toBe('offline_access');
  });

  // The recovery path: discovery is the provider's story about itself, and when
  // that story is wrong the operator's only other move is a code change.
  it('resolveScope lets MCP_OAUTH_SCOPES__<ID> override the discovered scopes', () => {
    process.env.MCP_OAUTH_SCOPES__FIRECRAWL = 'firecrawl:read offline_access';
    expect(resolveScope(metadata, 'firecrawl')).toBe('firecrawl:read offline_access');
  });

  it('resolveScope ignores a blank override rather than sending an empty scope', () => {
    process.env.MCP_OAUTH_SCOPES__FIRECRAWL = '   ';
    expect(resolveScope(metadata, 'firecrawl')).toBe('firecrawl:global');
  });

  // Same id transform resolveClientId uses, so an operator who has set one env
  // var can guess the other's name.
  it('resolveScope derives the env var name from the connector id', () => {
    process.env.MCP_OAUTH_SCOPES__MY_SERVER = 'a b';
    try {
      expect(resolveScope(metadata, 'my-server')).toBe('a b');
    } finally {
      delete process.env.MCP_OAUTH_SCOPES__MY_SERVER;
    }
  });
});
