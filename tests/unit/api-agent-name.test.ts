/**
 * HTTP-level tests for the agent display-name surface:
 *  - GET /api/v1/agents returns `name` (null when unset).
 *  - PATCH /api/v1/agents/:id accepts `name`, persists it to config.json, and
 *    keeps the in-memory config in sync.
 *  - Empty string or null clears the name (falls back to `id` in the UI).
 *  - `id` remains immutable regardless of `name`.
 *
 * Mirrors the LINE PATCH plumbing tests in api-router-line.test.ts. Uses a
 * real temp config.json because the route persists via writeAgentsToConfig().
 */
import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../../src/api/router';
import { AgentConfig, ApiKey } from '../../src/types';

const AGENT_ID = 'alfred';
const ADMIN = { Authorization: 'Bearer sk-test-admin' };

function makeAgentConfig(): AgentConfig {
  return {
    id: AGENT_ID,
    description: 'Personal assistant',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

describe('Agent display name API', () => {
  let tmpDir: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let app: express.Express;

  const apiKeys: ApiKey[] = [{ key: 'sk-test-admin', agents: '*', admin: true }];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-name-api-'));
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { logDir: '~/logs', timezone: 'UTC' },
          agents: [makeAgentConfig()],
        },
        null,
        2,
      ),
    );
    configs = new Map([[AGENT_ID, makeAgentConfig()]]);
    const runners = new Map();
    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys, configPath));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const patch = (body: Record<string, unknown>) =>
    supertest.default(app).patch(`/api/v1/agents/${AGENT_ID}`).set(ADMIN).send(body);

  it('GET /agents returns null name when unset', async () => {
    const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
    expect(agent.name).toBeNull();
    expect(agent.id).toBe(AGENT_ID); // id unaffected
  });

  it('sets a display name via PATCH and persists it', async () => {
    const res = await patch({ name: 'Alfred the Butler' });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe('Alfred the Butler');
    expect(res.body.agent.id).toBe(AGENT_ID); // id immutable

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].name).toBe('Alfred the Butler');
    expect(onDisk.agents[0].id).toBe(AGENT_ID);
    expect(configs.get(AGENT_ID)!.name).toBe('Alfred the Butler');
  });

  it('trims whitespace on the persisted name', async () => {
    await patch({ name: '  Spacey Name  ' });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].name).toBe('Spacey Name');
    expect(configs.get(AGENT_ID)!.name).toBe('Spacey Name');
  });

  it('reflects the name on GET /agents after PATCH', async () => {
    await patch({ name: 'Alfred the Butler' });
    const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
    expect(agent.name).toBe('Alfred the Butler');
  });

  it('clears the name with an empty string, falling back to id', async () => {
    await patch({ name: 'Alfred the Butler' });
    const res = await patch({ name: '' });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBeNull();

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].name).toBeUndefined();
    expect(configs.get(AGENT_ID)!.name).toBeNull();
  });

  it('clears the name with null', async () => {
    await patch({ name: 'Alfred the Butler' });
    const res = await patch({ name: null });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBeNull();

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].name).toBeUndefined();
    expect(configs.get(AGENT_ID)!.name).toBeNull();
  });

  it('rejects a non-string, non-null name with 400', async () => {
    const res = await patch({ name: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name must be a string or null/i);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].name).toBeUndefined(); // nothing written
  });

  it('leaves name untouched when the PATCH omits it', async () => {
    await patch({ name: 'Alfred the Butler' });
    const res = await patch({ description: 'updated desc' });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe('Alfred the Butler');

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].name).toBe('Alfred the Butler');
  });

  it('does not allow name to affect the immutable id', async () => {
    const res = await patch({ name: 'Totally Different' });
    expect(res.status).toBe(200);
    expect(res.body.agent.id).toBe(AGENT_ID);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].id).toBe(AGENT_ID);
  });
});
