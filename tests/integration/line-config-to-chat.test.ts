/**
 * Integration: the full "getpod configures LINE → user chats via LINE" path,
 * minus the real LINE servers. Proves the two halves connect through one shared
 * agent-config map:
 *
 *   1. PATCH /api/v1/agents/:id with line_channel_access_token + line_channel_secret
 *      (exactly what getpod's LINE card sends) writes AgentConfig.line and syncs
 *      the runner via updateAgentConfig().
 *   2. A signed LINE webhook to /webhooks/line/:id is then accepted using THOSE
 *      just-configured credentials and the message is forwarded to the agent's
 *      /channel intake.
 *   3. Clearing the credentials via PATCH makes the same webhook fail (404 — no
 *      LINE-enabled agent).
 *
 * The LINE outbound (reply/push) contract is covered by the LineReplyManager
 * unit tests (tests/unit/line-reply-manager.test.ts); here we focus on
 * config → inbound wiring, which is the new getpod-driven surface.
 */
import express from 'express';
import * as supertest from 'supertest';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../../src/api/router';
import { type LineWebhookOptions } from '../../src/api/line-webhook-router';
import { createWebhooksRouter } from '../../src/api/webhooks-router';
import { getPendingSenders, _resetPendingSenders } from '../../src/api/line-pending-senders';
import { AgentConfig, ApiKey } from '../../src/types';
import type { AgentRunner } from '../../src/agent/runner';

const AGENT_ID = 'baerbel';
const ADMIN = { Authorization: 'Bearer sk-admin' };
const ACCESS_TOKEN = 'line-access-token-xyz';
const SECRET = 'line-channel-secret-xyz';
const USER_ID = 'Uconfig00000000000000000000000000';
const KNOCKER_ID = 'Uknock000000000000000000000000000';

const listen = (server: http.Server): Promise<number> =>
  new Promise((res) => server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port)));

