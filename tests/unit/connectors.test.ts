/**
 * Unit tests for the connectors feature (native MCP injection).
 *
 *  token-env        — secret storage in mcp-token.env (0600, fresh parse)
 *  resolve          — enabled+connected → injected mcpServers entry
 *  boot-safety      — config.json with gateway.connectors but no token loads (no throw)
 *  connectors-router — GET / connect / status / delete + admin gating
 *  mcp-config gen    — writeMcpConfig emits the github entry only when connected
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ApiKey } from '../../src/types';
import type { AgentRunner } from '../../src/agent/runner';

const TOKEN_ENV = '/tmp/connectors-test-mcp-token.env';

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV_PATH = TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
  jest.resetModules();
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV_PATH;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
});

describe('token-env', () => {
  it('set/get/has/delete round-trip and 0600 perms', () => {
    const { setSecret, getSecret, hasSecret, deleteSecrets, readTokenEnv } =
      require('../../src/connectors/token-env');

    expect(getSecret('GITHUB_TOKEN')).toBeNull();
    expect(hasSecret('GITHUB_TOKEN')).toBe(false);

    setSecret('GITHUB_TOKEN', 'ghp_abc123');
    expect(getSecret('GITHUB_TOKEN')).toBe('ghp_abc123');
    expect(hasSecret('GITHUB_TOKEN')).toBe(true);
    expect(readTokenEnv()).toEqual({ GITHUB_TOKEN: 'ghp_abc123' });

    // File is 0600
    expect(fs.statSync(TOKEN_ENV).mode & 0o777).toBe(0o600);

    // Upsert keeps other keys
    setSecret('OTHER', 'x');
    setSecret('GITHUB_TOKEN', 'ghp_new');
    expect(readTokenEnv()).toEqual({ GITHUB_TOKEN: 'ghp_new', OTHER: 'x' });

    deleteSecrets(['GITHUB_TOKEN']);
    expect(getSecret('GITHUB_TOKEN')).toBeNull();
    expect(readTokenEnv()).toEqual({ OTHER: 'x' });
  });

  // A connector's secrets used to be written one setSecret() at a time — each
  // one a full read-modify-rewrite of mcp-token.env. A key the writer rejects
  // (or a disk error) partway through therefore left the earlier keys on disk:
  // a half-connected connector that resolves to a config with some real
  // credentials and some empty strings. Validate the whole batch first, write
  // once.
  it('setSecrets is all-or-nothing — one bad key writes none of them', () => {
    const { setSecret, setSecrets, readTokenEnv } = require('../../src/connectors/token-env');

    setSecret('EXISTING', 'keep-me');
    expect(() =>
      setSecrets({ CUSTOM__acme__a: 'v1', 'bad key': 'v2', CUSTOM__acme__b: 'v3' }),
    ).toThrow(/Invalid secret key/);

    // Neither the key before the bad one nor the one after it landed.
    expect(readTokenEnv()).toEqual({ EXISTING: 'keep-me' });

    // And a clean batch applies every key in a single rewrite.
    setSecrets({ CUSTOM__acme__a: 'v1', CUSTOM__acme__b: 'v3' });
    expect(readTokenEnv()).toEqual({ EXISTING: 'keep-me', CUSTOM__acme__a: 'v1', CUSTOM__acme__b: 'v3' });
  });

  it('deleteSecrets removes every named key in one rewrite and ignores absent ones', () => {
    const { setSecrets, deleteSecrets, readTokenEnv } = require('../../src/connectors/token-env');

    setSecrets({ A: '1', B: '2', C: '3' });
    deleteSecrets(['A', 'C', 'NEVER_EXISTED']);
    expect(readTokenEnv()).toEqual({ B: '2' });
  });

  it('missing file → empty, no throw', () => {
    const { readTokenEnv, getSecret } = require('../../src/connectors/token-env');
    expect(readTokenEnv()).toEqual({});
    expect(getSecret('NOPE')).toBeNull();
  });

  // ENOENT is the ONLY errno that may mean "empty". Every write here is a
  // read-modify-write that rewrites the file whole from what readTokenEnv
  // returned, so a read that fails for any other reason — EACCES, or the EMFILE
  // a gateway spawning this many subprocesses can genuinely hit — and answers
  // `{}` makes the following write erase every other connector's token with no
  // error reaching the caller, the log, or the user. Failing the write loudly
  // leaves the file on disk intact, which is strictly the better outcome.
  it('an unreadable file fails the write instead of silently erasing every other secret', () => {
    const { setSecrets, setSecret, readTokenEnv } = require('../../src/connectors/token-env');

    setSecrets({ CUSTOM__acme__access_token: 'live-token', OTHER: 'keep-me' });
    fs.chmodSync(TOKEN_ENV, 0o000);
    try {
      // Not "returns {} and carries on" — the whole operation aborts.
      expect(() => setSecret('CUSTOM__new__access_token', 'v')).toThrow(
        expect.objectContaining({ code: 'EACCES' }),
      );
    } finally {
      fs.chmodSync(TOKEN_ENV, 0o600);
    }

    // The pre-existing secrets are all still there — this is the whole point.
    expect(readTokenEnv()).toEqual({ CUSTOM__acme__access_token: 'live-token', OTHER: 'keep-me' });
  });

  it('reads fresh each call (no caching)', () => {
    const { setSecret, getSecret } = require('../../src/connectors/token-env');
    expect(getSecret('K')).toBeNull();
    fs.writeFileSync(TOKEN_ENV, 'K=external\n', { mode: 0o600 });
    expect(getSecret('K')).toBe('external');
    setSecret('K', 'updated');
    expect(getSecret('K')).toBe('updated');
  });
});

describe('resolve', () => {
  it('resolves nothing when there are no customConnectors, whatever the agent enables', () => {
    const { resolveEnabledConnectors } = require('../../src/connectors/resolve');
    expect(resolveEnabledConnectors({})).toEqual({});
    expect(resolveEnabledConnectors({ connectors: { anything: { enabled: true } } })).toEqual({});
  });

  // github/gmail/etc. are connectors an external control plane pushes in
  // (see connectors-router.ts's /oauth/receive). This exercises the exact
  // shape that route writes: credentialOwner:'external', resolved through the
  // generic customConnectors path like any other connector.
  it('externally-owned connector (github): enabled + connected → http entry with bearer; disabled/disconnected → omitted', () => {
    const { setSecret } = require('../../src/connectors/token-env');
    const { resolveEnabledConnectors, listConnectorStatus } =
      require('../../src/connectors/resolve');

    const customConnectors = {
      github: {
        label: 'GitHub',
        description: 'Repos, issues, and pull requests via the official GitHub MCP server.',
        config: {
          type: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: { Authorization: 'Bearer {access_token}' },
        },
        secretNames: ['access_token'],
        sourceUrl: 'https://github.com/github/github-mcp-server',
        credentialOwner: 'external' as const,
      },
    };

    // not connected → omitted
    expect(resolveEnabledConnectors({}, customConnectors)).toEqual({});

    // enabled but not connected → omitted
    expect(
      resolveEnabledConnectors({ connectors: { github: { enabled: true } } }, customConnectors),
    ).toEqual({});

    // enabled + connected → entry present, placeholder substituted
    setSecret('CUSTOM__github__access_token', 'ghp_xyz');
    const resolved = resolveEnabledConnectors(
      { connectors: { github: { enabled: true } } },
      customConnectors,
    );
    expect(resolved.github).toEqual({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ghp_xyz' },
    });

    // disabled for this agent → omitted even though connected
    expect(
      resolveEnabledConnectors({ connectors: { github: { enabled: false } } }, customConnectors),
    ).toEqual({});

    // status reports whose credential it is, no setup help
    const status = listConnectorStatus(customConnectors).find(
      (c: { id: string }) => c.id === 'github',
    );
    expect(status).toMatchObject({
      id: 'github',
      credentialOwner: 'external',
      connected: true,
    });
    expect(status.setup).toBeUndefined();
  });

  // Two independent connectors pushed by an external control plane must not share
  // connected state, even though both are customConnectors entries.
  it('two externally-owned connectors: independent secret slots, each resolves its own entry', () => {
    const { setSecret } = require('../../src/connectors/token-env');
    const { resolveEnabledConnectors, listConnectorStatus } =
      require('../../src/connectors/resolve');

    const customConnectors = {
      gmail: {
        label: 'Gmail',
        config: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        credentialOwner: 'external' as const,
      },
      'google-drive': {
        label: 'Google Drive',
        config: { type: 'http', url: 'https://drivemcp.googleapis.com/mcp/v1', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        credentialOwner: 'external' as const,
      },
    };
    const enabled = { connectors: { gmail: { enabled: true }, 'google-drive': { enabled: true } } };
    expect(resolveEnabledConnectors(enabled, customConnectors)).toEqual({});

    setSecret('CUSTOM__gmail__access_token', 'ya29.gmail');
    const gmailOnly = resolveEnabledConnectors(enabled, customConnectors);
    expect(gmailOnly.gmail).toEqual({
      type: 'http',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      headers: { Authorization: 'Bearer ya29.gmail' },
    });
    expect(gmailOnly['google-drive']).toBeUndefined();

    const statusAfterGmail = listConnectorStatus(customConnectors);
    expect(statusAfterGmail.find((c: { id: string }) => c.id === 'gmail')).toMatchObject({
      connected: true,
    });
    expect(statusAfterGmail.find((c: { id: string }) => c.id === 'google-drive')).toMatchObject({
      connected: false,
    });

    setSecret('CUSTOM__google-drive__access_token', 'ya29.drive');
    const both = resolveEnabledConnectors(enabled, customConnectors);
    expect(both['google-drive']).toEqual({
      type: 'http',
      url: 'https://drivemcp.googleapis.com/mcp/v1',
      headers: { Authorization: 'Bearer ya29.drive' },
    });
  });

  it('genuine user-pasted custom connector: opt-out default enablement; partially-connected → omitted; fully-connected → substituted', () => {
    const { setSecret } = require('../../src/connectors/token-env');
    const { resolveEnabledConnectors } = require('../../src/connectors/resolve');

    const customConnectors = {
      calendar: {
        label: 'Calendar',
        config: {
          type: 'streamable-http',
          url: 'https://server.smithery.ai/calendar/mcp',
          headers: { Authorization: 'Bearer {smithery_api_key}', 'X-Extra': '{unset_var}' },
        },
        secretNames: ['smithery_api_key', 'unset_var'],
      },
    };
    const agentConfig = { connectors: { calendar: { enabled: true } } };

    // No config at all (not even mentioning `calendar`) → still resolves once
    // secrets exist, because enablement defaults to on (opt-out model).
    setSecret('CUSTOM__calendar__smithery_api_key', 'sk-abc');
    setSecret('CUSTOM__calendar__unset_var', 'val');
    expect(resolveEnabledConnectors({}, customConnectors)).toEqual({
      calendar: {
        type: 'streamable-http',
        url: 'https://server.smithery.ai/calendar/mcp',
        headers: { Authorization: 'Bearer sk-abc', 'X-Extra': 'val' },
      },
    });

    // Explicitly disabled for this agent → omitted even though fully connected.
    expect(
      resolveEnabledConnectors({ connectors: { calendar: { enabled: false } } }, customConnectors),
    ).toEqual({});

    // Reset secrets to re-test the partial-connection path from a clean slate.
    const { deleteSecrets } = require('../../src/connectors/token-env');
    deleteSecrets(['CUSTOM__calendar__smithery_api_key', 'CUSTOM__calendar__unset_var']);

    // Enabled but only one of two required secrets present → still omitted.
    setSecret('CUSTOM__calendar__smithery_api_key', 'sk-abc');
    expect(resolveEnabledConnectors(agentConfig, customConnectors)).toEqual({});

    // Both secrets present → substituted into the raw config.
    setSecret('CUSTOM__calendar__unset_var', 'val');
    expect(resolveEnabledConnectors(agentConfig, customConnectors)).toEqual({
      calendar: {
        type: 'streamable-http',
        url: 'https://server.smithery.ai/calendar/mcp',
        headers: { Authorization: 'Bearer sk-abc', 'X-Extra': 'val' },
      },
    });
  });

  // A gateway whose agents belong to different people cannot ship a connector
  // that every one of them gets by default. `connectorsDefaultEnabled: false`
  // flips the model to opt-in for that deployment without changing what a
  // per-agent flag means.
  it('gateway.connectorsDefaultEnabled=false flips enablement to opt-in — silence means off, an explicit flag still wins', () => {
    const { setSecret } = require('../../src/connectors/token-env');
    const { resolveEnabledConnectors } = require('../../src/connectors/resolve');

    const customConnectors = {
      calendar: {
        label: 'Calendar',
        config: { type: 'streamable-http', url: 'https://server.smithery.ai/calendar/mcp', headers: { Authorization: 'Bearer {api_key}' } },
        secretNames: ['api_key'],
      },
    };
    setSecret('CUSTOM__calendar__api_key', 'sk-abc');
    const resolved = { calendar: { type: 'streamable-http', url: 'https://server.smithery.ai/calendar/mcp', headers: { Authorization: 'Bearer sk-abc' } } };

    // Default (opt-out): an agent that never mentions the connector still gets it.
    expect(resolveEnabledConnectors({}, customConnectors, true)).toEqual(resolved);

    // Opt-in: the same silent agent gets nothing...
    expect(resolveEnabledConnectors({}, customConnectors, false)).toEqual({});
    // ...until it opts in explicitly.
    expect(
      resolveEnabledConnectors({ connectors: { calendar: { enabled: true } } }, customConnectors, false),
    ).toEqual(resolved);
    // And an explicit `false` is still honoured under the opt-out default.
    expect(
      resolveEnabledConnectors({ connectors: { calendar: { enabled: false } } }, customConnectors, true),
    ).toEqual({});
  });

  // Regression: the per-connector secrets map was a plain `{}`, so every
  // Object.prototype member was already "present" in it. substitutePlaceholders
  // does `secrets[name] ?? ''`, so a pasted config containing {constructor} or
  // {toString} — perfectly ordinary placeholder names, not reserved — resolved
  // to a stringified JS function spliced into the MCP server's URL or header
  // instead of the empty string every other unset placeholder gets. A
  // null-prototype map has no inherited members to find.
  it('a placeholder named after an Object.prototype member resolves to empty, not to a JS function', () => {
    const { resolveEnabledConnectors } = require('../../src/connectors/resolve');
    const { setSecret } = require('../../src/connectors/token-env');

    const customConnectors = {
      acme: {
        label: 'Acme',
        config: {
          type: 'http',
          url: 'https://acme.example/mcp',
          headers: { Authorization: 'Bearer {api_key}', 'X-Odd': '{constructor}/{toString}/{hasOwnProperty}' },
        },
        // Only api_key is a declared secret; the rest are unset placeholders.
        secretNames: ['api_key'],
      },
    };
    setSecret('CUSTOM__acme__api_key', 'sk-abc');

    const resolved = resolveEnabledConnectors({}, customConnectors) as Record<string, { headers: Record<string, string> }>;
    expect(resolved.acme.headers['X-Odd']).toBe('//');
    expect(resolved.acme.headers.Authorization).toBe('Bearer sk-abc');
  });

  // credentialOwner is reported exactly as stored, never re-derived. The shape
  // this replaced inferred the reported kind from `secretNames.length` on every
  // status call while ALSO storing overrides for the cases that inference got
  // wrong — so a gateway-owned connector, which has a non-empty secretNames just
  // like a pasted one, reported as a paste-a-token connector whenever the
  // override was missed. All three of these carry ['access_token']; only the
  // stored owner tells them apart.
  it('listConnectorStatus: reports the stored credentialOwner verbatim, never inferred from secretNames', () => {
    const { listConnectorStatus } = require('../../src/connectors/resolve');
    const config = {
      type: 'http',
      url: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
      headers: { Authorization: 'Bearer {access_token}' },
    };
    const customConnectors = {
      firecrawl: { label: 'Firecrawl', config, secretNames: ['access_token'], credentialOwner: 'gateway' as const },
      pasted: { label: 'Pasted', config, secretNames: ['access_token'], credentialOwner: 'static' as const },
      pushed: { label: 'Pushed', config, secretNames: ['access_token'], credentialOwner: 'external' as const },
      open: { label: 'Open', config: { type: 'http', url: 'https://open.example/mcp' }, secretNames: [], credentialOwner: 'none' as const },
    };
    const byId = Object.fromEntries(
      listConnectorStatus(customConnectors).map((c: { id: string }) => [c.id, c]),
    );
    expect(byId.firecrawl.credentialOwner).toBe('gateway');
    expect(byId.pasted.credentialOwner).toBe('static');
    expect(byId.pushed.credentialOwner).toBe('external');
    expect(byId.open.credentialOwner).toBe('none');
    // The collapsed flags are gone from the wire, not merely unused.
    for (const c of Object.values(byId) as Record<string, unknown>[]) {
      expect(c).not.toHaveProperty('authKind');
      expect(c).not.toHaveProperty('managed');
      expect(c).not.toHaveProperty('oauth');
      expect(c).not.toHaveProperty('source');
    }
  });

  // Regression: transient refresh failures deliberately keep the access_token
  // (see oauth-refresh-sweep.ts), and `connected` is computed purely from that
  // token's presence — so a connector whose provider went away hours ago, whose
  // token expired, and whose every call now 401s, still rendered as a green
  // "Connected ✓" with nothing anywhere saying otherwise. The sweep's own
  // failure bookkeeping is surfaced so the panel can say "connected, but
  // refresh is failing, next try at ...".
  describe('listConnectorStatus: failing background refresh', () => {
    const firecrawl = {
      label: 'Firecrawl',
      config: {
        type: 'http',
        url: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
        headers: { Authorization: 'Bearer {access_token}' },
      },
      secretNames: ['access_token'],
      credentialOwner: 'gateway' as const,
    };

    function statusOfFirecrawl() {
      const { listConnectorStatus } = require('../../src/connectors/resolve');
      return listConnectorStatus({ firecrawl }).find((c: { id: string }) => c.id === 'firecrawl');
    }

    it('reports the consecutive-failure count and next attempt time', () => {
      const { setSecret } = require('../../src/connectors/token-env');
      const { customSecretKey } = require('../../src/connectors/custom');
      const {
        refreshTransientCountSecretKey,
        refreshBackoffUntilSecretKey,
      } = require('../../src/connectors/oauth-refresh-sweep');

      setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_stale');
      setSecret(refreshTransientCountSecretKey('firecrawl'), '4');
      setSecret(refreshBackoffUntilSecretKey('firecrawl'), '1893456000000');

      expect(statusOfFirecrawl()).toMatchObject({
        connected: true, // the token is still there — that part is unchanged
        refresh: { consecutiveFailures: 4, permanentFailures: 0, nextAttemptAt: 1893456000000 },
      });
    });

    // The transient streak is the *less* urgent of the two. A connector partway
    // through the three-strike permanent count is about to have its credentials
    // deleted by the sweep, and that state used to be invisible here: the block
    // read only the transient counter, so two refusals in a row still rendered
    // as a plain green checkmark with no refresh block at all.
    it('reports the permanent-refusal streak, the one that ends in deletion', () => {
      const { setSecret } = require('../../src/connectors/token-env');
      const { customSecretKey } = require('../../src/connectors/custom');
      const {
        refreshFailCountSecretKey,
        refreshBackoffUntilSecretKey,
      } = require('../../src/connectors/oauth-refresh-sweep');

      setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_stale');
      setSecret(refreshFailCountSecretKey('firecrawl'), '2'); // one tick from give-up
      setSecret(refreshBackoffUntilSecretKey('firecrawl'), '1893456000000');

      expect(statusOfFirecrawl()).toMatchObject({
        connected: true,
        refresh: { consecutiveFailures: 0, permanentFailures: 2, nextAttemptAt: 1893456000000 },
      });
    });

    it('omits the refresh block entirely when the sweep is healthy', () => {
      const { setSecret } = require('../../src/connectors/token-env');
      const { customSecretKey } = require('../../src/connectors/custom');
      const {
        refreshTokenSecretKey,
        expiresAtSecretKey,
      } = require('../../src/connectors/oauth-refresh-sweep');

      // What a real sign-in leaves behind: the token, the refresh_token that
      // renews it, and an expiry. An access_token on its own is NOT this state —
      // nothing can renew it and no path that mints one writes it that way, so
      // refreshStatusOf reports it as unrefreshable (see its doc).
      setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_ok');
      setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_ok');
      setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 3600_000));
      expect(statusOfFirecrawl().refresh).toBeUndefined();
      // Absent, not present-and-undefined: the single-status route omits the key,
      // and an in-process caller testing `'refresh' in status` (or counting keys)
      // must get the same answer from the list route.
      expect('refresh' in statusOfFirecrawl()).toBe(false);
    });

    // Reachable through ordinary configuration, not a hand-edited file: the scope
    // sent to the AS is whatever discovery advertised (see resolveScope), falling
    // back to 'offline_access' only when nothing advertises anything — so a server
    // whose scopes don't include it issues a token response with no refresh_token.
    // The sweep then has nothing to refresh with and skips the connector forever
    // without recording a failure, which left a green checkmark standing over a
    // token that expired an hour in.
    it('flags a connector that can never refresh once its token has actually expired', () => {
      const { setSecret } = require('../../src/connectors/token-env');
      const { customSecretKey } = require('../../src/connectors/custom');
      const { expiresAtSecretKey } = require('../../src/connectors/oauth-refresh-sweep');

      setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_dead');
      setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() - 60 * 60 * 1000));

      expect(statusOfFirecrawl()).toMatchObject({
        connected: true, // secret presence is unchanged — that is the whole problem
        refresh: { consecutiveFailures: 0, permanentFailures: 0, unrefreshable: true },
      });
    });

    it('stays quiet while that same token is still valid', () => {
      const { setSecret } = require('../../src/connectors/token-env');
      const { customSecretKey } = require('../../src/connectors/custom');
      const { expiresAtSecretKey } = require('../../src/connectors/oauth-refresh-sweep');

      setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_ok');
      setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 60 * 60 * 1000));

      expect('refresh' in statusOfFirecrawl()).toBe(false);
    });

    // `secretNames` is declared on CustomConnectorEntry but never validated when
    // config.json is read, so an entry written by hand (or by an older build) can
    // reach here without it. This runs inside an `async` Express 4 handler, which
    // does not catch rejections — so the throw used to leave the request with no
    // response at all, hanging the whole connector panel rather than one row.
    it('degrades one malformed entry instead of throwing out of the whole list', () => {
      const { listConnectorStatus } = require('../../src/connectors/resolve');
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const all = listConnectorStatus({
          broken: { label: 'Broken' }, // no secretNames
          firecrawl,
        });
        expect(all.find((c: { id: string }) => c.id === 'broken')).toMatchObject({
          id: 'broken',
          connected: false,
        });
        // The healthy entry beside it is unaffected.
        expect(all.find((c: { id: string }) => c.id === 'firecrawl')).toBeDefined();
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  // Regression: a resolve failure used to propagate straight out of
  // resolveEnabledConnectors — called unguarded inside session spawn
  // (session/process.ts's writeMcpConfig), so one malformed pasted config
  // (admin-trusted, not code-reviewed) aborted the ENTIRE session for every
  // user of the agent, not just the resolution of that one connector.
  it('a custom connector whose substitution throws is skipped, not fatal to the whole resolution', () => {
    const { setSecret } = require('../../src/connectors/token-env');
    setSecret('CUSTOM__broken__api_key', 'sk-abc');
    setSecret('CUSTOM__fine__api_key', 'sk-xyz');

    let result!: Record<string, unknown>;
    jest.isolateModules(() => {
      jest.doMock('../../src/connectors/custom', () => {
        const real = jest.requireActual('../../src/connectors/custom');
        return {
          ...real,
          substitutePlaceholders: (config: unknown, secrets: Record<string, string>) => {
            if (JSON.stringify(config).includes('broken')) throw new Error('malformed config');
            return real.substitutePlaceholders(config, secrets);
          },
        };
      });
      const { resolveEnabledConnectors } = require('../../src/connectors/resolve');
      result = resolveEnabledConnectors(
        {},
        {
          broken: { label: 'Broken', config: { url: 'https://broken.example/{api_key}' }, secretNames: ['api_key'] },
          fine: { label: 'Fine', config: { url: 'https://fine.example', headers: { Authorization: 'Bearer {api_key}' } }, secretNames: ['api_key'] },
        },
      );
    });
    jest.dontMock('../../src/connectors/custom');

    expect(result.broken).toBeUndefined();
    expect(result.fine).toEqual({ url: 'https://fine.example', headers: { Authorization: 'Bearer sk-xyz' } });
  });
});

describe('boot-safety', () => {
  it('loadConfig does not throw when gateway.connectors references an unset env var', () => {
    const { loadConfig } = require('../../src/config/loader');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-boot-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      gateway: {
        logDir: '/tmp', timezone: 'UTC',
        api: { keys: [{ key: 'k', agents: '*', admin: true }] },
        connectors: { github: { secretEnv: 'GITHUB_TOKEN' } },
      },
      agents: [{
        id: 'a1', description: 'd', workspace: dir, env: '',
        claude: { model: 'claude-opus-4-8', extraFlags: [] },
      }],
    }, null, 2));

    delete process.env.GITHUB_TOKEN;
    expect(() => loadConfig(cfgPath)).not.toThrow();
    const cfg = loadConfig(cfgPath);
    expect(cfg.gateway.connectors).toEqual({ github: { secretEnv: 'GITHUB_TOKEN' } });
  });
});

describe('connectors-router', () => {
  const adminKey = 'admin-key';
  const scopedKey = 'scoped-key';
  const apiKeys: ApiKey[] = [
    { key: adminKey, agents: '*', admin: true },
    { key: scopedKey, agents: ['a1'] },
  ];

  function makeApp(configPath?: string) {
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter(apiKeys, configPath));
    return app;
  }

  /** Write a temp config.json pre-seeded with the given customConnectors, return its path. */
  function tmpConfig(customConnectors: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        { gateway: { logDir: '/tmp', timezone: 'UTC', customConnectors }, agents: [] },
        null,
        2,
      ),
    );
    return cfgPath;
  }

  it('GET /v1/connectors returns an empty list when no connectors are configured', async () => {
    const res = await request(makeApp()).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.connectors).toEqual([]);
  });

  // Regression (round 10). `store.read()` does no runtime shape validation —
  // `secretNames` is required by the TypeScript type and by nothing else — so a
  // connector hand-written into config.json without it made `entry.secretNames
  // .length` a TypeError. On Express 4 a rejected async handler is not caught by
  // the router: it reaches index.ts's `unhandledRejection` hook, which runs
  // emergencyShutdown() and exits the process. One malformed line in config.json
  // therefore took down every agent on the box, from an authenticated request
  // that should have cost its caller a 500. The validation now sits inside the
  // same try as the rest of the handler.
  it('POST /:id/connect 500s on a malformed entry instead of rejecting out of the handler', async () => {
    const cfgPath = tmpConfig({
      broken: {
        label: 'Broken',
        config: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer {api_key}' } },
        // secretNames deliberately absent — what a hand-edited config.json looks like.
      },
    });
    const app = makeApp(cfgPath);

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const res = await request(app)
        .post('/api/v1/connectors/broken/connect')
        .set('X-Api-Key', adminKey)
        .send({ token: 'sk-live' });
      expect(res.status).toBe(500);
      // Give a rejection one macrotask to surface, as it would in production.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects missing / invalid key', async () => {
    expect((await request(makeApp()).get('/api/v1/connectors')).status).toBe(401);
    expect((await request(makeApp()).get('/api/v1/connectors').set('X-Api-Key', 'nope')).status).toBe(403);
  });

  // requireAdmin runs before the connector lookup, so a non-admin gets 403 rather
  // than the 404 an unknown id would otherwise produce — asserted with a real
  // configured connector so the test cannot pass for the wrong reason.
  it('non-admin cannot connect', async () => {
    const cfgPath = tmpConfig({
      stripe: {
        label: 'Stripe',
        config: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer {api_key}' } },
        secretNames: ['api_key'],
      },
    });
    const res = await request(makeApp(cfgPath))
      .post('/api/v1/connectors/stripe/connect')
      .set('X-Api-Key', scopedKey)
      .send({ token: 'sk_test_x' });
    expect(res.status).toBe(403);
  });

  // Regression: an externally-owned connector (github/gmail/etc., pushed via
  // /oauth/receive) held a real OAuth token, but the flags saying so were not
  // the ones /connect's guard checked — it looked at `entry.oauth`, which only
  // a user's own gateway-owned connector ever set. A pushed entry slipped
  // through and could be overwritten with an arbitrary string via this route,
  // bypassing the real OAuth flow and skipping the session restart
  // /oauth/receive does. One field means there is no second flag to miss.
  it('/connect rejects an externally-owned connector — cannot overwrite its real OAuth token with an arbitrary string', async () => {
    const cfgPath = tmpConfig({
      github: {
        label: 'GitHub',
        config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        credentialOwner: 'external',
      },
    });
    const { setSecret, getSecret } = require('../../src/connectors/token-env');
    const { customSecretKey } = require('../../src/connectors/custom');
    setSecret(customSecretKey('github', 'access_token'), 'ghu_real_oauth_token');

    const res = await request(makeApp(cfgPath))
      .post('/api/v1/connectors/github/connect')
      .set('X-Api-Key', adminKey)
      .send({ token: 'anything-an-attacker-or-mistake-typed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owned externally/i);
    expect(getSecret(customSecretKey('github', 'access_token'))).toBe('ghu_real_oauth_token'); // untouched
  });

  // github is pushed in by an external control plane now (via /oauth/receive
  // with a full config shape, not just a token — same as
  // gmail/drive/calendar; see tests/unit/oauth-connectors.test.ts for that
  // route's dedicated payload-shape coverage). This test keeps the
  // router-level push→status→delete round trip exercised end-to-end.
  it('oauth/receive stores the full pushed shape + secret; delete clears both', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2));
    const app = makeApp(cfgPath);
    const { getSecret } = require('../../src/connectors/token-env');
    const pushPayload = {
      access_token: 'ghu_pushed',
      label: 'GitHub',
      description: 'Repos, issues, and pull requests via the official GitHub MCP server.',
      config: {
        type: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer {access_token}' },
      },
      sourceUrl: 'https://github.com/github/github-mcp-server',
    };

    // empty access_token rejected
    const bad = await request(app)
      .post('/api/v1/connectors/github/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send({ ...pushPayload, access_token: '  ' });
    expect(bad.status).toBe(400);

    // receive
    const ok = await request(app)
      .post('/api/v1/connectors/github/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: 'github', connected: true });
    expect(getSecret('CUSTOM__github__access_token')).toBe('ghu_pushed');
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(written.gateway.customConnectors.github).toMatchObject({
      label: 'GitHub',
      secretNames: ['access_token'],
      credentialOwner: 'external',
    });

    // GET /v1/connectors reports whose credential it is
    const list = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    expect(list.body.connectors).toEqual([
      expect.objectContaining({
        id: 'github',
        label: 'GitHub',
        credentialOwner: 'external',
        connected: true,
        repoUrl: pushPayload.sourceUrl,
      }),
    ]);

    // status reflects connected
    const status = await request(app).get('/api/v1/connectors/github/status').set('X-Api-Key', adminKey);
    expect(status.body).toEqual({ id: 'github', connected: true });

    // delete — via the unified route
    const del = await request(app).delete('/api/v1/connectors/github').set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);
    expect(getSecret('CUSTOM__github__access_token')).toBeNull();
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).gateway.customConnectors).toEqual({});
  });

  // A pasted connector (credentialOwner: 'static' — the user typed it in
  // themselves) has nothing to fall back on for its config/label/description,
  // unlike the pushed github/gmail/etc. above. Disconnecting it
  // must not discard that config — only the secret — so the row survives and
  // can be reconnected without retyping everything.
  it("DELETE on a genuinely user-added custom connector clears the secret but keeps the entry (soft disconnect)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2));
    const app = makeApp(cfgPath);
    const { getSecret } = require('../../src/connectors/token-env');

    const add = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'Smithery Calendar',
        description: 'Calendar via Smithery',
        config: {
          type: 'streamable-http',
          url: 'https://server.smithery.ai/calendar/mcp',
          headers: { Authorization: 'Bearer {api_key}' },
        },
        secrets: { api_key: 'sk-abc' },
      });
    expect(add.status).toBe(200);
    const id = add.body.id;
    expect(getSecret(`CUSTOM__${id}__api_key`)).toBe('sk-abc');

    const del = await request(app).delete(`/api/v1/connectors/${id}`).set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ id, connected: false });

    // Secret is gone...
    expect(getSecret(`CUSTOM__${id}__api_key`)).toBeNull();
    // ...but the entry — and therefore the row — is still there.
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(written.gateway.customConnectors[id]).toMatchObject({
      label: 'Smithery Calendar',
      description: 'Calendar via Smithery',
      config: {
        type: 'streamable-http',
        url: 'https://server.smithery.ai/calendar/mcp',
        headers: { Authorization: 'Bearer {api_key}' },
      },
      secretNames: ['api_key'],
    });

    const list = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    expect(list.body.connectors).toEqual([
      expect.objectContaining({ id, label: 'Smithery Calendar', credentialOwner: 'static', connected: false }),
    ]);
  });

  // A "No auth" custom connector (no {placeholder} in its pasted config, so
  // secretNames: []) has no secret for the soft-disconnect above to clear.
  // listConnectorStatus's `secretNames.every(...)` is vacuously true on an
  // empty array, so soft-disconnecting it would report connected: true again
  // on the very next GET — Disconnect would look broken (click it, the row
  // never leaves "Connected"). DELETE must remove the entry outright instead.
  it('DELETE on a "No auth" (zero-secret) custom connector removes the entry, not a no-op soft disconnect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2));
    const app = makeApp(cfgPath);

    const add = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'sdfasdfasf',
        config: { type: 'http', url: 'https://example.com/mcp' },
      });
    expect(add.status).toBe(200);
    const id = add.body.id;

    // Reported connected — and always would be, per the vacuous every([]).
    const before = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    expect(before.body.connectors).toEqual([
      expect.objectContaining({ id, label: 'sdfasdfasf', credentialOwner: 'none', connected: true }),
    ]);

    const del = await request(app).delete(`/api/v1/connectors/${id}`).set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ id, connected: false });

    // The entry itself is gone — not left behind still reporting connected.
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(written.gateway.customConnectors ?? {}).toEqual({});

    const after = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    expect(after.body.connectors).toEqual([]);
  });

  // Regression: disconnecting a gateway-owned connector used to only
  // clear its secretNames (just 'access_token') — the refresh sweep's own
  // bookkeeping (__refresh_token/__client_id/__token_expires_at) lived
  // outside secretNames and survived, so oauth-refresh-sweep.ts would
  // silently mint a fresh access_token and resurrect a connector the user
  // just disconnected the next time its (unaffected) expiry came due.
  it('DELETE on a gateway-owned connector also clears the refresh sweep\'s own secrets', async () => {
    const cfgPath = tmpConfig({
      firecrawl: {
        label: 'Firecrawl',
        config: { type: 'http', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        credentialOwner: 'gateway' as const,
      },
    });
    const { setSecret, getSecret } = require('../../src/connectors/token-env');
    const { customSecretKey } = require('../../src/connectors/custom');
    const {
      refreshTokenSecretKey,
      clientIdSecretKey,
      expiresAtSecretKey,
      refreshFailCountSecretKey,
      refreshBackoffUntilSecretKey,
    } = require('../../src/connectors/oauth-refresh-sweep');

    setSecret(customSecretKey('firecrawl', 'access_token'), 'fco_live');
    setSecret(refreshTokenSecretKey('firecrawl'), 'fcr_live');
    setSecret(clientIdSecretKey('firecrawl'), 'dyn_live');
    setSecret(expiresAtSecretKey('firecrawl'), String(Date.now() + 3600_000));
    setSecret(refreshFailCountSecretKey('firecrawl'), '1');
    setSecret(refreshBackoffUntilSecretKey('firecrawl'), String(Date.now() + 60_000));

    const del = await request(makeApp(cfgPath)).delete('/api/v1/connectors/firecrawl').set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);

    expect(getSecret(customSecretKey('firecrawl', 'access_token'))).toBeNull();
    expect(getSecret(refreshTokenSecretKey('firecrawl'))).toBeNull();
    expect(getSecret(clientIdSecretKey('firecrawl'))).toBeNull();
    expect(getSecret(expiresAtSecretKey('firecrawl'))).toBeNull();
    expect(getSecret(refreshFailCountSecretKey('firecrawl'))).toBeNull();
    expect(getSecret(refreshBackoffUntilSecretKey('firecrawl'))).toBeNull();
  });

  // The exact bug the soft-disconnect fix above exposed: once DELETE keeps a
  // custom connector's entry alive, POST .../connect must actually be able to
  // reconnect it — this route used to 404 for any customConnectors id.
  it('POST .../connect reconnects a single-secret custom connector after DELETE soft-disconnected it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2));
    const app = makeApp(cfgPath);
    const { getSecret } = require('../../src/connectors/token-env');

    const add = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'Stripe',
        config: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer {api_key}' } },
        secrets: { api_key: 'sk_test_old' },
      });
    const id = add.body.id;

    await request(app).delete(`/api/v1/connectors/${id}`).set('X-Api-Key', adminKey);
    expect(getSecret(`CUSTOM__${id}__api_key`)).toBeNull();

    const reconnect = await request(app)
      .post(`/api/v1/connectors/${id}/connect`)
      .set('X-Api-Key', adminKey)
      .send({ token: 'sk_test_new' });
    expect(reconnect.status).toBe(200);
    expect(reconnect.body).toEqual({ id, connected: true });
    expect(getSecret(`CUSTOM__${id}__api_key`)).toBe('sk_test_new');

    const status = await request(app).get(`/api/v1/connectors/${id}/status`).set('X-Api-Key', adminKey);
    expect(status.body).toEqual({ id, connected: true });
  });

  it('POST .../connect on a gateway-owned connector rejects with a clear message instead of trying to store a plain token', async () => {
    const app = makeApp(tmpConfig({
      firecrawl: {
        label: 'Firecrawl',
        config: { type: 'http', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        credentialOwner: 'gateway' as const,
      },
    }));
    const res = await request(app)
      .post('/api/v1/connectors/firecrawl/connect')
      .set('X-Api-Key', adminKey)
      .send({ token: 'whatever' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oauth\/start/);
  });

  it('POST .../connect on a multi-secret custom connector rejects instead of silently storing the token under one name', async () => {
    const app = makeApp(tmpConfig({
      calendar: {
        label: 'Calendar',
        config: {
          type: 'streamable-http',
          url: 'https://server.smithery.ai/calendar/mcp',
          headers: { Authorization: 'Bearer {smithery_api_key}', 'X-Extra': '{unset_var}' },
        },
        secretNames: ['smithery_api_key', 'unset_var'],
      },
    }));
    const res = await request(app)
      .post('/api/v1/connectors/calendar/connect')
      .set('X-Api-Key', adminKey)
      .send({ token: 'whatever' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/needs 2 secrets/);
  });

  it('non-admin cannot reconnect a customConnectors entry either', async () => {
    const app = makeApp(tmpConfig({
      stripe: {
        label: 'Stripe',
        config: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer {api_key}' } },
        secretNames: ['api_key'],
      },
    }));
    const res = await request(app)
      .post('/api/v1/connectors/stripe/connect')
      .set('X-Api-Key', scopedKey)
      .send({ token: 'whatever' });
    expect(res.status).toBe(403);
  });

  it('unknown connector → 404', async () => {
    const res = await request(makeApp()).post('/api/v1/connectors/nope/connect').set('X-Api-Key', adminKey).send({ token: 'x' });
    expect(res.status).toBe(404);
  });

  // A session's MCP subprocess reads its generated config once, at spawn — it
  // cannot be hot-patched. Every route that changes a connector's secrets must
  // therefore restart the sessions using it, or the web panel says
  // "Connected ✓" while the agent the user is talking to right now still has no
  // such tool (and, on disconnect, still holds the revoked one). Only
  // /oauth/receive and the refresh sweep used to do this.
  describe('routes that change a connector restart the sessions using it', () => {
    /** A stand-in AgentRunner that records the restarts asked of it. */
    function fakeAgents() {
      const restartSessionsUsingConnector = jest.fn().mockResolvedValue({ restarted: true });
      const runner = { restartSessionsUsingConnector } as unknown as AgentRunner;
      return { restartSessionsUsingConnector, agents: new Map([['a1', runner]]) };
    }

    function makeAppWithAgents(configPath: string | undefined, agents: Map<string, AgentRunner>) {
      const { createConnectorsRouter } = require('../../src/api/connectors-router');
      const app = express();
      app.use(express.json());
      app.use('/api', createConnectorsRouter(apiKeys, configPath, agents));
      return app;
    }

    function calendarConfig() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
      const cfgPath = path.join(dir, 'config.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [{ id: 'a1' }] }, null, 2),
      );
      return cfgPath;
    }

    it('POST /v1/connectors/custom restarts once the new connector is actually connected', async () => {
      const { restartSessionsUsingConnector, agents } = fakeAgents();
      const app = makeAppWithAgents(calendarConfig(), agents);

      const add = await request(app)
        .post('/api/v1/connectors/custom')
        .set('X-Api-Key', adminKey)
        .send({
          label: 'Smithery Calendar',
          config: { type: 'streamable-http', url: 'https://server.smithery.ai/calendar/mcp', headers: { Authorization: 'Bearer {api_key}' } },
          secrets: { api_key: 'sk-abc' },
        });

      expect(add.status).toBe(200);
      expect(add.body.connected).toBe(true);
      // The overlay carries the just-written entry: the config watcher has not
      // told the runner about it yet, so without it the connector resolves to
      // nothing and every session's fingerprint comparison says "no change".
      expect(restartSessionsUsingConnector).toHaveBeenCalledWith(
        add.body.id,
        expect.objectContaining({
          overlay: expect.objectContaining({ [add.body.id]: expect.objectContaining({ secretNames: ['api_key'] }) }),
        }),
      );
    });

    it('POST /v1/connectors/custom does NOT restart when the connector is added still-unconnected', async () => {
      const { restartSessionsUsingConnector, agents } = fakeAgents();
      const app = makeAppWithAgents(calendarConfig(), agents);

      // A placeholder with no secret supplied — the entry exists but resolves
      // to nothing, so there is no reason to disturb a live session.
      const add = await request(app)
        .post('/api/v1/connectors/custom')
        .set('X-Api-Key', adminKey)
        .send({
          label: 'Smithery Calendar',
          config: { type: 'streamable-http', url: 'https://server.smithery.ai/calendar/mcp', headers: { Authorization: 'Bearer {api_key}' } },
        });

      expect(add.status).toBe(200);
      expect(add.body.connected).toBe(false);
      expect(restartSessionsUsingConnector).not.toHaveBeenCalled();
    });

    it('POST /:id/connect restarts after storing the pasted token', async () => {
      const { restartSessionsUsingConnector, agents } = fakeAgents();
      const cfgPath = tmpConfig({
        stripe: {
          label: 'Stripe',
          config: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer {api_key}' } },
          secretNames: ['api_key'],
        },
      });
      const app = makeAppWithAgents(cfgPath, agents);

      const res = await request(app)
        .post('/api/v1/connectors/stripe/connect')
        .set('X-Api-Key', adminKey)
        .send({ token: 'sk-live-placeholder' });

      expect(res.status).toBe(200);
      expect(restartSessionsUsingConnector).toHaveBeenCalledWith('stripe', expect.anything());
    });

    // Regression (round 10): DELETE used to ask each runner `usesConnector(id)`
    // BEFORE removing the secrets and pass the answer down as `force`, because
    // afterwards the connector resolves to nothing and the agent-level question
    // "do you use it?" answers "no" for everybody. That ordering was fragile —
    // the sweep's give-up path deleted the secrets first and then restarted with
    // no force, so a revoked token was never actually withdrawn from a running
    // session. The restart decision now lives on the session, which compares
    // what it was SPAWNED with against what the connector resolves to now, so
    // "resolves to nothing" is itself the change and needs no force flag and no
    // careful ordering.
    it('DELETE restarts the sessions even though the connector now resolves to nothing', async () => {
      const { restartSessionsUsingConnector, agents } = fakeAgents();
      const { getSecret } = require('../../src/connectors/token-env');
      const cfgPath = tmpConfig({
        stripe: {
          label: 'Stripe',
          config: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer {api_key}' } },
          secretNames: ['api_key'],
        },
      });
      const app = makeAppWithAgents(cfgPath, agents);

      await request(app)
        .post('/api/v1/connectors/stripe/connect')
        .set('X-Api-Key', adminKey)
        .send({ token: 'sk-live-placeholder' });
      restartSessionsUsingConnector.mockClear();

      const del = await request(app).delete('/api/v1/connectors/stripe').set('X-Api-Key', adminKey);
      expect(del.status).toBe(200);
      // The secret really is gone by the time the restart is asked for.
      expect(getSecret('CUSTOM__stripe__api_key')).toBeNull();
      // Still no force flag — but the entry itself is gone from config.json, and
      // the runner's in-memory gateway config is not reloaded synchronously, so
      // DELETE says so explicitly with a `null` overlay entry (round 11). A
      // connector with no placeholders would otherwise resolve unchanged here
      // and no session would restart.
      expect(restartSessionsUsingConnector).toHaveBeenCalledWith('stripe', { overlay: { stripe: null } });
    });

    it('a failing restart does not turn a successful connect into a 500', async () => {
      const { restartSessionsUsingConnector, agents } = fakeAgents();
      restartSessionsUsingConnector.mockRejectedValue(new Error('runner is wedged'));
      const cfgPath = tmpConfig({
        stripe: {
          label: 'Stripe',
          config: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer {api_key}' } },
          secretNames: ['api_key'],
        },
      });
      const app = makeAppWithAgents(cfgPath, agents);

      const res = await request(app)
        .post('/api/v1/connectors/stripe/connect')
        .set('X-Api-Key', adminKey)
        .send({ token: 'sk-live-placeholder' });

      // The secret IS stored; only the convenience restart failed.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'stripe', connected: true });
    });
  });

  // Regression: `secrets` was written to the token store by name without
  // checking it against the placeholders actually present in the pasted config.
  // A typo ({apiKey} in the config, "api_key" in secrets) produced a connector
  // reported as not-connected with the value silently sitting in
  // mcp-token.env under a name nothing reads — a stray credential on disk and
  // no error to explain it.
  it('POST /v1/connectors/custom 400s on a `secrets` key that is not a {placeholder} in the config', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'Typo',
        config: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer {apiKey}' } },
        secrets: { api_key: 'sk-abc', other: 'x' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('api_key');
    expect(res.body.error).toContain('other');
    expect(res.body.error).toContain('apiKey'); // tells the user the name it expected
    // Nothing was stored under the wrong name.
    const { getSecret } = require('../../src/connectors/token-env');
    expect(getSecret('CUSTOM__typo__api_key')).toBeNull();
  });

  // Regression: the id was slugged from a `read()` taken *before* the write
  // lock. Two concurrent adds of the same label both saw the slug as free, so
  // the second overwrote the first's entry — and, because the secrets are keyed
  // by id, pointed the survivor at the loser's credentials. Slugging inside
  // store.mutate makes the collision check see the map actually being written.
  it('two concurrent adds of the same label get distinct ids — neither overwrites the other', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2));
    const app = makeApp(cfgPath);
    const { getSecret } = require('../../src/connectors/token-env');

    const add = (secret: string) =>
      request(app)
        .post('/api/v1/connectors/custom')
        .set('X-Api-Key', adminKey)
        .send({
          label: 'Smithery Calendar',
          config: { type: 'streamable-http', url: 'https://server.smithery.ai/calendar/mcp', headers: { Authorization: 'Bearer {api_key}' } },
          secrets: { api_key: secret },
        });

    const [a, b] = await Promise.all([add('sk-first'), add('sk-second')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.id).not.toBe(b.body.id);

    // Both entries survive, and each holds its own secret.
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).gateway.customConnectors;
    expect(Object.keys(written).sort()).toEqual([a.body.id, b.body.id].sort());
    expect(getSecret(`CUSTOM__${a.body.id}__api_key`)).toBe('sk-first');
    expect(getSecret(`CUSTOM__${b.body.id}__api_key`)).toBe('sk-second');
  });

  // Regression: a hard delete removed the customConnectors entry but left every
  // agent's `connectors: { <id>: { enabled } }` flag behind. Those orphans are
  // invisible in the panel, and a later connector whose label slugs to the same
  // id silently inherits them — an agent the user never enabled it for gets it,
  // or one they want it for does not.
  it('DELETE removes the per-agent enablement flags along with the entry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          gateway: {
            logDir: '/tmp',
            timezone: 'UTC',
            customConnectors: {
              // secretNames: [] → a "No auth" entry, which DELETE hard-removes.
              wiki: { label: 'Wiki', config: { type: 'http', url: 'https://wiki.example/mcp' }, secretNames: [] },
            },
          },
          agents: [
            { id: 'a1', connectors: { wiki: { enabled: true }, other: { enabled: false } } },
            { id: 'a2', connectors: { wiki: { enabled: false } } },
            { id: 'a3' },
          ],
        },
        null,
        2,
      ),
    );

    const del = await request(makeApp(cfgPath)).delete('/api/v1/connectors/wiki').set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);

    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(written.gateway.customConnectors).toEqual({});
    expect(written.agents[0].connectors).toEqual({ other: { enabled: false } }); // untouched neighbour
    expect(written.agents[1].connectors).toEqual({});
    expect(written.agents[2].connectors).toBeUndefined(); // no flags → nothing invented
  });
});
