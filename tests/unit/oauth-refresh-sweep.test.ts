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
  refreshTransientCountSecretKey,
  transientBackoffMs,
  tokenGenerationSecretKey,
} from '../../src/connectors/oauth-refresh-sweep';
import { setSecret, getSecret, readTokenEnv, deleteSecrets } from '../../src/connectors/token-env';
import { clearOAuthMetadataCache } from '../../src/connectors/mcp-oauth';
import { customSecretKey } from '../../src/connectors/custom';
import type { AgentRunner } from '../../src/agent/runner';

const TOKEN_ENV = '/tmp/oauth-refresh-sweep-test-mcp-token.env';

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
  // The sweep caches discovered OAuth metadata per MCP URL for six hours, and
  // that cache is module state shared by every test in this file — without this
  // a later test's queued discovery mocks would go unconsumed and its token
  // request would be answered with a discovery response.
  clearOAuthMetadataCache();
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
  credentialOwner: 'gateway',
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

  // The due-check used to ask getSecret() five separate questions — five reads and
  // parses of the whole mcp-token.env, per connector, per 60s tick. They run back to
  // back with no await between them, so nothing was gained for the extra four: they
  // all describe the same instant. The re-read AFTER the token request is the
  // opposite case and must stay fresh — the "manual reconnect mid-flight" test below
  // is what holds that line.
  it('reads mcp-token.env once for the due-check, not once per key it inspects', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000)); // due
    // No refresh_token on purpose: the sweep runs the whole due-check and then stops
    // at the "nothing to refresh with" guard, so this counts the reads without
    // needing a mocked network round trip.

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

    // Counted at the token-env module boundary, the same seam countTokenEnvWrites
    // uses below. It has to be `require` and not the `import * as` namespace above:
    // esModuleInterop copies the exports into a fresh object, and a spy installed on
    // that copy never sees the sweep's calls.
    const tokenEnv = require('../../src/connectors/token-env');
    const readSpy = jest.spyOn(tokenEnv, 'readTokenEnv');
    const getSpy = jest.spyOn(tokenEnv, 'getSecret');
    let snapshots = 0;
    let singleKeyReads = 0;
    try {
      await refreshExpiringOAuthConnectors(store);
      // Read out before restoring — mockRestore() also resets the recorded calls,
      // which is why countTokenEnvWrites below takes its total() first too.
      snapshots = readSpy.mock.calls.length;
      singleKeyReads = getSpy.mock.calls.length;
    } finally {
      readSpy.mockRestore();
      getSpy.mockRestore();
    }

    expect(mockFetch).not.toHaveBeenCalled();
    // One snapshot for the whole due-check, with nothing going back for a second
    // copy of the same file.
    expect(snapshots).toBe(1);
    expect(singleKeyReads).toBe(0);
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

    /** Queue a full, successful discovery chain for the firecrawl URL. Only
     *  needed once per test — discovery is cached for the rest of it. */
    function queueDiscovery() {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"' }))
        .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }))
        .mockResolvedValueOnce(jsonResponse(200, { authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize', token_endpoint: 'https://www.firecrawl.dev/api/oauth/token' }));
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

    it('gives up after 3 consecutive refusals from the authorization server: clears all tokens so status correctly reports disconnected', async () => {
      setUpDueFirecrawl();
      setSecret(tokenGenerationSecretKey('firecrawl'), 'gen-1');
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

      for (let i = 0; i < 3; i++) {
        if (i === 0) queueDiscovery(); // cached for the remaining ticks
        // RFC 6749 §5.2: the AS itself declaring this grant dead.
        mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
        // Clear any backoff from the previous iteration so this tick is due again.
        setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
        await refreshExpiringOAuthConnectors(store);
      }

      const env = readTokenEnv();
      expect(env['CUSTOM__firecrawl__access_token']).toBeUndefined();
      expect(env[refreshTokenSecretKey('firecrawl')]).toBeUndefined();
      expect(env[clientIdSecretKey('firecrawl')]).toBeUndefined();
      expect(env[refreshFailCountSecretKey('firecrawl')]).toBeUndefined();
      // Cleared with the rest — a generation counter left behind for an id with
      // no tokens silently disarms the optimistic-concurrency check on the next
      // sign-in.
      expect(env[tokenGenerationSecretKey('firecrawl')]).toBeUndefined();
    });

    // The give-up tick is the one an admin greps for when a connector drops, and
    // the log line used to be emitted BEFORE the give-up branch was evaluated —
    // so the message immediately above "delete every credential for this
    // connector" read "retrying in 5m". The one moment the log matters most was
    // the one moment it said the opposite of what happened.
    it('logs the credential deletion on the give-up tick, not a retry that never happens', async () => {
      setUpDueFirecrawl();
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      for (let i = 0; i < 3; i++) {
        if (i === 0) queueDiscovery();
        mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
        setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
        await refreshExpiringOAuthConnectors(store);
      }

      const lines = errSpy.mock.calls.map((c) => String(c[0]));
      errSpy.mockRestore();

      // Sanity: the two ticks that really did schedule a retry still say so.
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('retrying in');
      expect(lines[2]).toContain('giving up');
      expect(lines[2]).not.toContain('retrying in');
      // And the tokens are in fact gone, so the message matches the outcome.
      expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBeUndefined();
    });

    // Each failure result is one logical state change: the count for this kind of
    // failure goes up, the count for the other kind is cleared. Writing that as
    // setSecrets-then-deleteSecrets is two whole-file rewrites, and a crash in
    // between leaves BOTH counters set — which connector status then renders as a
    // transient backoff that is not in effect.
    //
    // Counted at the token-env seam rather than on fs.renameSync, which jest
    // cannot spy on (fs's own properties are non-configurable): every writer in
    // that module funnels to exactly one atomic write, so calls here are rewrites.
    function countTokenEnvWrites() {
      const tokenEnv = require('../../src/connectors/token-env');
      const spies = (['setSecrets', 'updateSecrets', 'deleteSecrets'] as const).map((fn) =>
        jest.spyOn(tokenEnv, fn),
      );
      return {
        total: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
        restore: () => spies.forEach((s) => s.mockRestore()),
      };
    }

    it('records a permanent failure in exactly one rewrite of the token env', async () => {
      setUpDueFirecrawl();
      setSecret(refreshTransientCountSecretKey('firecrawl'), '4'); // must be cleared
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
      queueDiscovery();
      mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));

      const writes = countTokenEnvWrites();
      await refreshExpiringOAuthConnectors(store);
      const total = writes.total();
      writes.restore();

      expect(total).toBe(1);
      expect(getSecret(refreshFailCountSecretKey('firecrawl'))).toBe('1');
      expect(getSecret(refreshTransientCountSecretKey('firecrawl'))).toBeNull();
    });

    it('commits a successful refresh in exactly one rewrite of the token env', async () => {
      setUpDueFirecrawl();
      setSecret(refreshTransientCountSecretKey('firecrawl'), '2');
      setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
      queueDiscovery();
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'fco_new', token_type: 'bearer', expires_in: 3600 }),
      );

      const writes = countTokenEnvWrites();
      await refreshExpiringOAuthConnectors(store);
      const total = writes.total();
      writes.restore();

      expect(total).toBe(1);
      // The new token and the cleared counters landed together — a crash between
      // two rewrites could leave a fresh token still carrying a stale backoff,
      // which makes the next tick skip a connector that is perfectly healthy.
      expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBe('fco_new');
      expect(getSecret(refreshTransientCountSecretKey('firecrawl'))).toBeNull();
      expect(getSecret(refreshBackoffUntilSecretKey('firecrawl'))).toBeNull();
    });

    // Regression: giving up DELETES the user's credentials, so it must only ever
    // happen when the authorization server itself said the grant is dead. This
    // used to count any failure — so an ordinary provider outage lasting a few
    // ticks, landing while a token happened to be inside its refresh window,
    // destroyed a perfectly valid sign-in and forced a manual reconnect.
    it('never gives up on transient failures — an unreachable provider keeps its tokens', async () => {
      setUpDueFirecrawl();
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

      for (let i = 0; i < 5; i++) {
        mockFetch.mockRejectedValueOnce(new Error('network unreachable'));
        setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
        await refreshExpiringOAuthConnectors(store);
      }

      const env = readTokenEnv();
      expect(env['CUSTOM__firecrawl__access_token']).toBe('fco_old');
      expect(env[refreshTokenSecretKey('firecrawl')]).toBe('fcr_old');
      expect(env[clientIdSecretKey('firecrawl')]).toBe('dyn_abc');
      // Transient failures back off but never accumulate toward deletion.
      expect(getSecret(refreshFailCountSecretKey('firecrawl'))).toBeNull();
      expect(getSecret(refreshBackoffUntilSecretKey('firecrawl'))).not.toBeNull();
    });

    // A 500/429 from the token endpoint is the endpoint having a bad day, not a
    // verdict on the grant — same treatment as an unreachable host.
    it('treats a token-endpoint 500 as transient, not as a refusal', async () => {
      setUpDueFirecrawl();
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

      queueDiscovery();
      mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: 'server_error' }));
      await refreshExpiringOAuthConnectors(store);

      expect(getSecret(refreshFailCountSecretKey('firecrawl'))).toBeNull();
      expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBe('fco_old');
    });

    it('a success resets the failure count — one earlier refusal does not count toward giving up later', async () => {
      setUpDueFirecrawl();
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

      queueDiscovery();
      mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
      await refreshExpiringOAuthConnectors(store);
      expect(getSecret(refreshFailCountSecretKey('firecrawl'))).toBe('1');

      // Force past the backoff window and let this attempt succeed.
      setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'fco_new', token_type: 'bearer', expires_in: 3600 }),
      );
      await refreshExpiringOAuthConnectors(store);

      expect(getSecret(refreshFailCountSecretKey('firecrawl'))).toBeNull();
      expect(getSecret(refreshBackoffUntilSecretKey('firecrawl'))).toBeNull();
    });

    // The three discovery round-trips are three extra ways for a refresh to
    // fail, on a path where enough failures delete the user's credentials.
    it('reuses discovered metadata across ticks instead of re-probing every time', async () => {
      setUpDueFirecrawl();
      const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

      queueDiscovery();
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'fco_new_1', token_type: 'bearer', expires_in: 3600 }),
      );
      await refreshExpiringOAuthConnectors(store);
      expect(mockFetch).toHaveBeenCalledTimes(4); // 3 discovery + 1 token

      // Make it due again; only the token request should go out this time.
      setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'fco_new_2', token_type: 'bearer', expires_in: 3600 }),
      );
      await refreshExpiringOAuthConnectors(store);
      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBe('fco_new_2');
    });

    // Regression: transient failures deliberately never delete the grant and
    // never accumulate toward giving up — which, on a flat five-minute backoff,
    // meant a permanently unreachable MCP URL retried and log-spammed every five
    // minutes for the process lifetime while status stayed green. The backoff now
    // grows per consecutive transient failure, so a dead provider costs a handful
    // of attempts a day instead of 288, and still self-heals the moment it
    // answers again.
    describe('transient backoff escalation', () => {
      it('doubles the backoff window on each consecutive transient failure', async () => {
        setUpDueFirecrawl();
        const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

        const windows: number[] = [];
        for (let i = 0; i < 4; i++) {
          mockFetch.mockRejectedValueOnce(new Error('network unreachable'));
          setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
          const before = Date.now();
          await refreshExpiringOAuthConnectors(store);
          windows.push(Number(getSecret(refreshBackoffUntilSecretKey('firecrawl'))) - before);
          expect(getSecret(refreshTransientCountSecretKey('firecrawl'))).toBe(String(i + 1));
        }

        // 5m, 10m, 20m, 40m — each window at least ~1.9x the last (the lower
        // bound absorbs the few ms of clock drift inside each tick).
        expect(windows[0]).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
        expect(windows[0]).toBeLessThan(6 * 60 * 1000);
        for (let i = 1; i < windows.length; i++) {
          expect(windows[i]).toBeGreaterThan(windows[i - 1] * 1.9);
        }
      });

      it('caps the backoff so a dead provider is still retried a few times a day', () => {
        expect(transientBackoffMs(1)).toBe(5 * 60 * 1000);
        expect(transientBackoffMs(2)).toBe(10 * 60 * 1000);
        expect(transientBackoffMs(7)).toBe(320 * 60 * 1000); // 5m * 2^6, still under the cap
        expect(transientBackoffMs(8)).toBe(6 * 60 * 60 * 1000); // 5m * 2^7 = 640m, capped at 6h
        expect(transientBackoffMs(500)).toBe(6 * 60 * 60 * 1000);
        // 2 ** n is Infinity long before n=500, and Infinity * 5m is still
        // Infinity — a NaN/Infinity deadline would park the connector forever.
        expect(Number.isFinite(transientBackoffMs(500))).toBe(true);
      });

      it('resets the transient streak on success, so a later outage starts from 5m again', async () => {
        setUpDueFirecrawl();
        const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

        for (let i = 0; i < 3; i++) {
          mockFetch.mockRejectedValueOnce(new Error('network unreachable'));
          setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
          await refreshExpiringOAuthConnectors(store);
        }
        expect(getSecret(refreshTransientCountSecretKey('firecrawl'))).toBe('3');

        setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
        queueDiscovery();
        mockFetch.mockResolvedValueOnce(
          jsonResponse(200, { access_token: 'fco_new', token_type: 'bearer', expires_in: 3600 }),
        );
        await refreshExpiringOAuthConnectors(store);
        expect(getSecret(refreshTransientCountSecretKey('firecrawl'))).toBeNull();
      });

      // The authorization server answering at all — even to refuse — proves the
      // host is reachable, so the transient streak has ended. Leaving it set
      // would carry a stale multi-hour backoff into the permanent-failure path,
      // where three refusals are supposed to be reached promptly.
      it('clears the transient streak once the authorization server answers', async () => {
        setUpDueFirecrawl();
        const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));

        mockFetch.mockRejectedValueOnce(new Error('network unreachable'));
        await refreshExpiringOAuthConnectors(store);
        expect(getSecret(refreshTransientCountSecretKey('firecrawl'))).toBe('1');

        setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
        queueDiscovery();
        mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
        const before = Date.now();
        await refreshExpiringOAuthConnectors(store);

        expect(getSecret(refreshTransientCountSecretKey('firecrawl'))).toBeNull();
        expect(getSecret(refreshFailCountSecretKey('firecrawl'))).toBe('1');
        // Back on the flat permanent backoff, not an escalated transient one.
        const window = Number(getSecret(refreshBackoffUntilSecretKey('firecrawl'))) - before;
        expect(window).toBeLessThan(6 * 60 * 1000);
      });
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

