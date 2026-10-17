/**
 * Isolate-mode MCP hardening (#609): one agent serves many unrelated end users,
 * one conversation = (channel, chatId). The gateway MCP server must load only an
 * allowlist of modules, every channel tool must act on the origin chat only
 * (failing closed without one), and every file a tool sends or shares must sit in
 * this session's own media dir. Outside isolate mode nothing changes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// mcp/modules.ts pulls in the memory module, which imports bun:sqlite.
jest.mock('bun:sqlite', () => ({ Database: class {} }), { virtual: true });

const mockLinePush = jest.fn(async (_req: unknown) => ({}));
jest.mock('../../mcp/node_modules/@line/bot-sdk', () => ({
  messagingApi: {
    MessagingApiClient: class {
      pushMessage = mockLinePush;
      replyMessage = jest.fn(async () => ({}));
    },
  },
}));

const mockCloudSendText = jest.fn(async () => ({ messages: [{ id: 'wamid.out' }] }) as Record<string, unknown>);
jest.mock(
  '../../dist/api/whatsapp-cloud-client.js',
  () => ({
    WhatsAppCloudClient: jest.fn().mockImplementation(() => ({
      sendText: mockCloudSendText,
      removeReaction: jest.fn(async () => ({})),
    })),
  }),
  { virtual: true },
);

// eslint-disable-next-line import/first
// A plain require: mcp/modules.ts reaches the memory module, whose bun-only imports the
// jest type check cannot resolve.
const { gatewayModules } = require('../../mcp/modules') as { gatewayModules: (role?: string, media?: boolean) => Array<{ id: string }> };
// eslint-disable-next-line import/first
import { TelegramModule } from '../../mcp/tools/telegram/module';
// eslint-disable-next-line import/first
import { chatHasAttachment, MAX_LOGGED_ATTACHMENTS, recordChatAttachments } from '../../mcp/tools/telegram/attachment-log';
// eslint-disable-next-line import/first
import { DiscordModule } from '../../mcp/tools/discord/module';
// eslint-disable-next-line import/first
import { LineModule } from '../../mcp/tools/line/module';
// eslint-disable-next-line import/first
import { SlackModule } from '../../mcp/tools/slack/module';
// eslint-disable-next-line import/first
import { WhatsAppModule } from '../../mcp/tools/whatsapp/module';
// eslint-disable-next-line import/first
import { WhatsAppCloudModule } from '../../mcp/tools/whatsapp-cloud/module';
// eslint-disable-next-line import/first
import { WeChatModule } from '../../mcp/tools/wechat/module';
// eslint-disable-next-line import/first
import { ApiModule } from '../../mcp/tools/api/module';
// eslint-disable-next-line import/first
import { ShareFileModule } from '../../mcp/tools/share-file/module';
// eslint-disable-next-line import/first
import type { ChannelId, ChannelModule } from '../../mcp/types';

const ORIGIN = '1001';
const FOREIGN = '2002';
const LOCK = /this conversation can only reply to its own chat/;

const ENV_KEYS = [
  'GATEWAY_ISOLATE_MEMORY',
  'GATEWAY_ORIGIN_CHANNEL',
  'GATEWAY_ORIGIN_CHAT_ID',
  'GATEWAY_SESSION_MEDIA_DIR',
  'GATEWAY_API_URL',
  'GATEWAY_API_KEY',
  'GATEWAY_AGENT_ID',
  'GATEWAY_SESSION_ID',
  'TELEGRAM_STATE_DIR',
  'TELEGRAM_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_REPLY_REFRESH',
  'WHATSAPP_CLOUD_ACCESS_TOKEN',
  'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
  'WHATSAPP_CLOUD_DM_POLICY',
];
const saved: Record<string, string | undefined> = {};
const realFetch = global.fetch;
let root: string;
let mediaRoot: string;
let sessionMedia: string;
let ownFile: string;
let foreignFile: string;
let fetchCalls: string[];
let fetchBodies: string[];

function isolate(channel: string, chatId = ORIGIN): void {
  process.env.GATEWAY_ISOLATE_MEMORY = '1';
  process.env.GATEWAY_ORIGIN_CHANNEL = channel;
  process.env.GATEWAY_ORIGIN_CHAT_ID = chatId;
  process.env.GATEWAY_SESSION_MEDIA_DIR = sessionMedia;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-mcp-'));
  mediaRoot = path.join(root, 'media');
  sessionMedia = path.join(mediaRoot, `telegram-${ORIGIN}`);
  fs.mkdirSync(sessionMedia, { recursive: true });
  fs.mkdirSync(path.join(mediaRoot, `telegram-${FOREIGN}`), { recursive: true });
  // PNG magic so a share mint would otherwise accept it.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  ownFile = path.join(sessionMedia, 'own.png');
  foreignFile = path.join(mediaRoot, `telegram-${FOREIGN}`, 'theirs.png');
  fs.writeFileSync(ownFile, png);
  fs.writeFileSync(foreignFile, png);
  fetchCalls = [];
  fetchBodies = [];
  // One canned success body that satisfies every client under test (Slack's ok,
  // the share bridge's 201 + items, WeChat/WhatsApp/api_reply's plain ok).
  const body = { ok: true, ts: '1.2', items: [{ share_id: 's', token: 't', expires_at: 'x' }] };
  global.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push(String(url));
    fetchBodies.push(typeof init?.body === 'string' ? init.body : '');
    return new Response(JSON.stringify(body), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  mockLinePush.mockClear();
  mockCloudSendText.mockClear();
});

afterEach(() => {
  global.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ids = (role?: string, media = false) => gatewayModules(role, media).map((m) => m.id);

describe('default-deny module allowlist', () => {
  const FULL = [
    'telegram', 'discord', 'line', 'slack', 'whatsapp', 'whatsapp_cloud', 'wechat', 'cron', 'skills',
    'agent', 'browser', 'image', 'video', 'share-file', 'apps', 'api', 'memory',
  ];

  it('non-isolate registration is unchanged', () => {
    process.env.GATEWAY_ORIGIN_CHANNEL = 'telegram';
    expect(ids()).toEqual(FULL);
    expect(ids('worker', true)).toEqual(['memory', 'cron', 'image', 'video', 'share-file', 'narrate', 'browser']);
  });

  it('isolate mode loads only the origin channel plus image/video/share-file', () => {
    isolate('telegram');
    expect(ids()).toEqual(['telegram', 'image', 'video', 'share-file']);
    isolate('discord');
    expect(ids()).toEqual(['discord', 'image', 'video', 'share-file']);
  });

  it('isolate mode drops browser, cron and memory for workers too; narrate speaks only through the bridge', () => {
    isolate('telegram');
    expect(ids('worker', true)).toEqual(['image', 'video', 'share-file', 'narrate']);
    expect(ids('agent')).toEqual([]);
  });

  it('an empty origin exposes no channel module, and api only for api sessions', () => {
    isolate('');
    expect(ids()).toEqual(['image', 'video', 'share-file']);
    isolate('api', '');
    expect(ids()).toEqual(['image', 'video', 'share-file', 'api']);
  });

});

describe('telegram', () => {
  function mod(): { m: TelegramModule; api: Record<string, jest.Mock> } {
    const stateDir = path.join(root, 'tg');
    fs.mkdirSync(stateDir, { recursive: true });
    // Both chats are allowlisted, so only the origin lock can tell them apart.
    fs.writeFileSync(path.join(stateDir, 'access.json'), JSON.stringify({ allowFrom: [ORIGIN, FOREIGN] }));
    process.env.TELEGRAM_STATE_DIR = stateDir;
    const m = new TelegramModule();
    const api = {
      sendMessage: jest.fn(async () => ({ message_id: 7 })),
      sendPhoto: jest.fn(async () => ({ message_id: 8 })),
      setMessageReaction: jest.fn(async () => true),
      editMessageText: jest.fn(async () => ({ message_id: 7 })),
      getFile: jest.fn(async () => ({ file_path: 'x.jpg' })),
    };
    Object.assign(m as any, {
      bot: { api },
      _normalizeTelegramLineBreaks: (t: string) => t,
      _resolveTelegramReplyFormat: (t: string) => ({ sendText: t, parseMode: undefined }),
      _InputFile: class {},
    });
    return { m, api };
  }

  it('reply/react/edit reject a foreign chat and accept the origin', async () => {
    isolate('telegram');
    const { m, api } = mod();
    for (const [tool, extra] of [
      ['telegram_reply', { text: 'hi' }],
      ['telegram_react', { message_id: '1', emoji: '👍' }],
      ['telegram_edit_message', { message_id: '1', text: 'x' }],
    ] as const) {
      const bad = await m.handleTool(tool, { chat_id: FOREIGN, ...extra });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(LOCK);
      const ok = await m.handleTool(tool, { chat_id: ORIGIN, ...extra });
      expect(ok.isError).toBeUndefined();
    }
    expect(api.sendMessage.mock.calls.map((c: unknown[]) => c[0])).toEqual([ORIGIN]);
    expect(api.setMessageReaction.mock.calls.map((c: unknown[]) => c[0])).toEqual([ORIGIN]);
    expect(api.editMessageText.mock.calls.map((c: unknown[]) => c[0])).toEqual([ORIGIN]);
  });

  it('fails closed when the origin chat id is unknown', async () => {
    isolate('telegram', '');
    const { m, api } = mod();
    const res = await m.handleTool('telegram_reply', { chat_id: ORIGIN, text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/originating chat is unknown/);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('attachments must sit in the session media dir', async () => {
    isolate('telegram');
    const { m, api } = mod();
    const bad = await m.handleTool('telegram_reply', { chat_id: ORIGIN, text: 'x', files: [foreignFile] });
    expect(bad.content[0].text).toMatch(/outside this conversation's media directory/);
    expect(api.sendMessage).not.toHaveBeenCalled();
    const ok = await m.handleTool('telegram_reply', { chat_id: ORIGIN, text: 'x', files: [ownFile] });
    expect(ok.isError).toBeUndefined();
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('a media-relative attachment is sent from its resolved path', async () => {
    isolate('telegram');
    const { m, api } = mod();
    (m as any)._InputFile = class { constructor(readonly file: string) {} };
    const res = await m.handleTool('telegram_reply', { chat_id: ORIGIN, text: 'x', files: [`media/telegram-${ORIGIN}/own.png`] });
    expect(res.isError).toBeUndefined();
    expect(api.sendPhoto.mock.calls[0][1].file).toBe(fs.realpathSync(ownFile));
  });

  it('a symlink in the session dir pointing elsewhere is rejected', async () => {
    isolate('telegram');
    const { m } = mod();
    const link = path.join(sessionMedia, 'link.png');
    fs.symlinkSync(foreignFile, link);
    const res = await m.handleTool('telegram_reply', { chat_id: ORIGIN, text: 'x', files: [link] });
    expect(res.content[0].text).toMatch(/outside this conversation's media directory/);
  });

  it("isolate download takes only a file_id logged for the origin chat, into the session media dir", async () => {
    const { m, api } = mod();
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    const stateDir = process.env.TELEGRAM_STATE_DIR!;
    recordChatAttachments(stateDir, ORIGIN, ['OWN_ID']);
    recordChatAttachments(stateDir, FOREIGN, ['THEIR_ID']);
    isolate('telegram');
    expect(m.getTools().map((t) => t.name)).toContain('telegram_download_attachment');
    for (const file_id of ['THEIR_ID', 'never-seen']) {
      const res = await m.handleTool('telegram_download_attachment', { file_id });
      expect(res.content[0].text).toMatch(/isolate mode: this file_id was not sent in this conversation/);
    }
    expect(api.getFile).not.toHaveBeenCalled();
    const ok = await m.handleTool('telegram_download_attachment', { file_id: 'OWN_ID' });
    expect(ok.isError).toBeUndefined();
    expect(path.dirname(ok.content[0].text)).toBe(sessionMedia);
    expect(fs.existsSync(ok.content[0].text)).toBe(true);
    delete process.env.GATEWAY_SESSION_MEDIA_DIR;
    const noDir = await m.handleTool('telegram_download_attachment', { file_id: 'OWN_ID' });
    expect(noDir.content[0].text).toMatch(/no session media directory/);
    isolate('telegram', '');
    const noOrigin = await m.handleTool('telegram_download_attachment', { file_id: 'OWN_ID' });
    expect(noOrigin.isError).toBe(true);
    expect(api.getFile).toHaveBeenCalledTimes(1);
  });

  it('non-isolate download takes any file_id into the shared inbox', async () => {
    const { m, api } = mod();
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    const res = await m.handleTool('telegram_download_attachment', { file_id: 'anything' });
    expect(res.isError).toBeUndefined();
    expect(path.dirname(res.content[0].text)).toBe(path.join(process.env.TELEGRAM_STATE_DIR!, 'inbox'));
    expect(api.getFile).toHaveBeenCalledWith('anything');
  });

  it('the attachment log is per chat and keeps only the newest ids', () => {
    const dir = path.join(root, 'log');
    recordChatAttachments(dir, ORIGIN, Array.from({ length: MAX_LOGGED_ATTACHMENTS + 5 }, (_, i) => `id${i}`));
    recordChatAttachments(dir, ORIGIN, ['id5']); // re-seen ids move to the newest end
    expect(chatHasAttachment(dir, ORIGIN, 'id4')).toBe(false);
    expect(chatHasAttachment(dir, ORIGIN, 'id5')).toBe(true);
    expect(chatHasAttachment(dir, ORIGIN, `id${MAX_LOGGED_ATTACHMENTS + 4}`)).toBe(true);
    expect(chatHasAttachment(dir, FOREIGN, 'id5')).toBe(false);
    expect(chatHasAttachment(dir, '../x', 'id5')).toBe(false);
  });
});

describe('discord', () => {
  function mod(): { m: DiscordModule; react: jest.Mock; fetchChannel: jest.Mock } {
    const react = jest.fn(async () => undefined);
    const message = { react, edit: jest.fn(async () => ({ id: 'e1' })), startThread: jest.fn(async () => ({ id: 'th' })) };
    const channels: Record<string, unknown> = {
      [ORIGIN]: { isThread: () => false, parentId: 'category', messages: { fetch: async () => message }, threads: { create: async () => ({ id: 'th' }) } },
      th: { isThread: () => true, parentId: ORIGIN, messages: { fetch: async () => message } },
      [FOREIGN]: { isThread: () => false, parentId: 'category', messages: { fetch: async () => message } },
      thread_of_origin: { isThread: () => true, parentId: ORIGIN, messages: { fetch: async () => message } },
      thread_of_foreign: { isThread: () => true, parentId: FOREIGN, messages: { fetch: async () => message } },
      category: { isThread: () => false, parentId: null, messages: { fetch: async () => message } },
    };
    const fetchChannel = jest.fn(async (id: string) => channels[id]);
    const m = new DiscordModule();
    (m as any).client = { channels: { fetch: fetchChannel } };
    return { m, react, fetchChannel };
  }

  it('reply/react/edit/create_thread reject a foreign channel', async () => {
    isolate('discord');
    const { m, react, fetchChannel } = mod();
    for (const [tool, extra] of [
      ['discord_reply', { text: 'hi' }],
      ['discord_react', { message_id: '1', emoji: '👍' }],
      ['discord_edit_message', { message_id: '1', text: 'x' }],
      ['discord_create_thread', { name: 't' }],
    ] as const) {
      const bad = await m.handleTool(tool, { channel_id: FOREIGN, ...extra });
      expect(bad.content[0].text).toMatch(LOCK);
    }
    const bad = await m.handleTool('discord_react', { channel_id: 'thread_of_foreign', message_id: '1', emoji: 'x' });
    expect(bad.content[0].text).toMatch(LOCK);
    expect(react).not.toHaveBeenCalled();
    expect(fetchChannel).not.toHaveBeenCalled(); // the lock runs before any fetch
  });

  it('accepts the origin channel and only the threads this conversation created', async () => {
    isolate('discord');
    const { m, react } = mod();
    expect((await m.handleTool('discord_react', { channel_id: ORIGIN, message_id: '1', emoji: 'x' })).isError).toBeUndefined();
    // Another user's thread under the same channel is its own conversation.
    const other = await m.handleTool('discord_react', { channel_id: 'thread_of_origin', message_id: '1', emoji: 'x' });
    expect(other.content[0].text).toMatch(LOCK);
    expect((await m.handleTool('discord_create_thread', { channel_id: ORIGIN, name: 't' })).isError).toBeUndefined();
    expect((await m.handleTool('discord_react', { channel_id: 'th', message_id: '1', emoji: 'x' })).isError).toBeUndefined();
    expect(react).toHaveBeenCalledTimes(2);
  });

  it('non-isolate mode acts on any channel or thread', async () => {
    const { m, react } = mod();
    for (const id of [FOREIGN, 'thread_of_foreign', 'thread_of_origin']) {
      expect((await m.handleTool('discord_react', { channel_id: id, message_id: '1', emoji: 'x' })).isError).toBeUndefined();
    }
    expect(react).toHaveBeenCalledTimes(3);
  });

  it('a text channel whose category id equals the origin is still foreign', async () => {
    isolate('discord', 'category');
    const { m } = mod();
    const res = await m.handleTool('discord_react', { channel_id: ORIGIN, message_id: '1', emoji: 'x' });
    expect(res.content[0].text).toMatch(LOCK);
  });

  it('reply files must sit in the session media dir', async () => {
    isolate('discord');
    const { m } = mod();
    const res = await m.handleTool('discord_reply', { channel_id: ORIGIN, text: 'x', files: [foreignFile] });
    expect(res.content[0].text).toMatch(/outside this conversation's media directory/);
  });

  it('download accepts only https Discord CDN URLs and needs a session media dir', async () => {
    isolate('discord');
    const { m } = mod();
    for (const url of ['http://cdn.discordapp.com/a.png', 'https://evil.example/a.png', 'https://cdn.discordapp.com.evil.example/a.png', 'file:///etc/passwd']) {
      const res = await m.handleTool('discord_download_attachment', { url });
      expect(res.content[0].text).toMatch(/only https:\/\/cdn\.discordapp\.com/);
    }
    // An attachment posted in another conversation's channel is refused.
    const foreign = await m.handleTool('discord_download_attachment', { url: `https://cdn.discordapp.com/attachments/${FOREIGN}/1/a.png` });
    expect(foreign.content[0].text).toMatch(LOCK);
    delete process.env.GATEWAY_SESSION_MEDIA_DIR;
    const res = await m.handleTool('discord_download_attachment', { url: `https://cdn.discordapp.com/attachments/${ORIGIN}/1/a.png` });
    expect(res.content[0].text).toMatch(/no session media directory/);
  });
});

describe('reply-only channels', () => {
  it('line_reply and line_image reject a foreign chat; line_reply sends to the origin', async () => {
    isolate('line');
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'fixture';
    const m = new LineModule();
    for (const tool of ['line_reply', 'line_image']) {
      const res = await m.handleTool(tool, { chat_id: FOREIGN, text: 'hi', image: ownFile });
      expect(res.content[0].text).toMatch(LOCK);
    }
    const ok = await m.handleTool('line_reply', { chat_id: ORIGIN, text: 'hi' });
    expect(ok.isError).toBeUndefined();
    expect(mockLinePush.mock.calls.map((c) => (c[0] as { to: string }).to)).toEqual([ORIGIN]);
  });

  it('slack_reply rejects a foreign chat and foreign files; sends to the origin', async () => {
    isolate('slack');
    process.env.SLACK_BOT_TOKEN = 'fixture';
    const m = new SlackModule();
    expect((await m.handleTool('slack_reply', { chat_id: FOREIGN, text: 'hi' })).content[0].text).toMatch(LOCK);
    const badFile = await m.handleTool('slack_reply', { chat_id: ORIGIN, text: 'hi', files: [foreignFile] });
    expect(badFile.content[0].text).toMatch(/outside this conversation's media directory/);
    expect(fetchCalls).toEqual([]);
    expect((await m.handleTool('slack_reply', { chat_id: ORIGIN, text: 'hi' })).isError).toBeUndefined();
    expect(fetchCalls).toHaveLength(1);
  });

  it('whatsapp_reply rejects a foreign chat and a foreign image_path', async () => {
    isolate('whatsapp');
    Object.assign(process.env, { GATEWAY_AGENT_ID: 'a', GATEWAY_API_URL: 'http://gw', GATEWAY_API_KEY: 'k' });
    const m = new WhatsAppModule();
    expect((await m.handleTool('whatsapp_reply', { chat_id: FOREIGN, text: 'hi' })).content[0].text).toMatch(LOCK);
    const badFile = await m.handleTool('whatsapp_reply', { chat_id: ORIGIN, image_path: foreignFile });
    expect(badFile.content[0].text).toMatch(/outside this conversation's media directory/);
    expect(fetchCalls).toEqual([]);
    expect((await m.handleTool('whatsapp_reply', { chat_id: ORIGIN, text: 'hi' })).isError).toBeUndefined();
    expect(fetchCalls).toHaveLength(1);
  });

  it('whatsapp_cloud_reply rejects a foreign chat; sends to the origin', async () => {
    isolate('whatsapp_cloud');
    Object.assign(process.env, {
      WHATSAPP_CLOUD_ACCESS_TOKEN: 't', WHATSAPP_CLOUD_PHONE_NUMBER_ID: 'p', WHATSAPP_CLOUD_DM_POLICY: 'open',
    });
    const m = new WhatsAppCloudModule();
    expect((await m.handleTool('whatsapp_cloud_reply', { chat_id: FOREIGN, text: 'hi' })).content[0].text).toMatch(LOCK);
    expect(mockCloudSendText).not.toHaveBeenCalled();
    expect((await m.handleTool('whatsapp_cloud_reply', { chat_id: ORIGIN, text: 'hi' })).isError).toBeFalsy();
    expect(mockCloudSendText).toHaveBeenCalledTimes(1);
  });

  it('wechat_reply rejects a foreign chat; sends to the origin', async () => {
    isolate('wechat');
    Object.assign(process.env, { GATEWAY_AGENT_ID: 'a', GATEWAY_API_URL: 'http://gw', GATEWAY_API_KEY: 'k' });
    const m = new WeChatModule();
    expect((await m.handleTool('wechat_reply', { chat_id: FOREIGN, text: 'hi' })).content[0].text).toMatch(LOCK);
    expect(fetchCalls).toEqual([]);
    expect((await m.handleTool('wechat_reply', { chat_id: ORIGIN, text: 'hi' })).isError).toBeUndefined();
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('media paths', () => {
  beforeEach(() => {
    Object.assign(process.env, { GATEWAY_AGENT_ID: 'a', GATEWAY_API_URL: 'http://gw', GATEWAY_API_KEY: 'k', GATEWAY_SESSION_ID: 's' });
  });

  it('share_file mints only for files in the session media dir (absolute or media-relative)', async () => {
    isolate('telegram');
    const m = new ShareFileModule();
    for (const p of [foreignFile, `media/telegram-${FOREIGN}/theirs.png`, `media/telegram-${ORIGIN}/../telegram-${FOREIGN}/theirs.png`]) {
      const res = await m.handleTool('share_file', { path: p });
      expect(res.content[0].text).toMatch(/isolate_path_denied/);
    }
    expect(fetchCalls).toEqual([]);
    expect((await m.handleTool('share_file', { path: ownFile })).isError).toBeUndefined();
    expect((await m.handleTool('share_file', { path: `media/telegram-${ORIGIN}/own.png` })).isError).toBeUndefined();
    expect(fetchCalls).toHaveLength(2);
  });

  it('share_file fails closed without a session media dir', async () => {
    isolate('telegram');
    delete process.env.GATEWAY_SESSION_MEDIA_DIR;
    const res = await new ShareFileModule().handleTool('share_file', { path: ownFile });
    expect(res.content[0].text).toMatch(/no session media directory/);
    expect(fetchCalls).toEqual([]);
  });

  it('non-isolate share_file passes any path to the gateway unchanged', async () => {
    const res = await new ShareFileModule().handleTool('share_file', { path: foreignFile });
    expect(res.isError).toBeUndefined();
    expect(fetchCalls).toHaveLength(1);
  });

  it('api_reply and share_file hand the gateway the resolved path of a media-relative file', async () => {
    isolate('api', '');
    const rel = `media/telegram-${ORIGIN}/own.png`;
    expect((await new ApiModule().handleTool('api_reply', { files: [rel] })).isError).toBeUndefined();
    expect(JSON.parse(fetchBodies[0]).files).toEqual([fs.realpathSync(ownFile)]);
    expect((await new ShareFileModule().handleTool('share_file', { path: rel })).isError).toBeUndefined();
    expect(JSON.parse(fetchBodies[1]).refs[0].path).toBe(fs.realpathSync(ownFile));
  });

  it('non-isolate api_reply passes paths unchanged', async () => {
    expect((await new ApiModule().handleTool('api_reply', { files: ['rel/x.png'] })).isError).toBeUndefined();
    expect(JSON.parse(fetchBodies[0]).files).toEqual(['rel/x.png']);
  });

  it('api_reply attaches only session media files', async () => {
    isolate('api', '');
    const m = new ApiModule();
    expect((await m.handleTool('api_reply', { files: [foreignFile] })).content[0].text).toMatch(/outside this conversation's media directory/);
    expect(fetchCalls).toEqual([]);
    expect((await m.handleTool('api_reply', { files: [ownFile] })).isError).toBeUndefined();
    expect(fetchCalls).toHaveLength(1);
  });
});
