/**
 * Connector pause/resume, agent scope (all vs selected) and the default reach of
 * new custom connectors (#634).
 *
 * Every assertion about "which agents get the connector" is checked against
 * resolveEnabledConnectors itself, the function every spawn path calls, not against
 * what the route says it did.
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ApiKey, CustomConnectorEntry } from '../../src/types';

const TOKEN_ENV = path.join(os.tmpdir(), `connector-pause-scope-${process.pid}.env`);

beforeEach(() => {
  process.env.GATEWAY_MCP_TOKEN_ENV_PATH = TOKEN_ENV;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
  jest.resetModules();
});

afterAll(() => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV_PATH;
  try { fs.rmSync(TOKEN_ENV); } catch { /* ignore */ }
});

const adminKey = 'admin-key';
const scopedKey = 'scoped-key';
const apiKeys: ApiKey[] = [
  { key: adminKey, agents: '*', admin: true },
  { key: scopedKey, agents: ['a'] },
];
const HTTP_CONFIG = { type: 'http', url: 'https://ops.example/mcp', headers: { Authorization: 'Bearer {api_key}' } };

function tmpConfig(agentIds: string[], gateway: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-scope-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    gateway: { logDir: '/tmp', timezone: 'UTC', ...gateway },
    agents: agentIds.map((id) => ({ id })),
  }, null, 2));
  return cfgPath;
}

function makeApp(cfgPath: string, runners?: Map<string, unknown>) {
  const { createConnectorsRouter } = require('../../src/api/connectors-router');
  const app = express();
  app.use(express.json());
  app.use('/api', createConnectorsRouter(apiKeys, cfgPath, runners));
  return app;
}

function readConfig(cfgPath: string) {
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
    gateway: { customConnectors: Record<string, CustomConnectorEntry>; connectorsDefaultEnabled?: boolean };
    agents: Array<{ id: string; connectors?: Record<string, { enabled: boolean }> }>;
  };
}

/** Agent id → whether resolveEnabledConnectors injects `connectorId` for it. */
function resolvedFor(cfgPath: string, connectorId: string): Record<string, boolean> {
  const { resolveEnabledConnectors } = require('../../src/connectors/resolve');
  const cfg = readConfig(cfgPath);
  return Object.fromEntries(cfg.agents.map((a) => [
    a.id,
    connectorId in resolveEnabledConnectors(a, cfg.gateway.customConnectors, cfg.gateway.connectorsDefaultEnabled ?? true),
  ]));
}

async function addConnector(app: express.Express, body: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app).post('/api/v1/connectors/custom').set('X-Api-Key', adminKey)
    .send({ label: 'Ops API', config: HTTP_CONFIG, secrets: { api_key: 'sk-ops' }, ...body });
  expect(res.status).toBe(200);
  return res.body.id;
}

describe('default reach of new custom connectors', () => {
  it('a connector added without any scope reaches every agent, as before', async () => {
    const cfgPath = tmpConfig(['a', 'b']);
    const res = await request(makeApp(cfgPath)).post('/api/v1/connectors/custom').set('X-Api-Key', adminKey)
      .send({ label: 'Ops API', config: HTTP_CONFIG, secrets: { api_key: 'sk-ops' } });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('defaultEnabled');
    expect(readConfig(cfgPath).gateway.customConnectors[res.body.id]).not.toHaveProperty('defaultEnabled');
    expect(resolvedFor(cfgPath, res.body.id)).toEqual({ a: true, b: true });
  });

  it('an explicit defaultEnabled: false restricts it to agents that opt in', async () => {
    const cfgPath = tmpConfig(['a', 'b']);
    const id = await addConnector(makeApp(cfgPath), { defaultEnabled: false });
    expect(readConfig(cfgPath).gateway.customConnectors[id].defaultEnabled).toBe(false);
    expect(resolvedFor(cfgPath, id)).toEqual({ a: false, b: false });
  });

  it('an explicit selected scope restricts it to the listed agents', async () => {
    const cfgPath = tmpConfig(['a', 'b']);
    const app = makeApp(cfgPath);
    const id = await addConnector(app);
    await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey)
      .send({ mode: 'selected', agents: ['a'] }).expect(200);
    expect(resolvedFor(cfgPath, id)).toEqual({ a: true, b: false });
  });

  it('a stored entry without the field still resolves for every agent', () => {
    const { resolveEnabledConnectors } = require('../../src/connectors/resolve');
    fs.writeFileSync(TOKEN_ENV, 'CUSTOM__legacy__api_key=sk\n');
    const entries = { legacy: { label: 'Legacy', config: HTTP_CONFIG, secretNames: ['api_key'], credentialOwner: 'static' } };
    expect(Object.keys(resolveEnabledConnectors({}, entries))).toEqual(['legacy']);
  });

  it('defaultEnabled can be changed after creation without touching the secret', async () => {
    const cfgPath = tmpConfig(['a']);
    const app = makeApp(cfgPath);
    const id = await addConnector(app, { defaultEnabled: false });
    const tokenBefore = fs.readFileSync(TOKEN_ENV, 'utf8');
    const res = await request(app).patch(`/api/v1/connectors/${id}`).set('X-Api-Key', adminKey).send({ defaultEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.defaultEnabled).toBe(true);
    expect(fs.readFileSync(TOKEN_ENV, 'utf8')).toBe(tokenBefore);
    expect(resolvedFor(cfgPath, id)).toEqual({ a: true });
  });
});

