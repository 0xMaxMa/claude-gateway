import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createPstackRouter } from '../../../src/api/pstack-router';
import { collectManifest } from '../../../src/api/manifest-sources';
import { resetModelCatalogCache, resetSettingsEnvCache } from '../../../src/agent/model-catalog';
import type { AgentConfig, ApiKey, ModelConfig } from '../../../src/types';
import { pstackClaudeConfig } from '../../helpers/pstack-fixture';

/** PUT/DELETE /v1/agents/:id/pstack (#582) and the `pstack enable|disable` CLI they generate. */

const KEYS: ApiKey[] = [
  { key: 'admin', description: 'admin', agents: '*', admin: true },
  { key: 'alice-write', description: 'w', agents: ['alice'], write: true },
  { key: 'alice-read', description: 'r', agents: ['alice'] },
];
const MODELS: ModelConfig[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', alias: 'opus', contextWindow: 200000 },
  { id: 'gpt-6-sol[1m]', label: 'GPT 6 Sol', alias: 'gpt6sol', contextWindow: 1050000 },
];

/** Third review of #591 (M8): a host's provider env pointed selectableModels at the real catalog. */
const CATALOG_ENV = ['MODELS_BASE_URL', 'ANTHROPIC_BASE_URL', 'MODELS_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
let tmp: string, configPath: string, agents: Map<string, AgentConfig>, fixture: ReturnType<typeof pstackClaudeConfig>, previous: string | undefined;
let savedEnv: Array<string | undefined>, fetchSpy: jest.SpyInstance;
beforeEach(() => {
  fixture = pstackClaudeConfig();
  previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = fixture.configDir;
  savedEnv = CATALOG_ENV.map(key => process.env[key]);
  for (const key of CATALOG_ENV) delete process.env[key];
  fetchSpy = jest.spyOn(global, 'fetch');
  resetModelCatalogCache(); resetSettingsEnvCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-router-'));
  configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ id: 'alice', claude: { model: 'claude-opus-5-5' } }, { id: 'bob', claude: { model: 'claude-opus-5-5' } }] }));
  agents = new Map([['alice', { id: 'alice' } as AgentConfig], ['bob', { id: 'bob' } as AgentConfig]]);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  CATALOG_ENV.forEach((key, i) => { if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i]; });
  resetModelCatalogCache(); resetSettingsEnvCache();
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
  fixture.cleanup(); fs.rmSync(tmp, { recursive: true, force: true });
});

function app() {
  const a = express(); a.use(express.json());
  a.use('/api', createPstackRouter(KEYS, agents, configPath, () => MODELS));
  return a;
}
const persisted = (id: string) => JSON.parse(fs.readFileSync(configPath, 'utf8')).agents.find((a: { id: string }) => a.id === id).pstack;

test('a write key sets up its own agent; the saved block is in config.json and live config', async () => {
  const res = await request(app()).put('/api/v1/agents/alice/pstack').set('X-Api-Key', 'alice-write')
    .send({ roles: { 'why investigators': 'GPT-6-SOL[1m]' }, defaultEffort: 'high' });
  expect(res.status).toBe(200);
  expect(res.body.pstack).toEqual({ roles: { 'why investigators': 'gpt-6-sol[1m]' }, defaultEffort: 'high' });
  expect(persisted('alice')).toEqual(res.body.pstack);
  expect(agents.get('alice')!.pstack).toEqual(res.body.pstack);
});

test('the CLI form sends roles as a JSON string', async () => {
  const res = await request(app()).put('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin').send({ roles: '{"bug-fix":"claude-opus-5-5"}' });
  expect(res.status).toBe(200);
  expect(persisted('alice')).toEqual({ roles: { 'bug-fix': 'claude-opus-5-5' } });
});

// Third review of #591 (L3): `pstack enable <agent>` for an agent already set up wiped every role it had.
test('fields a PUT omits keep their saved values; roles {} resets the roles', async () => {
  const put = (body: object) => request(app()).put('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin').send(body);
  await put({ roles: { 'bug-fix': 'claude-opus-5-5' }, defaultEffort: 'high' });
  expect((await put({})).body.pstack).toEqual({ roles: { 'bug-fix': 'claude-opus-5-5' }, defaultEffort: 'high' });
  expect((await put({ defaultEffort: 'low' })).body.pstack).toEqual({ roles: { 'bug-fix': 'claude-opus-5-5' }, defaultEffort: 'low' });
  expect((await put({ roles: {} })).body.pstack).toEqual({ defaultEffort: 'low' });
  expect(persisted('alice')).toEqual({ defaultEffort: 'low' });
});

