/**
 * Unit tests for custom (user-pasted) connectors — the 2nd, admin-trusted-not-
 * code-reviewed tier alongside CONNECTOR_CATALOG.
 *
 *  custom helpers    — slugify / extractPlaceholders / substitutePlaceholders
 *  connectors-router — POST /custom (create), DELETE /custom/:id, GET merges tiers
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ApiKey } from '../../src/types';

const TOKEN_ENV = '/tmp/custom-connectors-test-mcp-token.env';

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV = TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
  jest.resetModules();
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
});

describe('custom helpers', () => {
  it('slugify: lowercases, dashes, and de-dupes against catalog + existing ids', () => {
    const { slugify } = require('../../src/connectors/custom');
    expect(slugify('Weather API!', [])).toBe('weather-api');
    // Collides with the built-in 'github' id
    expect(slugify('GitHub', [])).toBe('github-2');
    // Collides with an existing custom id
    expect(slugify('Foo', ['foo'])).toBe('foo-2');
    expect(slugify('Foo', ['foo', 'foo-2'])).toBe('foo-3');
  });

  it('extractPlaceholders: finds every unique {name} in nested string values', () => {
    const { extractPlaceholders } = require('../../src/connectors/custom');
    const config = {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer {api_key}', 'X-Team': '{team_id}' },
      nested: ['{team_id}', 'no-placeholder-here'],
    };
    expect(extractPlaceholders(config).sort()).toEqual(['api_key', 'team_id']);
  });

  it('extractPlaceholders: empty when there are none', () => {
    const { extractPlaceholders } = require('../../src/connectors/custom');
    expect(extractPlaceholders({ command: 'npx', args: ['some-mcp'] })).toEqual([]);
  });

  it('substitutePlaceholders: replaces recursively, missing secrets become empty string', () => {
    const { substitutePlaceholders } = require('../../src/connectors/custom');
    const config = { headers: { Authorization: 'Bearer {api_key}' }, list: ['{a}', 'x'] };
    expect(substitutePlaceholders(config, { api_key: 'sk-123', a: 'A' })).toEqual({
      headers: { Authorization: 'Bearer sk-123' },
      list: ['A', 'x'],
    });
    expect(substitutePlaceholders(config, {})).toEqual({
      headers: { Authorization: 'Bearer ' },
      list: ['', 'x'],
    });
  });
});

describe('connectors-router — custom connectors', () => {
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

  function tmpConfig() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-custom-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ gateway: { logDir: '/tmp', timezone: 'UTC' }, agents: [] }, null, 2),
    );
    return cfgPath;
  }

  it('non-admin cannot add a custom connector', async () => {
    const res = await request(makeApp(tmpConfig()))
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', scopedKey)
      .send({ label: 'X', config: { command: 'npx', args: ['x-mcp'] } });
    expect(res.status).toBe(403);
  });

  it('rejects a missing/invalid config body', async () => {
    const app = makeApp(tmpConfig());
    const noConfig = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({ label: 'X' });
    expect(noConfig.status).toBe(400);

    const arrayConfig = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({ label: 'X', config: ['not', 'an', 'object'] });
    expect(arrayConfig.status).toBe(400);

    const noLabel = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({ config: { command: 'npx' } });
    expect(noLabel.status).toBe(400);
  });

  it('creates with no secrets provided → connected:false when placeholders exist', async () => {
    const cfgPath = tmpConfig();
    const app = makeApp(cfgPath);
    const res = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'Smithery Google Calendar',
        description: 'Calendar via Smithery',
        config: {
          type: 'streamable-http',
          url: 'https://server.smithery.ai/@mayla-debug/mcp-google-calendar2/mcp',
          headers: { Authorization: 'Bearer {smithery_api_key}' },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'smithery-google-calendar', label: 'Smithery Google Calendar', connected: false });

    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(written.gateway.customConnectors['smithery-google-calendar']).toEqual({
      label: 'Smithery Google Calendar',
      description: 'Calendar via Smithery',
      config: {
        type: 'streamable-http',
        url: 'https://server.smithery.ai/@mayla-debug/mcp-google-calendar2/mcp',
        headers: { Authorization: 'Bearer {smithery_api_key}' },
      },
      secretNames: ['smithery_api_key'],
    });
  });

  it('creates with secrets provided inline → connected:true, and GET /v1/connectors merges it in with source "custom"', async () => {
    const cfgPath = tmpConfig();
    const app = makeApp(cfgPath);
    const create = await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'No Auth Server',
        config: { type: 'streamable-http', url: 'https://mcp.airshelf.ai/mcp' },
      });
    expect(create.status).toBe(200);
    expect(create.body).toEqual({ id: 'no-auth-server', label: 'No Auth Server', connected: true });

    const list = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    const github = list.body.connectors.find((c: { id: string }) => c.id === 'github');
    expect(github.source).toBe('built-in');
    const custom = list.body.connectors.find((c: { id: string }) => c.id === 'no-auth-server');
    expect(custom).toMatchObject({ id: 'no-auth-server', label: 'No Auth Server', connected: true, source: 'custom' });
    expect(custom.repoUrl).toBeUndefined(); // no sourceUrl was given
  });

  it('sourceUrl round-trips as repoUrl in GET /v1/connectors; omitted when not given', async () => {
    const cfgPath = tmpConfig();
    const app = makeApp(cfgPath);
    await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'Rollforge',
        config: { command: 'npx', args: ['@agentutility/mcp-rollforge'] },
        sourceUrl: 'https://github.com/agentutility/mcp-rollforge',
      });

    const list = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    const custom = list.body.connectors.find((c: { id: string }) => c.id === 'rollforge');
    expect(custom.repoUrl).toBe('https://github.com/agentutility/mcp-rollforge');

    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(written.gateway.customConnectors.rollforge.sourceUrl).toBe(
      'https://github.com/agentutility/mcp-rollforge',
    );
  });

  it('rejects a non-string sourceUrl', async () => {
    const res = await request(makeApp(tmpConfig()))
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({ label: 'X', config: { command: 'npx' }, sourceUrl: 123 });
    expect(res.status).toBe(400);
  });

  it('unknown connector id → 404 on status/delete', async () => {
    const app = makeApp(tmpConfig());
    const status = await request(app).get('/api/v1/connectors/nope/status').set('X-Api-Key', adminKey);
    expect(status.status).toBe(404);
    const del = await request(app).delete('/api/v1/connectors/custom/nope').set('X-Api-Key', adminKey);
    expect(del.status).toBe(404);
  });

  it('delete clears the namespaced secret + config entry', async () => {
    const cfgPath = tmpConfig();
    const app = makeApp(cfgPath);
    const { getSecret } = require('../../src/connectors/token-env');

    await request(app)
      .post('/api/v1/connectors/custom')
      .set('X-Api-Key', adminKey)
      .send({
        label: 'Rollforge',
        config: { command: 'npx', args: ['@agentutility/mcp-rollforge'], env: { TOKEN: '{token}' } },
        secrets: { token: 'shhh' },
      });
    expect(getSecret('CUSTOM__rollforge__token')).toBe('shhh');

    const del = await request(app).delete('/api/v1/connectors/custom/rollforge').set('X-Api-Key', adminKey);
    expect(del.status).toBe(200);
    expect(getSecret('CUSTOM__rollforge__token')).toBeNull();
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).gateway.customConnectors).toEqual({});
  });
});
