/**
 * Reply context on the wire (WhatsApp Phase 2, display-only).
 *
 * Pins the JSON key names the web dashboard reads off
 *   GET /api/v1/agents/:agentId/chats/:chatId/messages
 * and its /search sibling. Both routes `res.json(...)` the history layer's
 * MessagePage/SearchPage straight through, so the wire format is the
 * HistoryMessage interface verbatim — camelCase, NOT snake_case. That makes
 * these key names a shared contract with the frontend repo, hence a test that
 * asserts the literal strings rather than just the values.
 *
 * Nothing here composes or sends a reply — the dashboard only displays the
 * quoted context that already arrived from WhatsApp.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import * as supertest from 'supertest';
import { createApiRouter } from '../../src/api/router';
import { AgentRunner } from '../../src/agent/runner';
import { HistoryDB } from '../../src/history/db';
import { AgentConfig, ApiKey } from '../../src/types';

const AGENT_ID = 'alfred';
const CHAT_ID = 'whatsapp-66812345678';
const AUTH = { Authorization: 'Bearer sk-test-app' };

const agentConfig: AgentConfig = {
  id: AGENT_ID,
  description: 'Personal assistant',
  workspace: '/tmp/alfred',
  env: '',
  telegram: { botToken: 'tok' },
  claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
};
const apiKeys: ApiKey[] = [{ key: 'sk-test-app', agents: [AGENT_ID] }];

const REPLY = {
  repliedToMessageId: '3EB0C767D26A1D8F2A11',
  repliedToText: 'the original question',
  repliedToUser: '66812345678@s.whatsapp.net',
};

let tmpDir: string;
let db: HistoryDB;
let app: express.Express;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-wire-test-'));
  db = HistoryDB.forAgent(tmpDir, AGENT_ID);
  const runner = { getHistoryDb: () => db, getAgentsBaseDir: () => tmpDir };
  const runners = new Map([[AGENT_ID, runner as unknown as AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
});

afterEach(() => {
  HistoryDB.evict(tmpDir, AGENT_ID);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const seed = (extra: Record<string, unknown> = {}, content = 'a reply') =>
  db.insertMessage({
    chatId: CHAT_ID,
    sessionId: 's1',
    source: 'whatsapp',
    role: 'user',
    content,
    senderName: 'Nok',
    senderId: '66812345678',
    platformMessageId: 'ABCD1234',
    ts: 1_000,
    ...extra,
  });

const getMessages = () =>
  supertest.default(app).get(`/api/v1/agents/${AGENT_ID}/chats/${CHAT_ID}/messages`).set(AUTH);

describe('GET .../messages — reply context JSON keys', () => {
  it('exposes all three fields in camelCase, alongside the existing sender fields', async () => {
    seed(REPLY);
    const res = await getMessages();
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    const m = res.body.messages[0];
    // The exact keys the frontend binds to — changing any of these is a breaking
    // API change for the dashboard's reply-preview.
    expect(m).toMatchObject({
      repliedToMessageId: REPLY.repliedToMessageId,
      repliedToText: REPLY.repliedToText,
      repliedToUser: REPLY.repliedToUser,
    });
    // Same casing convention as the fields that already ship on this route.
    expect(m).toMatchObject({ senderId: '66812345678', platformMessageId: 'ABCD1234' });
  });

  it('does not emit snake_case aliases (the route passes HistoryMessage through verbatim)', async () => {
    seed(REPLY);
    const m = (await getMessages()).body.messages[0];
    for (const legacy of ['replied_to_message_id', 'replied_message_id', 'replied_text', 'replied_user']) {
      expect(m).not.toHaveProperty(legacy);
    }
  });

  it('returns id-only reply context for a Cloud API message', async () => {
    seed({ source: 'whatsapp_cloud', repliedToMessageId: 'wamid.HBgL' });
    const m = (await getMessages()).body.messages[0];
    expect(m.repliedToMessageId).toBe('wamid.HBgL');
    expect(m).not.toHaveProperty('repliedToText');
    expect(m).not.toHaveProperty('repliedToUser');
  });

  it('omits the keys entirely for a message that is not a reply', async () => {
    seed({}, 'just a message');
    const m = (await getMessages()).body.messages[0];
    expect(m).not.toHaveProperty('repliedToMessageId');
    expect(m).not.toHaveProperty('repliedToText');
    expect(m).not.toHaveProperty('repliedToUser');
  });
});

describe('GET .../messages/search — reply context JSON keys', () => {
  it('carries the same camelCase fields through the FTS path', async () => {
    seed(REPLY, 'quokka sighting');
    const res = await supertest
      .default(app)
      .get(`/api/v1/agents/${AGENT_ID}/chats/${CHAT_ID}/messages/search`)
      .query({ q: 'quokka' })
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject(REPLY);
  });
});
