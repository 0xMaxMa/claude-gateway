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

    // disabled → omitted
    expect(resolveEnabledConnectors({ connectors: {} })).toEqual({});

    // enabled but not connected → omitted
    expect(resolveEnabledConnectors({ connectors: { github: { enabled: true } } })).toEqual({});

    // enabled + connected → entry present
    setSecret('GITHUB_TOKEN', 'ghp_xyz');
    const resolved = resolveEnabledConnectors({ connectors: { github: { enabled: true } } });
    expect(resolved.github).toEqual({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ghp_xyz' },
    });

    // connected reflected in status
    const status = listConnectorStatus().find((c: { id: string }) => c.id === 'github');
    expect(status).toMatchObject({ id: 'github', authKind: 'secret', connected: true });

    // guided token-generation help is surfaced for the web panel
    expect(status.setup.tokenUrl).toMatch(/^https:\/\/github\.com\/settings\/tokens\/new/);
    expect(typeof status.setup.label).toBe('string');
    expect(status.setup.label.length).toBeGreaterThan(0);
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
    expect(github).toMatchObject({ id: 'github', label: 'GitHub', connected: false });
    expect(github.setup.tokenUrl).toMatch(/^https:\/\/github\.com\/settings\/tokens\/new/);
    expect(github.setup.label).toBeTruthy();
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

  it('connect stores secret + writes config.json; delete clears both', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-router-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2));
    const app = makeApp(cfgPath);
    const { getSecret } = require('../../src/connectors/token-env');

    // empty token rejected
    const bad = await request(app).post('/api/v1/connectors/github/connect').set('X-Api-Key', adminKey).send({ token: '  ' });
    expect(bad.status).toBe(400);

    // connect
    const ok = await request(app).post('/api/v1/connectors/github/connect').set('X-Api-Key', adminKey).send({ token: 'ghp_secret' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: 'github', connected: true });
    expect(getSecret('GITHUB_TOKEN')).toBe('ghp_secret');
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
