/**
 * HTTP-level tests for the WhatsApp channel management surface on the
 * agents API:
 *  - PATCH /api/v1/agents/:id accepts whatsapp_dm_policy/whatsapp_dm_allowlist/
 *    whatsapp_group_policy/whatsapp_group_allowlist/whatsapp_require_mention/
 *    whatsapp_pairing — access-control only, NO credential fields (the
 *    "credential" is the linked device session on disk, never in a PATCH body).
 *  - GET  /api/v1/agents exposes whatsapp_connected/whatsapp_status/whatsapp_number
 *    as LIVE state from the runner, not config-derived.
 *  - POST .../whatsapp/link, .../pairing-code, .../unlink, .../send and
 *    GET .../whatsapp/status all delegate to the AgentRunner.
 *
 * Mirrors tests/unit/api-router-sms.test.ts's structure. Uses a real temp
 * config.json for the access-control PATCH (persists via writeAgentsToConfig)
 * and a mock AgentRunner (jest.fn() methods) for the live-status/link surface.
 */
import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../../src/api/router';
import { _resetPendingSenders, recordDeniedSender } from '../../src/api/pending-senders';
import { AgentConfig, ApiKey } from '../../src/types';
import type { WhatsAppStatus } from '../../src/whatsapp/manager';

const AGENT_ID = 'alfred';
const ADMIN = { Authorization: 'Bearer sk-test-admin' };
const GROUP = '123456789-987654321@g.us';
const USER = '66812345678@s.whatsapp.net';

