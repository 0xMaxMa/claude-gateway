/**
 * Unit tests for api/oauth-connectors-router.ts — the two routers backing
 * generic OAuth sign-in for gateway-owned custom connectors
 * (`credentialOwner: 'gateway'`):
 *   createOauthConnectorsRouter() — admin-gated POST .../oauth/start
 *   createOauthCallbackRouter()  — public GET /oauth/mcp/callback
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ApiKey } from '../../src/types';
import { createCustomConnectorsStore } from '../../src/connectors/custom-connectors-store';
import type { CustomConnectorsStore } from '../../src/connectors/custom-connectors-store';
import { PendingOAuthStore } from '../../src/connectors/pending-oauth-store';
import type { OAuthMetadata } from '../../src/connectors/mcp-oauth';

const TOKEN_ENV = '/tmp/oauth-connectors-router-test-mcp-token.env';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV_PATH = TOKEN_ENV;
  try {
    fs.rmSync(TOKEN_ENV);
  } catch {
    /* ignore */
  }
  mockFetch.mockReset();
  delete process.env.MCP_OAUTH_SCOPES__FIRECRAWL;
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV_PATH;
  try {
    fs.rmSync(TOKEN_ENV);
  } catch {
    /* ignore */
  }
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const adminKey = 'admin-key';
const apiKeys: ApiKey[] = [{ key: adminKey, agents: '*', admin: true }];

function tmpConfig(customConnectors: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-oauth-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        gateway: {
          logDir: '/tmp',
          timezone: 'UTC',
          publicUrl: 'https://pod-abc.vm.example.com/gateway',
          customConnectors,
        },
        agents: [],
      },
      null,
      2,
    ),
  );
  return cfgPath;
}

