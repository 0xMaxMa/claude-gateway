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

const TOKEN_ENV = '/tmp/connectors-test-mcp-token.env';

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV = TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
  jest.resetModules();
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
});

describe('token-env', () => {
  it('set/get/has/delete round-trip and 0600 perms', () => {
    const { setSecret, getSecret, hasSecret, deleteSecret, readTokenEnv } =
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

    deleteSecret('GITHUB_TOKEN');
    expect(getSecret('GITHUB_TOKEN')).toBeNull();
    expect(readTokenEnv()).toEqual({ OTHER: 'x' });
  });

  it('missing file → empty, no throw', () => {
    const { readTokenEnv, getSecret } = require('../../src/connectors/token-env');
    expect(readTokenEnv()).toEqual({});
    expect(getSecret('NOPE')).toBeNull();
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
  it('CONNECTOR_CATALOG is empty by default — nothing resolves from it, regardless of config', () => {
    const { resolveEnabledConnectors } = require('../../src/connectors/resolve');
    expect(resolveEnabledConnectors({})).toEqual({});
    expect(resolveEnabledConnectors({ connectors: { anything: { enabled: true } } })).toEqual({});
  });

  // github/gmail/etc. are no longer built-in catalog entries — they're managed
  // custom connectors pushed by services/api (see connectors-router.ts's
  // /oauth/receive). This exercises the exact shape that route writes:
  // authKind:'oauth' + managed:true, resolved through the generic
  // customConnectors path like any other custom connector.
  it('managed connector (github): enabled + connected → http entry with bearer; disabled/disconnected → omitted', () => {
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
        authKind: 'oauth' as const,
        managed: true,
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

    // status reports it as built-in (not "Custom") and oauth-kind, no setup help
    const status = listConnectorStatus(customConnectors).find(
      (c: { id: string }) => c.id === 'github',
    );
    expect(status).toMatchObject({
      id: 'github',
      authKind: 'oauth',
      connected: true,
      source: 'built-in',
    });
    expect(status.setup).toBeUndefined();
  });

  // Two independent managed connectors pushed by services/api must not share
  // connected state, even though both are custom-connector entries.
  it('two managed connectors: independent secret slots, each resolves its own entry', () => {
    const { setSecret } = require('../../src/connectors/token-env');
    const { resolveEnabledConnectors, listConnectorStatus } =
      require('../../src/connectors/resolve');

    const customConnectors = {
      gmail: {
        label: 'Gmail',
        config: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        authKind: 'oauth' as const,
        managed: true,
      },
      'google-drive': {
        label: 'Google Drive',
        config: { type: 'http', url: 'https://drivemcp.googleapis.com/mcp/v1', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        authKind: 'oauth' as const,
        managed: true,
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
    const { deleteSecret } = require('../../src/connectors/token-env');
    deleteSecret('CUSTOM__calendar__smithery_api_key');
    deleteSecret('CUSTOM__calendar__unset_var');

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

  // A user-added generic-OAuth custom connector (oauth: true, added via
  // POST /v1/connectors/custom, no explicit authKind — that field is only
  // ever set by services/api's managed push, see CustomConnectorEntry's doc
  // comment) must still report authKind: 'oauth', not fall through to
  // 'secret' just because secretNames is non-empty — the web panel's Auth
  // column and icon both key off this.
  it("listConnectorStatus: a user-added oauth:true custom connector reports authKind 'oauth', not 'secret'", () => {
    const { listConnectorStatus } = require('../../src/connectors/resolve');
    const customConnectors = {
      firecrawl: {
        label: 'Firecrawl',
        config: {
          type: 'http',
          url: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
          headers: { Authorization: 'Bearer {access_token}' },
        },
        secretNames: ['access_token'],
        oauth: true,
      },
    };
    const status = listConnectorStatus(customConnectors).find(
      (c: { id: string }) => c.id === 'firecrawl',
    );
    expect(status).toMatchObject({
      id: 'firecrawl',
      authKind: 'oauth',
      source: 'custom',
      oauth: true,
    });
  });

  // Regression: a deployer-defined CONNECTOR_CATALOG entry's build() throwing
  // used to propagate straight out of resolveEnabledConnectors — called
  // unguarded inside session spawn (session/process.ts's writeMcpConfig), so
  // one bad catalog entry aborted the ENTIRE session for every user of the
  // agent, not just the resolution of that one connector.
  it('a built-in catalog entry whose build() throws is skipped, not fatal to the whole resolution', () => {
    const throwingSpec = {
      id: 'flaky',
      label: 'Flaky',
      transport: 'http',
      auth: { kind: 'none' },
      build: () => {
        throw new Error('boom');
      },
    };
    let result!: Record<string, unknown>;
    jest.isolateModules(() => {
      jest.doMock('../../src/connectors/catalog', () => ({
        CONNECTOR_CATALOG: [throwingSpec],
        getConnectorSpec: () => undefined,
      }));
      const { resolveEnabledConnectors } = require('../../src/connectors/resolve');
      result = resolveEnabledConnectors({});
    });
    jest.dontMock('../../src/connectors/catalog');
    expect(result).toEqual({});
  });

  // Same isolation for the customConnectors path — a malformed pasted config
  // (admin-trusted, not code-reviewed) must not take down every OTHER
  // connector's resolution for this session.
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

  it('GET /v1/connectors returns an empty catalog by default (CONNECTOR_CATALOG is empty)', async () => {
    const res = await request(makeApp()).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.connectors).toEqual([]);
  });

  it('rejects missing / invalid key', async () => {
    expect((await request(makeApp()).get('/api/v1/connectors')).status).toBe(401);
    expect((await request(makeApp()).get('/api/v1/connectors').set('X-Api-Key', 'nope')).status).toBe(403);
  });

  // CONNECTOR_CATALOG is empty by default now, so /connect 404s for every id
  // before ever reaching requireAdmin — mock one synthetic 'secret'-kind
  // built-in entry (the shape a deployer's own fork might hardcode) so this
  // still exercises the route's actual admin gate, not just its 404 path.
  // jest.isolateModules scopes the mock to this test only — it does NOT leak
  // into later tests the way a bare jest.doMock would (doMock registrations
  // survive jest.resetModules(), which only clears cached instances).
  it('non-admin cannot connect', async () => {
    const stubSpec = {
      id: 'stub-secret',
      label: 'Stub',
      transport: 'http',
      auth: { kind: 'secret', secretEnv: 'STUB_TOKEN' },
      build: () => ({}),
    };
    let res!: request.Response;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../src/connectors/catalog', () => ({
        CONNECTOR_CATALOG: [stubSpec],
        getConnectorSpec: (id: string) => (id === 'stub-secret' ? stubSpec : undefined),
      }));
      const { createConnectorsRouter } = require('../../src/api/connectors-router');
      const app = express();
      app.use(express.json());
      app.use('/api', createConnectorsRouter(apiKeys));
      res = await request(app)
        .post('/api/v1/connectors/stub-secret/connect')
        .set('X-Api-Key', scopedKey)
        .send({ token: 'ghp_x' });
    });
    // jest.doMock registrations outlive isolateModulesAsync's registry scope
    // (it only isolates the module cache, not the mock registry) — undo it
    // explicitly so later tests' fresh `require`s get the real catalog again.
    jest.dontMock('../../src/connectors/catalog');
    expect(res.status).toBe(403);
  });

  // Regression: connect/delete for a built-in catalog entry used to also
  // read-modify-write config.json's gateway.connectors subtree via a
  // dedicated function+lock (mutateGatewayConnectors) that nothing ever read
  // back — dead state with its own uncoordinated lock racing
  // custom-connectors-store.ts's lock on the same file. That write path was
  // removed; this proves the actually-meaningful behavior (the secret itself,
  // and connected status derived from it) still works end-to-end with no
  // config.json at all.
  it('catalog secret-kind connect/delete round-trip works with no config.json (no dead file write to break)', async () => {
    const stubSpec = {
      id: 'stub-secret',
      label: 'Stub',
      transport: 'http',
      auth: { kind: 'secret', secretEnv: 'STUB_TOKEN' },
      build: () => ({}),
    };
    let connectRes!: request.Response;
    let statusAfterConnect!: request.Response;
    let deleteRes!: request.Response;
    let statusAfterDelete!: request.Response;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../src/connectors/catalog', () => ({
        CONNECTOR_CATALOG: [stubSpec],
        getConnectorSpec: (id: string) => (id === 'stub-secret' ? stubSpec : undefined),
      }));
      const { createConnectorsRouter } = require('../../src/api/connectors-router');
      const app = express();
      app.use(express.json());
      app.use('/api', createConnectorsRouter(apiKeys)); // no configPath at all
      connectRes = await request(app)
        .post('/api/v1/connectors/stub-secret/connect')
        .set('X-Api-Key', adminKey)
        .send({ token: 'stub-token-value' });
      statusAfterConnect = await request(app)
        .get('/api/v1/connectors/stub-secret/status')
        .set('X-Api-Key', adminKey);
      deleteRes = await request(app)
        .delete('/api/v1/connectors/stub-secret')
        .set('X-Api-Key', adminKey);
      statusAfterDelete = await request(app)
        .get('/api/v1/connectors/stub-secret/status')
        .set('X-Api-Key', adminKey);
    });
    jest.dontMock('../../src/connectors/catalog');

    expect(connectRes.status).toBe(200);
    expect(connectRes.body).toEqual({ id: 'stub-secret', connected: true });
    expect(statusAfterConnect.body).toEqual({ id: 'stub-secret', connected: true });
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ id: 'stub-secret', connected: false });
    expect(statusAfterDelete.body).toEqual({ id: 'stub-secret', connected: false });
  });

  // Regression: a managed connector (github/gmail/etc., pushed via
  // /oauth/receive) has authKind:'oauth' + managed:true but — unlike a
  // user's own oauth:true custom connector — never sets `oauth: true` itself.
  // /connect's guard used to check only `entry.oauth`, so a managed entry
  // slipped through it and could be overwritten with an arbitrary string via
  // this route, bypassing the real OAuth flow and skipping the session
  // restart /oauth/receive does.
  it('/connect rejects a managed connector — cannot overwrite its real OAuth token with an arbitrary string', async () => {
    const cfgPath = tmpConfig({
      github: {
        label: 'GitHub',
        config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        authKind: 'oauth',
        managed: true,
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
    expect(res.body.error).toMatch(/managed externally/i);
    expect(getSecret(customSecretKey('github', 'access_token'))).toBe('ghu_real_oauth_token'); // untouched
  });

  // github is a services/api-managed custom connector now (pushed via
  // /oauth/receive with a full config shape, not just a token — same as
  // gmail/drive/calendar; see tests/unit/oauth-connectors.test.ts for that
  // route's dedicated payload-shape coverage). This test keeps the
  // router-level push→status→delete round trip exercised end-to-end.
  it('oauth/receive stores the full managed shape + secret; delete clears both', async () => {
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
      authKind: 'oauth',
      managed: true,
    });

    // GET /v1/connectors reports it as built-in (not "Custom") and oauth-kind
    const list = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    expect(list.body.connectors).toEqual([
      expect.objectContaining({
        id: 'github',
        label: 'GitHub',
        authKind: 'oauth',
        connected: true,
        source: 'built-in',
        repoUrl: pushPayload.sourceUrl,
      }),
    ]);

    // status reflects connected
    const status = await request(app).get('/api/v1/connectors/github/status').set('X-Api-Key', adminKey);
    expect(status.body).toEqual({ id: 'github', connected: true });

    // delete — via the unified route (github has no catalog entry, falls back to customConnectors)
    const del = await request(app).delete('/api/v1/connectors/github').set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);
    expect(getSecret('CUSTOM__github__access_token')).toBeNull();
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).gateway.customConnectors).toEqual({});
  });

  // A genuinely user-added custom connector (no entry.managed — nothing pushed
  // it, the user pasted it themselves) has no catalog to fall back on for its
  // config/label/description, unlike github/gmail/etc. above. Disconnecting it
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
      expect.objectContaining({ id, label: 'Smithery Calendar', source: 'custom', connected: false }),
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
      expect.objectContaining({ id, label: 'sdfasdfasf', authKind: 'none', connected: true }),
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

  // Regression: disconnecting an oauth:true custom connector used to only
  // clear its secretNames (just 'access_token') — the refresh sweep's own
  // bookkeeping (__refresh_token/__client_id/__token_expires_at) lived
  // outside secretNames and survived, so oauth-refresh-sweep.ts would
  // silently mint a fresh access_token and resurrect a connector the user
  // just disconnected the next time its (unaffected) expiry came due.
  it('DELETE on an oauth:true custom connector also clears the refresh sweep\'s own secrets', async () => {
    const cfgPath = tmpConfig({
      firecrawl: {
        label: 'Firecrawl',
        config: { type: 'http', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        oauth: true,
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
  // reconnect it — before this fallback existed, this route only ever looked
  // in the built-in CONNECTOR_CATALOG and 404'd for any customConnectors id.
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

  it('POST .../connect on an oauth:true custom connector rejects with a clear message instead of trying to store a plain token', async () => {
    const app = makeApp(tmpConfig({
      firecrawl: {
        label: 'Firecrawl',
        config: { type: 'http', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', headers: { Authorization: 'Bearer {access_token}' } },
        secretNames: ['access_token'],
        oauth: true,
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
});