function makeAgentConfig(): AgentConfig {
  return {
    id: AGENT_ID,
    description: 'Personal assistant',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

function makeMockRunner() {
  return {
    getWhatsAppStatus: jest.fn((): WhatsAppStatus => ({ status: 'unlinked' })),
    startWhatsAppLinking: jest.fn(async () => {}),
    requestWhatsAppPairingCode: jest.fn(async () => 'ABCD-1234'),
    unlinkWhatsApp: jest.fn(async () => {}),
    sendWhatsAppMessage: jest.fn(async () => {}),
    // Mirrors AgentRunner's real fallback: an explicit accountId wins,
    // otherwise 'default' (the tests don't exercise the "remembered inbound
    // account" branch, which lives entirely in the real AgentRunner).
    resolveWhatsAppAccountId: jest.fn((_chatId: string | undefined, accountId?: string) => accountId ?? 'default'),
    updateAgentConfig: jest.fn(),
  };
}

describe('WhatsApp channel management API', () => {
  let tmpDir: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let runners: Map<string, ReturnType<typeof makeMockRunner>>;
  let app: express.Express;

  const apiKeys: ApiKey[] = [
    { key: 'sk-test-admin', agents: '*', admin: true },
    // Agent-scoped but NOT write-scoped — used to confirm /whatsapp/send
    // requires write, not just agent access.
    { key: 'sk-test-readonly', agents: [AGENT_ID] },
  ];

  beforeEach(() => {
    _resetPendingSenders();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-whatsapp-api-'));
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
    runners = new Map([[AGENT_ID, makeMockRunner()]]);
    app = express();
    app.use(express.json());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use('/api', createApiRouter(runners as any, configs, apiKeys, configPath));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const patch = (body: Record<string, unknown>) =>
    supertest.default(app).patch(`/api/v1/agents/${AGENT_ID}`).set(ADMIN).send(body);

  it('PATCH rejects any attempt at a credential field — there is none to set', async () => {
    // Unknown fields are simply ignored (not validated against an allowlist
    // of accepted keys elsewhere in this router) — this just confirms no
    // whatsapp "connect" happens via PATCH the way every other channel does.
    const res = await patch({ whatsapp_bot_token: 'should-be-ignored' });
    expect(res.status).toBe(200);
    expect(res.body.agent.whatsapp_connected).toBe(false);
  });

  it('PATCH sets DM access-control fields, creating the whatsapp config block on first touch', async () => {
    const res = await patch({ whatsapp_dm_policy: 'allowlist', whatsapp_dm_allowlist: [USER], whatsapp_pairing: false });
    expect(res.status).toBe(200);
    expect(res.body.agent.whatsapp_dm_policy).toBe('allowlist');
    expect(res.body.agent.whatsapp_dm_allowlist).toEqual([USER]);
    expect(res.body.agent.whatsapp_pairing).toBe(false);

    // The flat whatsapp_* PATCH fields land on the agent's first account —
    // 'default' here, since this agent has no accounts array yet.
    const expected = { accounts: [{ id: 'default', dmPolicy: 'allowlist', dmAllowlist: [USER], pairing: false }] };
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].whatsapp).toEqual(expected);
    expect(configs.get(AGENT_ID)!.whatsapp).toEqual(expected);
  });

  it('PATCH sets group access-control fields independently of DM fields', async () => {
    const res = await patch({
      whatsapp_group_policy: 'allowlist',
      whatsapp_group_allowlist: [GROUP],
      whatsapp_require_mention: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.agent.whatsapp_group_policy).toBe('allowlist');
    expect(res.body.agent.whatsapp_group_allowlist).toEqual([GROUP]);
    expect(res.body.agent.whatsapp_require_mention).toBe(false);
    expect(res.body.agent.whatsapp_dm_policy).toBeNull();
  });

  it('rejects an invalid whatsapp_dm_policy value with 400', async () => {
    const res = await patch({ whatsapp_dm_policy: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/whatsapp_dm_policy/i);
  });

  it('rejects a non-array whatsapp_group_allowlist with 400', async () => {
    const res = await patch({ whatsapp_group_allowlist: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/whatsapp_group_allowlist/i);
  });

  it('GET /agents reports live status from the runner, not from config', async () => {
    runners.get(AGENT_ID)!.getWhatsAppStatus.mockReturnValue({ status: 'linked', phoneNumber: '66812345678' });
    const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
    expect(agent.whatsapp_connected).toBe(true);
    expect(agent.whatsapp_status).toBe('linked');
    expect(agent.whatsapp_number).toBe('66812345678');
  });

  it('GET /agents tolerates a runner with no getWhatsAppStatus (older/mocked runner) without 500ing', async () => {
    runners.set(AGENT_ID, {} as ReturnType<typeof makeMockRunner>);
    const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
    expect(agent.whatsapp_connected).toBe(false);
    expect(agent.whatsapp_status).toBe('unlinked');
  });

  it('GET .../whatsapp/status returns the runner live status', async () => {
    runners.get(AGENT_ID)!.getWhatsAppStatus.mockReturnValue({ status: 'pending_scan', qr: 'data:image/png;base64,x' });
    const res = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/whatsapp/status`).set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account_id: 'default', status: 'pending_scan', qr: 'data:image/png;base64,x' });
  });

  it('POST .../whatsapp/link starts a linking flow via the runner', async () => {
    const res = await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/whatsapp/link`).set(ADMIN);
    expect(res.status).toBe(200);
    expect(runners.get(AGENT_ID)!.startWhatsAppLinking).toHaveBeenCalledTimes(1);
  });

  it('POST .../whatsapp/link surfaces a runner error as 500', async () => {
    runners.get(AGENT_ID)!.startWhatsAppLinking.mockRejectedValueOnce(new Error('boom'));
    const res = await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/whatsapp/link`).set(ADMIN);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });

  it('POST .../whatsapp/pairing-code requires a phoneNumber and returns the code', async () => {
    const missing = await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/whatsapp/pairing-code`).set(ADMIN).send({});
    expect(missing.status).toBe(400);

    const res = await supertest
      .default(app)
      .post(`/api/v1/agents/${AGENT_ID}/whatsapp/pairing-code`)
      .set(ADMIN)
      .send({ phoneNumber: '+15551234567' });
    expect(res.status).toBe(200);
    expect(res.body.pairingCode).toBe('ABCD-1234');
    expect(runners.get(AGENT_ID)!.requestWhatsAppPairingCode).toHaveBeenCalledWith('+15551234567', 'default');
  });

  it('POST .../whatsapp/unlink calls through to the runner', async () => {
    const res = await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/whatsapp/unlink`).set(ADMIN);
    expect(res.status).toBe(200);
    expect(runners.get(AGENT_ID)!.unlinkWhatsApp).toHaveBeenCalledTimes(1);
  });

  it('POST .../whatsapp/send requires jid and (text or image_path), then calls through', async () => {
    configs.get(AGENT_ID)!.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
    const missingJid = await supertest
      .default(app)
      .post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`)
      .set(ADMIN)
      .send({ text: 'hi' });
    expect(missingJid.status).toBe(400);

    const missingBody = await supertest
      .default(app)
      .post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`)
      .set(ADMIN)
      .send({ jid: USER });
    expect(missingBody.status).toBe(400);

    const res = await supertest
      .default(app)
      .post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`)
      .set(ADMIN)
      .send({ jid: USER, text: 'hello', image_path: '/tmp/x.jpg' });
    expect(res.status).toBe(200);
    // account_id is undefined here — the runner then falls back to whichever
    // account the inbound turn for this chat arrived on.
    // The trailing bag is empty: a body with none of the Phase-2 fields must
    // produce exactly the pre-Phase-2 send (no quote, no document, no ack-clear).
    expect(runners.get(AGENT_ID)!.sendWhatsAppMessage).toHaveBeenCalledWith(USER, 'hello', '/tmp/x.jpg', undefined, {});
  });

  it('POST .../whatsapp/send forwards the Phase-2 reply/document/ack fields', async () => {
    configs.get(AGENT_ID)!.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
    const res = await supertest
      .default(app)
      .post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`)
      .set(ADMIN)
      .send({
        jid: USER,
        text: 'quoted answer',
        image_path: '/tmp/x.jpg',
        reply_to_message_id: 'IN-1',
        message_id: 'IN-1',
        as_document: true,
      });
    expect(res.status).toBe(200);
    expect(runners.get(AGENT_ID)!.sendWhatsAppMessage).toHaveBeenCalledWith(USER, 'quoted answer', '/tmp/x.jpg', undefined, {
      quotedMessageId: 'IN-1',
      ackMessageId: 'IN-1',
      asDocument: true,
    });
  });

  it('POST .../whatsapp/send ignores wrongly-typed Phase-2 fields instead of failing the send', async () => {
    configs.get(AGENT_ID)!.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
    const res = await supertest
      .default(app)
      .post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`)
      .set(ADMIN)
      .send({ jid: USER, text: 'hi', reply_to_message_id: 42, message_id: '', as_document: 'yes' });
    expect(res.status).toBe(200);
    expect(runners.get(AGENT_ID)!.sendWhatsAppMessage).toHaveBeenCalledWith(USER, 'hi', undefined, undefined, {});
  });

  it('POST .../whatsapp/send surfaces a send failure (e.g. not linked) as 502', async () => {
    configs.get(AGENT_ID)!.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
    runners.get(AGENT_ID)!.sendWhatsAppMessage.mockRejectedValueOnce(new Error('WhatsApp is not linked'));
    const res = await supertest
      .default(app)
      .post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`)
      .set(ADMIN)
      .send({ jid: USER, text: 'hi' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('WhatsApp is not linked');
  });

  it('POST .../whatsapp/send requires a write-scoped key, not just agent access', async () => {
    configs.get(AGENT_ID)!.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
    const readOnly = { Authorization: 'Bearer sk-test-readonly' };
    const res = await supertest
      .default(app)
      .post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`)
      .set(readOnly)
      .send({ jid: USER, text: 'hi' });
    expect(res.status).toBe(403);
    expect(runners.get(AGENT_ID)!.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('POST .../whatsapp/send refuses a jid the account is not allowed to message', async () => {
    // No allowlist configured at all — closed by default, same posture as
    // the inbound gate this mirrors.
    const res = await supertest
      .default(app)
      .post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`)
      .set(ADMIN)
      .send({ jid: USER, text: 'hi' });
    expect(res.status).toBe(403);
    expect(runners.get(AGENT_ID)!.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('POST .../whatsapp/send refuses an image_path inside the account state directory', async () => {
    configs.get(AGENT_ID)!.whatsapp = { accounts: [{ id: 'default', dmPolicy: 'open' }] };
    const stateDir = path.join(configs.get(AGENT_ID)!.workspace, '.whatsapp-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const credsPath = path.join(stateDir, 'creds.json');
    fs.writeFileSync(credsPath, '{"secret":"do-not-leak"}');
    try {
      const res = await supertest
        .default(app)
        .post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`)
        .set(ADMIN)
        .send({ jid: USER, text: 'hi', image_path: credsPath });
      expect(res.status).toBe(400);
      expect(runners.get(AGENT_ID)!.sendWhatsAppMessage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('whatsapp/pending routes reuse the generic pending-senders store', async () => {
    const empty = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/whatsapp/pending`).set(ADMIN);
    expect(empty.status).toBe(200);
    expect(empty.body.senders).toEqual([]);
  });

  it('agent-not-found returns 404 on every whatsapp route', async () => {
    const missing = 'nope';
    const routes = [
      () => supertest.default(app).get(`/api/v1/agents/${missing}/whatsapp/status`).set(ADMIN),
      () => supertest.default(app).post(`/api/v1/agents/${missing}/whatsapp/link`).set(ADMIN),
      () => supertest.default(app).post(`/api/v1/agents/${missing}/whatsapp/unlink`).set(ADMIN),
      () => supertest.default(app).post(`/api/v1/agents/${missing}/whatsapp/send`).set(ADMIN).send({ jid: USER, text: 'hi' }),
    ];
    for (const req of routes) {
      const res = await req();
      expect(res.status).toBe(404);
    }
  });

  // ── Multi-account (Phase 1 of the WhatsApp feature-parity plan) ──────────
  describe('multi-account', () => {
    const addAccount = (body: Record<string, unknown>) =>
      supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/whatsapp/accounts`).set(ADMIN).send(body);

    it('GET .../whatsapp/accounts reports an implicit "default" for an agent with no whatsapp config', async () => {
      const res = await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/whatsapp/accounts`).set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.accounts).toHaveLength(1);
      expect(res.body.accounts[0]).toMatchObject({ id: 'default', connected: false, status: 'unlinked' });
    });

    it('POST .../whatsapp/accounts adds a slot, persists it, and hands the runner the new config', async () => {
      const res = await addAccount({ id: 'work', label: 'Work phone' });
      expect(res.status).toBe(201);
      expect(res.body.account).toMatchObject({ id: 'work', label: 'Work phone', status: 'unlinked' });
      // The implicit 'default' is materialized alongside it, so what's running
      // and what's on disk agree.
      expect(res.body.accounts.map((a: { id: string }) => a.id)).toEqual(['default', 'work']);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].whatsapp).toEqual({
        accounts: [{ id: 'default' }, { id: 'work', label: 'Work phone' }],
      });
      expect(configs.get(AGENT_ID)!.whatsapp!.accounts.map((a) => a.id)).toEqual(['default', 'work']);
      // This is what actually spawns the second WhatsAppManager.
      expect(runners.get(AGENT_ID)!.updateAgentConfig).toHaveBeenCalled();
    });

    it('two concurrent POST .../whatsapp/accounts calls for different ids both survive — no in-memory clobber', async () => {
      // Regression test for a race where two overlapping add/remove requests
      // for the same agent both read the same pre-lock account snapshot; the
      // loser's in-memory cfg.whatsapp assignment (built from that stale
      // snapshot) used to stomp the winner's, even though the config FILE
      // ended up correct. Firing both through the real Express app exercises
      // the actual async interleaving, not a mocked one.
      const [resA, resB] = await Promise.all([addAccount({ id: 'alpha' }), addAccount({ id: 'beta' })]);
      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);

      const inMemoryIds = configs.get(AGENT_ID)!.whatsapp!.accounts.map((a) => a.id).sort();
      expect(inMemoryIds).toEqual(['alpha', 'beta', 'default']);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const onDiskIds = (onDisk.agents[0].whatsapp.accounts as { id: string }[]).map((a) => a.id).sort();
      expect(onDiskIds).toEqual(['alpha', 'beta', 'default']);
    });

    it('POST .../whatsapp/accounts rejects a bad id (it becomes a directory name) and a duplicate', async () => {
      for (const bad of ['../escape', 'Work', 'has space', '', '-leading']) {
        const res = await addAccount({ id: bad });
        expect(res.status).toBe(400);
      }
      expect((await addAccount({ id: 'work' })).status).toBe(201);
      expect((await addAccount({ id: 'work' })).status).toBe(409);
      expect((await addAccount({ id: 'default' })).status).toBe(409);
    });

    it('link/pairing-code/unlink/status/send all target the requested account', async () => {
      await addAccount({ id: 'work' });
      configs.get(AGENT_ID)!.whatsapp!.accounts.find((a) => a.id === 'work')!.dmPolicy = 'open';
      const runner = runners.get(AGENT_ID)!;

      await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/whatsapp/link`).set(ADMIN).send({ account_id: 'work' });
      expect(runner.startWhatsAppLinking).toHaveBeenCalledWith('work');

      await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/whatsapp/pairing-code`).set(ADMIN)
        .send({ phoneNumber: '+15551234567', account_id: 'work' });
      expect(runner.requestWhatsAppPairingCode).toHaveBeenCalledWith('+15551234567', 'work');

      await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/whatsapp/unlink`).set(ADMIN).send({ account_id: 'work' });
      expect(runner.unlinkWhatsApp).toHaveBeenCalledWith('work');

      const status = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/whatsapp/status?account_id=work`).set(ADMIN);
      expect(status.body.account_id).toBe('work');
      expect(runner.getWhatsAppStatus).toHaveBeenLastCalledWith('work');

      await supertest.default(app).post(`/api/v1/agents/${AGENT_ID}/whatsapp/send`).set(ADMIN)
        .send({ jid: USER, text: 'hi', account_id: 'work' });
      expect(runner.sendWhatsAppMessage).toHaveBeenCalledWith(USER, 'hi', undefined, 'work', {});
    });

    it('an account the agent does not have is a 404, on both the routes and PATCH', async () => {
      const status = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/whatsapp/status?account_id=ghost`).set(ADMIN);
      expect(status.status).toBe(404);

      const link = await supertest.default(app)
        .post(`/api/v1/agents/${AGENT_ID}/whatsapp/link`).set(ADMIN).send({ account_id: 'ghost' });
      expect(link.status).toBe(404);

      const patched = await patch({ whatsapp_account_id: 'ghost', whatsapp_dm_policy: 'open' });
      expect(patched.status).toBe(404);
    });

    it('PATCH with whatsapp_account_id edits only that account', async () => {
      await addAccount({ id: 'work' });
      const res = await patch({ whatsapp_account_id: 'work', whatsapp_dm_policy: 'open' });
      expect(res.status).toBe(200);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].whatsapp.accounts).toEqual([
        { id: 'default' },
        { id: 'work', dmPolicy: 'open' },
      ]);
      // accounts[0] — and therefore the legacy flat mirror the old UI reads —
      // is untouched by an edit aimed at a different account.
      expect(res.body.agent.whatsapp_dm_policy).toBeNull();
      expect(res.body.agent.whatsapp_accounts[1].dm_policy).toBe('open');
    });

    it('pending senders are isolated per account — the same JID knocking on two numbers does not merge or cross-clear', async () => {
      await addAccount({ id: 'work' });
      // Simulates the same real-world contact messaging both linked numbers —
      // manager.ts records each under `whatsapp:${accountId}`, never the bare
      // 'whatsapp' channel, precisely so this doesn't collide into one entry.
      recordDeniedSender('whatsapp:default', AGENT_ID, USER, 'Default caller');
      recordDeniedSender('whatsapp:work', AGENT_ID, USER, 'Work caller');

      const defaultPending = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/whatsapp/pending`).set(ADMIN);
      expect(defaultPending.body.senders).toHaveLength(1);
      expect(defaultPending.body.senders[0].displayName).toBe('Default caller');

      const workPending = await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/whatsapp/pending?account_id=work`).set(ADMIN);
      expect(workPending.body.senders).toHaveLength(1);
      expect(workPending.body.senders[0].displayName).toBe('Work caller');

      // Dismissing the knock on `default` must not touch `work`'s entry for
      // the exact same JID — this is the cross-account leak the fix closes.
      await supertest.default(app)
        .delete(`/api/v1/agents/${AGENT_ID}/whatsapp/pending/${encodeURIComponent(USER)}`).set(ADMIN);
      expect(
        (await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/whatsapp/pending`).set(ADMIN)).body.senders,
      ).toHaveLength(0);
      expect(
        (
          await supertest.default(app)
            .get(`/api/v1/agents/${AGENT_ID}/whatsapp/pending?account_id=work`)
            .set(ADMIN)
        ).body.senders,
      ).toHaveLength(1);
    });

    it('approving a DM allowlist entry on one account only clears that account\'s pending knock', async () => {
      await addAccount({ id: 'work' });
      recordDeniedSender('whatsapp:default', AGENT_ID, USER, 'Default caller');
      recordDeniedSender('whatsapp:work', AGENT_ID, USER, 'Work caller');

      const res = await patch({
        whatsapp_account_id: 'default',
        whatsapp_dm_policy: 'allowlist',
        whatsapp_dm_allowlist: [USER],
      });
      expect(res.status).toBe(200);

      expect(
        (await supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/whatsapp/pending`).set(ADMIN)).body.senders,
      ).toHaveLength(0);
      // `work` never had its allowlist touched — its pending knock survives.
      expect(
        (
          await supertest.default(app)
            .get(`/api/v1/agents/${AGENT_ID}/whatsapp/pending?account_id=work`)
            .set(ADMIN)
        ).body.senders,
      ).toHaveLength(1);
    });

    it('DELETE .../whatsapp/accounts/:id unlinks it, drops it from config, and refuses the last one', async () => {
      await addAccount({ id: 'work' });
      const runner = runners.get(AGENT_ID)!;

      const res = await supertest.default(app)
        .delete(`/api/v1/agents/${AGENT_ID}/whatsapp/accounts/work`).set(ADMIN);
      expect(res.status).toBe(200);
      // Unlinked before removal — otherwise the session dir survives, still
      // logged in on the phone, with no manager left to log it out.
      expect(runner.unlinkWhatsApp).toHaveBeenCalledWith('work');
      expect(res.body.accounts.map((a: { id: string }) => a.id)).toEqual(['default']);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(onDisk.agents[0].whatsapp).toEqual({ accounts: [{ id: 'default' }] });

      // Removing the last account would silently degrade to an unlink.
      const last = await supertest.default(app)
        .delete(`/api/v1/agents/${AGENT_ID}/whatsapp/accounts/default`).set(ADMIN);
      expect(last.status).toBe(409);
      const ghost = await supertest.default(app)
        .delete(`/api/v1/agents/${AGENT_ID}/whatsapp/accounts/ghost`).set(ADMIN);
      expect(ghost.status).toBe(404);
    });
  });
});