describe('pause / resume', () => {
  it('pausing removes the connector from every agent, keeps the secret, and resume restores it', async () => {
    const cfgPath = tmpConfig(['a', 'b']);
    const app = makeApp(cfgPath);
    const id = await addConnector(app, { defaultEnabled: true });
    // An explicit per-agent enable must not survive a pause either.
    const cfg = readConfig(cfgPath);
    cfg.agents[1].connectors = { [id]: { enabled: true } };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const tokenBefore = fs.readFileSync(TOKEN_ENV, 'utf8');

    const paused = await request(app).patch(`/api/v1/connectors/${id}`).set('X-Api-Key', adminKey).send({ paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.paused).toBe(true);
    expect(resolvedFor(cfgPath, id)).toEqual({ a: false, b: false });
    expect(fs.readFileSync(TOKEN_ENV, 'utf8')).toBe(tokenBefore);

    const list = await request(app).get('/api/v1/connectors').set('X-Api-Key', adminKey);
    expect(list.body.capabilities).toMatchObject({ connectorPause: true, connectorScope: true, connectorSidecar: true });
    expect(list.body.connectors[0]).toMatchObject({ id, connected: true, paused: true });
    const status = await request(app).get(`/api/v1/connectors/${id}/status`).set('X-Api-Key', adminKey);
    expect(status.body).toMatchObject({ id, connected: true, paused: true });

    const resumed = await request(app).patch(`/api/v1/connectors/${id}`).set('X-Api-Key', adminKey).send({ paused: false });
    expect(resumed.body.paused).toBe(false);
    expect(resolvedFor(cfgPath, id)).toEqual({ a: true, b: true });
    expect(fs.readFileSync(TOKEN_ENV, 'utf8')).toBe(tokenBefore);
    const after = await request(app).get(`/api/v1/connectors/${id}/status`).set('X-Api-Key', adminKey);
    expect(after.body.connected).toBe(true);
    expect('paused' in after.body).toBe(false);
  });

  it('restarts the sessions using the connector with the paused entry', async () => {
    const cfgPath = tmpConfig(['a']);
    const restart = jest.fn().mockResolvedValue({ restarted: true });
    const app = makeApp(cfgPath, new Map([['a', { restartSessionsUsingConnector: restart }]]));
    const id = await addConnector(app, { defaultEnabled: true });
    restart.mockClear();
    await request(app).patch(`/api/v1/connectors/${id}`).set('X-Api-Key', adminKey).send({ paused: true }).expect(200);
    expect(restart).toHaveBeenCalledWith(id, { overlay: { [id]: expect.objectContaining({ paused: true }) } });
  });

  it('validates input, is admin-only and 404s an unknown id', async () => {
    const cfgPath = tmpConfig(['a']);
    const app = makeApp(cfgPath);
    const id = await addConnector(app);
    await request(app).patch(`/api/v1/connectors/${id}`).set('X-Api-Key', scopedKey).send({ paused: true }).expect(403);
    await request(app).patch(`/api/v1/connectors/${id}`).set('X-Api-Key', adminKey).send({ paused: 'yes' }).expect(400);
    await request(app).patch(`/api/v1/connectors/${id}`).set('X-Api-Key', adminKey).send({}).expect(400);
    await request(app).patch('/api/v1/connectors/nope').set('X-Api-Key', adminKey).send({ paused: true }).expect(404);
    expect(readConfig(cfgPath).gateway.customConnectors[id].paused).toBeUndefined();
  });
});

describe('external pushes keep the admin\'s choices', () => {
  it('POST /:id/oauth/receive preserves paused, defaultEnabled and resourcesPath on an existing entry', async () => {
    const cfgPath = tmpConfig(['a']);
    const app = makeApp(cfgPath);
    const push = () => request(app).post('/api/v1/connectors/gmail/oauth/receive').set('X-Api-Key', adminKey).send({
      access_token: 'tok', label: 'Gmail', config: { type: 'http', url: 'https://gmail.example/mcp', headers: { Authorization: 'Bearer {access_token}' } },
    });
    expect((await push()).status).toBe(200);
    await request(app).patch('/api/v1/connectors/gmail').set('X-Api-Key', adminKey).send({ paused: true, defaultEnabled: false }).expect(200);
    await request(app).patch('/api/v1/connectors/gmail/management').set('X-Api-Key', adminKey).send({ resourcesPath: '/v1/grants' }).expect(200);
    expect((await push()).status).toBe(200);
    expect(readConfig(cfgPath).gateway.customConnectors.gmail).toMatchObject({ paused: true, defaultEnabled: false, resourcesPath: '/v1/grants' });
    expect(resolvedFor(cfgPath, 'gmail')).toEqual({ a: false });
  });
});

describe('agent scope', () => {
  it('does not write an empty connectors map onto agents it does not scope', async () => {
    const cfgPath = tmpConfig(['a', 'b']);
    const app = makeApp(cfgPath);
    const id = await addConnector(app);
    await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey)
      .send({ mode: 'selected', agents: ['a'] }).expect(200);
    expect(readConfig(cfgPath).agents).toEqual([{ id: 'a', connectors: { [id]: { enabled: true } } }, { id: 'b' }]);
  });

  it('selected → only the listed agents resolve it; all → every agent again', async () => {
    const cfgPath = tmpConfig(['a', 'b', 'c']);
    const app = makeApp(cfgPath);
    const id = await addConnector(app, { defaultEnabled: true });

    const sel = await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey)
      .send({ mode: 'selected', agents: ['a', 'b'] });
    expect(sel.status).toBe(200);
    expect(sel.body.mode).toBe('selected');
    expect(resolvedFor(cfgPath, id)).toEqual({ a: true, b: true, c: false });
    expect(readConfig(cfgPath).agents.map((a) => a.connectors?.[id])).toEqual([{ enabled: true }, { enabled: true }, undefined]);

    const all = await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey).send({ mode: 'all' });
    expect(all.body.mode).toBe('all');
    expect(resolvedFor(cfgPath, id)).toEqual({ a: true, b: true, c: true });
  });

  it('all clears explicit opt-outs, and on an opt-in gateway enables each current agent', async () => {
    const cfgPath = tmpConfig(['a', 'b'], { connectorsDefaultEnabled: false });
    const app = makeApp(cfgPath);
    const id = await addConnector(app);
    const cfg = readConfig(cfgPath);
    cfg.agents[0].connectors = { [id]: { enabled: false }, other: { enabled: true } };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    const res = await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey).send({ mode: 'all' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'all', defaultEnabled: false });
    expect(resolvedFor(cfgPath, id)).toEqual({ a: true, b: true });
    // An unrelated connector's flag is left alone.
    expect(readConfig(cfgPath).agents[0].connectors?.other).toEqual({ enabled: true });
  });

  it('GET reflects a per-agent toggle written through PATCH /v1/agents/:id shape', async () => {
    const cfgPath = tmpConfig(['a', 'b']);
    const app = makeApp(cfgPath);
    const id = await addConnector(app, { defaultEnabled: true });
    expect((await request(app).get(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey)).body.mode).toBe('all');
    const cfg = readConfig(cfgPath);
    cfg.agents[1].connectors = { [id]: { enabled: false } };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const res = await request(app).get(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey);
    expect(res.body).toMatchObject({ mode: 'selected', agents: [{ id: 'a', enabled: true }, { id: 'b', enabled: false }] });
  });

  it('GET agrees with resolveEnabledConnectors over mixed defaults and overrides', async () => {
    const flags = [undefined, true, false] as const;
    for (const gatewayDefault of [true, false]) {
      for (const entryDefault of flags) {
        const agentIds = ['a0', 'a1', 'a2'];
        const cfgPath = tmpConfig(agentIds, { connectorsDefaultEnabled: gatewayDefault });
        const cfg = readConfig(cfgPath);
        cfg.gateway.customConnectors = {
          ops: { label: 'Ops', config: HTTP_CONFIG, secretNames: ['api_key'], credentialOwner: 'static', ...(entryDefault === undefined ? {} : { defaultEnabled: entryDefault }) },
        };
        cfg.agents.forEach((a, i) => { if (flags[i] !== undefined) a.connectors = { ops: { enabled: flags[i] as boolean } }; });
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
        fs.writeFileSync(TOKEN_ENV, 'CUSTOM__ops__api_key=sk\n');
        const res = await request(makeApp(cfgPath)).get('/api/v1/connectors/ops/agents').set('X-Api-Key', adminKey);
        expect(res.status).toBe(200);
        const fromApi = Object.fromEntries(res.body.agents.map((a: { id: string; enabled: boolean }) => [a.id, a.enabled]));
        expect({ gatewayDefault, entryDefault, fromApi }).toEqual({ gatewayDefault, entryDefault, fromApi: resolvedFor(cfgPath, 'ops') });
      }
    }
  });

  it('restarts only the agents whose answer changed, handing them the new scope', async () => {
    const cfgPath = tmpConfig(['a', 'b', 'c']);
    const runners = new Map(['a', 'b', 'c'].map((id) => [id, { restartSessionsUsingConnector: jest.fn().mockResolvedValue({ restarted: false }) }]));
    const app = makeApp(cfgPath, runners);
    const id = await addConnector(app, { defaultEnabled: true });
    for (const r of runners.values()) r.restartSessionsUsingConnector.mockClear();

    await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey)
      .send({ mode: 'selected', agents: ['a'] }).expect(200);
    // Unchanged agent: the overlay only, so the shared config sees the new default.
    expect(runners.get('a')!.restartSessionsUsingConnector).toHaveBeenCalledWith(id, {
      overlay: { [id]: expect.objectContaining({ defaultEnabled: false }) },
    });
    for (const agentId of ['b', 'c']) {
      expect(runners.get(agentId)!.restartSessionsUsingConnector).toHaveBeenCalledWith(id, {
        overlay: { [id]: expect.objectContaining({ defaultEnabled: false }) },
        agentConnectors: {},
      });
    }
  });

  it('validates input, is admin-only and rejects unknown ids without writing', async () => {
    const cfgPath = tmpConfig(['a']);
    const app = makeApp(cfgPath);
    const id = await addConnector(app, { defaultEnabled: true });
    const before = fs.readFileSync(cfgPath, 'utf8');
    await request(app).get(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', scopedKey).expect(403);
    await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', scopedKey).send({ mode: 'all' }).expect(403);
    await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey).send({ mode: 'some' }).expect(400);
    await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey).send({ mode: 'selected' }).expect(400);
    await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey).send({ mode: 'all', agents: ['a'] }).expect(400);
    const unknownAgent = await request(app).put(`/api/v1/connectors/${id}/agents`).set('X-Api-Key', adminKey)
      .send({ mode: 'selected', agents: ['a', 'ghost'] });
    expect(unknownAgent.status).toBe(400);
    expect(unknownAgent.body.error).toContain('ghost');
    await request(app).get('/api/v1/connectors/nope/agents').set('X-Api-Key', adminKey).expect(404);
    await request(app).put('/api/v1/connectors/nope/agents').set('X-Api-Key', adminKey).send({ mode: 'all' }).expect(404);
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
  });
});