/**
 * Regressions from the fourth independent review pass.
 */
describe('a successful refresh stays successful', () => {
  function mockSuccessfulRefresh(accessToken: string) {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {}, {
          'www-authenticate':
            'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
          token_endpoint: 'https://www.firecrawl.dev/api/oauth/token',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: accessToken, token_type: 'bearer', expires_in: 3600 }),
      );
  }

  // The restart used to sit inside the same try as the network calls with no
  // per-runner catch, so a rejecting proc.stop() fell through to the classifier,
  // which treats anything that isn't an OAuthTokenError as a transient refresh
  // failure. The refresh had already succeeded and its token was already written.
  it('a failing session restart is not recorded as a refresh failure', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));
    mockSuccessfulRefresh('fco_new');

    const agents = new Map<string, AgentRunner>([
      [
        'main',
        {
          restartSessionsUsingConnector: jest.fn().mockRejectedValue(new Error('stop() failed')),
        } as unknown as AgentRunner,
      ],
    ]);

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    await refreshExpiringOAuthConnectors(store, agents);

    const env = readTokenEnv();
    expect(env['CUSTOM__firecrawl__access_token']).toBe('fco_new'); // the refresh DID succeed
    expect(env[refreshTransientCountSecretKey('firecrawl')]).toBeUndefined();
    expect(env[refreshBackoffUntilSecretKey('firecrawl')]).toBeUndefined();
  });
});