describe('createOauthConnectorsRouter — POST /v1/connectors/custom/:id/oauth/start', () => {
  function makeApp(configPath: string, pendingStore: PendingOAuthStore) {
    const { createOauthConnectorsRouter } = require('../../src/api/oauth-connectors-router');
    const store = createCustomConnectorsStore(configPath);
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createOauthConnectorsRouter(
        apiKeys,
        { gateway: { publicUrl: 'https://pod-abc.vm.example.com/gateway' } },
        store,
        pendingStore,
      ),
    );
    return app;
  }

  const firecrawlEntry = {
    label: 'Firecrawl',
    config: { type: 'http', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', headers: { Authorization: 'Bearer {access_token}' } },
    secretNames: ['access_token'],
    credentialOwner: 'gateway',
  };

  it('404s for an unknown connector id', async () => {
    const app = makeApp(tmpConfig(), new PendingOAuthStore());
    const res = await request(app)
      .post('/api/v1/connectors/custom/nope/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(res.status).toBe(404);
  });

  it("400s when the connector wasn't added with oauth: true", async () => {
    const app = makeApp(
      tmpConfig({ plain: { ...firecrawlEntry, credentialOwner: 'static' } }),
      new PendingOAuthStore(),
    );
    const res = await request(app)
      .post('/api/v1/connectors/custom/plain/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oauth: true/);
  });

  // 'external' is not just "also not gateway-owned": its token arrives through a
  // different endpoint, so the generic refusal above would send the caller to an
  // oauth/start it must never use. It gets its own message, and its own test.
  it('400s with the /oauth/receive route when the credential is owned externally', async () => {
    const app = makeApp(
      tmpConfig({ pushed: { ...firecrawlEntry, credentialOwner: 'external' } }),
      new PendingOAuthStore(),
    );
    const res = await request(app)
      .post('/api/v1/connectors/custom/pushed/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oauth\/receive/);
  });

  it('non-admin cannot start an OAuth flow', async () => {
    const scopedApp = express();
    scopedApp.use(express.json());
    const { createOauthConnectorsRouter } = require('../../src/api/oauth-connectors-router');
    const store = createCustomConnectorsStore(tmpConfig({ firecrawl: firecrawlEntry }));
    scopedApp.use(
      '/api',
      createOauthConnectorsRouter(
        [{ key: 'scoped', agents: ['a1'] }, ...apiKeys],
        { gateway: { publicUrl: 'https://pod-abc.vm.example.com/gateway' } },
        store,
      ),
    );
    const res = await request(scopedApp)
      .post('/api/v1/connectors/custom/firecrawl/oauth/start')
      .set('X-Api-Key', 'scoped');
    expect(res.status).toBe(403);
  });

  it('discovers metadata, registers a client via DCR, and returns an authorize URL that includes PKCE + resource', async () => {
    const pendingStore = new PendingOAuthStore();
    const app = makeApp(tmpConfig({ firecrawl: firecrawlEntry }), pendingStore);

    const prmUrl = 'https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth';
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${prmUrl}"` }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
          token_endpoint: 'https://www.firecrawl.dev/api/oauth/token',
          registration_endpoint: 'https://www.firecrawl.dev/api/oauth/register',
          scopes_supported: ['firecrawl:global', 'offline_access'],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { client_id: 'dyn_abc123' }));

    const res = await request(app)
      .post('/api/v1/connectors/custom/firecrawl/oauth/start')
      .set('X-Api-Key', adminKey);

    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://www.firecrawl.dev/api/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('dyn_abc123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://pod-abc.vm.example.com/gateway/oauth/mcp/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe('https://mcp.firecrawl.dev/v2/mcp-oauth');
    expect(url.searchParams.get('scope')).toBe('firecrawl:global offline_access');
    expect(pendingStore.size()).toBe(1);
  });

  /**
   * The `scope` in that URL is what the admin is asked to consent to, so where it
   * comes from matters. These two drive it end-to-end rather than through
   * resolveScope alone: the router is the only thing that decides which connector
   * id the scope is resolved for.
   */
  function mockScopeDiscovery(prm: Record<string, unknown>, asScopes: unknown[]) {
    const prmUrl = 'https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth';
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${prmUrl}"` }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'], ...prm }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
          token_endpoint: 'https://www.firecrawl.dev/api/oauth/token',
          registration_endpoint: 'https://www.firecrawl.dev/api/oauth/register',
          scopes_supported: asScopes,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { client_id: 'dyn_abc123' }));
  }

  async function scopeOfAuthorizeUrl(): Promise<string | null> {
    const app = makeApp(tmpConfig({ firecrawl: firecrawlEntry }), new PendingOAuthStore());
    const res = await request(app)
      .post('/api/v1/connectors/custom/firecrawl/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(res.status).toBe(200);
    return new URL(res.body.authorizeUrl).searchParams.get('scope');
  }

  // The AS's global list is every scope it issues for every resource behind it —
  // consenting to it hands this gateway a whole provider's privileges, and on an
  // AS holding scopes this client is not entitled to it is an invalid_scope that
  // fails the sign-in outright.
  it('asks only for the scopes the MCP server itself declares, not the AS’s whole catalogue', async () => {
    mockScopeDiscovery({ scopes_supported: ['firecrawl:global', 'offline_access'] }, [
      'firecrawl:global',
      'offline_access',
      'admin:billing',
      'org:delete',
    ]);
    expect(await scopeOfAuthorizeUrl()).toBe('firecrawl:global offline_access');
  });

  // Discovery is the provider's story about itself. When that story is wrong the
  // sign-in dies at the provider with an invalid_scope, and without this the
  // operator's only remaining move is to patch the gateway.
  it('lets MCP_OAUTH_SCOPES__<ID> override what discovery advertised', async () => {
    process.env.MCP_OAUTH_SCOPES__FIRECRAWL = 'firecrawl:read offline_access';
    mockScopeDiscovery({ scopes_supported: ['firecrawl:global'] }, ['firecrawl:global']);
    expect(await scopeOfAuthorizeUrl()).toBe('firecrawl:read offline_access');
  });

  it('502s with the discovery error when the MCP url does not look like an OAuth server', async () => {
    const app = makeApp(tmpConfig({ firecrawl: firecrawlEntry }), new PendingOAuthStore());
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await request(app)
      .post('/api/v1/connectors/custom/firecrawl/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Expected a 401/);
  });

  // Regression: every /oauth/start call re-ran DCR unconditionally, so every
  // abandoned or retried "Connect" click registered (and orphaned, at the
  // provider) a brand-new OAuth client. The second call for the same
  // connector must reuse the client_id from the first instead of
  // registering again.
  it('reuses the DCR-registered client_id on a second /oauth/start call for the same connector — no second registration', async () => {
    const pendingStore = new PendingOAuthStore();
    const app = makeApp(tmpConfig({ firecrawl: firecrawlEntry }), pendingStore);

    const discoveryMocks = () => [
      jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"` }),
      jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }),
      jsonResponse(200, {
        authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
        token_endpoint: 'https://www.firecrawl.dev/api/oauth/token',
        registration_endpoint: 'https://www.firecrawl.dev/api/oauth/register',
      }),
    ];

    // First call: discovery (3) + DCR registration (1) = 4 fetches.
    for (const m of discoveryMocks()) mockFetch.mockResolvedValueOnce(m);
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { client_id: 'dyn_first_registration' }));
    const first = await request(app)
      .post('/api/v1/connectors/custom/firecrawl/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(first.status).toBe(200);
    expect(new URL(first.body.authorizeUrl).searchParams.get('client_id')).toBe('dyn_first_registration');
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // Second call: discovery only (3) — no registration call this time.
    for (const m of discoveryMocks()) mockFetch.mockResolvedValueOnce(m);
    const second = await request(app)
      .post('/api/v1/connectors/custom/firecrawl/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(second.status).toBe(200);
    expect(new URL(second.body.authorizeUrl).searchParams.get('client_id')).toBe('dyn_first_registration');
    expect(mockFetch).toHaveBeenCalledTimes(4 + 3); // not 4 + 4 — no re-registration
  });

  // A cached client_id was registered against a specific redirect_uri — if
  // gateway.publicUrl changes, that redirect_uri is no longer valid at the
  // provider, so the cache must be invalidated and a fresh client registered.
  it('re-registers instead of reusing the cache when the redirect_uri (gateway.publicUrl) has changed', async () => {
    const pendingStore = new PendingOAuthStore();
    const cfgPath = tmpConfig({ firecrawl: firecrawlEntry });
    const { createOauthConnectorsRouter } = require('../../src/api/oauth-connectors-router');
    const store = createCustomConnectorsStore(cfgPath);
    const appV1 = express();
    appV1.use(express.json());
    appV1.use('/api', createOauthConnectorsRouter(apiKeys, { gateway: { publicUrl: 'https://pod-abc.vm.example.com/gateway' } }, store, pendingStore));

    const discoveryMocks = () => [
      jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"` }),
      jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }),
      jsonResponse(200, {
        authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
        token_endpoint: 'https://www.firecrawl.dev/api/oauth/token',
        registration_endpoint: 'https://www.firecrawl.dev/api/oauth/register',
      }),
    ];
    for (const m of discoveryMocks()) mockFetch.mockResolvedValueOnce(m);
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { client_id: 'dyn_old_redirect' }));
    await request(appV1).post('/api/v1/connectors/custom/firecrawl/oauth/start').set('X-Api-Key', adminKey);

    // Same connector, new gateway.publicUrl (e.g. a fresh tunnel) → different redirect_uri.
    const appV2 = express();
    appV2.use(express.json());
    appV2.use('/api', createOauthConnectorsRouter(apiKeys, { gateway: { publicUrl: 'https://pod-abc-new-tunnel.vm.example.com/gateway' } }, store, pendingStore));
    for (const m of discoveryMocks()) mockFetch.mockResolvedValueOnce(m);
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { client_id: 'dyn_new_redirect' }));
    const res = await request(appV2).post('/api/v1/connectors/custom/firecrawl/oauth/start').set('X-Api-Key', adminKey);

    expect(res.status).toBe(200);
    expect(new URL(res.body.authorizeUrl).searchParams.get('client_id')).toBe('dyn_new_redirect');
  });

  it("500s when gateway.publicUrl isn't a valid /gateway URL", async () => {
    const { createOauthConnectorsRouter } = require('../../src/api/oauth-connectors-router');
    const store = createCustomConnectorsStore(tmpConfig({ firecrawl: firecrawlEntry }));
    const app = express();
    app.use(express.json());
    app.use('/api', createOauthConnectorsRouter(apiKeys, { gateway: { publicUrl: undefined } }, store));
    const res = await request(app)
      .post('/api/v1/connectors/custom/firecrawl/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(res.status).toBe(500);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

/**
 * Minimal CustomConnectorsStore over an in-memory map. The callback router only
 * reads, and it reads twice per request (before and after the token exchange),
 * so a plain object is enough — and mutating that object between the two reads
 * is exactly how the mid-flow race is reproduced below.
 */
function gatewayOwnedStore(
  connectors: Record<string, { credentialOwner: string }> = {
    firecrawl: { credentialOwner: 'gateway' },
  },
): CustomConnectorsStore {
  return {
    read: async () => connectors as never,
    mutate: async (fn) => {
      fn(connectors as never);
    },
    withEntry: async (id, fn) =>
      fn({
        entry: connectors[id] as never,
        remove: () => {
          delete connectors[id];
        },
      }),
  };
}

describe('createOauthCallbackRouter — GET /oauth/mcp/callback', () => {
  function makeApp(pendingStore: PendingOAuthStore, returnUrl?: string, store = gatewayOwnedStore()) {
    const { createOauthCallbackRouter } = require('../../src/api/oauth-connectors-router');
    const app = express();
    app.use(createOauthCallbackRouter(store, pendingStore, returnUrl));
    return app;
  }

  const metadata: OAuthMetadata = {
    resource: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
    tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
    scopesSupported: [],
  };

  it('returns 400 for an unknown/expired state, and never calls the token endpoint', async () => {
    const app = makeApp(new PendingOAuthStore());
    const res = await request(app).get('/oauth/mcp/callback?state=nope&code=abc');
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 when the provider reports an error, without touching the token endpoint', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
    const app = makeApp(pendingStore);
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&error=access_denied`);
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/access_denied/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // This route is public (no auth) — `error` is a raw, attacker-controllable
  // query param. Without escaping, a state a real admin's browser is holding
  // (leaked via referrer/history/logs) plus a crafted `error` value would be
  // reflected straight into the HTML response.
  it('HTML-escapes the provider error before putting it in the fallback page (no oauthReturnUrl configured)', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
    const app = makeApp(pendingStore); // no returnUrl — takes the plain-HTML fallback path
    const payload = '<script>alert(1)</script>';
    const res = await request(app).get(
      `/oauth/mcp/callback?state=${state}&error=${encodeURIComponent(payload)}`,
    );
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('exchanges the code and writes access_token, refresh_token, client_id, and expiry into mcp-token.env', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier-123',
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: 'fco_new',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'fcr_new',
      }),
    );

    const app = makeApp(pendingStore);
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&code=the-code`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Connected/);

    const { readTokenEnv } = require('../../src/connectors/token-env');
    const env = readTokenEnv();
    expect(env['CUSTOM__firecrawl__access_token']).toBe('fco_new');
    expect(env['CUSTOMINT__firecrawl____refresh_token']).toBe('fcr_new');
    expect(env['CUSTOMINT__firecrawl____client_id']).toBe('dyn_abc');
    expect(Number(env['CUSTOMINT__firecrawl____token_expires_at'])).toBeGreaterThan(Date.now());
    // Bumped so oauth-refresh-sweep.ts can detect a fresher token written
    // here while one of its own refreshes was still in flight, and discard
    // its own now-stale result instead of clobbering this one.
    expect(env['CUSTOMINT__firecrawl____token_generation']).toBeTruthy();

    // The token endpoint call itself used the stored PKCE verifier + resource.
    const [, init] = mockFetch.mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('code_verifier')).toBe('verifier-123');
    expect(body.get('resource')).toBe(metadata.resource);
  });

  it('with a configured oauthReturnUrl, a real HTTP redirect goes straight there — no interstitial page', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'fco_1', token_type: 'bearer', expires_in: 3600 }),
    );

    const app = makeApp(pendingStore, 'https://app.example.com/connectors');
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&code=c1`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.example.com/connectors');
  });

  it('an invalid oauthReturnUrl falls back to the plain "close this tab" message instead of crashing', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'fco_1', token_type: 'bearer', expires_in: 3600 }),
    );

    const app = makeApp(pendingStore, 'not-a-valid-url');
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&code=c1`);
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toMatch(/close this tab/);
  });

  /**
   * `new URL()` accepts every scheme there is, and this value's only job is to
   * become the `Location` of a 302 sent to the end user's own browser from a
   * route that is public by design. A `javascript:` return URL is therefore a
   * stored XSS primitive aimed at everyone who ever finishes — or abandons — a
   * sign-in, and `file:` points that browser at the operator's own disk.
   */
  const BAD_SCHEMES = [
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
  ];

  it.each(BAD_SCHEMES)('refuses a non-http(s) oauthReturnUrl (%s) on the success path', async (bad) => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'fco_1', token_type: 'bearer', expires_in: 3600 }),
    );

    const app = makeApp(pendingStore, bad);
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&code=c1`);
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toMatch(/close this tab/);
  });

  // fail() redirects too, so it needs the same gate — and this is the easier
  // half to reach: a denial takes no valid pending flow and no token exchange.
  it.each(BAD_SCHEMES)('refuses a non-http(s) oauthReturnUrl (%s) on the failure path', async (bad) => {
    const app = makeApp(new PendingOAuthStore(), bad);
    const res = await request(app).get('/oauth/mcp/callback?error=access_denied');
    expect(res.headers.location).toBeUndefined();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // The control: http is not https, but it is a real deployment — a gateway and
  // its app both on localhost during development. Only non-web schemes are out.
  it('still redirects to a plain-http oauthReturnUrl', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'fco_1', token_type: 'bearer', expires_in: 3600 }),
    );

    const app = makeApp(pendingStore, 'http://localhost:3000/connectors');
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&code=c1`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/connectors');
  });

  // The exact bug a real user hit: with oauthReturnUrl configured, denying
  // consent used to leave the browser stranded on a bare gateway page with
  // no way back — only the success path redirected. Every terminal outcome
  // must redirect back when the app knows where "back" is.
  it('with a configured oauthReturnUrl, denying consent also redirects back — with the reason in a query param, not stranded on a bare gateway page', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });

    const app = makeApp(pendingStore, 'https://app.example.com/connectors');
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&error=access_denied`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('https://app.example.com/connectors');
    expect(location.searchParams.get('connector_oauth_error')).toBe('access_denied');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // The redirect param is the one place a provider-supplied value leaves this
  // process for someone else's app, and `searchParams.set` only makes it a
  // well-formed parameter — not a safe one. A provider (or anyone who got hold of a
  // live state) answering with a novel-length `error` used to have all of it
  // forwarded into the app's own error display.
  it('clamps a non-conforming provider error to a generic code before forwarding it to the return URL', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });

    const app = makeApp(pendingStore, 'https://app.example.com/connectors');
    const payload = '<img src=x onerror=alert(1)>' + 'A'.repeat(500);
    const res = await request(app).get(
      `/oauth/mcp/callback?state=${state}&error=${encodeURIComponent(payload)}`,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('connector_oauth_error')).toBe('provider_error');
    expect(res.headers.location).not.toContain('onerror');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('with a configured oauthReturnUrl, an expired/unknown state also redirects back instead of a bare 400 page', async () => {
    const app = makeApp(new PendingOAuthStore(), 'https://app.example.com/connectors');
    const res = await request(app).get('/oauth/mcp/callback?state=nope&code=abc');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('https://app.example.com/connectors');
    expect(location.searchParams.get('connector_oauth_error')).toBe('expired_link');
  });

  it('the same state cannot be replayed — a second callback with the same state 400s', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'fco_1', token_type: 'bearer', expires_in: 3600 }),
    );
    const app = makeApp(pendingStore);
    const first = await request(app).get(`/oauth/mcp/callback?state=${state}&code=c1`);
    expect(first.status).toBe(200);
    const second = await request(app).get(`/oauth/mcp/callback?state=${state}&code=c2`);
    expect(second.status).toBe(400);
  });

  it('502s and does not write any secret when the token exchange itself fails', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
    const app = makeApp(pendingStore);
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&code=bad`);
    expect(res.status).toBe(502);

    const { hasSecret } = require('../../src/connectors/token-env');
    expect(hasSecret('CUSTOM__firecrawl__access_token')).toBe(false);
  });
});

