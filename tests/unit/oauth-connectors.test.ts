/**
 * 'oauth'-kind connectors (Gmail/Drive/Calendar) — the gateway never does the
 * OAuth dance itself (client_secret lives in getpod-ai's services/api, which
 * runs infra the user never gets shell access to). This just covers the
 * receiving end: POST /oauth/receive stores a pushed access_token, and the
 * ordinary paste-token /connect route correctly refuses 'oauth'-kind ids.
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiKey } from '../../src/types';

const TOKEN_ENV = '/tmp/oauth-connectors-test-mcp-token.env';

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV = TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
  jest.resetModules();
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
});

describe('connectors-router — oauth-kind connectors', () => {
  const adminKey = 'admin-key';
  const scopedKey = 'scoped-key';
  const apiKeys: ApiKey[] = [
    { key: adminKey, agents: '*', admin: true },
    { key: scopedKey, agents: ['a1'] },
  ];

  function makeApp(configPath?: string, agents?: Map<string, unknown>) {
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(express.json());
    app.use('/api', createConnectorsRouter(apiKeys, configPath, agents));
    return app;
  }

  function tmpConfig() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-oauth-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2),
    );
    return cfgPath;
  }

  it('GET /v1/connectors reports gmail/google-drive/google-calendar as authKind "oauth"', async () => {
    const res = await request(makeApp(tmpConfig())).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    const byId = Object.fromEntries(res.body.connectors.map((c: { id: string; authKind: string }) => [c.id, c.authKind]));
    expect(byId.gmail).toBe('oauth');
    expect(byId['google-drive']).toBe('oauth');
    expect(byId['google-calendar']).toBe('oauth');
  });

  it('POST /connect rejects an oauth-kind connector (not a paste-token flow)', async () => {
    const res = await request(makeApp(tmpConfig()))
      .post('/api/v1/connectors/gmail/connect')
      .set('X-Api-Key', adminKey)
      .send({ token: 'whatever' });
    expect(res.status).toBe(400);
  });

  it('oauth/receive requires admin', async () => {
    const res = await request(makeApp(tmpConfig()))
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', scopedKey)
      .send({ access_token: 'at-1' });
    expect(res.status).toBe(403);
  });

  it('oauth/receive rejects a non-oauth connector', async () => {
    const res = await request(makeApp(tmpConfig()))
      .post('/api/v1/connectors/github/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send({ access_token: 'at-1' });
    expect(res.status).toBe(400);
  });

  it('oauth/receive rejects a missing/blank access_token', async () => {
    const app = makeApp(tmpConfig());
    const missing = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send({});
    expect(missing.status).toBe(400);

    const blank = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send({ access_token: '   ' });
    expect(blank.status).toBe(400);
  });

  it('oauth/receive stores the token and marks the connector connected', async () => {
    const cfgPath = tmpConfig();
    const app = makeApp(cfgPath);

    const res = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send({ access_token: 'at-pushed-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'gmail', connected: true });

    const { getSecret } = require('../../src/connectors/token-env');
    expect(getSecret('GMAIL_ACCESS_TOKEN')).toBe('at-pushed-1');

    const list = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    const gmail = list.body.connectors.find((c: { id: string }) => c.id === 'gmail');
    expect(gmail.connected).toBe(true);

    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(written.gateway.connectors.gmail).toEqual({ secretEnv: 'GMAIL_ACCESS_TOKEN' });
  });

  it('oauth/receive restarts sessions using the connector across every tracked AgentRunner', async () => {
    const restartSessionsUsingConnector = jest.fn().mockResolvedValue({ restarted: true });
    const fakeRunner = { restartSessionsUsingConnector } as unknown;
    const agents = new Map([['agent-1', fakeRunner]]);

    const app = makeApp(tmpConfig(), agents);
    const res = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send({ access_token: 'at-2' });

    expect(res.status).toBe(200);
    expect(restartSessionsUsingConnector).toHaveBeenCalledWith('gmail');
  });

  it('disconnect clears the secret for an oauth-kind connector', async () => {
    const app = makeApp(tmpConfig());
    await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send({ access_token: 'at-3' });

    const del = await request(app).delete('/api/v1/connectors/gmail').set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);

    const { getSecret } = require('../../src/connectors/token-env');
    expect(getSecret('GMAIL_ACCESS_TOKEN')).toBeNull();
  });
});
