/**
 * HTTP-level tests for the `allow_tools` default on agent creation:
 *  - POST /api/v1/agents with no `allow_tools` defaults the new agent to
 *    `allow_tools: true`, both persisted to config.json and reflected in the
 *    in-memory config immediately (no file-watcher round-trip / restart).
 *  - An explicit `allow_tools: false` in the body is respected, not overridden.
 *  - A non-boolean `allow_tools` is rejected with 400.
 *  - Pre-existing agents are untouched (no migration of their config entry).
 *
 * Regression coverage for the bug where POST /v1/agents never set `allow_tools`,
 * so every downstream read fell back to a falsy default and brand-new agents
 * were tool-disabled until an explicit PATCH. Mirrors the real-router + temp
 * config.json setup in api-agent-name.test.ts.
 */
import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../../src/api/router';
import { AgentConfig, ApiKey } from '../../src/types';

const EXISTING_ID = 'alfred';
const ADMIN = { Authorization: 'Bearer sk-test-admin' };

function makeExistingAgent(): AgentConfig {
  return {
    id: EXISTING_ID,
    description: 'Personal assistant',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

describe('POST /api/v1/agents — allow_tools default', () => {
  let tmpDir: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let app: express.Express;
  // Track workspace dirs the handler creates under $HOME so we can clean them up.
  const createdAgentIds: string[] = [];

  const apiKeys: ApiKey[] = [{ key: 'sk-test-admin', agents: '*', admin: true }];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-allowtools-api-'));
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { logDir: '~/logs', timezone: 'UTC' },
          agents: [makeExistingAgent()],
        },
        null,
        2,
      ),
    );
    configs = new Map([[EXISTING_ID, makeExistingAgent()]]);
    const runners = new Map();
    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys, configPath));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // The create handler writes a workspace under ~/.claude-gateway/agents/<id>.
    for (const id of createdAgentIds) {
      fs.rmSync(path.join(os.homedir(), '.claude-gateway', 'agents', id), {
        recursive: true,
        force: true,
      });
    }
    createdAgentIds.length = 0;
  });

  const create = (body: Record<string, unknown>) => {
    if (typeof body.id === 'string') createdAgentIds.push(body.id);
    return supertest.default(app).post('/api/v1/agents').set(ADMIN).send(body);
  };

  const readDisk = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

  it('defaults allow_tools to true in config.json when omitted', async () => {
    const res = await create({ id: 'toolbot', description: 'A new bot' });
    expect(res.status).toBe(201);
    expect(res.body.agent.allow_tools).toBe(true);

    const onDisk = readDisk();
    const entry = onDisk.agents.find((a: { id: string }) => a.id === 'toolbot');
    expect(entry).toBeDefined();
    expect(entry.allow_tools).toBe(true);
  });

  it('reflects allow_tools: true on GET /agents immediately (no restart)', async () => {
    await create({ id: 'toolbot', description: 'A new bot' });
    const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a: { id: string }) => a.id === 'toolbot');
    expect(agent).toBeDefined();
    expect(agent.allow_tools).toBe(true);
    // In-memory config map is updated synchronously, not via the file watcher.
    expect(configs.get('toolbot')!.allow_tools).toBe(true);
  });

  it('respects an explicit allow_tools: false and does not override it', async () => {
    const res = await create({ id: 'chatbot', description: 'Conversational only', allow_tools: false });
    expect(res.status).toBe(201);
    expect(res.body.agent.allow_tools).toBe(false);

    const onDisk = readDisk();
    const entry = onDisk.agents.find((a: { id: string }) => a.id === 'chatbot');
    expect(entry.allow_tools).toBe(false);
    expect(configs.get('chatbot')!.allow_tools).toBe(false);

    const get = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    const agent = get.body.agents.find((a: { id: string }) => a.id === 'chatbot');
    expect(agent.allow_tools).toBe(false);
  });

  it('honors an explicit allow_tools: true', async () => {
    const res = await create({ id: 'toolbot2', description: 'Explicit true', allow_tools: true });
    expect(res.status).toBe(201);
    expect(res.body.agent.allow_tools).toBe(true);
    expect(readDisk().agents.find((a: { id: string }) => a.id === 'toolbot2').allow_tools).toBe(true);
  });

  it('rejects a non-boolean allow_tools with 400', async () => {
    const res = await create({ id: 'badbot', description: 'Invalid flag', allow_tools: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allow_tools must be a boolean/i);
    // Nothing persisted on validation failure.
    const onDisk = readDisk();
    expect(onDisk.agents.find((a: { id: string }) => a.id === 'badbot')).toBeUndefined();
  });

  it('leaves pre-existing agents untouched (no migration)', async () => {
    await create({ id: 'toolbot', description: 'A new bot' });
    const onDisk = readDisk();
    const existing = onDisk.agents.find((a: { id: string }) => a.id === EXISTING_ID);
    // The pre-existing agent had no allow_tools field; it must stay absent.
    expect(existing).toBeDefined();
    expect(existing.allow_tools).toBeUndefined();
  });
});
