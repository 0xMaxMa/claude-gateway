/**
 * HTTP-level tests for the Telegram/Discord group-pairing surface added to the
 * agents API (mirror of LINE's group tier):
 *  - GET  /agents exposes *_group_policy / *_group_allowlist / *_require_mention
 *  - GET  /telegram|discord/pending carries `kind`
 *  - POST /telegram|discord/approve is kind-aware (group knock → allowlist, no handshake)
 *  - PATCH /telegram|discord/policy accepts groupPolicy + requireMention
 *  - DELETE group/guild allow validates ids (telegram allows leading minus)
 *
 * Writes a real access.json into the agent's state dir because the routes
 * persist through readTelegramAccess/readDiscordAccess.
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

describe('Telegram/Discord group-pairing API', () => {
  let tmpDir: string;
  let workspace: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let app: express.Express;

  const apiKeys: ApiKey[] = [
    { key: 'sk-test-admin', agents: '*', admin: true },
  ];

  function makeAgentConfig(): AgentConfig {
    return {
      id: AGENT_ID,
      description: 'Personal assistant',
      workspace,
      env: '',
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
      telegram: { botToken: 'tg-token-123' },
      discord: { botToken: 'dc-token-123' },
    } as AgentConfig;
  }

  function writeTelegramAccess(obj: unknown): void {
    const dir = path.join(workspace, '.telegram-state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify(obj));
  }
  function writeDiscordAccess(obj: unknown): void {
    const dir = path.join(workspace, '.discord-state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify(obj));
  }
  function readTelegramAccessRaw(): any {
    return JSON.parse(fs.readFileSync(path.join(workspace, '.telegram-state', 'access.json'), 'utf8'));
  }
  function readDiscordAccessRaw(): any {
    return JSON.parse(fs.readFileSync(path.join(workspace, '.discord-state', 'access.json'), 'utf8'));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-group-api-'));
    workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { logDir: '~/logs', timezone: 'UTC' }, agents: [makeAgentConfig()] }, null, 2));
    configs = new Map([[AGENT_ID, makeAgentConfig()]]);
    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(new Map(), configs, apiKeys, configPath));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const req = () => supertest.default(app);
  const future = Date.now() + 3600_000;

  describe('Telegram', () => {
    it('GET /agents exposes group tier fields', async () => {
      writeTelegramAccess({ dmPolicy: 'allowlist', pairing: true, groupPolicy: 'allowlist', groupAllowlist: ['-100123'], requireMention: true, pending: {} });
      const res = await req().get('/api/v1/agents').set(ADMIN);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.telegram_group_policy).toBe('allowlist');
      expect(agent.telegram_group_allowlist).toEqual(['-100123']);
      expect(agent.telegram_require_mention).toBe(true);
    });

    it('GET /pending carries kind for group knocks', async () => {
      writeTelegramAccess({ pending: { g1: { senderId: '5', chatId: '-100999', createdAt: 1, expiresAt: future, replies: 1, kind: 'group' } } });
      const res = await req().get(`/api/v1/agents/${AGENT_ID}/telegram/pending`).set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.pending[0].kind).toBe('group');
      expect(res.body.pending[0].chatId).toBe('-100999');
    });

    it('POST /approve on a group knock moves chatId into groupAllowlist (no approved/ file)', async () => {
      writeTelegramAccess({ groupPolicy: 'allowlist', groupAllowlist: [], pending: { g1: { senderId: '5', chatId: '-100999', createdAt: 1, expiresAt: future, replies: 1, kind: 'group' } } });
      const res = await req().post(`/api/v1/agents/${AGENT_ID}/telegram/approve`).set(ADMIN).send({ code: 'g1' });
      expect(res.status).toBe(200);
      expect(res.body.groupId).toBe('-100999');
      const after = readTelegramAccessRaw();
      expect(after.groupAllowlist).toContain('-100999');
      expect(after.pending.g1).toBeUndefined();
      expect(after.allowFrom ?? []).not.toContain('5');
      expect(fs.existsSync(path.join(workspace, '.telegram-state', 'approved', '5'))).toBe(false);
    });

    it('PATCH /policy accepts groupPolicy + requireMention', async () => {
      writeTelegramAccess({ dmPolicy: 'allowlist', pairing: true, groupPolicy: 'allowlist', groupAllowlist: [], requireMention: true, pending: {} });
      const res = await req().patch(`/api/v1/agents/${AGENT_ID}/telegram/policy`).set(ADMIN).send({ groupPolicy: 'disabled', requireMention: false });
      expect(res.status).toBe(200);
      expect(res.body.groupPolicy).toBe('disabled');
      expect(res.body.requireMention).toBe(false);
      const after = readTelegramAccessRaw();
      expect(after.groupPolicy).toBe('disabled');
      expect(after.requireMention).toBe(false);
    });

    it('DELETE group/allow removes a negative group id', async () => {
      writeTelegramAccess({ groupPolicy: 'allowlist', groupAllowlist: ['-100123', '-100456'], pending: {} });
      const res = await req().delete(`/api/v1/agents/${AGENT_ID}/telegram/group/allow/-100123`).set(ADMIN);
      expect(res.status).toBe(200);
      expect(readTelegramAccessRaw().groupAllowlist).toEqual(['-100456']);
    });

    it('DELETE group/allow rejects a non-numeric id', async () => {
      const res = await req().delete(`/api/v1/agents/${AGENT_ID}/telegram/group/allow/abc`).set(ADMIN);
      expect(res.status).toBe(400);
    });

    it('legacyGroupAllowFrom survives an unrelated read-mutate-write round trip (migration regression guard)', async () => {
      // Raw legacy file — never went through the current migration. An
      // unrelated admin action (policy PATCH) must not silently strip the
      // per-group restriction before gateLogic() ever gets to enforce it.
      writeTelegramAccess({
        dmPolicy: 'allowlist',
        groups: { '-100456': { requireMention: false, allowFrom: ['9'] } },
        pending: {},
      });
      const res = await req()
        .patch(`/api/v1/agents/${AGENT_ID}/telegram/policy`)
        .set(ADMIN)
        .send({ requireMention: true });
      expect(res.status).toBe(200);
      const after = readTelegramAccessRaw();
      expect(after.groupAllowlist).toContain('-100456');
      expect(after.legacyGroupAllowFrom).toEqual({ '-100456': ['9'] });
    });

    it('DELETE group/allow also clears the legacy restriction for that group', async () => {
      writeTelegramAccess({
        groupPolicy: 'allowlist',
        groupAllowlist: ['-100456'],
        legacyGroupAllowFrom: { '-100456': ['9'] },
        pending: {},
      });
      const res = await req().delete(`/api/v1/agents/${AGENT_ID}/telegram/group/allow/-100456`).set(ADMIN);
      expect(res.status).toBe(200);
      const after = readTelegramAccessRaw();
      expect(after.groupAllowlist).toEqual([]);
      expect(after.legacyGroupAllowFrom?.['-100456']).toBeUndefined();
    });
  });

  describe('Discord', () => {
    it('GET /agents exposes guild tier fields', async () => {
      writeDiscordAccess({ dmPolicy: 'allowlist', pairing: true, groupPolicy: 'allowlist', requireMention: true, guildAllowlist: ['777'], channelAllowlist: [], roleAllowlist: [], pending: {} });
      const res = await req().get('/api/v1/agents').set(ADMIN);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.discord_group_policy).toBe('allowlist');
      expect(agent.discord_guild_allowlist).toEqual(['777']);
      expect(agent.discord_require_mention).toBe(true);
    });

    it('POST /approve on a guild knock moves guildId into guildAllowlist', async () => {
      writeDiscordAccess({ groupPolicy: 'allowlist', guildAllowlist: [], channelAllowlist: [], roleAllowlist: [], pending: { g1: { senderId: '5', channelId: 'c1', guildId: '777', createdAt: 1, expiresAt: future, replies: 1, kind: 'guild' } } });
      const res = await req().post(`/api/v1/agents/${AGENT_ID}/discord/approve`).set(ADMIN).send({ code: 'g1' });
      expect(res.status).toBe(200);
      expect(res.body.guildId).toBe('777');
      const after = readDiscordAccessRaw();
      expect(after.guildAllowlist).toContain('777');
      expect(after.pending.g1).toBeUndefined();
      expect(fs.existsSync(path.join(workspace, '.discord-state', 'approved', '5'))).toBe(false);
    });

    it('PATCH /policy accepts groupPolicy + requireMention', async () => {
      writeDiscordAccess({ dmPolicy: 'allowlist', pairing: true, groupPolicy: 'open', requireMention: false, guildAllowlist: [], channelAllowlist: [], roleAllowlist: [], pending: {} });
      const res = await req().patch(`/api/v1/agents/${AGENT_ID}/discord/policy`).set(ADMIN).send({ groupPolicy: 'allowlist', requireMention: true });
      expect(res.status).toBe(200);
      expect(res.body.groupPolicy).toBe('allowlist');
      expect(res.body.requireMention).toBe(true);
    });

    it('DELETE guild/allow rejects a leading-minus id (guild ids are positive snowflakes)', async () => {
      const res = await req().delete(`/api/v1/agents/${AGENT_ID}/discord/guild/allow/-777`).set(ADMIN);
      expect(res.status).toBe(400);
    });

    it('DELETE guild/allow removes a numeric guild id', async () => {
      writeDiscordAccess({ groupPolicy: 'allowlist', guildAllowlist: ['777', '888'], channelAllowlist: [], roleAllowlist: [], pending: {} });
      const res = await req().delete(`/api/v1/agents/${AGENT_ID}/discord/guild/allow/777`).set(ADMIN);
      expect(res.status).toBe(200);
      expect(readDiscordAccessRaw().guildAllowlist).toEqual(['888']);
    });
  });
});
