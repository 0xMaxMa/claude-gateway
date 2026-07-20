/**
 * Integration tests: Chat History API (planning-50)
 *
 * Spins up a real AgentRunner + GatewayRouter with a mock claude subprocess
 * and exercises all 7 Chat History / Media API endpoints via supertest.
 *
 * Test IDs: I-HIST-01 through I-HIST-27 (non-contiguous: I-HIST-14 is the `order` param
 * test from #211/PR #213; active-days coverage is I-HIST-21 through I-HIST-27)
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { AgentConfig, GatewayConfig } from '../../src/types';

// ─── constants ───────────────────────────────────────────────────────────────

const MOCK_CLAUDE_API_BIN = path.resolve(__dirname, '../helpers/mock-claude-api.js');
const API_KEY_ADMIN = 'sk-test-admin-hist';
const API_KEY_OTHER = 'sk-test-other-hist';

// ─── helpers ─────────────────────────────────────────────────────────────────

function createStructuredWorkspace(agentsBaseDir: string, agentId: string): string {
  const ws = path.join(agentsBaseDir, agentId, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  const stubs: Record<string, string> = {
    'AGENTS.md': '# Agent\nYou are a test assistant.',
    'SOUL.md': '# Soul\nBe helpful.',
    'USER.md': '# User\nTester.',
    'HEARTBEAT.md': '# Heartbeat\n',
    'MEMORY.md': '# Memory\n',
  };
  for (const [name, content] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(ws, name), content, 'utf-8');
  }
  return ws;
}

function makeAgentConfig(id: string, workspace: string): AgentConfig {
  return {
    id,
    description: `Test agent ${id}`,
    workspace,
    env: '',
    telegram: { botToken: `token-${id}` },
    claude: { model: 'claude-test', dangerouslySkipPermissions: false, extraFlags: [] },
  };
}

function makeGatewayConfig(logDir: string): GatewayConfig {
  return {
    gateway: {
      logDir,
      timezone: 'UTC',
      api: {
        keys: [
          { key: API_KEY_ADMIN, description: 'Admin all', agents: '*' },
          { key: API_KEY_OTHER, description: 'Other agent', agents: ['other-agent'] },
        ],
      },
    },
    agents: [],
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout exceeded');
}

/** Send a message and wait for response, return session_id */
async function sendMessage(
  app: ReturnType<GatewayRouter['getApp']>,
  agentId: string,
  message: string,
  sessionId?: string,
): Promise<{ sessionId: string; response: string }> {
  // Pre-generate a stable ID used as both chat_id and session_id so that
  // chatId in the DB (api-{chat_id}) always equals api-{returned session_id}.
  const sid = sessionId ?? randomUUID();
  const res = await supertest(app)
    .post(`/api/v1/agents/${agentId}/messages`)
    .set('X-Api-Key', API_KEY_ADMIN)
    .send({ message, chat_id: sid, session_id: sid });
  if (res.status !== 200) throw new Error(`sendMessage failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { sessionId: res.body.session_id as string, response: res.body.response as string };
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('Chat History API integration (planning-50)', () => {
  beforeAll(() => {
    process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE_API_BIN}`;
  });

  afterAll(() => {
    delete process.env.CLAUDE_BIN;
  });

  // ─── I-HIST-01: GET /chats returns empty array before any messages ─────────
  it('I-HIST-01: GET /chats returns empty array for fresh agent', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-01-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-01-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats')
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chats)).toBe(true);
    expect(res.body.chats).toHaveLength(0);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-02: GET /chats shows chat after message is sent ───────────────
  it('I-HIST-02: GET /chats returns chat entry after API message', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-02-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-02-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const { sessionId } = await sendMessage(router.getApp(), 'alfred', 'Hello history!');

    // Allow history write to settle
    await new Promise((r) => setTimeout(r, 200));

    const res = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats')
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.chats.length).toBeGreaterThanOrEqual(1);

    const chat = res.body.chats.find((c: { chatId: string }) => c.chatId === `api-${sessionId}`);
    expect(chat).toBeDefined();
    expect(chat.messageCount).toBeGreaterThanOrEqual(1);
    expect(typeof chat.lastActive).toBe('number');

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-03: GET /chats/:chatId/messages returns messages ──────────────
  it('I-HIST-03: GET /chats/:chatId/messages returns stored messages', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-03-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-03-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());
    const app = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await app.start(0);

    const { sessionId } = await sendMessage(app.getApp(), 'alfred', 'Tell me a story');
    await new Promise((r) => setTimeout(r, 200));

    const chatId = `api-${sessionId}`;
    const res = await supertest(app.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages`)
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.hasMore).toBe('boolean');

    const userMsg = res.body.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe('Tell me a story');
    expect(userMsg.chatId).toBe(chatId);
    expect(typeof userMsg.ts).toBe('number');

    await app.stop();
    await runner.stop();
  });

  // ─── I-HIST-04: Pagination — limit and nextCursor ─────────────────────────
  it('I-HIST-04: GET /chats/:chatId/messages paginates with limit and cursor', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-04-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-04-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const sid = 'hist-04-session';
    // Send 3 messages in the same session — produces 6 rows (3 user + 3 assistant)
    for (let i = 0; i < 3; i++) {
      await sendMessage(router.getApp(), 'alfred', `message-${i}`, sid);
    }
    await new Promise((r) => setTimeout(r, 300));

    const chatId = `api-${sid}`;

    // Request only 2 at a time
    const page1 = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages?limit=2`)
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(page1.status).toBe(200);
    expect(page1.body.messages).toHaveLength(2);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.nextCursor).not.toBeNull();

    // Fetch next page using cursor
    const cursor = page1.body.nextCursor as number;
    const page2 = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages?limit=2&before=${cursor}`)
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(page2.status).toBe(200);
    expect(page2.body.messages.length).toBeGreaterThanOrEqual(1);
    // No message should appear in both pages
    const ids1 = new Set(page1.body.messages.map((m: { ts: number }) => m.ts));
    for (const m of page2.body.messages) {
      expect(ids1.has(m.ts)).toBe(false);
    }

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-14: GET messages honors the `order` param (asc/desc, case-insensitive, 400 on invalid) ─
  it('I-HIST-14: order=asc reads forward, is case-insensitive, and rejects invalid values with 400', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-14-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-14-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const sid = 'hist-14-session';
    for (let i = 0; i < 3; i++) {
      await sendMessage(router.getApp(), 'alfred', `message-${i}`, sid);
    }
    await new Promise((r) => setTimeout(r, 300));
    const chatId = `api-${sid}`;

    // asc → strictly ascending ts (oldest first)
    const asc = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages?order=asc`)
      .set('X-Api-Key', API_KEY_ADMIN);
    expect(asc.status).toBe(200);
    const ascTs = asc.body.messages.map((m: { ts: number }) => m.ts);
    expect(ascTs).toEqual([...ascTs].sort((a, b) => a - b));

    // Uppercase ASC is accepted (case-insensitive) and matches lowercase asc
    const ascUpper = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages?order=ASC`)
      .set('X-Api-Key', API_KEY_ADMIN);
    expect(ascUpper.status).toBe(200);
    expect(ascUpper.body.messages.map((m: { ts: number }) => m.ts)).toEqual(ascTs);

    // desc → strictly descending ts (newest first), same as the default
    const desc = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages?order=desc`)
      .set('X-Api-Key', API_KEY_ADMIN);
    expect(desc.status).toBe(200);
    expect(desc.body.messages.map((m: { ts: number }) => m.ts)).toEqual([...ascTs].reverse());

    // An invalid explicit value surfaces as 400 rather than silently defaulting
    const bad = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages?order=sideways`)
      .set('X-Api-Key', API_KEY_ADMIN);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/order/i);

    // A repeated param parses as an array, not a string — must 400, never 500
    const dup = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages?order=asc&order=asc`)
      .set('X-Api-Key', API_KEY_ADMIN);
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/order/i);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-05: FTS search finds matching messages ─────────────────────────
  it('I-HIST-05: GET /chats/:chatId/messages/search finds matching content', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-05-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-05-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const sid = 'hist-05-session';
    await sendMessage(router.getApp(), 'alfred', 'quantum computing is fascinating', sid);
    await sendMessage(router.getApp(), 'alfred', 'what is the weather today', sid);
    await new Promise((r) => setTimeout(r, 300));

    const chatId = `api-${sid}`;
    const res = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages/search?q=quantum`)
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.results[0].content).toMatch(/quantum/i);

    // "weather" should not appear in results
    const noMatch = res.body.results.every((r: { content: string }) => !r.content.includes('weather'));
    expect(noMatch).toBe(true);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-06: FTS search with empty q returns 400 ──────────────────────
  it('I-HIST-06: GET /messages/search with empty q returns 400', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-06-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-06-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats/api-any/messages/search?q=')
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-07: GET /chats/:chatId/sessions returns 400 for api chat ──────
  it('I-HIST-07: GET /chats/:chatId/sessions returns 400 for api:// chatId', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-07-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-07-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats/api-some-session/sessions')
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/telegram|discord/i);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-08: Media upload returns mediaPath ────────────────────────────
  it('I-HIST-08: POST /media uploads file and returns mediaPath', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-08-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-08-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    // Minimal JPEG header bytes (enough to pass MIME check via Content-Type)
    const fakeImage = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/media')
      .set('X-Api-Key', API_KEY_ADMIN)
      .set('Content-Type', 'image/jpeg')
      .set('X-Filename', 'test-photo.jpg')
      .send(fakeImage);

    expect(res.status).toBe(200);
    expect(typeof res.body.mediaPath).toBe('string');
    expect(res.body.mediaPath).toMatch(/ui-upload/);
    expect(res.body.mediaPath).toMatch(/\.jpg$/);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-09: Media upload and serve round-trip ─────────────────────────
  it('I-HIST-09: Uploaded media file can be served back via GET /media/*', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-09-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-09-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const uniquePayload = Buffer.from(`unique-test-content-${Date.now()}`);

    // Upload
    const uploadRes = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/media')
      .set('X-Api-Key', API_KEY_ADMIN)
      .set('Content-Type', 'image/png')
      .set('X-Filename', 'round-trip.png')
      .send(uniquePayload);

    expect(uploadRes.status).toBe(200);
    const mediaPath = uploadRes.body.mediaPath as string;

    // Serve — strip leading "media/" as the endpoint adds its own path prefix
    const servePath = mediaPath.startsWith('media/') ? mediaPath.slice(6) : mediaPath;
    const serveRes = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/media/${servePath}`)
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(serveRes.status).toBe(200);
    expect(serveRes.body).toBeDefined();

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-10: Upload unsupported MIME type → 415 ────────────────────────
  it('I-HIST-10: POST /media with unsupported MIME type returns 415', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-10-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-10-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .post('/api/v1/agents/alfred/media')
      .set('X-Api-Key', API_KEY_ADMIN)
      .set('Content-Type', 'application/javascript')
      .send(Buffer.from('alert(1)'));

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/unsupported/i);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-11: Auth — history endpoint returns 403 for wrong agent ────────
  it('I-HIST-11: GET /chats returns 403 when key has no access to agent', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-11-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-11-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    // API_KEY_OTHER only has access to 'other-agent', not 'alfred'
    const res = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats')
      .set('X-Api-Key', API_KEY_OTHER);

    expect(res.status).toBe(403);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-12: Media serve — path traversal blocked ─────────────────────
  it('I-HIST-12: GET /media with path traversal returns 400', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-12-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-12-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    // Use percent-encoded traversal to bypass HTTP client URL normalization
    const res = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd')
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(400);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-13: SSE disconnect — assistant reply still persists ──────────
  it('I-HIST-13: assistant reply persisted after SSE client disconnects mid-stream', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-13-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-13-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const sid = randomUUID();
    const chatId = `api-${sid}`;
    const port = ((router as unknown as { server: http.Server }).server.address() as { port: number }).port;

    // Stream request — disconnect right after first data arrives
    await new Promise<void>((resolve) => {
      const reqBody = JSON.stringify({ message: 'disconnect test message', chat_id: sid, session_id: sid, stream: true });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/v1/agents/alfred/messages',
          method: 'POST',
          headers: {
            'X-Api-Key': API_KEY_ADMIN,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(reqBody),
          },
        },
        (res) => {
          res.once('data', () => { res.destroy(); resolve(); });
        },
      );
      req.on('error', () => {});
      req.write(reqBody);
      req.end();
    });

    // Poll until Claude finishes server-side and persists the assistant reply
    const app = router.getApp();
    let messages: Array<{ role: string; content: string }> = [];
    await waitFor(async () => {
      const res = await supertest(app)
        .get(`/api/v1/agents/alfred/chats/${chatId}/messages`)
        .set('X-Api-Key', API_KEY_ADMIN);
      messages = (res.body.messages as Array<{ role: string; content: string }>) ?? [];
      return messages.some(m => m.role === 'assistant');
    }, 10000, 200);

    const userMsg = messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('disconnect test message');

    const assistantMsg = messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain('disconnect test message');

    await router.stop();
    await runner.stop();
  }, 15000);

  // ─── I-HIST-21: active-days — happy path with tz bucketing + session filter ─
  it('I-HIST-21: GET /chats/:chatId/messages/active-days returns distinct local days', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-21-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-21-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    await waitFor(() => runner.isRunning());
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const sid = 'hist-21-session';
    await sendMessage(router.getApp(), 'alfred', 'first day message', sid);
    await new Promise((r) => setTimeout(r, 200));

    const chatId = `api-${sid}`;
    const now = Date.now();
    const res = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/${chatId}/messages/active-days?from=${now - 86400000}&to=${now + 86400000}&tz_offset=420&session_id=${sid}`)
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(res.body.days.length).toBeGreaterThanOrEqual(1);
    expect(res.body.days[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-22: active-days — missing from/to returns 400 ────────────────
  it('I-HIST-22: GET /messages/active-days with missing from/to returns 400', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-22-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-22-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const noFrom = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats/api-any/messages/active-days?to=1000')
      .set('X-Api-Key', API_KEY_ADMIN);
    const noTo = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats/api-any/messages/active-days?from=0')
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(noFrom.status).toBe(400);
    expect(noTo.status).toBe(400);
    expect(noFrom.body.error).toBeDefined();

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-23: active-days — non-numeric from returns 400, not a silent truncation ─
  it('I-HIST-23: GET /messages/active-days with non-numeric from/to returns 400', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-23-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-23-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    // "100garbage" would silently truncate to 100 under parseInt() — must 400 instead.
    const res = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats/api-any/messages/active-days?from=100garbage&to=200')
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(400);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-24: active-days — non-numeric tz_offset returns 400 ──────────
  it('I-HIST-24: GET /messages/active-days with non-numeric tz_offset returns 400', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-24-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-24-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats/api-any/messages/active-days?from=0&to=1000&tz_offset=banana')
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tz_offset/i);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-25: active-days — 403 when key has no access to agent ────────
  it('I-HIST-25: GET /messages/active-days returns 403 when key has no access to agent', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-25-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-25-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .get('/api/v1/agents/alfred/chats/api-any/messages/active-days?from=0&to=1000')
      .set('X-Api-Key', API_KEY_OTHER);

    expect(res.status).toBe(403);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-26: active-days — 404 when agent not found ───────────────────
  it('I-HIST-26: GET /messages/active-days returns 404 for unknown agent', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-26-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-26-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    const res = await supertest(router.getApp())
      .get('/api/v1/agents/nonexistent/chats/api-any/messages/active-days?from=0&to=1000')
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(404);

    await router.stop();
    await runner.stop();
  });

  // ─── I-HIST-27: active-days — window larger than 366 days returns 400 ─────
  it('I-HIST-27: GET /messages/active-days with an over-long window returns 400', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-27-'));
    const ws = createStructuredWorkspace(base, 'alfred');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-27-log-'));
    const cfg = makeAgentConfig('alfred', ws);
    const gwCfg = makeGatewayConfig(logDir);

    const runner = new AgentRunner(cfg, gwCfg);
    await runner.start();
    const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gwCfg);
    await router.start(0);

    // 400 days apart — beyond the 366-day cap that guards against a full-history scan.
    const from = 0;
    const to = 400 * 24 * 60 * 60 * 1000;
    const res = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/api-any/messages/active-days?from=${from}&to=${to}`)
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/window too large/i);

    // A window exactly at the boundary (366 days) is still accepted (200).
    const okTo = 366 * 24 * 60 * 60 * 1000;
    const ok = await supertest(router.getApp())
      .get(`/api/v1/agents/alfred/chats/api-any/messages/active-days?from=${from}&to=${okTo}`)
      .set('X-Api-Key', API_KEY_ADMIN);

    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.days)).toBe(true);

    await router.stop();
    await runner.stop();
  });
});