// Third review of #591: an app agent's workers run in a container and never load pstack, so saving it did nothing.
test('an app agent cannot be set up; removing a stale block still works', async () => {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.agents[0].type = 'app-agent'; fs.writeFileSync(configPath, JSON.stringify(config));
  const res = await request(app()).put('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin').send({});
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({ code: 'PSTACK_UNSUPPORTED_AGENT', error: expect.stringContaining('container') });
  expect(persisted('alice')).toBeUndefined();
  config.agents[0].pstack = {}; fs.writeFileSync(configPath, JSON.stringify(config));
  expect((await request(app()).delete('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin')).status).toBe(200);
  expect(persisted('alice')).toBeUndefined();
});

test('DELETE removes the block', async () => {
  await request(app()).put('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin').send({});
  expect(persisted('alice')).toEqual({});
  const res = await request(app()).delete('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin');
  expect(res.status).toBe(200);
  expect(res.body.pstack).toBeNull();
  expect(persisted('alice')).toBeUndefined();
  expect(agents.get('alice')!.pstack).toBeUndefined();
});

test.each([['alice-write', 'bob'], ['alice-read', 'alice']])('key %s cannot change %s', async (key, agent) => {
  const res = await request(app()).put(`/api/v1/agents/${agent}/pstack`).set('X-Api-Key', key).send({});
  expect(res.status).toBe(403);
  expect(persisted(agent)).toBeUndefined();
});

test('the admin key can change any agent', async () => {
  expect((await request(app()).put('/api/v1/agents/bob/pstack').set('X-Api-Key', 'admin').send({})).status).toBe(200);
});

test.each([
  [{ roles: { 'bug-fix': 'opus' } }, 'MODEL_ALIAS_NOT_ALLOWED'],
  [{ roles: { 'bug-fix': 'gpt-7' } }, 'UNKNOWN_MODEL'],
  [{ roles: { 'how critics': 'claude-opus-5-5' } }, 'UNKNOWN_PSTACK_ROLE'],
  [{ sha: '1bfdab4' }, 'INVALID_PSTACK_CONFIG'],
  [{ roles: { 'bug-fix': 'claude-opus-5-5 @ultra' } }, 'INVALID_EFFORT'],
])('rejects %j with %s and writes nothing', async (body, code) => {
  const res = await request(app()).put('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin').send(body);
  expect(res.status).toBe(400);
  // Review of #591 (L6): the API's `{ error: <text>, code }` shape, as share and voice errors.
  expect(res.body.code).toBe(code);
  expect(typeof res.body.error).toBe('string');
  expect(res.body.error).not.toBe(code);
  expect(persisted('alice')).toBeUndefined();
});

test('roles that are not JSON are refused with the same error shape', async () => {
  const res = await request(app()).put('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin').send({ roles: '{bug-fix' });
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: 'roles must be a JSON object', code: 'INVALID_PSTACK_CONFIG' });
});

test('setup requires the plugin to be installed', async () => {
  fixture.cleanup(); fixture = pstackClaudeConfig(false); process.env.CLAUDE_CONFIG_DIR = fixture.configDir;
  const res = await request(app()).put('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin').send({});
  expect(res.body).toMatchObject({ code: 'PSTACK_NOT_INSTALLED' });
  expect(res.body.error).toContain('/plugin install pstack@pstack-claude');
  // Review of #582: the plugin's marketplace must be added before it can be installed.
  expect(res.body.error).toContain('/plugin marketplace add michael-denyer/pstack-claude');
});

test('unknown agents are 404', async () => {
  expect((await request(app()).put('/api/v1/agents/carol/pstack').set('X-Api-Key', 'admin').send({})).status).toBe(404);
});

test('the routes are in the manifest as `pstack enable|disable <agentId>`', () => {
  const routes = collectManifest().filter(r => r.cli?.noun === 'pstack').map(r => `${r.method} ${r.path} ${r.cli!.verb} ${r.cli!.args}`);
  expect(routes.sort()).toEqual(['DELETE /v1/agents/:agentId/pstack disable agentId', 'PUT /v1/agents/:agentId/pstack enable agentId']);
});

// Review of #582: an agent loaded in memory but missing from config.json is a 404, not a 500.
test('an agent missing from config.json is 404', async () => {
  agents.set('carol', { id: 'carol' } as AgentConfig);
  expect((await request(app()).put('/api/v1/agents/carol/pstack').set('X-Api-Key', 'admin').send({})).status).toBe(404);
});

// Review of #582: an unexpected save failure is still a 500, but its cause is logged, not swallowed.
test('an unexpected save failure is logged with its cause', async () => {
  fs.writeFileSync(configPath, '{not json');
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await request(app()).delete('/api/v1/agents/alice/pstack').set('X-Api-Key', 'admin');
    expect(res.status).toBe(500);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('alice'), expect.stringMatching(/JSON/));
  } finally { log.mockRestore(); }
});