// The runner half of the scope route: the new per-agent map has to be adopted
// before resolving, or every session compares against the stale one and nothing
// restarts. A paused overlay must likewise resolve to nothing.
describe('AgentRunner.restartSessionsUsingConnector — scope and pause', () => {
  let base: string;
  const entry = { label: 'Docs', config: { type: 'http', url: 'https://docs.example/mcp' }, secretNames: [], credentialOwner: 'none' };

  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-runner-scope-')); });
  afterEach(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } });

  async function targetFor(opts: Record<string, unknown>) {
    const workspace = path.join(base, 'a1', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const { AgentRunner } = require('../../src/agent/runner');
    const agentConfig = { id: 'a1', description: 'a', workspace, env: '', claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] } };
    const runner = new AgentRunner(agentConfig, { gateway: { logDir: os.tmpdir(), timezone: 'UTC', customConnectors: { docs: entry } }, agents: [] });
    let seen: unknown = 'filter never ran';
    jest.spyOn(runner, 'restartOrDefer').mockImplementation((async (o: { filter?: (proc: unknown) => boolean }) => {
      o.filter?.({ connectorConfigChanged: (_id: string, server: unknown) => { seen = server; return false; } });
      return { immediate: 0, deferred: 0, skipped: 0 };
    }) as never);
    await runner.restartSessionsUsingConnector('docs', opts);
    return { seen, connectors: (runner as unknown as { agentConfig: { connectors?: unknown } }).agentConfig.connectors };
  }

  it('adopts the new per-agent map, so a de-scoped agent resolves nothing', async () => {
    expect((await targetFor({})).seen).toEqual(entry.config);
    const out = await targetFor({ agentConnectors: { docs: { enabled: false } } });
    expect(out.seen).toBeUndefined();
    expect(out.connectors).toEqual({ docs: { enabled: false } });
  });

  it('a paused overlay resolves to nothing', async () => {
    expect((await targetFor({ overlay: { docs: { ...entry, paused: true } } })).seen).toBeUndefined();
  });
});
