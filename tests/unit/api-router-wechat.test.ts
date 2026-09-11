/**
 * HTTP-level tests for the WeChat channel management surface on the agents API:
 *  - GET/POST/DELETE /api/v1/agents/:id/wechat/{status,link,unlink,send}
 *  - GET/DELETE /api/v1/agents/:id/wechat/pending(/:senderId)
 *  - PATCH /api/v1/agents/:id accepts wechat_dm_policy/wechat_dm_allowlist/wechat_pairing
 *  - GET /api/v1/agents exposes wechat_connected/wechat_dm_policy/wechat_dm_allowlist/wechat_pairing
 *
 * Unlike LINE/Slack (config-driven credentials), WeChat's "connected" state is
 * LIVE manager state — so link/unlink/status/send route through a fake
 * AgentRunner (mirrors tests/unit/line-file-download.test.ts's `fakeRunner`
 * pattern: a plain object with just the methods the router calls, cast `as
 * unknown as AgentRunner`), not through config.json.
 */
import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../../src/api/router';
import { _resetPendingSenders, recordDeniedSender } from '../../src/api/pending-senders';
import { AgentConfig, ApiKey } from '../../src/types';
import type { AgentRunner } from '../../src/agent/runner';
import type { WeChatStatus } from '../../src/wechat/manager';

const AGENT_ID = 'alfred';
const ADMIN = { Authorization: 'Bearer sk-test-admin' };
const WRITE_ONLY = { Authorization: 'Bearer sk-test-write' };

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: AGENT_ID,
    description: 'Personal assistant',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', extraFlags: [] },
    ...overrides,
  };
}

function fakeRunner(overrides: Partial<Record<string, jest.Mock>> = {}): {
  runner: AgentRunner;
  mocks: {
    getWeChatStatus: jest.Mock;
    startWeChatLinking: jest.Mock;
    unlinkWeChat: jest.Mock;
    sendWeChatMessage: jest.Mock;
    updateAgentConfig: jest.Mock;
  };
} {
  const mocks = {
    getWeChatStatus: jest.fn<WeChatStatus, []>(() => ({ status: 'unlinked', loggedOut: false })),
    startWeChatLinking: jest.fn().mockResolvedValue(undefined),
    unlinkWeChat: jest.fn().mockResolvedValue(undefined),
    sendWeChatMessage: jest.fn().mockResolvedValue(undefined),
    updateAgentConfig: jest.fn(),
    ...overrides,
  };
  return { runner: mocks as unknown as AgentRunner, mocks };
}

