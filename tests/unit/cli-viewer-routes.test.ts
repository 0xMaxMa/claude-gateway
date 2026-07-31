import supertest from 'supertest';
import crypto from 'crypto';
import { GatewayRouter } from '../../src/api/gateway-router';
import { cliPairingStore } from '../../src/cli-viewer/pairing-store';
import { ptyStreamRegistry } from '../../src/shell/pty-stream-registry';
import type { AgentConfig, GatewayConfig } from '../../src/types';

/**
 * `/cli` webview terminal viewer — HTTP surface on the real Express app.
 *
 * Proves the device-authorization flow and, critically, that the viewer is
 * AGENT-SCOPED: its access cookie and PTY ticket can only reach the one agent
 * the pairing was created for — never another agent, never the admin dashboard.
 * A leaked link stays locked; only a chat approval (or verified Telegram
 * initData) unlocks it.
 */

const BOT_TOKEN = '111222:test-bot-token';
const AGENT = 'agent-x';
const OTHER_AGENT = 'agent-y';

function fakeRunner(sessions: Array<Record<string, unknown>>) {
  return { getSessionsSummary: () => sessions } as never;
}

function buildApp() {
  const gatewayConfig: GatewayConfig = {
    gateway: { logDir: '/tmp', timezone: 'UTC', publicUrl: 'https://host.example/gw' },
    agents: [],
  };
  const agents = new Map<string, never>();
  agents.set(AGENT, fakeRunner([
    { sessionId: 'sess-1', chatId: 'c1', source: 'telegram', mode: 'pty-shell', model: 'm', isRunning: true, spawnedAt: 0, uptimeSec: 5, tokens: 0 },
    { sessionId: 'sess-head', chatId: 'c2', source: 'api', mode: 'headless', model: 'm', isRunning: true, spawnedAt: 0, uptimeSec: 5, tokens: 0 },
  ]));
  agents.set(OTHER_AGENT, fakeRunner([
    { sessionId: 'other-sess', chatId: 'c9', source: 'telegram', mode: 'pty-shell', model: 'm', isRunning: true, spawnedAt: 0, uptimeSec: 5, tokens: 0 },
  ]));
  const configs = new Map<string, AgentConfig>();
  configs.set(AGENT, { id: AGENT, telegram: { botToken: BOT_TOKEN } } as unknown as AgentConfig);
  const router = new GatewayRouter(agents as never, configs, undefined, gatewayConfig);
  return router.getApp();
}

function pairCookie(res: { headers: Record<string, unknown> }, name: string): string {
  const set = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const hit = set.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0] : '';
}

function signInitData(userId: number, botToken = BOT_TOKEN, ageSec = 0): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - ageSec),
    user: JSON.stringify({ id: userId, first_name: 'T' }),
  });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