/**
 * Regressions from the fourth independent review pass. Each of these describes a
 * state a user can reach through ordinary use, not a hand-crafted one.
 */
describe('createOauthCallbackRouter — a completed sign-in is a fresh start', () => {
  function makeApp(pendingStore: PendingOAuthStore, returnUrl?: string) {
    const { createOauthCallbackRouter } = require('../../src/api/oauth-connectors-router');
    const app = express();
    app.use(createOauthCallbackRouter(gatewayOwnedStore(), pendingStore, returnUrl));
    return app;
  }

  const metadata: OAuthMetadata = {
    resource: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
    tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
    scopesSupported: [],
  };

  function startFlow(pendingStore: PendingOAuthStore): string {
    return pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod-abc.vm.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
  }

  // The state after a provider outage: transientBackoffMs caps at 6h, and a
  // permanent count of 2 is one refusal short of MAX_CONSECUTIVE_FAILURES. The
  // user notices the connector is broken and signs in again — which used to
  // leave all three values in place, so the sweep skipped the brand-new
  // (one-hour) token for six hours and the next refusal deleted it outright.
  it('clears the refresh backoff and BOTH failure counters', async () => {
    const {
      refreshFailCountSecretKey,
      refreshTransientCountSecretKey,
      refreshBackoffUntilSecretKey,
    } = require('../../src/connectors/oauth-refresh-sweep');
    const { setSecrets, readTokenEnv } = require('../../src/connectors/token-env');
    const sixHoursOut = Date.now() + 6 * 60 * 60 * 1000;
    setSecrets({
      [refreshTransientCountSecretKey('firecrawl')]: '8',
      [refreshFailCountSecretKey('firecrawl')]: '2',
      [refreshBackoffUntilSecretKey('firecrawl')]: String(sixHoursOut),
    });

    const pendingStore = new PendingOAuthStore();
    const state = startFlow(pendingStore);
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: 'NEW',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'R2',
      }),
    );
    const res = await request(makeApp(pendingStore)).get(
      `/oauth/mcp/callback?state=${state}&code=good`,
    );
    expect(res.status).toBe(200);

    const env = readTokenEnv();
    expect(env['CUSTOM__firecrawl__access_token']).toBe('NEW');
    expect(env[refreshTransientCountSecretKey('firecrawl')]).toBeUndefined();
    expect(env[refreshFailCountSecretKey('firecrawl')]).toBeUndefined();
    expect(env[refreshBackoffUntilSecretKey('firecrawl')]).toBeUndefined();
  });

  // resolveGatewayPublicUrl REQUIRES publicUrl to end in /gateway, so this is the
  // path every provider is actually handed. Traefik strips the prefix in prod;
  // the direct-path deployment that same function permits does not, and used to
  // 404 with the pending flow left to expire silently.
  it('answers on the /gateway-prefixed path the redirect_uri actually points at', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = startFlow(pendingStore);
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'VIA_PREFIX', token_type: 'bearer', expires_in: 3600 }),
    );
    const res = await request(makeApp(pendingStore)).get(
      `/gateway/oauth/mcp/callback?state=${state}&code=good`,
    );
    expect(res.status).toBe(200);

    const { readTokenEnv } = require('../../src/connectors/token-env');
    expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBe('VIA_PREFIX');
  });
});

