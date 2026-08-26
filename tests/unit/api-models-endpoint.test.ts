/**
 * GET /api/v1/models — live catalog with a static fallback (issue #409).
 *
 * This endpoint used to `.map()` straight over the `models` array handed to
 * the router at construction, i.e. `gateway.models` from config.json. That file
 * is written once at provisioning, so the endpoint could only ever report the
 * list baked in at setup time no matter what changed upstream.
 */

import express from 'express';
import request from 'supertest';
import { createApiRouter } from '../../src/api/router';
import { resetModelCatalogCache, resetSettingsEnvCache } from '../../src/agent/model-catalog';
import { DEFAULT_MODELS } from '../../src/agent/runner';
import type { AgentConfig, ApiKey, ModelConfig } from '../../src/types';

const AGENT_ID = 'alfred';
const AUTH = { Authorization: 'Bearer sk-test-app' };

const apiKeys: ApiKey[] = [{ key: 'sk-test-app', agents: [AGENT_ID] }];

const agentConfig: AgentConfig = {
  id: AGENT_ID,
  description: 'Personal assistant',
  workspace: '/tmp/alfred',
  env: '',
  telegram: { botToken: 'tok' },
  claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
};

const STATIC_MODELS: ModelConfig[] = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', alias: 'sonnet', contextWindow: 200000 },
];

const ENV_KEYS = ['MODELS_BASE_URL', 'ANTHROPIC_BASE_URL', 'MODELS_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] as const;

// No default: passing `undefined` explicitly must reach the router as
// undefined, which is the "gateway.models absent from config.json" case.
function buildApp(models?: ModelConfig[]) {
  const runners = new Map<string, never>();
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(
    runners as unknown as Map<string, import('../../src/agent/runner').AgentRunner>,
    configs, apiKeys, undefined, models,
  ));
  return app;
}

describe('GET /api/v1/models', () => {
  const realFetch = global.fetch;
  const saved: Record<string, string | undefined> = {};
  let fetchMock: jest.Mock;

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.CLAUDE_CONFIG_DIR = '/nonexistent-claude-config-for-tests';
    resetModelCatalogCache();
    resetSettingsEnvCache();
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    resetModelCatalogCache();
    resetSettingsEnvCache();
  });

  it('returns the configured list when no catalog base URL is set', async () => {
    const res = await request(buildApp(STATIC_MODELS)).get('/api/v1/models').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', alias: 'sonnet', contextWindow: 200000, multiplier: 1 },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the live catalog when one is configured', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'byok/some-model', display_name: 'Some BYOK Model' }] }),
    });

    const res = await request(buildApp(STATIC_MODELS)).get('/api/v1/models').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(['claude-sonnet-4-6', 'byok/some-model']);
    expect(res.body.models[1].name).toBe('Some BYOK Model');
  });

  it('falls back to the configured list when the catalog is unreachable', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(buildApp(STATIC_MODELS)).get('/api/v1/models').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(['claude-sonnet-4-6']);
  });

  it('still requires auth', async () => {
    const res = await request(buildApp(STATIC_MODELS)).get('/api/v1/models');
    expect(res.status).toBe(401);
  });

  it('reports the defaults when the gateway has no configured models', async () => {
    // Previously `[]`: the endpoint said "no models" while the chat picker,
    // which falls back to DEFAULT_MODELS, showed the full list.
    const res = await request(buildApp()).get('/api/v1/models').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(DEFAULT_MODELS.map((m) => m.id));
  });

  it('enriches the catalog from the same list the runner uses, so the shared cache is not degraded', async () => {
    // fetchModelCatalog caches one parsed catalog per process, and its
    // alias/contextWindow/multiplier come from whichever caller's list
    // populated the cache first. With `?? []` here, one request on a gateway
    // that has no `gateway.models` cached a catalog with every alias set to
    // its id and every context window at the 200k default — and the picker and
    // every contextWindowFor() call read that for the next 60 seconds.
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    const oneMillion = DEFAULT_MODELS.find((m) => m.contextWindow === 1000000)!;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: oneMillion.id, display_name: oneMillion.label }] }),
    });

    const res = await request(buildApp()).get('/api/v1/models').set(AUTH);

    expect(res.body.models[0]).toEqual({
      id: oneMillion.id,
      name: oneMillion.label,
      alias: oneMillion.alias,
      contextWindow: 1000000,
      multiplier: oneMillion.multiplier ?? 1,
    });
  });
});