describe('WeChat channel management API', () => {
  let tmpDir: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let runners: Map<string, AgentRunner>;
  let app: express.Express;

  const apiKeys: ApiKey[] = [
    { key: 'sk-test-admin', agents: '*', admin: true },
    { key: 'sk-test-write', agents: [AGENT_ID], write: true },
  ];

  beforeEach(() => {
    _resetPendingSenders();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-wechat-api-'));
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
    runners = new Map();
    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys, configPath));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /wechat/status', () => {
    it('returns the live manager status', async () => {
      const { runner } = fakeRunner({
        getWeChatStatus: jest.fn(() => ({ status: 'pending_scan', qr: 'data:...', loggedOut: false })),
      });
      runners.set(AGENT_ID, runner);

      const res = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/wechat/status`).set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'pending_scan', qr: 'data:...', loggedOut: false });
    });

    it('404s when the agent has no runner', async () => {
      const res = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/wechat/status`).set(ADMIN);
      expect(res.status).toBe(404);
    });

    it('403s a read-only key (write permission required, like every other connect surface)', async () => {
      configs.set('other-agent', makeAgentConfig({ id: 'other-agent' }));
      const readOnly = { key: 'sk-read', agents: [AGENT_ID] };
      const localKeys = [...apiKeys, readOnly];
      const localApp = express();
      localApp.use(express.json());
      localApp.use('/api', createApiRouter(runners, configs, localKeys, configPath));
      runners.set(AGENT_ID, fakeRunner().runner);

      const res = await supertest
        .default(localApp)
        .get(`/api/v1/agents/${AGENT_ID}/wechat/status`)
        .set({ Authorization: 'Bearer sk-read' });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /wechat/link', () => {
    it('starts linking and returns the resulting status', async () => {
      const { runner, mocks } = fakeRunner({
        getWeChatStatus: jest.fn(() => ({ status: 'linked', loggedOut: false })),
      });
      runners.set(AGENT_ID, runner);

      const res = await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/wechat/link`).set(WRITE_ONLY);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, status: { status: 'linked', loggedOut: false } });
      expect(mocks.startWeChatLinking).toHaveBeenCalledTimes(1);
    });

    it('surfaces a 500 when the kill switch is off (startWeChatLinking rejects)', async () => {
      const { runner } = fakeRunner({
        startWeChatLinking: jest.fn().mockRejectedValue(new Error('WECHAT_CHANNEL_DISABLED is "true"')),
      });
      runners.set(AGENT_ID, runner);

      const res = await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/wechat/link`).set(WRITE_ONLY);
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/WECHAT_CHANNEL_DISABLED/);
    });
  });

  describe('POST /wechat/unlink', () => {
    it('unlinks the account', async () => {
      const { runner, mocks } = fakeRunner();
      runners.set(AGENT_ID, runner);

      const res = await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/wechat/unlink`).set(WRITE_ONLY);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mocks.unlinkWeChat).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /wechat/send', () => {
    it('sends via the runner (internal route, used by the wechat_reply MCP tool)', async () => {
      const { runner, mocks } = fakeRunner();
      runners.set(AGENT_ID, runner);

      const res = await supertest
        .default(app)
        .post(`/api/v1/agents/${AGENT_ID}/wechat/send`)
        .set(WRITE_ONLY)
        .send({ to_id: 'ilink-user-1', text: 'hello' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mocks.sendWeChatMessage).toHaveBeenCalledWith('ilink-user-1', 'hello');
    });

    it('400s when to_id or text is missing', async () => {
      runners.set(AGENT_ID, fakeRunner().runner);
      const res1 = await supertest
        .default(app)
        .post(`/api/v1/agents/${AGENT_ID}/wechat/send`)
        .set(WRITE_ONLY)
        .send({ text: 'hello' });
      expect(res1.status).toBe(400);

      const res2 = await supertest
        .default(app)
        .post(`/api/v1/agents/${AGENT_ID}/wechat/send`)
        .set(WRITE_ONLY)
        .send({ to_id: 'u1' });
      expect(res2.status).toBe(400);
    });
  });

  describe('GET/DELETE /wechat/pending', () => {
    it('lists a denied sender recorded via recordDeniedSender, admin only', async () => {
      recordDeniedSender('wechat', AGENT_ID, 'ilink-user-9', 'Some User');

      const denied = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/wechat/pending`).set(WRITE_ONLY);
      expect(denied.status).toBe(403);

      const res = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/wechat/pending`).set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.senders).toHaveLength(1);
      expect(res.body.senders[0]).toMatchObject({ userId: 'ilink-user-9', displayName: 'Some User' });
    });

    it('dismisses a pending sender', async () => {
      recordDeniedSender('wechat', AGENT_ID, 'ilink-user-9');

      const del = await supertest
        .default(app)
        .delete(`/api/v1/agents/${AGENT_ID}/wechat/pending/ilink-user-9`)
        .set(ADMIN);
      expect(del.status).toBe(200);

      const res = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/wechat/pending`).set(ADMIN);
      expect(res.body.senders).toHaveLength(0);
    });

    it('does not leak a wechat pending sender into the line/slack namespaces', async () => {
      recordDeniedSender('wechat', AGENT_ID, 'shared-id');
      const line = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/line/pending`).set(ADMIN);
      expect(line.body.senders).toHaveLength(0);
    });
  });

  describe('PATCH /agents/:id — wechat_dm_policy / wechat_dm_allowlist / wechat_pairing', () => {
    const patch = (body: Record<string, unknown>) =>
      supertest.default(app).patch(`/api/v1/agents/${AGENT_ID}`).set(ADMIN).send(body);

    it('persists dmPolicy/dmAllowlist without requiring any prior wechat block (unlike LINE/Slack)', async () => {
      runners.set(AGENT_ID, fakeRunner().runner);
      const res = await patch({ wechat_dm_policy: 'allowlist', wechat_dm_allowlist: ['ilink-user-1'] });
      expect(res.status).toBe(200);
      expect(res.body.agent.wechat_dm_policy).toBe('allowlist');
      expect(res.body.agent.wechat_dm_allowlist).toEqual(['ilink-user-1']);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].wechat).toEqual({ dmPolicy: 'allowlist', dmAllowlist: ['ilink-user-1'] });
      expect(configs.get(AGENT_ID)!.wechat).toEqual({ dmPolicy: 'allowlist', dmAllowlist: ['ilink-user-1'] });
    });

    it('rejects an invalid dmPolicy value with 400', async () => {
      const res = await patch({ wechat_dm_policy: 'bogus' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/wechat_dm_policy/);
    });

    it('rejects a non-array dmAllowlist with 400', async () => {
      const res = await patch({ wechat_dm_allowlist: 'not-an-array' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/wechat_dm_allowlist/);
    });

    it('rejects a non-boolean pairing value with 400', async () => {
      const res = await patch({ wechat_pairing: 'yes' });
      expect(res.status).toBe(400);
    });

    it('clears a field with an explicit null', async () => {
      runners.set(AGENT_ID, fakeRunner().runner);
      await patch({ wechat_dm_policy: 'open' });
      const res = await patch({ wechat_dm_policy: null });
      expect(res.status).toBe(200);
      expect(res.body.agent.wechat_dm_policy).toBeNull();
    });

    it('pushes the updated config into the live runner, when one exists', async () => {
      const { runner, mocks } = fakeRunner();
      runners.set(AGENT_ID, runner);
      await patch({ wechat_dm_policy: 'open' });
      expect(mocks.updateAgentConfig).toHaveBeenCalled();
    });

    it('drops a newly-allowlisted sender from the pending list', async () => {
      recordDeniedSender('wechat', AGENT_ID, 'ilink-user-1');
      runners.set(AGENT_ID, fakeRunner().runner);

      await patch({ wechat_dm_policy: 'allowlist', wechat_dm_allowlist: ['ilink-user-1'] });

      const pending = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/wechat/pending`).set(ADMIN);
      expect(pending.body.senders).toHaveLength(0);
    });
  });

  describe('GET /agents — wechat_connected/wechat_dm_policy/wechat_dm_allowlist/wechat_pairing', () => {
    it('reports wechat_connected true only when the live manager status is "linked"', async () => {
      runners.set(
        AGENT_ID,
        fakeRunner({ getWeChatStatus: jest.fn(() => ({ status: 'linked', loggedOut: false })) }).runner,
      );

      const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
      expect(res.status).toBe(200);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.wechat_connected).toBe(true);
    });

    it('reports wechat_connected false with no runner at all', async () => {
      const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
      const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.wechat_connected).toBe(false);
      expect(agent.wechat_dm_policy).toBeNull();
      expect(agent.wechat_dm_allowlist).toEqual([]);
      expect(agent.wechat_pairing).toBe(true); // absent ⇒ on, mirrors line_pairing/slack_pairing
    });
  });
});