describe('POST .../oauth/start — an abandoned flow must not touch the live client_id', () => {
  function makeApp(configPath: string, pendingStore: PendingOAuthStore) {
    const { createOauthConnectorsRouter } = require('../../src/api/oauth-connectors-router');
    const store = createCustomConnectorsStore(configPath);
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createOauthConnectorsRouter(
        apiKeys,
        { gateway: { publicUrl: 'https://pod-abc.vm.example.com/gateway' } },
        store,
        pendingStore,
      ),
    );
    return app;
  }

  // Reachable by editing gateway.publicUrl and then closing the Connect dialog:
  // the cached redirect_uri no longer matches, so start DCR-registers a new
  // client. Writing that into the key the sweep refreshes with left refresh_token
  // R1 (issued to C1) paired with client_id C2 — the AS answers invalid_client,
  // which is classified permanent, and three ticks later the working sign-in is
  // deleted.
  it('leaves the connector refreshable with the client its refresh_token was issued to', async () => {
    const { clientIdSecretKey } = require('../../src/connectors/oauth-refresh-sweep');
    const { setSecrets, readTokenEnv } = require('../../src/connectors/token-env');
    setSecrets({
      [clientIdSecretKey('firecrawl')]: 'C1_LIVE',
      'CUSTOMINT__firecrawl____client_redirect_uri': 'https://OLD.example.com/gateway/oauth/mcp/callback',
      'CUSTOMINT__firecrawl____refresh_token': 'R1',
    });

    // discovery (probe 401 → PRM → AS metadata), then the DCR registration
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, {
          'www-authenticate':
            'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource"',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
          token_endpoint: 'https://www.firecrawl.dev/api/oauth/token',
          registration_endpoint: 'https://www.firecrawl.dev/api/oauth/register',
          scopes_supported: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { client_id: 'C2_NEW' }));

    const app = makeApp(
      tmpConfig({
        firecrawl: {
          label: 'Firecrawl',
          config: { type: 'http', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth' },
          secretNames: ['access_token'],
          credentialOwner: 'gateway',
        },
      }),
      new PendingOAuthStore(),
    );
    const res = await request(app)
      .post('/api/v1/connectors/custom/firecrawl/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain('client_id=C2_NEW');

    // The user then closes the tab. The live pairing must be untouched.
    const env = readTokenEnv();
    expect(env[clientIdSecretKey('firecrawl')]).toBe('C1_LIVE');
    expect(env['CUSTOMINT__firecrawl____dcr_client_id']).toBe('C2_NEW');
  });
});

