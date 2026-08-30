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
  it('enabled + connected → github http entry with bearer; disabled/disconnected → omitted', () => {
    const { setSecret } = require('../../src/connectors/token-env');
    const { resolveEnabledConnectors, listConnectorStatus } =
      require('../../src/connectors/resolve');

    // Enablement is opt-out (default enabled) — microsoft-365 needs no secret
    // so it resolves by default regardless of config; explicitly opt it out
    // in these assertions to keep this test focused on github.
    const noMs365 = { connectors: { 'microsoft-365': { enabled: false as const } } };

    // no config, not connected → omitted
    expect(resolveEnabledConnectors(noMs365)).toEqual({});

    // enabled but not connected → omitted
    expect(
      resolveEnabledConnectors({
        connectors: { github: { enabled: true }, 'microsoft-365': { enabled: false } },
      }),
    ).toEqual({});

    // enabled + connected → entry present
    setSecret('GITHUB_TOKEN', 'ghp_xyz');
    const resolved = resolveEnabledConnectors({
      connectors: { github: { enabled: true }, 'microsoft-365': { enabled: false } },
    });
    expect(resolved.github).toEqual({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ghp_xyz' },
    });

    // connected reflected in status — github is now a real OAuth connector
    // (services/api-driven, no paste-token setup help to surface).
    const status = listConnectorStatus().find((c: { id: string }) => c.id === 'github');
    expect(status).toMatchObject({ id: 'github', authKind: 'oauth', connected: true });
    expect(status.setup).toBeUndefined();
  });

  // POC (manual-token) Google connectors: each keeps its own secret slot even
  // though the community servers they wrap both read GOOGLE_ACCESS_TOKEN — so
  // connecting Gmail must not flip Drive's `connected` too.
  it('gmail + google-drive: independent secret slots, each resolves its own stdio entry', () => {
    const { setSecret } = require('../../src/connectors/token-env');
    const { resolveEnabledConnectors, listConnectorStatus } =
      require('../../src/connectors/resolve');

    const enabled = {
      connectors: {
        gmail: { enabled: true },
        'google-drive': { enabled: true },
        // Opt-out: microsoft-365 needs no secret, so opt-in default resolves
        // it regardless — excluded here to keep this test focused on Google.
        'microsoft-365': { enabled: false as const },
      },
    };
    expect(resolveEnabledConnectors(enabled)).toEqual({});

    setSecret('GMAIL_ACCESS_TOKEN', 'ya29.gmail');
    const gmailOnly = resolveEnabledConnectors(enabled);
    expect(gmailOnly.gmail).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'gmail-mcp'],
      env: { GOOGLE_ACCESS_TOKEN: 'ya29.gmail' },
    });
    expect(gmailOnly['google-drive']).toBeUndefined();

    const statusAfterGmail = listConnectorStatus();
    expect(statusAfterGmail.find((c: { id: string }) => c.id === 'gmail')).toMatchObject({
      connected: true,
    });
    expect(statusAfterGmail.find((c: { id: string }) => c.id === 'google-drive')).toMatchObject({
      connected: false,
    });

    setSecret('GDRIVE_ACCESS_TOKEN', 'ya29.drive');
    const both = resolveEnabledConnectors(enabled);
    expect(both['google-drive']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'google-drive-mcp'],
      env: { GOOGLE_ACCESS_TOKEN: 'ya29.drive' },
    });
  });

  it('custom connector: opt-out default enablement; partially-connected → omitted; fully-connected → substituted', () => {
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
    // microsoft-365 opted out throughout — see the "opt-out" comment above.
    const noMs365 = { 'microsoft-365': { enabled: false as const } };
    const agentConfig = { connectors: { calendar: { enabled: true }, ...noMs365 } };

    // No config at all (not even mentioning `calendar`) → still resolves once
    // secrets exist, because enablement defaults to on (opt-out model).
    setSecret('CUSTOM__calendar__smithery_api_key', 'sk-abc');
    setSecret('CUSTOM__calendar__unset_var', 'val');
    expect(resolveEnabledConnectors({ connectors: noMs365 }, customConnectors)).toEqual({
      calendar: {
        type: 'streamable-http',
        url: 'https://server.smithery.ai/calendar/mcp',
        headers: { Authorization: 'Bearer sk-abc', 'X-Extra': 'val' },
      },
    });

    // Explicitly disabled for this agent → omitted even though fully connected.
    expect(
      resolveEnabledConnectors(
        { connectors: { calendar: { enabled: false }, ...noMs365 } },
        customConnectors,
      ),
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

  it('GET /v1/connectors returns catalog with connected=false initially', async () => {
    const res = await request(makeApp()).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    expect(res.status).toBe(200);
    const github = res.body.connectors.find((c: { id: string }) => c.id === 'github');
    expect(github).toMatchObject({
      id: 'github',
      label: 'GitHub',
      authKind: 'oauth',
      connected: false,
    });
    expect(github.setup).toBeUndefined();
    expect(github.repoUrl).toBe('https://github.com/github/github-mcp-server');
  });

  it('rejects missing / invalid key', async () => {
    expect((await request(makeApp()).get('/api/v1/connectors')).status).toBe(401);
    expect((await request(makeApp()).get('/api/v1/connectors').set('X-Api-Key', 'nope')).status).toBe(403);
  });

  it('non-admin cannot connect', async () => {
    const res = await request(makeApp())
      .post('/api/v1/connectors/github/connect')
      .set('X-Api-Key', scopedKey)
      .send({ token: 'ghp_x' });
    expect(res.status).toBe(403);
  });

  // github is oauth-kind now (services/api pushes the token via /oauth/receive,
  // same as gmail/drive/calendar — see tests/unit/oauth-connectors.test.ts for
  // that route's dedicated coverage). This test keeps the router-level
  // connect→status→delete round trip exercised end-to-end from this suite.
  it('oauth/receive stores the access token + writes config.json; delete clears both', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2));
    const app = makeApp(cfgPath);
    const { getSecret } = require('../../src/connectors/token-env');

    // empty access_token rejected
    const bad = await request(app).post('/api/v1/connectors/github/oauth/receive').set('X-Api-Key', adminKey).send({ access_token: '  ' });
    expect(bad.status).toBe(400);

    // receive
    const ok = await request(app).post('/api/v1/connectors/github/oauth/receive').set('X-Api-Key', adminKey).send({ access_token: 'ghu_pushed' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: 'github', connected: true });
    expect(getSecret('GITHUB_TOKEN')).toBe('ghu_pushed');
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(written.gateway.connectors).toEqual({ github: { secretEnv: 'GITHUB_TOKEN' } });

    // status reflects connected
    const status = await request(app).get('/api/v1/connectors/github/status').set('X-Api-Key', adminKey);
    expect(status.body).toEqual({ id: 'github', connected: true });

    // delete
    const del = await request(app).delete('/api/v1/connectors/github').set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);
    expect(getSecret('GITHUB_TOKEN')).toBeNull();
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).gateway.connectors).toEqual({});
  });

  it('unknown connector → 404', async () => {
    const res = await request(makeApp()).post('/api/v1/connectors/nope/connect').set('X-Api-Key', adminKey).send({ token: 'x' });
    expect(res.status).toBe(404);
  });
});