describe('corrupt bookkeeping cannot disable the give-up path', () => {
  // A non-numeric counter used to poison everything downstream of it: NaN + 1 is
  // NaN, `NaN >= MAX_CONSECUTIVE_FAILURES` is false forever so the give-up branch
  // became unreachable, and transientBackoffMs(NaN) wrote 'NaN' into the backoff
  // key, where the skip guard's `Number('NaN') > Date.now()` is also false. Net
  // effect: hammering a dead token endpoint every 60s for the life of the process.
  it('treats a garbage fail count as 0 and still reaches the third-strike deletion', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));
    setSecret(refreshFailCountSecretKey('firecrawl'), 'not-a-number');

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        mockFetch.mockReset();
        // Cleared so every attempt costs the same four fetches. Left cached, the
        // second tick would need only the token request and would consume the
        // 401 probe response below instead — a 401 with no RFC 6749 error code,
        // which classifies as transient and would not exercise this path at all.
        clearOAuthMetadataCache();
        mockFetch
          .mockResolvedValueOnce(
            jsonResponse(401, {}, {
              'www-authenticate':
                'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"',
            }),
          )
          .mockResolvedValueOnce(
            jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }),
          )
          .mockResolvedValueOnce(
            jsonResponse(200, {
              authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize',
              token_endpoint: 'https://www.firecrawl.dev/api/oauth/token',
            }),
          )
          .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));

        // Each attempt clears its own backoff, so the next tick isn't skipped —
        // this test is about the counter, not the backoff timing.
        deleteSecrets([refreshBackoffUntilSecretKey('firecrawl')]);
        await refreshExpiringOAuthConnectors(store);

        const count = readTokenEnv()[refreshFailCountSecretKey('firecrawl')];
        if (attempt < 2) expect(count).toBe(String(attempt + 1));
      }
    } finally {
      errSpy.mockRestore();
    }

    // Third strike: credentials gone, exactly as with a well-formed counter.
    const env = readTokenEnv();
    expect(env['CUSTOM__firecrawl__access_token']).toBeUndefined();
    expect(env[refreshTokenSecretKey('firecrawl')]).toBeUndefined();
  });
});

