/**
 * HTTP-level tests for the WhatsApp Cloud channel management surface on the
 * agents API:
 *  - PATCH /api/v1/agents/:id accepts whatsapp_cloud_access_token +
 *    whatsapp_cloud_phone_number_id + whatsapp_cloud_app_secret +
 *    whatsapp_cloud_verify_token (all 4 together or all cleared), verifies
 *    the credentials via a Graph API check before persisting (the Save-time
 *    check documented on verifyWhatsAppCloudCredentials), writes
 *    AgentConfig.whatsapp_cloud to config.json, and keeps the in-memory
 *    config in sync.
 *  - GET /api/v1/agents exposes whatsapp_cloud_connected /
 *    whatsapp_cloud_access_token_preview / whatsapp_cloud_webhook_path.
 *
 * Mirrors tests/unit/api-router-slack.test.ts's structure exactly (real temp
 * config.json, supertest, mocked global.fetch standing in for the Graph API
 * Save-time check), adapted for 4 credentials instead of 2.
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
const VALID_TOKEN = 'wa-cloud-access-token-1234567890';
const VALID_PHONE_NUMBER_ID = '1234567890123456';
const VALID_APP_SECRET = 'wa-cloud-app-secret-abcdef';
const VALID_VERIFY_TOKEN = 'wa-cloud-verify-token-xyz';

function makeAgentConfig(): AgentConfig {
  return {
    id: AGENT_ID,
    description: 'Personal assistant',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

describe('WhatsApp Cloud channel management API', () => {
  let tmpDir: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let app: express.Express;
  const realFetch = global.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  const apiKeys: ApiKey[] = [{ key: 'sk-test-admin', agents: '*', admin: true }];

  beforeEach(() => {
    _resetPendingSenders();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-wa-cloud-api-'));
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
    // Default: every Graph API credential check succeeds. Individual tests override this.
    global.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ id: VALID_PHONE_NUMBER_ID, display_phone_number: '+66 81 234 5678' }),
      } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const patch = (body: Record<string, unknown>) =>
    supertest.default(app).patch(`/api/v1/agents/${AGENT_ID}`).set(ADMIN).send(body);

  const CONNECT_BODY = {
    whatsapp_cloud_access_token: VALID_TOKEN,
    whatsapp_cloud_phone_number_id: VALID_PHONE_NUMBER_ID,
    whatsapp_cloud_app_secret: VALID_APP_SECRET,
    whatsapp_cloud_verify_token: VALID_VERIFY_TOKEN,
  };

  it('connects WhatsApp Cloud when all 4 credentials are provided and the Graph API check succeeds', async () => {
    const res = await patch(CONNECT_BODY);
    expect(res.status).toBe(200);
    expect(res.body.agent.whatsapp_cloud_connected).toBe(true);
    expect(res.body.agent.whatsapp_cloud_webhook_path).toBe(`/webhooks/whatsapp_cloud/${AGENT_ID}`);
    expect(res.body.agent.whatsapp_cloud_access_token_preview).toBeTruthy();
    expect(res.body.agent.whatsapp_cloud_access_token_preview).not.toContain(VALID_TOKEN); // masked
    expect(res.body.agent.whatsapp_cloud_phone_number_id).toBe(VALID_PHONE_NUMBER_ID);

    // The Graph API check was actually called, against the new credentials.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain(`graph.facebook.com`);
    expect(fetchCalls[0]!.url).toContain(VALID_PHONE_NUMBER_ID);
    expect(fetchCalls[0]!.url).toContain(VALID_TOKEN);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].whatsapp_cloud).toEqual({
      accessToken: VALID_TOKEN,
      phoneNumberId: VALID_PHONE_NUMBER_ID,
      appSecret: VALID_APP_SECRET,
      verifyToken: VALID_VERIFY_TOKEN,
    });
    expect(configs.get(AGENT_ID)!.whatsapp_cloud).toEqual({
      accessToken: VALID_TOKEN,
      phoneNumberId: VALID_PHONE_NUMBER_ID,
      appSecret: VALID_APP_SECRET,
      verifyToken: VALID_VERIFY_TOKEN,
    });
  });

  it('rejects invalid credentials with 400 and persists nothing', async () => {
    global.fetch = (async (url: string) => {
      fetchCalls.push({ url });
      return { ok: true, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) } as Response;
    }) as typeof fetch;

    const res = await patch(CONNECT_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid whatsapp cloud credentials/i);
    expect(res.body.error).toMatch(/Invalid OAuth access token/);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].whatsapp_cloud).toBeUndefined();
    expect(configs.get(AGENT_ID)!.whatsapp_cloud).toBeUndefined();
  });

  it('rejects with 400 when the Graph API network call itself fails', async () => {
    global.fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND graph.facebook.com');
    }) as typeof fetch;

    const res = await patch(CONNECT_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid whatsapp cloud credentials/i);
    expect(res.body.error).toMatch(/ENOTFOUND/);
  });

  it('rejects a half-set (3 of 4 credentials) with 400 — no Graph API call', async () => {
    const res = await patch({
      whatsapp_cloud_access_token: VALID_TOKEN,
      whatsapp_cloud_phone_number_id: VALID_PHONE_NUMBER_ID,
      whatsapp_cloud_app_secret: VALID_APP_SECRET,
      // whatsapp_cloud_verify_token omitted
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/together/i);
    expect(fetchCalls).toHaveLength(0);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].whatsapp_cloud).toBeUndefined();
  });

  it('a partial credential PATCH on an ALREADY-CONNECTED channel is rejected — existing credentials are not silently wiped', async () => {
    // Guards the merge branch at router.ts's whatsappCloudTouched block
    // (`agent.whatsapp_cloud = {...(existing ?? {}), accessToken: at, ...}`):
    // that branch is only reachable once the all-4-or-none validation above
    // it has already passed, so a request rotating just one credential (e.g.
    // "just the access token") must 400 here rather than ever reaching that
    // merge and blanking the other three fields to ''.
    const connect = await patch(CONNECT_BODY);
    expect(connect.status).toBe(200);

    const rotateTokenOnly = await patch({ whatsapp_cloud_access_token: 'rotated-token' });
    expect(rotateTokenOnly.status).toBe(400);
    expect(rotateTokenOnly.body.error).toMatch(/together/i);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].whatsapp_cloud).toEqual({
      accessToken: VALID_TOKEN,
      phoneNumberId: VALID_PHONE_NUMBER_ID,
      appSecret: VALID_APP_SECRET,
      verifyToken: VALID_VERIFY_TOKEN,
    });
    expect(configs.get(AGENT_ID)!.whatsapp_cloud).toEqual({
      accessToken: VALID_TOKEN,
      phoneNumberId: VALID_PHONE_NUMBER_ID,
      appSecret: VALID_APP_SECRET,
      verifyToken: VALID_VERIFY_TOKEN,
    });
  });

  it('rejects non-string credential with 400', async () => {
    const res = await patch({ ...CONNECT_BODY, whatsapp_cloud_access_token: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/whatsapp_cloud_access_token must be a string/i);
  });

  it('disconnects WhatsApp Cloud when all 4 credentials are cleared — no Graph API call', async () => {
    await patch(CONNECT_BODY);
    fetchCalls = [];
    const res = await patch({
      whatsapp_cloud_access_token: '',
      whatsapp_cloud_phone_number_id: '',
      whatsapp_cloud_app_secret: '',
      whatsapp_cloud_verify_token: '',
    });
    expect(res.status).toBe(200);
    expect(res.body.agent.whatsapp_cloud_connected).toBe(false);
    expect(res.body.agent.whatsapp_cloud_webhook_path).toBeNull();
    expect(fetchCalls).toHaveLength(0);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].whatsapp_cloud).toBeUndefined();
    expect(configs.get(AGENT_ID)!.whatsapp_cloud).toBeUndefined();
  });

  it('GET /agents reflects WhatsApp Cloud connection status', async () => {
    await patch(CONNECT_BODY);
    const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
    expect(agent.whatsapp_cloud_connected).toBe(true);
    expect(agent.whatsapp_cloud_webhook_path).toBe(`/webhooks/whatsapp_cloud/${AGENT_ID}`);
  });

  // Slack-pattern regression guard (see writeAgentsToConfig's "policy without
  // credentials is meaningless" comment): patching only an access field with
  // NO existing credential block must be a silent no-op, not a partial write.
  it('PATCH-ing only whatsapp_cloud_dm_policy with no existing credential block is a silent no-op', async () => {
    const res = await patch({ whatsapp_cloud_dm_policy: 'open' });
    expect(res.status).toBe(200);
    expect(res.body.agent.whatsapp_cloud_connected).toBe(false);
    expect(res.body.agent.whatsapp_cloud_dm_policy).toBeNull();
    expect(fetchCalls).toHaveLength(0);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].whatsapp_cloud).toBeUndefined();
    expect(configs.get(AGENT_ID)!.whatsapp_cloud).toBeUndefined();
  });

  it('access-policy fields apply once credentials exist, and clear the pending list for newly allowlisted senders', async () => {
    await patch(CONNECT_BODY);
    const res = await patch({ whatsapp_cloud_dm_policy: 'allowlist', whatsapp_cloud_dm_allowlist: ['66812345678'] });
    expect(res.status).toBe(200);
    expect(res.body.agent.whatsapp_cloud_dm_policy).toBe('allowlist');
    expect(res.body.agent.whatsapp_cloud_dm_allowlist).toEqual(['66812345678']);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].whatsapp_cloud.dmPolicy).toBe('allowlist');
    expect(onDisk.agents[0].whatsapp_cloud.dmAllowlist).toEqual(['66812345678']);
  });

  // Phase 3 — the message-template opt-in. Validated and persisted through the
  // same merge path as whatsapp_cloud_pairing, but unlike pairing it defaults
  // to FALSE: templates are what reach a user outside the 24h reply window, so
  // the capability must never appear just because the gateway was upgraded.
  describe('whatsapp_cloud_templates_enabled (Phase 3)', () => {
    it('defaults to false on a freshly connected channel', async () => {
      const res = await patch(CONNECT_BODY);
      expect(res.body.agent.whatsapp_cloud_templates_enabled).toBe(false);

      const list = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
      const agent = list.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
      expect(agent.whatsapp_cloud_templates_enabled).toBe(false);
    });

    it('persists true to disk and to the in-memory config', async () => {
      await patch(CONNECT_BODY);
      const res = await patch({ whatsapp_cloud_templates_enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.agent.whatsapp_cloud_templates_enabled).toBe(true);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].whatsapp_cloud.templatesEnabled).toBe(true);
      expect(configs.get(AGENT_ID)!.whatsapp_cloud!.templatesEnabled).toBe(true);
    });

    it('turning it back off persists false rather than dropping the field silently', async () => {
      await patch(CONNECT_BODY);
      await patch({ whatsapp_cloud_templates_enabled: true });
      const res = await patch({ whatsapp_cloud_templates_enabled: false });
      expect(res.body.agent.whatsapp_cloud_templates_enabled).toBe(false);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].whatsapp_cloud.templatesEnabled).toBe(false);
    });

    it('null clears the field, falling back to the off-by-default', async () => {
      await patch(CONNECT_BODY);
      await patch({ whatsapp_cloud_templates_enabled: true });
      const res = await patch({ whatsapp_cloud_templates_enabled: null });
      expect(res.body.agent.whatsapp_cloud_templates_enabled).toBe(false);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].whatsapp_cloud.templatesEnabled).toBeUndefined();
    });

    it('rejects a non-boolean with 400 and persists nothing', async () => {
      await patch(CONNECT_BODY);
      const res = await patch({ whatsapp_cloud_templates_enabled: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/whatsapp_cloud_templates_enabled must be a boolean/);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].whatsapp_cloud.templatesEnabled).toBeUndefined();
    });

    // Same "policy without credentials is meaningless" rule the access fields
    // follow — no credential block means nothing to merge into.
    it('is a silent no-op with no existing credential block', async () => {
      const res = await patch({ whatsapp_cloud_templates_enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.agent.whatsapp_cloud_templates_enabled).toBeNull();

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].whatsapp_cloud).toBeUndefined();
    });

    // The credential merge must not wipe an opt-in that was already granted.
    it('survives a later credential re-save', async () => {
      await patch(CONNECT_BODY);
      await patch({ whatsapp_cloud_templates_enabled: true });
      const res = await patch(CONNECT_BODY);
      expect(res.body.agent.whatsapp_cloud_templates_enabled).toBe(true);
    });
  });
});
