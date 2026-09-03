/**
 * Unit tests for api/oauth-connectors-router.ts — the two routers backing
 * generic OAuth sign-in for `oauth: true` custom connectors:
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
import { PendingOAuthStore } from '../../src/connectors/pending-oauth-store';
import type { OAuthMetadata } from '../../src/connectors/mcp-oauth';

const TOKEN_ENV = '/tmp/oauth-connectors-router-test-mcp-token.env';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV = TOKEN_ENV;
  try {
    fs.rmSync(TOKEN_ENV);
  } catch {
    /* ignore */
  }
  mockFetch.mockReset();
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV;
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
          publicUrl: 'https://pod-abc.vm.getpod.ai/gateway',
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
        { gateway: { publicUrl: 'https://pod-abc.vm.getpod.ai/gateway' } },
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
    oauth: true,
  };

  it('404s for an unknown connector id', async () => {
    const app = makeApp(tmpConfig(), new PendingOAuthStore());
    const res = await request(app)
      .post('/api/v1/connectors/custom/nope/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(res.status).toBe(404);
  });

  it("400s when the connector wasn't added with oauth: true", async () => {
    const app = makeApp(tmpConfig({ plain: { ...firecrawlEntry, oauth: undefined } }), new PendingOAuthStore());
    const res = await request(app)
      .post('/api/v1/connectors/custom/plain/oauth/start')
      .set('X-Api-Key', adminKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oauth: true/);
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
        { gateway: { publicUrl: 'https://pod-abc.vm.getpod.ai/gateway' } },
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
    expect(url.searchParams.get('redirect_uri')).toBe('https://pod-abc.vm.getpod.ai/gateway/oauth/mcp/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe('https://mcp.firecrawl.dev/v2/mcp-oauth');
    expect(url.searchParams.get('scope')).toBe('firecrawl:global offline_access');
    expect(pendingStore.size()).toBe(1);
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

describe('createOauthCallbackRouter — GET /oauth/mcp/callback', () => {
  function makeApp(pendingStore: PendingOAuthStore, returnUrl?: string) {
    const { createOauthCallbackRouter } = require('../../src/api/oauth-connectors-router');
    const app = express();
    app.use(createOauthCallbackRouter(pendingStore, returnUrl));
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
    expect(env['CUSTOM__firecrawl____refresh_token']).toBe('fcr_new');
    expect(env['CUSTOM__firecrawl____client_id']).toBe('dyn_abc');
    expect(Number(env['CUSTOM__firecrawl____token_expires_at'])).toBeGreaterThan(Date.now());

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

    const app = makeApp(pendingStore, 'https://app.getpod.ai/connectors');
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&code=c1`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.getpod.ai/connectors');
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

    const app = makeApp(pendingStore, 'https://app.getpod.ai/connectors');
    const res = await request(app).get(`/oauth/mcp/callback?state=${state}&error=access_denied`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('https://app.getpod.ai/connectors');
    expect(location.searchParams.get('connector_oauth_error')).toBe('access_denied');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('with a configured oauthReturnUrl, an expired/unknown state also redirects back instead of a bare 400 page', async () => {
    const app = makeApp(new PendingOAuthStore(), 'https://app.getpod.ai/connectors');
    const res = await request(app).get('/oauth/mcp/callback?state=nope&code=abc');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('https://app.getpod.ai/connectors');
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
