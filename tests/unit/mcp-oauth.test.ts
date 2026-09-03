/**
 * Unit tests for connectors/mcp-oauth.ts — the generic OAuth 2.1 + PKCE (+ DCR)
 * helpers behind "custom" connectors marked `oauth: true` (Firecrawl etc.).
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
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  type OAuthMetadata,
} from '../../src/connectors/mcp-oauth';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.MCP_OAUTH_CLIENT_ID__FIRECRAWL;
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
    expect(mockFetch).toHaveBeenNthCalledWith(2, PRM_URL);
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'https://www.firecrawl.dev/.well-known/oauth-authorization-server');
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

describe('registerClient / resolveClientId', () => {
  it('registerClient posts DCR params and returns the issued client_id', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { client_id: 'dyn_abc123' }));
    const clientId = await registerClient(
      'https://www.firecrawl.dev/api/oauth/register',
      'https://pod.example.com/gateway/oauth/mcp/callback',
      'GetPod (firecrawl)',
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