/**
 * Round-6 regression: `refresh_token` and the `client_id` it was issued to are
 * one credential, and the callback has to replace them together or not at all.
 *
 * `client_id` is written unconditionally; `refresh_token` only when the response
 * carried one — and an authorization server is entitled to omit it (RFC 6749 §6,
 * and it happens routinely whenever the granted scopes don't include
 * `offline_access`; see the scope fallback in oauth-connectors-router.ts). With
 * no removal, the OLD refresh_token R1 — issued to the old client C1 — survived
 * beside the NEW client_id C2. The sweep then POSTs that mismatched pair, the AS
 * answers `invalid_client`, `OAuthTokenError.isPermanent` classifies it as
 * permanent, and three ticks later the sweep deletes a sign-in that had just
 * succeeded.
 */
describe('createOauthCallbackRouter — refresh_token and client_id are replaced together', () => {
  function makeApp(pendingStore: PendingOAuthStore) {
    const { createOauthCallbackRouter } = require('../../src/api/oauth-connectors-router');
    const app = express();
    app.use(createOauthCallbackRouter(gatewayOwnedStore(), pendingStore));
    return app;
  }

  const metadata: OAuthMetadata = {
    resource: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
    tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
    scopesSupported: [],
  };

  function startFlowAs(pendingStore: PendingOAuthStore, clientId: string): string {
    return pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId,
      redirectUri: 'https://pod-abc.vm.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
  }

  it('removes the old refresh_token when the new token response carries none', async () => {
    const {
      refreshTokenSecretKey,
      clientIdSecretKey,
    } = require('../../src/connectors/oauth-refresh-sweep');
    const { setSecrets, readTokenEnv } = require('../../src/connectors/token-env');
    setSecrets({
      [refreshTokenSecretKey('firecrawl')]: 'R1',
      [clientIdSecretKey('firecrawl')]: 'C1',
    });

    const pendingStore = new PendingOAuthStore();
    const state = startFlowAs(pendingStore, 'C2');
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'NEW', token_type: 'bearer', expires_in: 3600 }),
    );
    const res = await request(makeApp(pendingStore)).get(
      `/oauth/mcp/callback?state=${state}&code=good`,
    );
    expect(res.status).toBe(200);

    const env = readTokenEnv();
    expect(env['CUSTOM__firecrawl__access_token']).toBe('NEW');
    expect(env[clientIdSecretKey('firecrawl')]).toBe('C2');
    // Not R1 paired with C2 — nothing at all. `refreshStatusOf` reports the
    // connector as `unrefreshable` once the token expires, which is the honest
    // state, instead of the sweep destroying it three ticks from now.
    expect(env[refreshTokenSecretKey('firecrawl')]).toBeUndefined();
  });

  it('replaces — not removes — the refresh_token when the response does carry one', async () => {
    const {
      refreshTokenSecretKey,
      clientIdSecretKey,
    } = require('../../src/connectors/oauth-refresh-sweep');
    const { setSecrets, readTokenEnv } = require('../../src/connectors/token-env');
    setSecrets({
      [refreshTokenSecretKey('firecrawl')]: 'R1',
      [clientIdSecretKey('firecrawl')]: 'C1',
    });

    const pendingStore = new PendingOAuthStore();
    const state = startFlowAs(pendingStore, 'C2');
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: 'NEW',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'R2',
      }),
    );
    const res = await request(makeApp(pendingStore)).get(
      `/oauth/mcp/callback?state=${state}&code=good`,
    );
    expect(res.status).toBe(200);

    const env = readTokenEnv();
    expect(env[refreshTokenSecretKey('firecrawl')]).toBe('R2');
    expect(env[clientIdSecretKey('firecrawl')]).toBe('C2');
  });
});