describe('LINE: getpod config → chat (inbound) integration', () => {
  let tmpDir: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let runners: Map<string, AgentRunner>;
  let callbackServer: http.Server;
  let callbackPort: number;
  const intake: unknown[] = [];

  // Minimal runner that mirrors how the real one exposes config + callback port.
  // updateAgentConfig() must mutate what getAgentConfig() returns — that is the
  // exact mechanism the PATCH route relies on to make the webhook see new creds.
  function makeRunner(): AgentRunner {
    let cfg = configs.get(AGENT_ID)!;
    return {
      getAgentConfig: () => cfg,
      updateAgentConfig: (next: AgentConfig) => { cfg = next; },
      getCallbackPort: () => callbackPort,
    } as unknown as AgentRunner;
  }

  beforeEach(async () => {
    intake.length = 0;
    _resetPendingSenders();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-line-int-'));
    configPath = path.join(tmpDir, 'config.json');
    const baseAgent: AgentConfig = {
      id: AGENT_ID,
      description: 'test',
      workspace: path.join(tmpDir, 'ws'),
      env: '',
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    };
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { logDir: tmpDir, timezone: 'UTC' }, agents: [baseAgent] }, null, 2),
    );
    configs = new Map([[AGENT_ID, { ...baseAgent }]]);

    // Agent /channel intake recorder
    callbackServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/channel') intake.push(JSON.parse(body || '{}'));
        res.writeHead(200).end('{}');
      });
    });
    callbackPort = await listen(callbackServer);

    runners = new Map([[AGENT_ID, makeRunner()]]);
  });

  afterEach(() => {
    callbackServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildApp(lineOpts: LineWebhookOptions = {}): express.Express {
    const app = express();
    // LINE webhook must be mounted before express.json() (raw body for signature).
    app.use('/webhooks', createWebhooksRouter(runners, tmpDir, lineOpts));
    app.use(express.json());
    const apiKeys: ApiKey[] = [{ key: 'sk-admin', agents: '*', admin: true }];
    app.use('/api', createApiRouter(runners, configs, apiKeys, configPath));
    return app;
  }

  const signedWebhook = (app: express.Express, text: string) => {
    const raw = JSON.stringify({
      destination: 'x',
      events: [
        {
          type: 'message',
          timestamp: 1700000000000,
          replyToken: 'rt-int',
          source: { type: 'user', userId: USER_ID },
          message: { type: 'text', id: 'm1', text },
        },
      ],
    });
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
    return supertest
      .default(app)
      .post(`/webhooks/line/${AGENT_ID}`)
      .set('Content-Type', 'application/json')
      .set('x-line-signature', sig)
      .send(raw);
  };

  it('config via PATCH then a signed webhook is accepted and forwarded', async () => {
    const app = buildApp();

    // Before config: webhook has no LINE-enabled agent → 404.
    const pre = await signedWebhook(app, 'too early');
    expect(pre.status).toBe(404);

    // getpod's LINE card → PATCH credentials. dmPolicy 'open' so this test stays
    // focused on the forwarding path (the closed default + allowlist denial is
    // covered by the denied-sender test below).
    const patch = await supertest
      .default(app)
      .patch(`/api/v1/agents/${AGENT_ID}`)
      .set(ADMIN)
      .send({
        line_channel_access_token: ACCESS_TOKEN,
        line_channel_secret: SECRET,
        line_dm_policy: 'open',
      });
    expect(patch.status).toBe(200);
    expect(patch.body.agent.line_connected).toBe(true);
    expect(patch.body.agent.line_webhook_path).toBe(`/webhooks/line/${AGENT_ID}`);

    // Now the same signed webhook is accepted with the configured secret.
    const ok = await signedWebhook(app, 'สวัสดีจาก LINE');
    expect(ok.status).toBe(200);

    // Intake forwarded to the agent's /channel (async after ack).
    await new Promise((r) => setTimeout(r, 300));
    expect(intake).toHaveLength(1);
    const post = intake[0] as { content: string; meta: Record<string, string> };
    expect(post.content).toBe('สวัสดีจาก LINE');
    expect(post.meta.source).toBe('line');
    expect(post.meta.chat_id).toBe(USER_ID);
    expect(post.meta.reply_token).toBe('rt-int');
  });

  it('a wrong signature is rejected even after config', async () => {
    const app = buildApp();
    await supertest
      .default(app)
      .patch(`/api/v1/agents/${AGENT_ID}`)
      .set(ADMIN)
      .send({ line_channel_access_token: ACCESS_TOKEN, line_channel_secret: SECRET });

    const raw = JSON.stringify({ events: [] });
    const res = await supertest
      .default(app)
      .post(`/webhooks/line/${AGENT_ID}`)
      .set('Content-Type', 'application/json')
      .set('x-line-signature', 'not-a-valid-signature')
      .send(raw);
    expect(res.status).toBe(401);
  });

  it('records a denied (off-allowlist) sender on the knock list, not forwarded', async () => {
    // Stand up a local LINE API mock so the gate's best-effort getProfile()
    // resolves fast (returns {}) instead of hitting the real api.line.me.
    const lineMock = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
    const lineMockPort = await listen(lineMock);
    // Point the webhook's outbound LINE client at the mock via the router's
    // apiBase option (no global env — the base URL is a constructor param now).

    try {
      const app = buildApp({ apiBase: `http://127.0.0.1:${lineMockPort}` });
      // Configure creds + allowlist policy that allows only USER_ID.
      await supertest
        .default(app)
        .patch(`/api/v1/agents/${AGENT_ID}`)
        .set(ADMIN)
        .send({
          line_channel_access_token: ACCESS_TOKEN,
          line_channel_secret: SECRET,
          line_dm_policy: 'allowlist',
          line_dm_allowlist: [USER_ID],
        });

      // A different user DMs the bot → denied by the gate.
      const raw = JSON.stringify({
        destination: 'x',
        events: [
          {
            type: 'message',
            timestamp: 1700000000000,
            replyToken: 'rt-knock',
            source: { type: 'user', userId: KNOCKER_ID },
            message: { type: 'text', id: 'mk', text: 'let me in' },
          },
        ],
      });
      const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
      const res = await supertest
        .default(app)
        .post(`/webhooks/line/${AGENT_ID}`)
        .set('Content-Type', 'application/json')
        .set('x-line-signature', sig)
        .send(raw);
      expect(res.status).toBe(200); // webhook is always ack'd

      // Async gate work settles: not forwarded, but recorded on the knock list.
      await new Promise((r) => setTimeout(r, 300));
      expect(intake).toHaveLength(0);
      expect(getPendingSenders(AGENT_ID).map((s) => s.userId)).toContain(KNOCKER_ID);
    } finally {
      lineMock.close();
    }
  });

  it('clearing credentials via PATCH disables the webhook again', async () => {
    const app = buildApp();
    await supertest
      .default(app)
      .patch(`/api/v1/agents/${AGENT_ID}`)
      .set(ADMIN)
      .send({ line_channel_access_token: ACCESS_TOKEN, line_channel_secret: SECRET });

    const clear = await supertest
      .default(app)
      .patch(`/api/v1/agents/${AGENT_ID}`)
      .set(ADMIN)
      .send({ line_channel_access_token: '', line_channel_secret: '' });
    expect(clear.body.agent.line_connected).toBe(false);

    const res = await signedWebhook(app, 'after disconnect');
    expect(res.status).toBe(404);
  });
});
