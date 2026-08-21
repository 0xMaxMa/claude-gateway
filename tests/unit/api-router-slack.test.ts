/**
 * HTTP-level tests for the Slack channel management surface on the agents API:
 *  - PATCH /api/v1/agents/:id accepts slack_bot_token + slack_signing_secret
 *    (both-or-neither), verifies the bot token via auth.test before persisting
 *    (the Save-time check documented on slack-client.ts's authTest()), writes
 *    AgentConfig.slack to config.json, and keeps the in-memory config in sync.
 *  - GET  /api/v1/agents exposes slack_connected / slack_token_preview / slack_webhook_path.
 *
 * Mirrors tests/unit/api-router-line.test.ts's structure. Uses a real temp
 * config.json because the route persists via writeAgentsToConfig().
 */
import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../../src/api/router';
import { _resetPendingSenders } from '../../src/api/pending-senders';
import { AgentConfig, ApiKey } from '../../src/types';

const AGENT_ID = 'alfred';
const ADMIN = { Authorization: 'Bearer sk-test-admin' };
const VALID_TOKEN = 'xoxb-slack-bot-token-1234567890';
const VALID_SECRET = 'slack-signing-secret-abcdef';

function makeAgentConfig(): AgentConfig {
  return {
    id: AGENT_ID,
    description: 'Personal assistant',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

describe('Slack channel management API', () => {
  let tmpDir: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let app: express.Express;
  const realFetch = global.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  const apiKeys: ApiKey[] = [{ key: 'sk-test-admin', agents: '*', admin: true }];

  beforeEach(() => {
    _resetPendingSenders();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-slack-api-'));
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        { gateway: { logDir: '~/logs', timezone: 'UTC' }, agents: [makeAgentConfig()] },
        null,
        2,
      ),
    );
    configs = new Map([[AGENT_ID, makeAgentConfig()]]);
    const runners = new Map();
    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys, configPath));

    fetchCalls = [];
    // Default: every auth.test call succeeds. Individual tests override this.
    global.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ ok: true, team: 'Test Workspace' }),
      } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const patch = (body: Record<string, unknown>) =>
    supertest.default(app).patch(`/api/v1/agents/${AGENT_ID}`).set(ADMIN).send(body);

  it('connects Slack when both credentials are provided and auth.test succeeds', async () => {
    const res = await patch({ slack_bot_token: VALID_TOKEN, slack_signing_secret: VALID_SECRET });
    expect(res.status).toBe(200);
    expect(res.body.agent.slack_connected).toBe(true);
    expect(res.body.agent.slack_webhook_path).toBe(`/webhooks/slack/${AGENT_ID}`);
    expect(res.body.agent.slack_token_preview).toBeTruthy();
    expect(res.body.agent.slack_token_preview).not.toContain(VALID_TOKEN); // masked

    // auth.test was actually called, against the new token
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('https://slack.com/api/auth.test');
    expect(String(fetchCalls[0]!.init?.headers && (fetchCalls[0]!.init!.headers as Record<string, string>)['Authorization'])).toBe(
      `Bearer ${VALID_TOKEN}`,
    );

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].slack).toEqual({ botToken: VALID_TOKEN, signingSecret: VALID_SECRET });
    expect(configs.get(AGENT_ID)!.slack).toEqual({ botToken: VALID_TOKEN, signingSecret: VALID_SECRET });
  });

  it('rejects an invalid token with 400 and persists nothing', async () => {
    global.fetch = (async (url: string) => {
      fetchCalls.push({ url });
      return { ok: true, json: async () => ({ ok: false, error: 'invalid_auth' }) } as Response;
    }) as typeof fetch;

    const res = await patch({ slack_bot_token: VALID_TOKEN, slack_signing_secret: VALID_SECRET });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid slack bot token/i);
    expect(res.body.error).toMatch(/invalid_auth/);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].slack).toBeUndefined();
    expect(configs.get(AGENT_ID)!.slack).toBeUndefined();
  });

  it('rejects with 400 when the auth.test network call itself fails', async () => {
    global.fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND slack.com');
    }) as typeof fetch;

    const res = await patch({ slack_bot_token: VALID_TOKEN, slack_signing_secret: VALID_SECRET });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid slack bot token/i);
    expect(res.body.error).toMatch(/ENOTFOUND/);
  });

  it('rejects a half-set (one credential without the other) with 400 — no auth.test call', async () => {
    const res = await patch({ slack_bot_token: VALID_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/together/i);
    expect(fetchCalls).toHaveLength(0);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].slack).toBeUndefined();
  });

  it('rejects non-string credential with 400', async () => {
    const res = await patch({ slack_bot_token: 123, slack_signing_secret: VALID_SECRET });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/slack_bot_token must be a string/i);
  });

  it('disconnects Slack when both credentials are cleared — no auth.test call', async () => {
    await patch({ slack_bot_token: VALID_TOKEN, slack_signing_secret: VALID_SECRET });
    fetchCalls = [];
    const res = await patch({ slack_bot_token: '', slack_signing_secret: '' });
    expect(res.status).toBe(200);
    expect(res.body.agent.slack_connected).toBe(false);
    expect(res.body.agent.slack_webhook_path).toBeNull();
    expect(fetchCalls).toHaveLength(0);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].slack).toBeUndefined();
    expect(configs.get(AGENT_ID)!.slack).toBeUndefined();
  });

  it('GET /agents reflects Slack connection status', async () => {
    await patch({ slack_bot_token: VALID_TOKEN, slack_signing_secret: VALID_SECRET });
    const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
    expect(agent.slack_connected).toBe(true);
    expect(agent.slack_webhook_path).toBe(`/webhooks/slack/${AGENT_ID}`);
  });
});
