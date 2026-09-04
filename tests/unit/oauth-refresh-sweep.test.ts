import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createCustomConnectorsStore } from '../../src/connectors/custom-connectors-store';
import {
  refreshExpiringOAuthConnectors,
  refreshTokenSecretKey,
  clientIdSecretKey,
  expiresAtSecretKey,
  refreshFailCountSecretKey,
  refreshBackoffUntilSecretKey,
  tokenGenerationSecretKey,
} from '../../src/connectors/oauth-refresh-sweep';
import { setSecret, getSecret, readTokenEnv } from '../../src/connectors/token-env';
import { customSecretKey } from '../../src/connectors/custom';
import type { AgentRunner } from '../../src/agent/runner';

const TOKEN_ENV = '/tmp/oauth-refresh-sweep-test-mcp-token.env';

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

function tmpConfigWith(customConnectors: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-refresh-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC', customConnectors }, agents: [] }, null, 2),
  );
  return cfgPath;
}

const firecrawlEntry = {
  label: 'Firecrawl',
  config: { type: 'http', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', headers: { Authorization: 'Bearer {access_token}' } },
  secretNames: ['access_token'],
  oauth: true,
};

describe('refreshExpiringOAuthConnectors', () => {
  it('skips a connector whose token is not near expiry yet — no network calls at all', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 30 * 60 * 1000)); // 30 min out

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    await refreshExpiringOAuthConnectors(store);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBe('fco_old');
  });

  it('refreshes a connector within the skew window and rewrites access_token/refresh_token/expiry', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 60 * 1000)); // 1 min out — due

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
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'fco_new', token_type: 'bearer', expires_in: 3600, refresh_token: 'fcr_new' }),
      );

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    await refreshExpiringOAuthConnectors(store);

    const env = readTokenEnv();
    expect(env['CUSTOM__firecrawl__access_token']).toBe('fco_new');
    expect(env[refreshTokenSecretKey('firecrawl')]).toBe('fcr_new');
    expect(Number(env[expiresAtSecretKey('firecrawl')])).toBeGreaterThan(Date.now() + 3500 * 1000);

    // The refresh grant itself used the stored refresh_token + client_id + resource.
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const body = new URLSearchParams(lastCall[1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('fcr_old');
    expect(body.get('client_id')).toBe('dyn_abc');
    expect(body.get('resource')).toBe('https://mcp.firecrawl.dev/v2/mcp-oauth');
  });

  it('one connector failing to refresh does not stop a second, due, connector from refreshing', async () => {
    setSecret(customSecretKey('broken', 'access_token'), 'fco_broken');
    setSecret(refreshTokenSecretKey('broken'), 'fcr_broken');
    setSecret(clientIdSecretKey('broken'), 'dyn_broken');
    setSecret(expiresAtSecretKey('broken'), String(Date.now() + 1000));

    setSecret(customSecretKey('ok', 'access_token'), 'fco_ok_old');
    setSecret(refreshTokenSecretKey('ok'), 'fcr_ok');
    setSecret(clientIdSecretKey('ok'), 'dyn_ok');
    setSecret(expiresAtSecretKey('ok'), String(Date.now() + 1000));

    const brokenEntry = { ...firecrawlEntry, config: { ...firecrawlEntry.config, url: 'https://mcp.broken.example/oauth' } };
    const okEntry = { ...firecrawlEntry, config: { ...firecrawlEntry.config, url: 'https://mcp.ok.example/oauth' } };

    // "broken" connector: discovery probe itself fails outright.
    mockFetch.mockRejectedValueOnce(new Error('network unreachable'));
    // "ok" connector: full successful discovery + refresh chain.
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.ok.example/.well-known/oauth-protected-resource/oauth"' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://auth.ok.example'] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://auth.ok.example/authorize',
          token_endpoint: 'https://auth.ok.example/token',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'fco_ok_new', token_type: 'bearer', expires_in: 3600 }));

    const store = createCustomConnectorsStore(tmpConfigWith({ broken: brokenEntry, ok: okEntry }));
    await expect(refreshExpiringOAuthConnectors(store)).resolves.not.toThrow();

    const env = readTokenEnv();
    expect(env['CUSTOM__broken__access_token']).toBe('fco_broken'); // untouched
    expect(env['CUSTOM__ok__access_token']).toBe('fco_ok_new'); // refreshed despite the other's failure
  });

  it('skips a connector with no stored refresh_token/client_id (nothing to refresh with)', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));
    // Deliberately no refresh_token / client_id secrets set.

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    await refreshExpiringOAuthConnectors(store);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ignores non-oauth custom connectors entirely', async () => {
    const store = createCustomConnectorsStore(
      tmpConfigWith({ plain: { ...firecrawlEntry, oauth: undefined } }),
    );
    await refreshExpiringOAuthConnectors(store);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Regression: a network blip self-heals next tick (fail count resets on
  // any success), but a refresh_token that keeps failing must eventually
  // stop being retried AND stop reporting "connected" — before this fix the
  // sweep retried an already-dead refresh_token forever, every 60s, while
  // status kept showing a green checkmark for a connector that could never
  // actually refresh again.
  describe('failure backoff and give-up', () => {
    function setUpDueFirecrawl() {
      setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
      setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
      setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
      setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));
    }

    it('backs off after a failure — a second sweep tick immediately after does not retry the network call', async () => {
      setUpDueFirecrawl();
      mockFetch.mockRejectedValueOnce(new Error('network unreachable'));

      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
      await refreshExpiringOAuthConnectors(store);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(getSecret(refreshBackoffUntilSecretKey('firecrawl'))).not.toBeNull();

      // Next tick, still within the backoff window — must not call out again.
      await refreshExpiringOAuthConnectors(store);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('gives up after 3 consecutive failures: clears all tokens so status correctly reports disconnected', async () => {
      setUpDueFirecrawl();
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

      for (let i = 0; i < 3; i++) {
        mockFetch.mockRejectedValueOnce(new Error('invalid_grant'));
        // Clear any backoff from the previous iteration so this tick is due again.
        setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
        await refreshExpiringOAuthConnectors(store);
      }

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const env = readTokenEnv();
      expect(env['CUSTOM__firecrawl__access_token']).toBeUndefined();
      expect(env[refreshTokenSecretKey('firecrawl')]).toBeUndefined();
      expect(env[clientIdSecretKey('firecrawl')]).toBeUndefined();
      expect(env[refreshFailCountSecretKey('firecrawl')]).toBeUndefined();
    });

    it('a success resets the failure count — one earlier blip does not count toward giving up later', async () => {
      setUpDueFirecrawl();
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

      mockFetch.mockRejectedValueOnce(new Error('network unreachable'));
      await refreshExpiringOAuthConnectors(store);
      expect(getSecret(refreshFailCountSecretKey('firecrawl'))).toBe('1');

      // Force past the backoff window and let this attempt succeed.
      setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
      mockFetch
        .mockResolvedValueOnce(jsonResponse(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"' }))
        .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }))
        .mockResolvedValueOnce(jsonResponse(200, { authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize', token_endpoint: 'https://www.firecrawl.dev/api/oauth/token' }))
        .mockResolvedValueOnce(jsonResponse(200, { access_token: 'fco_new', token_type: 'bearer', expires_in: 3600 }));
      await refreshExpiringOAuthConnectors(store);

      expect(getSecret(refreshFailCountSecretKey('firecrawl'))).toBeNull();
      expect(getSecret(refreshBackoffUntilSecretKey('firecrawl'))).toBeNull();
    });
  });

  // Regression: disconnect only ever cleared secretNames (just access_token for
  // an oauth entry) — refresh_token/client_id/expiry survived, so the sweep
  // would silently resurrect a connector the user just disconnected. The fix
  // lives in connectors-router.ts's DELETE handler; this proves the sweep's
  // own precondition (no refresh_token/client_id) correctly makes it a no-op
  // once that cleanup has happened.
  it('does nothing for a connector whose refresh_token/client_id were cleared by a disconnect', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));
    // No refresh_token/client_id — this is the post-disconnect state.

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    await refreshExpiringOAuthConnectors(store);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBe('fco_old'); // untouched, not resurrected
  });

  it('restarts sessions using the connector after a successful refresh', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"' }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize', token_endpoint: 'https://www.firecrawl.dev/api/oauth/token' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'fco_new', token_type: 'bearer', expires_in: 3600 }));

    const restartSessionsUsingConnector = jest.fn().mockResolvedValue({ restarted: true });
    const agents = new Map<string, AgentRunner>([
      ['main', { restartSessionsUsingConnector } as unknown as AgentRunner],
    ]);

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    await refreshExpiringOAuthConnectors(store, agents);

    expect(restartSessionsUsingConnector).toHaveBeenCalledWith('firecrawl');
  });

  // Regression: a manual reconnect (fresh /oauth/mcp/callback exchange) racing
  // this sweep's own in-flight refresh must win — the sweep's write is derived
  // from a refresh_token that may already be stale the instant a fresher sign-in
  // lands, so it must detect that and discard its own result instead of
  // clobbering the newer one.
  it('abandons its own refresh result if a fresher token was written while it was in flight', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));
    setSecret(tokenGenerationSecretKey('firecrawl'), 'gen-1');

    mockFetch
      .mockResolvedValueOnce(jsonResponse(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"' }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize', token_endpoint: 'https://www.firecrawl.dev/api/oauth/token' }))
      // Simulate a concurrent manual reconnect landing its own fresher token
      // (and bumping the generation stamp) while this sweep's token request
      // is still in flight, just before the sweep's response resolves.
      .mockImplementationOnce(async () => {
        setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_from_manual_reconnect');
        setSecret(tokenGenerationSecretKey('firecrawl'), 'gen-2-from-manual-reconnect');
        return jsonResponse(200, { access_token: 'fco_from_sweep_stale', token_type: 'bearer', expires_in: 3600 });
      });

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    await refreshExpiringOAuthConnectors(store);

    // The sweep's own (now-stale) result must NOT have overwritten the fresher one.
    expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBe('fco_from_manual_reconnect');
    expect(getSecret(tokenGenerationSecretKey('firecrawl'))).toBe('gen-2-from-manual-reconnect');
  });
});
