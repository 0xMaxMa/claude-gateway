/**
 * isolate_memory default-deny on the agent API (#609): routes that read or
 * message an arbitrary chat (or serve any chat's media) need an admin key for an isolated agent, and the
 * attachments route checks realpath (and, isolated, the session's own media).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import * as supertest from 'supertest';
import { createApiRouter } from '../../src/api/router';
import { HistoryDB } from '../../src/history/db';
import { AgentConfig, ApiKey } from '../../src/types';

const AGENT = 'iso';
const KEYS: ApiKey[] = [
  { key: 'agent-key', agents: [AGENT], write: true },
  { key: 'star-key', agents: '*', write: true },
  { key: 'admin-key', agents: '*', admin: true },
];
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

describe('isolate_memory API hardening (#609)', () => {
  let baseDir: string;
  let runner: Record<string, jest.Mock>;

  const buildApp = (isolateMemory: boolean) => {
    runner = {
      getHistoryDb: jest.fn(() => ({
        listChats: () => [{ chatId: 'telegram-1' }],
        getMessages: () => ({ messages: [] }),
        searchMessages: () => ({ results: [] }),
        getActiveDays: () => [],
      })),
      listSessionsForChat: jest.fn(async () => ({ sessions: [] })),
      sendMessageToSession: jest.fn(async (...args: unknown[]) => {
        (args[5] as { onDone: (text: string, files: unknown[]) => void }).onDone('ok', []);
        return () => {};
      }),
      sendWeChatMessage: jest.fn(async () => {}),
      getAgentsBaseDir: jest.fn(() => baseDir),
      addApiAttachments: jest.fn(),
      getAgentConfig: jest.fn(() => ({})),
    };
    const configs = new Map<string, AgentConfig>([[AGENT, { id: AGENT, isolateMemory } as AgentConfig]]);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(new Map([[AGENT, runner as never]]), configs, KEYS));
    return app;
  };

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-iso-')));
  });
  afterEach(() => {
    HistoryDB.evict(baseDir, AGENT);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const crossChat: Array<[string, (r: supertest.SuperTest<supertest.Test>) => supertest.Test]> = [
    ['list chats', (r) => r.get(`/api/v1/agents/${AGENT}/chats`)],
    ['chat sessions', (r) => r.get(`/api/v1/agents/${AGENT}/chats/telegram-1/sessions`)],
    ['messages', (r) => r.get(`/api/v1/agents/${AGENT}/chats/telegram-1/messages`)],
    ['search', (r) => r.get(`/api/v1/agents/${AGENT}/chats/telegram-1/messages/search?q=x`)],
    ['active days', (r) => r.get(`/api/v1/agents/${AGENT}/chats/telegram-1/messages/active-days?from=0&to=86400000`)],
    ['session inject', (r) => r.post(`/api/v1/agents/${AGENT}/chats/telegram-1/sessions/s1/messages`).send({ content: 'hi' })],
    ['media file', (r) => r.get(`/api/v1/agents/${AGENT}/media/telegram-1/x.png`)],
  ];

  test("media of an API session stays readable with the agent's key: reply attachments link to it", async () => {
    const dir = path.join(baseDir, AGENT, 'media', 'api-s1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.png'), 'x');
    const res = await supertest.default(buildApp(true)).get(`/api/v1/agents/${AGENT}/media/api-s1/x.png`).set(bearer('agent-key'));
    expect(res.body?.error ?? '').not.toMatch(/isolate_memory/);
    expect(res.status).not.toBe(403);
  });

  // The reply path of an isolated agent's own conversation: the MCP tool locks the
  // recipient to the originating chat, so these stay open to the agent's key.
  test.each([
    ['wechat send', (r: supertest.SuperTest<supertest.Test>) => r.post(`/api/v1/agents/${AGENT}/wechat/send`).send({ to_id: 'u', text: 'hi' })],
    ['whatsapp send', (r: supertest.SuperTest<supertest.Test>) => r.post(`/api/v1/agents/${AGENT}/whatsapp/send`).send({ jid: 'j@s.whatsapp.net', text: 'hi' })],
  ])('%s: stays usable by an isolated agent\'s own key', async (_name, call) => {
    const res = await call(supertest.default(buildApp(true)) as never).set(bearer('agent-key'));
    expect(res.body.error ?? '').not.toMatch(/isolate_memory/);
  });

  test.each(crossChat)('%s: an isolated agent refuses a non-admin key with 403', async (_name, call) => {
    const app = buildApp(true);
    for (const key of ['agent-key', 'star-key']) {
      const res = await call(supertest.default(app) as never).set(bearer(key));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/isolate_memory: cross-chat access requires an admin key/);
    }
    expect(runner.getHistoryDb).not.toHaveBeenCalled();
    expect(runner.sendMessageToSession).not.toHaveBeenCalled();
    expect(runner.sendWeChatMessage).not.toHaveBeenCalled();
  });

  test.each(crossChat)('%s: an admin key passes the isolate gate', async (_name, call) => {
    const res = await call(supertest.default(buildApp(true)) as never).set(bearer('admin-key'));
    expect(res.body.error ?? '').not.toMatch(/isolate_memory/);
  });

  test.each(crossChat)('%s: a non-isolated agent still accepts an agent-scoped key', async (_name, call) => {
    const res = await call(supertest.default(buildApp(false)) as never).set(bearer('agent-key'));
    expect(res.body.error ?? '').not.toMatch(/isolate_memory/);
    expect(res.status).not.toBe(403);
  });

  describe('POST /sessions/:sid/attachments', () => {
    const media = (dir: string, file: string) => {
      fs.mkdirSync(path.join(baseDir, AGENT, 'media', dir), { recursive: true });
      const p = path.join(baseDir, AGENT, 'media', dir, file);
      fs.writeFileSync(p, 'x');
      return p;
    };
    const attach = (app: express.Application, sid: string, files: string[]) =>
      supertest.default(app).post(`/api/v1/agents/${AGENT}/sessions/${sid}/attachments`).set(bearer('agent-key')).send({ files });

    test('a symlink inside the media root that points outside it is refused (all agents)', async () => {
      const outside = path.join(baseDir, 'secret.txt');
      fs.writeFileSync(outside, 'secret');
      media('api-s1', 'ok.txt');
      const link = path.join(baseDir, AGENT, 'media', 'api-s1', 'link.txt');
      fs.symlinkSync(outside, link);
      const res = await attach(buildApp(false), 's1', [link]);
      expect(res.status).toBe(400);
      expect(runner.addApiAttachments).not.toHaveBeenCalled();
    });

    test('a non-isolated agent may attach any file under the media root', async () => {
      const own = media('api-s1', 'ok.txt');
      const other = media('api-s2', 'other.txt');
      const res = await attach(buildApp(false), 's1', [own, other]);
      expect(res.status).toBe(200);
      expect(runner.addApiAttachments).toHaveBeenCalledWith('s1', [own, other]);
    });

    test("an isolated agent may attach only this session's media", async () => {
      const own = media('api-s1', 'ok.txt');
      const other = media('api-s2', 'other.txt');
      const app = buildApp(true);
      expect((await attach(app, 's1', [own])).status).toBe(200);
      expect((await attach(app, 's1', [other])).status).toBe(400);
      expect(runner.addApiAttachments).toHaveBeenCalledTimes(1);
    });
  });
});
