/**
 * Managed OAuth connectors (github/Gmail/Drive/Calendar) — the gateway never
 * does the OAuth dance itself (client_secret lives in getpod-ai's services/api,
 * which runs infra the user never gets shell access to) and has no catalog
 * entry for any of them (CONNECTOR_CATALOG is empty by default — see
 * catalog.ts). This covers the receiving end: POST /oauth/receive stores a
 * pushed access_token + full connector shape as a managed custom connector
 * (authKind:'oauth', managed:true), reported as source:'built-in' so the web
 * panel doesn't show a "Custom" badge on something GetPod pushed in.
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

  /** The shape services/api's real push sends — see internal/vm/connector_push.go. */
  function pushPayload(overrides: Record<string, unknown> = {}) {
    return {
      access_token: 'at-pushed-1',
      label: 'Gmail',
      description: 'Search threads, read messages, manage labels, and draft email.',
      config: {
        type: 'http',
        url: 'https://gmailmcp.googleapis.com/mcp/v1',
        headers: { Authorization: 'Bearer {access_token}' },
      },
      sourceUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
      ...overrides,
    };
  }

  it('GET /v1/connectors reports a pushed connector as authKind "oauth", source "built-in"', async () => {
    const app = makeApp(tmpConfig());
    await request(app).post('/api/v1/connectors/gmail/oauth/receive').set('X-Api-Key', adminKey).send(pushPayload());

    const res = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    const gmail = res.body.connectors.find((c: { id: string }) => c.id === 'gmail');
    expect(gmail).toMatchObject({ id: 'gmail', authKind: 'oauth', source: 'built-in', connected: true });
  });

  it('POST /connect 404s for an id with no built-in catalog entry (CONNECTOR_CATALOG is empty by default)', async () => {
    const res = await request(makeApp(tmpConfig()))
      .post('/api/v1/connectors/gmail/connect')
      .set('X-Api-Key', adminKey)
      .send({ token: 'whatever' });
    expect(res.status).toBe(404);
  });

  it('oauth/receive requires admin (checked before any payload validation)', async () => {
    const res = await request(makeApp(tmpConfig()))
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', scopedKey)
      .send(pushPayload());
    expect(res.status).toBe(403);
  });

  it('oauth/receive rejects a config whose placeholders are not exactly {access_token}', async () => {
    const app = makeApp(tmpConfig());

    const noPlaceholder = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload({ config: { type: 'http', url: 'https://example.com' } }));
    expect(noPlaceholder.status).toBe(400);

    const extraPlaceholder = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(
        pushPayload({
          config: {
            type: 'http',
            url: 'https://example.com',
            headers: { Authorization: 'Bearer {access_token}', 'X-Extra': '{something_else}' },
          },
        }),
      );
    expect(extraPlaceholder.status).toBe(400);
  });

  it('oauth/receive rejects a missing/blank access_token, or a missing label/config', async () => {
    const app = makeApp(tmpConfig());
    const missing = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send({});
    expect(missing.status).toBe(400);

    const blank = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload({ access_token: '   ' }));
    expect(blank.status).toBe(400);

    const noLabel = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload({ label: undefined }));
    expect(noLabel.status).toBe(400);

    const noConfig = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload({ config: undefined }));
    expect(noConfig.status).toBe(400);
  });

  it('oauth/receive stores the full shape + secret, marks the connector connected', async () => {
    const cfgPath = tmpConfig();
    const app = makeApp(cfgPath);

    const res = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'gmail', connected: true });

    const { getSecret } = require('../../src/connectors/token-env');
    expect(getSecret('CUSTOM__gmail__access_token')).toBe('at-pushed-1');

    const list = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    const gmail = list.body.connectors.find((c: { id: string }) => c.id === 'gmail');
    expect(gmail.connected).toBe(true);

    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(written.gateway.customConnectors.gmail).toMatchObject({
      label: 'Gmail',
      secretNames: ['access_token'],
      authKind: 'oauth',
      managed: true,
    });
  });

  it('oauth/receive restarts sessions using the connector across every tracked AgentRunner', async () => {
    const restartSessionsUsingConnector = jest.fn().mockResolvedValue({ restarted: true });
    const fakeRunner = { restartSessionsUsingConnector } as unknown;
    const agents = new Map([['agent-1', fakeRunner]]);

    const app = makeApp(tmpConfig(), agents);
    const res = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload());

    expect(res.status).toBe(200);
    expect(restartSessionsUsingConnector).toHaveBeenCalledWith('gmail');
  });

  it('disconnect clears the secret for a managed oauth connector via the unified DELETE route', async () => {
    const app = makeApp(tmpConfig());
    await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload());

    const del = await request(app).delete('/api/v1/connectors/gmail').set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);

    const { getSecret } = require('../../src/connectors/token-env');
    expect(getSecret('CUSTOM__gmail__access_token')).toBeNull();
  });
});