/**
 * The callback is a public route whose only proof is `state`, and `state` proves
 * one thing: this browser started this flow. It says nothing about the connector
 * still being there, or this gateway still being the party that owns its
 * credential — and the gap is a whole FLOW_TTL_MS of the user reading a consent
 * screen. Two ordinary admin actions land inside it, and both used to be undone
 * by the returning callback.
 */
describe('createOauthCallbackRouter — a connector that changed under the flow', () => {
  const { readTokenEnv } = require('../../src/connectors/token-env');
  const {
    refreshTokenSecretKey,
    clientIdSecretKey,
  } = require('../../src/connectors/oauth-refresh-sweep');

  const metadata: OAuthMetadata = {
    resource: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    authorizationEndpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
    tokenEndpoint: 'https://www.firecrawl.dev/api/oauth/token',
    scopesSupported: [],
  };

  function makeApp(pendingStore: PendingOAuthStore, store: CustomConnectorsStore) {
    const { createOauthCallbackRouter } = require('../../src/api/oauth-connectors-router');
    const app = express();
    app.use(createOauthCallbackRouter(store, pendingStore));
    return app;
  }

  function startFlow(pendingStore: PendingOAuthStore): string {
    return pendingStore.create({
      connectorId: 'firecrawl',
      metadata,
      clientId: 'dyn_abc',
      redirectUri: 'https://pod.example.com/gateway/oauth/mcp/callback',
      codeVerifier: 'verifier',
    });
  }

  function expectNothingStored(): void {
    const env = readTokenEnv();
    expect(env['CUSTOM__firecrawl__access_token']).toBeUndefined();
    expect(env[refreshTokenSecretKey('firecrawl')]).toBeUndefined();
    expect(env[clientIdSecretKey('firecrawl')]).toBeUndefined();
    expect(env['CUSTOMINT__firecrawl____token_generation']).toBeUndefined();
  }

  // DELETE clears the credentials precisely so a live refresh_token cannot
  // resurrect a connector the admin just disconnected. Writing a whole fresh
  // token set here would do exactly that, one route over.
  it('refuses to resurrect a connector deleted while the user was on the consent screen', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = startFlow(pendingStore);
    const store = gatewayOwnedStore({}); // already deleted

    const res = await request(makeApp(pendingStore, store)).get(
      `/oauth/mcp/callback?state=${state}&code=good`,
    );

    expect(res.status).toBe(409);
    // Caught before the exchange — no code is spent on a token nothing will keep.
    expect(mockFetch).not.toHaveBeenCalled();
    expectNothingStored();
  });

  // /oauth/receive can hand the id to an external control plane. The sweep skips
  // a non-'gateway' entry and DELETE only clears CUSTOMINT__* for a 'gateway'
  // one, so anything written here would be an orphan nothing ever collects.
  it("refuses to write gateway-owned token state onto an entry now owned 'external'", async () => {
    const pendingStore = new PendingOAuthStore();
    const state = startFlow(pendingStore);
    const store = gatewayOwnedStore({ firecrawl: { credentialOwner: 'external' } });

    const res = await request(makeApp(pendingStore, store)).get(
      `/oauth/mcp/callback?state=${state}&code=good`,
    );

    expect(res.status).toBe(409);
    expect(mockFetch).not.toHaveBeenCalled();
    expectNothingStored();
  });

  // The pre-check is an optimisation; this is the one that closes the race. The
  // entry is 'gateway' when the exchange starts and gone by the time it returns,
  // which is what a DELETE landing during the token round trip looks like.
  it('discards an already-exchanged token when the connector goes away DURING the exchange', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = startFlow(pendingStore);
    const connectors: Record<string, { credentialOwner: string }> = {
      firecrawl: { credentialOwner: 'gateway' },
    };
    const store = gatewayOwnedStore(connectors);

    mockFetch.mockImplementationOnce(async () => {
      delete connectors['firecrawl']; // the admin's DELETE, mid-flight
      return jsonResponse(200, {
        access_token: 'fco_new',
        refresh_token: 'fcr_new',
        token_type: 'bearer',
        expires_in: 3600,
      });
    });

    const res = await request(makeApp(pendingStore, store)).get(
      `/oauth/mcp/callback?state=${state}&code=good`,
    );

    expect(res.status).toBe(409);
    expect(mockFetch).toHaveBeenCalledTimes(1); // it DID exchange...
    expectNothingStored(); // ...and kept nothing.
  });

  // An unreadable config.json degrades to {} rather than throwing (see
  // custom-connectors-store.ts), which must read as "cannot vouch for this
  // connector" — not as permission to write.
  it('fails closed when the connector store cannot be read', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = startFlow(pendingStore);
    const store: CustomConnectorsStore = {
      read: async () => ({}), // what a degraded read returns
      mutate: async () => {},
      withEntry: async (_id, fn) => fn({ entry: undefined, remove: () => {} }),
    };

    const res = await request(makeApp(pendingStore, store)).get(
      `/oauth/mcp/callback?state=${state}&code=good`,
    );

    expect(res.status).toBe(409);
    expectNothingStored();
  });

  it('still completes normally when the connector is untouched', async () => {
    const pendingStore = new PendingOAuthStore();
    const state = startFlow(pendingStore);
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: 'fco_new',
        refresh_token: 'fcr_new',
        token_type: 'bearer',
        expires_in: 3600,
      }),
    );

    const res = await request(
      makeApp(pendingStore, gatewayOwnedStore({ firecrawl: { credentialOwner: 'gateway' } })),
    ).get(`/oauth/mcp/callback?state=${state}&code=good`);

    expect(res.status).toBe(200);
    expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBe('fco_new');
  });
});
