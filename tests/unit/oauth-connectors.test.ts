/**
 * Externally-owned OAuth connectors (github/Gmail/Drive/Calendar) — the gateway
 * never does the OAuth dance itself (client_secret lives in an external control
 * plane, which runs infra the user never gets shell access to). This covers
 * the receiving end: POST /oauth/receive stores a
 * pushed access_token + full connector shape as a custom connector with
 * credentialOwner:'external', so nothing here offers to sign in for it or tries
 * to refresh a token this gateway holds no refresh_token for.
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiKey } from '../../src/types';

const TOKEN_ENV = '/tmp/oauth-connectors-test-mcp-token.env';

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV_PATH = TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
  jest.resetModules();
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV_PATH;
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

  /** The shape a real control-plane push sends. */
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

  it('GET /v1/connectors reports a pushed connector as credentialOwner "external"', async () => {
    const app = makeApp(tmpConfig());
    await request(app).post('/api/v1/connectors/gmail/oauth/receive').set('X-Api-Key', adminKey).send(pushPayload());

    const res = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    const gmail = res.body.connectors.find((c: { id: string }) => c.id === 'gmail');
    expect(gmail).toMatchObject({ id: 'gmail', credentialOwner: 'external', connected: true });
  });

  it('POST /connect 404s for an id that is not a configured connector', async () => {
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
      credentialOwner: 'external',
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
    // The entry was written to config.json a moment ago, and the config watcher
    // has not re-read it into any runner yet — so the runner is handed the new
    // entry as an overlay. Without it the runner would resolve the connector
    // against a gatewayConfig that does not know about gmail yet, get nothing
    // back, and match the "spawned without it" fingerprint of every session.
    expect(restartSessionsUsingConnector).toHaveBeenCalledWith(
      'gmail',
      expect.objectContaining({
        overlay: expect.objectContaining({
          gmail: expect.objectContaining({ label: 'Gmail', secretNames: ['access_token'] }),
        }),
      }),
    );
  });

  /**
   * A push onto an id the gateway was managing itself is a handover of ownership,
   * and the entry it overwrites always ends up 'external'.
   *
   * That matters because both remaining ways to clear the sweep's internal keys are
   * gated on `credentialOwner === 'gateway'`: the sweep refreshes only 'gateway'
   * entries, and DELETE clears `internalSecretKeysOf` only for 'gateway' entries. Once
   * the entry says 'external', neither guard holds again — so a refresh_token left
   * behind by the push is a live credential no code path can ever remove, still
   * sitting in mcp-token.env.
   */
  it('a push over a gateway-owned connector clears the sweep bookkeeping it can no longer reach', async () => {
    const app = makeApp(tmpConfig());
    const { setSecrets, getSecret } = require('../../src/connectors/token-env');
    // Built from the sweep's own key helpers, not hardcoded strings: this test is
    // about the handover clearing whatever the sweep stores, and a key added there
    // later must be covered here automatically rather than silently escaping.
    const { internalSecretKeysOf } = require('../../src/connectors/oauth-refresh-sweep');
    const internalKeys: string[] = internalSecretKeysOf('gmail');

    // A gateway-owned (OAuth sign-in) connector under the id the push will take over.
    await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'Gmail',
        oauth: true,
        config: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', headers: { Authorization: 'Bearer {access_token}' } },
      });
    // What a completed sign-in plus a few sweep ticks would have left on it.
    expect(internalKeys.length).toBeGreaterThan(0);
    setSecrets(Object.fromEntries(internalKeys.map((k) => [k, 'sweep-owned-value'])));

    const res = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload());
    expect(res.status).toBe(200);

    expect(getSecret('CUSTOM__gmail__access_token')).toBe('at-pushed-1');
    for (const key of internalKeys) expect(getSecret(key)).toBeNull();
  });

  it('a repeat push over an already-external connector leaves nothing to clear', async () => {
    // The common case — a control plane re-pushing a rotated token. Nothing was
    // gateway-owned, so the removal list must stay empty rather than becoming a
    // blanket delete that reaches keys this route has no business touching.
    const app = makeApp(tmpConfig());
    const { setSecrets, getSecret } = require('../../src/connectors/token-env');

    await request(app).post('/api/v1/connectors/gmail/oauth/receive').set('X-Api-Key', adminKey).send(pushPayload());
    setSecrets({ CUSTOM__unrelated__api_key: 'keep-me' });

    const again = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload({ access_token: 'at-pushed-2' }));
    expect(again.status).toBe(200);
    expect(getSecret('CUSTOM__gmail__access_token')).toBe('at-pushed-2');
    expect(getSecret('CUSTOM__unrelated__api_key')).toBe('keep-me');
  });

  /**
   * Regression (round 10). The route overwrites `secretNames` with
   * ['access_token'], so any secret the previous entry declared under a different
   * name is orphaned: every path that can remove a custom secret enumerates the
   * CURRENT secretNames (DELETE maps over them; /connect refuses an 'external'
   * entry outright), so nothing left can name it again.
   *
   * The concrete case is a pasted-key connector — credentialOwner 'static', a
   * `{api_key}` placeholder — that a control plane later pushes an OAuth token
   * onto. The live third-party API key stays in the 0600 store forever, invisible
   * to every route, with no supported operation that clears it.
   */
  it('a push over a connector with differently-named secrets clears the ones it orphans', async () => {
    const app = makeApp(tmpConfig());
    const { getSecret } = require('../../src/connectors/token-env');

    // A pasted-key connector under the id the push will take over.
    const add = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'Gmail',
        config: {
          type: 'http',
          url: 'https://gmailmcp.googleapis.com/mcp/v1',
          headers: { Authorization: 'Bearer {api_key}', 'X-Org': '{org_id}' },
        },
        secrets: { api_key: 'live-third-party-key', org_id: 'org-42' },
      });
    expect(add.status).toBe(200);
    expect(add.body.id).toBe('gmail');
    expect(getSecret('CUSTOM__gmail__api_key')).toBe('live-third-party-key');

    const res = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload());
    expect(res.status).toBe(200);

    // The pushed token is stored; the names the new entry does not declare are gone.
    expect(getSecret('CUSTOM__gmail__access_token')).toBe('at-pushed-1');
    expect(getSecret('CUSTOM__gmail__api_key')).toBeNull();
    expect(getSecret('CUSTOM__gmail__org_id')).toBeNull();
  });

  it('a repeat push does not delete the access_token it is replacing', async () => {
    // The stale-name removal is computed as "previous names minus new names", so
    // a name carried across both entries must survive — otherwise the common case
    // (a control plane re-pushing a rotated token) would write the new value and
    // then remove it in the same call.
    const app = makeApp(tmpConfig());
    const { getSecret } = require('../../src/connectors/token-env');

    await request(app).post('/api/v1/connectors/gmail/oauth/receive').set('X-Api-Key', adminKey).send(pushPayload());
    const again = await request(app)
      .post('/api/v1/connectors/gmail/oauth/receive')
      .set('X-Api-Key', adminKey)
      .send(pushPayload({ access_token: 'at-pushed-3' }));

    expect(again.status).toBe(200);
    expect(getSecret('CUSTOM__gmail__access_token')).toBe('at-pushed-3');
  });

  it('disconnect removes an externally-owned connector via the unified DELETE route', async () => {
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
