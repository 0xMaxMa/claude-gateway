/**
 * HTTP-level tests for the LINE channel management surface on the agents API:
 *  - PATCH /api/v1/agents/:id accepts line_channel_access_token + line_channel_secret
 *    (both-or-neither), writes AgentConfig.line to config.json, and keeps the
 *    in-memory config in sync.
 *  - GET  /api/v1/agents exposes line_connected / line_token_preview / line_webhook_path.
 *
 * Mirrors the telegram/discord PATCH plumbing in src/api/router.ts. Uses a real
 * temp config.json because the route persists via writeAgentsToConfig().
 */
import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../../src/api/router';
import {
  recordDeniedSender,
  recordDeniedConversation,
  getPendingSenders,
  _resetPendingSenders,
} from '../../src/api/line-pending-senders';
import { AgentConfig, ApiKey } from '../../src/types';

const AGENT_ID = 'alfred';
const ADMIN = { Authorization: 'Bearer sk-test-admin' };
const USER = { Authorization: 'Bearer sk-test-user' };
const VALID_AT = 'line-channel-access-token-1234567890';
const VALID_SECRET = 'line-channel-secret-abcdef';

function makeAgentConfig(): AgentConfig {
  return {
    id: AGENT_ID,
    description: 'Personal assistant',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

describe('LINE channel management API', () => {
  let tmpDir: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let app: express.Express;

  const apiKeys: ApiKey[] = [
    { key: 'sk-test-admin', agents: '*', admin: true },
    { key: 'sk-test-user', agents: '*' },
  ];

  beforeEach(() => {
    _resetPendingSenders();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-line-api-'));
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
    // No runners — LINE is webhook-based; PATCH only does updateAgentConfig() if a
    // runner exists, and the route must work without one.
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

  it('connects LINE when both credentials are provided', async () => {
    const res = await patch({
      line_channel_access_token: VALID_AT,
      line_channel_secret: VALID_SECRET,
    });
    expect(res.status).toBe(200);
    expect(res.body.agent.line_connected).toBe(true);
    expect(res.body.agent.line_webhook_path).toBe(`/webhooks/line/${AGENT_ID}`);
    expect(res.body.agent.line_token_preview).toBeTruthy();
    expect(res.body.agent.line_token_preview).not.toContain(VALID_AT); // masked

    // persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].line).toEqual({
      channelAccessToken: VALID_AT,
      channelSecret: VALID_SECRET,
    });
    // in-memory map synced
    expect(configs.get(AGENT_ID)!.line).toEqual({
      channelAccessToken: VALID_AT,
      channelSecret: VALID_SECRET,
    });
  });

  it('rejects a half-set (one credential without the other) with 400', async () => {
    const res = await patch({ line_channel_access_token: VALID_AT });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/together/i);
    // nothing written
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].line).toBeUndefined();
  });

  it('rejects non-string credential with 400', async () => {
    const res = await patch({ line_channel_access_token: 123, line_channel_secret: VALID_SECRET });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/line_channel_access_token must be a string/i);
  });

  it('disconnects LINE when both credentials are cleared', async () => {
    await patch({ line_channel_access_token: VALID_AT, line_channel_secret: VALID_SECRET });
    const res = await patch({ line_channel_access_token: '', line_channel_secret: '' });
    expect(res.status).toBe(200);
    expect(res.body.agent.line_connected).toBe(false);
    expect(res.body.agent.line_webhook_path).toBeNull();

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].line).toBeUndefined();
    expect(configs.get(AGENT_ID)!.line).toBeUndefined();
  });

  it('GET /agents reflects LINE connection status', async () => {
    await patch({ line_channel_access_token: VALID_AT, line_channel_secret: VALID_SECRET });
    const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
    expect(agent.line_connected).toBe(true);
    expect(agent.line_webhook_path).toBe(`/webhooks/line/${AGENT_ID}`);
    expect(agent.line_token_preview).toBeTruthy();
  });

  it('leaves LINE untouched when the PATCH omits LINE fields', async () => {
    await patch({ line_channel_access_token: VALID_AT, line_channel_secret: VALID_SECRET });
    const res = await patch({ description: 'updated desc' });
    expect(res.status).toBe(200);
    expect(res.body.agent.line_connected).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].line.channelSecret).toBe(VALID_SECRET);
  });

  describe('DM access control (Tier 1: dmPolicy + dmAllowlist)', () => {
    const connect = () =>
      patch({ line_channel_access_token: VALID_AT, line_channel_secret: VALID_SECRET });

    it('sets dmPolicy + dmAllowlist without resending credentials', async () => {
      await connect();
      const res = await patch({
        line_dm_policy: 'allowlist',
        line_dm_allowlist: ['Uabc', 'Udef'],
      });
      expect(res.status).toBe(200);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].line).toEqual({
        channelAccessToken: VALID_AT,
        channelSecret: VALID_SECRET,
        dmPolicy: 'allowlist',
        dmAllowlist: ['Uabc', 'Udef'],
      });
      // in-memory synced (webhook router reads this live)
      expect(configs.get(AGENT_ID)!.line!.dmPolicy).toBe('allowlist');
      expect(configs.get(AGENT_ID)!.line!.dmAllowlist).toEqual(['Uabc', 'Udef']);
    });

    it('exposes line_dm_policy + line_dm_allowlist on GET /agents', async () => {
      await connect();
      await patch({ line_dm_policy: 'allowlist', line_dm_allowlist: ['Uabc'] });
      const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.line_dm_policy).toBe('allowlist');
      expect(agent.line_dm_allowlist).toEqual(['Uabc']);
    });

    it('returns null policy + empty allowlist when unset (closed default)', async () => {
      await connect();
      const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.line_dm_policy).toBeNull();
      expect(agent.line_dm_allowlist).toEqual([]);
    });

    it('clears fields when passed null', async () => {
      await connect();
      await patch({ line_dm_policy: 'open', line_dm_allowlist: ['Uabc'] });
      const res = await patch({ line_dm_policy: null, line_dm_allowlist: null });
      expect(res.status).toBe(200);
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].line.dmPolicy).toBeUndefined();
      expect(onDisk.agents[0].line.dmAllowlist).toBeUndefined();
      // credentials survive the clear
      expect(onDisk.agents[0].line.channelSecret).toBe(VALID_SECRET);
    });

    it('rejects an invalid policy value with 400', async () => {
      await connect();
      const res = await patch({ line_dm_policy: 'pairing' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/line_dm_policy/i);
    });

    it('rejects a non-string allowlist entry with 400', async () => {
      await connect();
      const res = await patch({ line_dm_allowlist: ['Uok', 123] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/line_dm_allowlist/i);
    });

    it('ignores access fields when no LINE channel exists', async () => {
      const res = await patch({ line_dm_policy: 'allowlist', line_dm_allowlist: ['Uabc'] });
      expect(res.status).toBe(200);
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].line).toBeUndefined();
    });

    it('sets credentials and access policy together in one PATCH', async () => {
      const res = await patch({
        line_channel_access_token: VALID_AT,
        line_channel_secret: VALID_SECRET,
        line_dm_policy: 'allowlist',
        line_dm_allowlist: ['Uabc'],
      });
      expect(res.status).toBe(200);
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].line).toEqual({
        channelAccessToken: VALID_AT,
        channelSecret: VALID_SECRET,
        dmPolicy: 'allowlist',
        dmAllowlist: ['Uabc'],
      });
    });

    it('drops a user from the knock list when added to the allowlist', async () => {
      await connect();
      recordDeniedSender(AGENT_ID, 'Uknocker', 'Knocker', 1000);
      recordDeniedSender(AGENT_ID, 'Uother', 'Other', 1000);
      const res = await patch({ line_dm_policy: 'allowlist', line_dm_allowlist: ['Uknocker'] });
      expect(res.status).toBe(200);
      // Uknocker is now allowed → gone from the knock list; Uother stays.
      expect(getPendingSenders(AGENT_ID).map((s) => s.userId)).toEqual(['Uother']);
    });
  });

  describe('GET /agents/:id/line/pending', () => {
    const url = `/api/v1/agents/${AGENT_ID}/line/pending`;

    it('returns recorded denied senders to an admin (most-recent first)', async () => {
      recordDeniedSender(AGENT_ID, 'Ualice', 'Alice', 1000);
      recordDeniedSender(AGENT_ID, 'Ubob', 'Bob', 2000);
      const res = await supertest.default(app).get(url).set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.senders.map((s: { userId: string }) => s.userId)).toEqual(['Ubob', 'Ualice']);
      expect(res.body.senders[0]).toMatchObject({ userId: 'Ubob', displayName: 'Bob', count: 1 });
    });

    it('rejects a non-admin key with 403', async () => {
      const res = await supertest.default(app).get(url).set(USER);
      expect(res.status).toBe(403);
    });

    it('returns 404 for an unknown agent', async () => {
      const res = await supertest.default(app)
        .get('/api/v1/agents/ghost/line/pending')
        .set(ADMIN);
      expect(res.status).toBe(404);
    });

    it('is empty when nothing has been denied', async () => {
      const res = await supertest.default(app).get(url).set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.senders).toEqual([]);
    });

    it('exposes the pairing code on each sender (pairing mode)', async () => {
      recordDeniedSender(AGENT_ID, 'Ualice', 'Alice', 1000, 'ABC123');
      const res = await supertest.default(app).get(url).set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.senders[0]).toMatchObject({ userId: 'Ualice', code: 'ABC123' });
    });

    it('DELETE removes one sender from the knock list (admin)', async () => {
      recordDeniedSender(AGENT_ID, 'Ualice', 'Alice', 1000);
      recordDeniedConversation(AGENT_ID, 'Cteam', 'group', 'Team', 1000);
      const res = await supertest.default(app)
        .delete(`${url}/Ualice`)
        .set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(getPendingSenders(AGENT_ID).map((s) => s.userId)).toEqual(['Cteam']);
    });

    it('DELETE is idempotent for an unknown id', async () => {
      const res = await supertest.default(app).delete(`${url}/Unobody`).set(ADMIN);
      expect(res.status).toBe(200);
    });

    it('DELETE rejects a non-admin key with 403', async () => {
      recordDeniedSender(AGENT_ID, 'Ualice', 'Alice', 1000);
      const res = await supertest.default(app).delete(`${url}/Ualice`).set(USER);
      expect(res.status).toBe(403);
      expect(getPendingSenders(AGENT_ID)).toHaveLength(1); // untouched
    });

    it('DELETE returns 404 for an unknown agent', async () => {
      const res = await supertest.default(app)
        .delete('/api/v1/agents/ghost/line/pending/Ualice')
        .set(ADMIN);
      expect(res.status).toBe(404);
    });
  });

  describe('pairing toggle (line_pairing)', () => {
    const connect = () =>
      patch({ line_channel_access_token: VALID_AT, line_channel_secret: VALID_SECRET });

    it('accepts line_pairing true/false and persists it', async () => {
      await connect();
      const off = await patch({ line_pairing: false });
      expect(off.status).toBe(200);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).agents[0].line.pairing).toBe(false);
      expect(configs.get(AGENT_ID)!.line!.pairing).toBe(false);

      const on = await patch({ line_pairing: true });
      expect(on.status).toBe(200);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).agents[0].line.pairing).toBe(true);
    });

    it('exposes line_pairing on GET /agents, defaulting to true when unset', async () => {
      await connect();
      const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.line_pairing).toBe(true);

      await patch({ line_pairing: false });
      const res2 = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
      const agent2 = res2.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent2.line_pairing).toBe(false);
    });

    it('clears line_pairing back to default when set to null', async () => {
      await connect();
      await patch({ line_pairing: false });
      const res = await patch({ line_pairing: null });
      expect(res.status).toBe(200);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).agents[0].line.pairing).toBeUndefined();
    });

    it('rejects a non-boolean line_pairing with 400', async () => {
      await connect();
      const res = await patch({ line_pairing: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/line_pairing/i);
    });
  });

  describe('Group/room access control (Tier 3: groupPolicy + groupAllowlist + requireMention)', () => {
    const connect = () =>
      patch({ line_channel_access_token: VALID_AT, line_channel_secret: VALID_SECRET });

    it('sets group policy/allowlist + requireMention without resending credentials', async () => {
      await connect();
      const res = await patch({
        line_group_policy: 'allowlist',
        line_group_allowlist: ['Cf3a9', 'Re8f1'],
        line_require_mention: true,
      });
      expect(res.status).toBe(200);
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].line).toMatchObject({
        groupPolicy: 'allowlist',
        groupAllowlist: ['Cf3a9', 'Re8f1'],
        requireMention: true,
      });
      expect(configs.get(AGENT_ID)!.line!.groupPolicy).toBe('allowlist');
      expect(configs.get(AGENT_ID)!.line!.requireMention).toBe(true);
    });

    it('exposes line_group_* + line_require_mention on GET /agents', async () => {
      await connect();
      await patch({ line_group_policy: 'open', line_group_allowlist: ['Cf3a9'], line_require_mention: false });
      const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.line_group_policy).toBe('open');
      expect(agent.line_group_allowlist).toEqual(['Cf3a9']);
      expect(agent.line_require_mention).toBe(false);
    });

    it('returns null group policy + empty allowlist when unset', async () => {
      await connect();
      const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.line_group_policy).toBeNull();
      expect(agent.line_group_allowlist).toEqual([]);
      expect(agent.line_require_mention).toBeNull();
    });

    it('rejects an invalid group policy + a non-boolean requireMention', async () => {
      await connect();
      expect((await patch({ line_group_policy: 'nope' })).status).toBe(400);
      expect((await patch({ line_require_mention: 'yes' })).status).toBe(400);
      expect((await patch({ line_group_allowlist: ['Cok', 5] })).status).toBe(400);
    });

    it('drops a group from the knock list when added to the group allowlist', async () => {
      await connect();
      recordDeniedConversation(AGENT_ID, 'Cf3a9', 'group', 'Team', 1000);
      recordDeniedConversation(AGENT_ID, 'Cother', 'group', 'Other', 1000);
      const res = await patch({ line_group_policy: 'allowlist', line_group_allowlist: ['Cf3a9'] });
      expect(res.status).toBe(200);
      expect(getPendingSenders(AGENT_ID).map((s) => s.userId)).toEqual(['Cother']);
    });
  });
});