/**
 * Round-6 regressions for the sweep.
 */
describe('giving up is selective about the cached DCR registration', () => {
  // Imported from the module that owns the internal key namespace rather than
  // rebuilt here: these two moved out of oauth-connectors-router.ts precisely
  // because a cache only one module can name is a cache nobody else can
  // invalidate, and a copy of the naming rule in the test would drift with it.
  const {
    dcrClientIdSecretKey,
    clientRedirectUriSecretKey,
  } = require('../../src/connectors/oauth-refresh-sweep');

  function setUpDueFirecrawl() {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));
    setSecret(dcrClientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(clientRedirectUriSecretKey('firecrawl'), 'https://pod.example.com/gateway/oauth/mcp/callback');
  }

  function queueDiscovery() {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"' }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize', token_endpoint: 'https://www.firecrawl.dev/api/oauth/token' }));
  }

  /** Three consecutive refusals with the same RFC 6749 §5.2 error code — the
   *  give-up threshold. */
  async function giveUpWith(errorCode: string) {
    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) {
        if (i === 0) queueDiscovery();
        mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: errorCode }));
        setSecret(refreshBackoffUntilSecretKey('firecrawl'), '0');
        await refreshExpiringOAuthConnectors(store);
      }
    } finally {
      errSpy.mockRestore();
    }
    return readTokenEnv();
  }

  // The provider is saying it does not recognise this client at all. A cache
  // holding a client_id the provider has deleted is unrecoverable through the
  // UI: Connect reads the cache, finds the redirect_uri still matches, skips
  // re-registration and fails again — forever, until someone hand-edits
  // mcp-token.env.
  it('clears the cached registration when the AS refuses the CLIENT', async () => {
    setUpDueFirecrawl();
    const env = await giveUpWith('invalid_client');
    expect(env['CUSTOM__firecrawl__access_token']).toBeUndefined();
    expect(env[dcrClientIdSecretKey('firecrawl')]).toBeUndefined();
    expect(env[clientRedirectUriSecretKey('firecrawl')]).toBeUndefined();
  });

  // `invalid_grant` is the opposite: the refresh_token is dead while the
  // registered client is still perfectly good. Throwing the client away here
  // orphans a registration at the provider for nothing — the next Connect click
  // just mints another one.
  it('keeps the cached registration when the AS refuses only the GRANT', async () => {
    setUpDueFirecrawl();
    const env = await giveUpWith('invalid_grant');
    expect(env['CUSTOM__firecrawl__access_token']).toBeUndefined();
    expect(env[refreshTokenSecretKey('firecrawl')]).toBeUndefined();
    expect(env[dcrClientIdSecretKey('firecrawl')]).toBe('dyn_abc');
    expect(env[clientRedirectUriSecretKey('firecrawl')]).toBe(
      'https://pod.example.com/gateway/oauth/mcp/callback',
    );
  });
});