describe('/cli webview terminal viewer routes', () => {
  let app: ReturnType<typeof buildApp>;
  let hasSocketsSpy: jest.SpyInstance;

  beforeEach(() => {
    app = buildApp();
    hasSocketsSpy = jest.spyOn(ptyStreamRegistry, 'hasSockets').mockReturnValue(true);
  });
  afterEach(() => hasSocketsSpy.mockRestore());

  it('device flow: open → approve in chat → unlock → agent-scoped viewer', async () => {
    const { pairingId } = cliPairingStore.create(AGENT, 'discord', 'user-1');

    // Browser opens the link → device page, binds this browser.
    const open = await supertest(app).get(`/cli/${pairingId}`);
    expect(open.status).toBe(200);
    const pair = pairCookie(open, 'cli_pair');
    expect(pair).toBeTruthy();

    // Still pending before approval.
    const pending = await supertest(app).get(`/cli/${pairingId}/status`).set('Cookie', pair);
    expect(pending.body).toEqual({ status: 'pending' });

    // The authenticated chat user approves.
    expect(cliPairingStore.approve(pairingId, 'discord', 'user-1')).toBe('ok');

    // Now the poll issues the agent-scoped access cookie.
    const ready = await supertest(app).get(`/cli/${pairingId}/status`).set('Cookie', pair);
    expect(ready.body).toEqual({ status: 'ready' });
    const session = pairCookie(ready, 'cli_session');
    expect(session).toBeTruthy();

    // Viewer renders, scoped to this agent.
    const view = await supertest(app).get(`/cli/${pairingId}/view`).set('Cookie', session);
    expect(view.status).toBe(200);
    expect(view.text).toContain(AGENT);

    // Input-mode shortcut bar: Esc + four arrows, wired by data-seq and gated by
    // the input toggle (display:none until input mode is on).
    expect(view.text).toContain('id="keybar"');
    for (const seq of ['esc', 'left', 'up', 'down', 'right']) {
      expect(view.text).toContain(`data-seq="${seq}"`);
    }
    expect(view.text).toContain("keybar.style.display = on ? 'flex' : 'none'");
    // Arrow keys must honor DECCKM (application vs normal cursor keys).
    expect(view.text).toContain('applicationCursorKeysMode');

    // Sessions list is filtered to the agent's live pty-shell sessions.
    const sessions = await supertest(app).get(`/cli/${pairingId}/sessions`).set('Cookie', session);
    expect(sessions.body.agentId).toBe(AGENT);
    expect(sessions.body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['sess-1']);

    // A ticket can be minted for the agent's own session…
    const ticket = await supertest(app).post(`/cli/${pairingId}/pty-ticket`).set('Cookie', session).send({ sessionId: 'sess-1' });
    expect(ticket.status).toBe(200);
    expect(ticket.body.ticket).toMatch(/^[0-9a-f]{32}$/);

    // …but NOT for another agent's session (agent-scoping).
    const cross = await supertest(app).post(`/cli/${pairingId}/pty-ticket`).set('Cookie', session).send({ sessionId: 'other-sess' });
    expect(cross.status).toBe(404);
  });

  it('a leaked link opened in a second browser is rejected (first-writer-wins)', async () => {
    const { pairingId } = cliPairingStore.create(AGENT, 'discord', 'user-1');
    await supertest(app).get(`/cli/${pairingId}`).expect(200); // first browser binds
    const second = await supertest(app).get(`/cli/${pairingId}`); // no cookie = different browser
    expect(second.status).toBe(409);
  });

  it('status is foreign for a browser that did not bind the pairing', async () => {
    const { pairingId } = cliPairingStore.create(AGENT, 'discord', 'user-1');
    await supertest(app).get(`/cli/${pairingId}`).expect(200);
    const res = await supertest(app).get(`/cli/${pairingId}/status`).set('Cookie', 'cli_pair=someone-elses-token');
    expect(res.body).toEqual({ status: 'foreign' });
  });

  it('viewer and ticket require a valid access session (no cookie → 401)', async () => {
    const { pairingId } = cliPairingStore.create(AGENT, 'discord', 'user-1');
    await supertest(app).get(`/cli/${pairingId}/view`).expect(401);
    await supertest(app).get(`/cli/${pairingId}/sessions`).expect(401);
    await supertest(app).post(`/cli/${pairingId}/pty-ticket`).send({ sessionId: 'sess-1' }).expect(401);
  });

  it('an access session for one pairing cannot be replayed against another', async () => {
    const a = cliPairingStore.create(AGENT, 'discord', 'user-1');
    const b = cliPairingStore.create(OTHER_AGENT, 'discord', 'user-2');
    const open = await supertest(app).get(`/cli/${a.pairingId}`);
    const pair = pairCookie(open, 'cli_pair');
    cliPairingStore.approve(a.pairingId, 'discord', 'user-1');
    const ready = await supertest(app).get(`/cli/${a.pairingId}/status`).set('Cookie', pair);
    const session = pairCookie(ready, 'cli_session');
    // The session cookie from pairing A must not authorize pairing B's viewer.
    await supertest(app).get(`/cli/${b.pairingId}/view`).set('Cookie', session).expect(401);
  });

  it('Telegram initData fast-path: valid unlocks, foreign user 403, tampered 401', async () => {
    // Valid initData for the pairing's own user unlocks.
    const good = cliPairingStore.create(AGENT, 'telegram', '777');
    const open = await supertest(app).get(`/cli/${good.pairingId}`);
    const pair = pairCookie(open, 'cli_pair');
    const ok = await supertest(app).post(`/cli/${good.pairingId}/tg-init`).set('Cookie', pair).send({ initData: signInitData(777) });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ready' });
    expect(pairCookie(ok, 'cli_session')).toBeTruthy();

    // initData for a DIFFERENT user id is rejected (403) even if validly signed.
    const foreign = cliPairingStore.create(AGENT, 'telegram', '777');
    const fOpen = await supertest(app).get(`/cli/${foreign.pairingId}`);
    const f = await supertest(app).post(`/cli/${foreign.pairingId}/tg-init`).set('Cookie', pairCookie(fOpen, 'cli_pair')).send({ initData: signInitData(999) });
    expect(f.status).toBe(403);

    // A tampered payload fails the HMAC (401).
    const bad = cliPairingStore.create(AGENT, 'telegram', '777');
    const bOpen = await supertest(app).get(`/cli/${bad.pairingId}`);
    const tampered = signInitData(777).replace(/first_name%22%3A%22T/, 'first_name%22%3A%22X');
    const b = await supertest(app).post(`/cli/${bad.pairingId}/tg-init`).set('Cookie', pairCookie(bOpen, 'cli_pair')).send({ initData: tampered });
    expect(b.status).toBe(401);
  });

  it('Telegram initData works even without a prior page-load cookie (Mini App webview)', async () => {
    // A Telegram Mini App may not replay the cli_pair cookie from the device
    // page load; initData alone must still unlock (identity is proven by HMAC).
    const { pairingId } = cliPairingStore.create(AGENT, 'telegram', '777');
    const res = await supertest(app).post(`/cli/${pairingId}/tg-init`).send({ initData: signInitData(777) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
    expect(pairCookie(res, 'cli_session')).toBeTruthy();
  });

  it('an unknown pairing id 404s the device page', async () => {
    const res = await supertest(app).get('/cli/deadbeef');
    expect(res.status).toBe(404);
  });
});