// The sweep's doc comment promises "never throws out of the sweep so one broken
// connector can't stop the rest" — but the guard only ever wrapped the network
// call. Everything outside it touches mcp-token.env too: the reads that decide
// whether a connector is due, and the updateSecrets/setSecrets/deleteSecrets
// calls in the failure branches, each of which can throw an errno of its own.
// Uncaught, one such blip on the FIRST connector in the map abandoned the sweep
// for every connector after it, and gateway-router.ts's `.catch()` swallowed the
// reason: nothing else refreshed that tick, and the only trace was one line
// naming the first connector.
describe('a token-env write failure on one connector does not abandon the sweep', () => {
  it('still refreshes a later connector after an earlier one fails to record its failure', async () => {
    setSecret(customSecretKey('broken', 'access_token'), 'fco_broken');
    setSecret(refreshTokenSecretKey('broken'), 'fcr_broken');
    setSecret(clientIdSecretKey('broken'), 'dyn_broken');
    setSecret(expiresAtSecretKey('broken'), String(Date.now() + 1000));

    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 1000));

    // `broken` fails transiently (its discovery probe rejects), which lands in
    // the branch that records the streak with setSecrets — the call made to fail
    // here, exactly as an EACCES/EMFILE on the token file would.
    mockFetch.mockRejectedValueOnce(new Error('network unreachable'));
    // Then `firecrawl`'s own discovery + refresh, which must still happen.
    mockFetch
      .mockResolvedValueOnce(jsonResponse(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"' }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize', token_endpoint: 'https://www.firecrawl.dev/api/oauth/token' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'fco_new', token_type: 'bearer', expires_in: 3600 }));

    const tokenEnv = require('../../src/connectors/token-env');
    const writeFail = jest.spyOn(tokenEnv, 'setSecrets').mockImplementation(() => {
      const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      e.code = 'EACCES';
      throw e;
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Insertion order is iteration order — `broken` is visited first.
      const store = createCustomConnectorsStore(
        tmpConfigWith({
          broken: { ...firecrawlEntry, config: { ...firecrawlEntry.config, url: 'https://broken.example/mcp' } },
          firecrawl: firecrawlEntry,
        }),
      );
      await expect(refreshExpiringOAuthConnectors(store)).resolves.toBeUndefined();

      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('connector=broken sweep step failed')),
      ).toBe(true);
    } finally {
      writeFail.mockRestore();
      errSpy.mockRestore();
    }

    expect(readTokenEnv()['CUSTOM__firecrawl__access_token']).toBe('fco_new');
  });
});

// A hand-edited or truncated mcp-token.env can hold anything, and `Number()`
// maps an overflowing literal to Infinity rather than NaN. `Infinity - now >=
// REFRESH_SKEW_MS` is true, so the old guard read that as "expires never" and
// skipped the connector on every tick for the life of the file — the exact
// silent-death state the sweep exists to prevent, with no failure recorded and a
// green checkmark over a token that expired an hour in.
describe('a corrupt expiry is refreshed, not trusted', () => {
  it('refreshes a connector whose recorded expiry overflows to Infinity', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), '1e400');

    mockFetch
      .mockResolvedValueOnce(jsonResponse(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource/v2/mcp-oauth"' }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ['https://www.firecrawl.dev'] }))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_endpoint: 'https://www.firecrawl.dev/api/oauth/authorize', token_endpoint: 'https://www.firecrawl.dev/api/oauth/token' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'fco_new', token_type: 'bearer', expires_in: 3600 }));

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    await refreshExpiringOAuthConnectors(store);

    const env = readTokenEnv();
    expect(env['CUSTOM__firecrawl__access_token']).toBe('fco_new');
    // And the corrupt value is gone — the success path always writes a real one.
    expect(Number(env[expiresAtSecretKey('firecrawl')])).toBeLessThan(Date.now() + 3700 * 1000);
  });

  // The finite case must still short-circuit: this is the guard that keeps the
  // sweep from calling a token endpoint every 60s for every healthy connector.
  it('still skips a connector whose expiry is a normal, distant timestamp', async () => {
    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_old');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_old');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_abc');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 30 * 60 * 1000));

    const store = createCustomConnectorsStore(tmpConfigWith({ firecrawl: firecrawlEntry }));
    await refreshExpiringOAuthConnectors(store);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
