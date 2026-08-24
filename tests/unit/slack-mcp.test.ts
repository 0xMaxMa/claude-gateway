/**
 * Unit tests for the Slack channel's pure logic and MCP tool module:
 *  - normalizeSlackEvent (src/api/slack-webhook-router.ts) — inbound parsing
 *  - SlackModule (mcp/tools/slack/module.ts) — outbound slack_reply tool
 *
 * Signature validation (verifySlackSignature) is covered separately in
 * slack-signature.test.ts (crypto-level, no network). This file mocks `global.fetch` (mirrors
 * tests/unit/cron-client-update.test.ts's pattern) rather than hitting a real
 * Slack API.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeSlackEvent } from '../../src/api/slack-webhook-router';
import { SlackModule } from '../../mcp/tools/slack/module';

describe('normalizeSlackEvent()', () => {
  test('DM message → content + meta, kind user', () => {
    const out = normalizeSlackEvent({
      type: 'message',
      channel: 'D0123456789',
      channel_type: 'im',
      user: 'U0123456789',
      text: 'hello',
      ts: '1700000000.000100',
      event_ts: '1700000000.000100',
    });
    expect(out).toEqual({
      content: 'hello',
      meta: {
        source: 'slack',
        chat_id: 'D0123456789',
        user_id: 'U0123456789',
        user: 'U0123456789',
        message_id: '1700000000.000100',
        ts: '1700000000.000100',
        slack_chat_type: 'user',
      },
    });
  });

  test('app_mention in a channel → kind group, thread_ts passed through when present', () => {
    const out = normalizeSlackEvent({
      type: 'app_mention',
      channel: 'C0123456789',
      channel_type: 'channel',
      user: 'U0123456789',
      text: '<@BOT> hi',
      ts: '1700000001.000100',
      thread_ts: '1699999999.000000',
    });
    expect(out?.meta.slack_chat_type).toBe('group');
    expect(out?.meta.thread_ts).toBe('1699999999.000000');
  });

  test('bot-authored event → null (bot-loop protection)', () => {
    const out = normalizeSlackEvent({
      type: 'message',
      channel: 'D1',
      channel_type: 'im',
      user: 'U1',
      bot_id: 'B1',
      text: 'hi',
    });
    expect(out).toBeNull();
  });

  test('unsupported event type → null', () => {
    const out = normalizeSlackEvent({ type: 'reaction_added', channel: 'C1', user: 'U1' });
    expect(out).toBeNull();
  });

  test('missing channel → null', () => {
    const out = normalizeSlackEvent({ type: 'message', channel_type: 'im', user: 'U1', text: 'hi' });
    expect(out).toBeNull();
  });

  test('no text → empty content, not null (an empty message is still forwarded)', () => {
    const out = normalizeSlackEvent({
      type: 'message',
      channel: 'D1',
      channel_type: 'im',
      user: 'U1',
    });
    expect(out?.content).toBe('');
  });
});

describe('SlackModule', () => {
  const restore: Record<string, string | undefined> = {};
  beforeEach(() => {
    restore.origin = process.env.GATEWAY_ORIGIN_CHANNEL;
    restore.token = process.env.SLACK_BOT_TOKEN;
  });
  afterEach(() => {
    if (restore.origin === undefined) delete process.env.GATEWAY_ORIGIN_CHANNEL;
    else process.env.GATEWAY_ORIGIN_CHANNEL = restore.origin;
    if (restore.token === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = restore.token;
  });

  test('isEnabled() true only when GATEWAY_ORIGIN_CHANNEL is slack', () => {
    process.env.GATEWAY_ORIGIN_CHANNEL = 'slack';
    expect(new SlackModule().isEnabled()).toBe(true);
    process.env.GATEWAY_ORIGIN_CHANNEL = 'line';
    expect(new SlackModule().isEnabled()).toBe(false);
  });

  test('getTools() exposes exactly slack_reply, requiring only chat_id', () => {
    const tools = new SlackModule().getTools();
    expect(tools.map((t) => t.name)).toEqual(['slack_reply']);
    // `text` is optional — a files-only reply (image, no caption) is valid.
    expect((tools[0].inputSchema as { required: string[] }).required).toEqual(['chat_id']);
    const props = (tools[0].inputSchema as { properties: Record<string, { type: string; items?: { type: string } }> })
      .properties;
    expect(props.files).toMatchObject({ type: 'array', items: { type: 'string' } });
  });

  test('missing chat_id → error, no network attempted', async () => {
    const mod = new SlackModule();
    const res = await mod.handleTool('slack_reply', { text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing chat_id/i);
  });

  test('empty text and no files → error', async () => {
    const mod = new SlackModule();
    const res = await mod.handleTool('slack_reply', { chat_id: 'D1', text: '' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/text cannot be empty/i);
  });

  test('missing SLACK_BOT_TOKEN → error', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const mod = new SlackModule();
    const res = await mod.handleTool('slack_reply', { chat_id: 'D1', text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing SLACK_BOT_TOKEN/i);
  });

  test('unknown tool name → error', async () => {
    const mod = new SlackModule();
    const res = await mod.handleTool('nope', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/unknown tool/i);
  });

  describe('successful reply (mocked fetch)', () => {
    const realFetch = global.fetch;
    let calls: { url: string; body: Record<string, unknown> }[];

    beforeEach(() => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      calls = [];
      global.fetch = (async (url: string, init: RequestInit) => {
        // Slack calls are form-urlencoded now (see slack-client.ts's `call()` doc
        // comment) — every value round-trips as a string, not JSON.
        const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
        calls.push({ url, body });
        return {
          ok: true,
          json: async () => ({ ok: true, ts: '1700000002.000100' }),
        } as Response;
      }) as typeof fetch;
    });
    afterEach(() => {
      global.fetch = realFetch;
    });

    test('posts with unfurl disabled, and threads when thread_id is passed', async () => {
      const mod = new SlackModule();
      const res = await mod.handleTool('slack_reply', {
        chat_id: 'D1',
        text: 'hello back',
        thread_id: '1699999999.000000',
      });
      expect(res.isError).toBeFalsy();
      const postCall = calls.find((c) => c.url.endsWith('/chat.postMessage'));
      expect(postCall?.body).toMatchObject({
        channel: 'D1',
        text: 'hello back',
        unfurl_links: 'false',
        unfurl_media: 'false',
        thread_ts: '1699999999.000000',
      });
    });

    test('passing message_id clears the ack-reaction after a successful send', async () => {
      const mod = new SlackModule();
      await mod.handleTool('slack_reply', { chat_id: 'D1', text: 'hi', message_id: '1700000000.000100' });
      const reactionCall = calls.find((c) => c.url.endsWith('/reactions.remove'));
      expect(reactionCall?.body).toMatchObject({ channel: 'D1', timestamp: '1700000000.000100' });
    });

    test('no message_id → no reaction call made', async () => {
      const mod = new SlackModule();
      await mod.handleTool('slack_reply', { chat_id: 'D1', text: 'hi' });
      expect(calls.some((c) => c.url.endsWith('/reactions.remove'))).toBe(false);
    });
  });

  /**
   * `files` on slack_reply drives Slack's 3-step external-upload flow
   * (files.getUploadURLExternal → raw multipart POST to the returned upload_url
   * → one files.completeUploadExternal). The old files.upload is deprecated, so
   * the sequence itself is the contract worth pinning.
   */
  describe('file attachments (mocked 3-step upload)', () => {
    const realFetch = global.fetch;
    let calls: { url: string; init?: RequestInit }[];
    let tmpDir: string;
    let imgPath: string;

    const bodyOf = (url: string) => calls.find((c) => c.url.endsWith(url));
    const jsonBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;

    beforeEach(() => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-slack-upload-'));
      imgPath = path.join(tmpDir, 'pic.png');
      fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]));
      calls = [];
      global.fetch = (async (input: string, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/files.getUploadURLExternal')) {
          const q = Object.fromEntries(new URLSearchParams(String(init?.body)));
          return {
            ok: true,
            json: async () => ({
              ok: true,
              upload_url: `https://files.slack.test/upload/${q.filename}`,
              file_id: `F-${q.filename}`,
            }),
          } as Response;
        }
        if (url.startsWith('https://files.slack.test/upload/')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }) as typeof fetch;
    });

    afterEach(() => {
      global.fetch = realFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('text + files → getUploadURL, byte POST, then ONE completeUpload (no chat.postMessage)', async () => {
      const other = path.join(tmpDir, 'chart.png');
      fs.writeFileSync(other, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const mod = new SlackModule();
      const res = await mod.handleTool('slack_reply', {
        chat_id: 'D1',
        text: 'here you go',
        thread_id: '1699999999.000000',
        files: [imgPath, other],
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toMatch(/2 file\(s\)/);

      // Exact call order: reserve+upload per file, then one shared complete.
      expect(calls.map((c) => c.url)).toEqual([
        'https://slack.com/api/files.getUploadURLExternal',
        'https://files.slack.test/upload/pic.png',
        'https://slack.com/api/files.getUploadURLExternal',
        'https://files.slack.test/upload/chart.png',
        'https://slack.com/api/files.completeUploadExternal',
      ]);
      // Text rides along as initial_comment — never a second postMessage.
      expect(calls.some((c) => c.url.endsWith('/chat.postMessage'))).toBe(false);

      const reserve = Object.fromEntries(
        new URLSearchParams(String(calls[0].init?.body)),
      );
      expect(reserve).toMatchObject({ filename: 'pic.png', length: '6' });

      // Step 2 is multipart with the bytes under field name `file`.
      const upload = calls[1].init?.body;
      expect(upload).toBeInstanceOf(FormData);
      expect((upload as FormData).get('file')).toBeTruthy();

      // Step 3 is JSON (a nested `files` array can't be form-encoded).
      const complete = bodyOf('/files.completeUploadExternal');
      expect(
        (complete?.init?.headers as Record<string, string>)['Content-Type'],
      ).toMatch(/application\/json/);
      expect(jsonBody(complete?.init)).toEqual({
        files: [
          { id: 'F-pic.png', title: 'pic.png' },
          { id: 'F-chart.png', title: 'chart.png' },
        ],
        channel_id: 'D1',
        thread_ts: '1699999999.000000',
        initial_comment: 'here you go',
      });
    });

    test('files without text → sends, no "text cannot be empty" error, no initial_comment', async () => {
      const mod = new SlackModule();
      const res = await mod.handleTool('slack_reply', { chat_id: 'D1', files: [imgPath] });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).not.toMatch(/text cannot be empty/i);
      const complete = jsonBody(bodyOf('/files.completeUploadExternal')?.init);
      expect(complete.initial_comment).toBeUndefined();
      expect(complete.channel_id).toBe('D1');
    });

    test('oversized file → error before any upload call is made', async () => {
      const big = path.join(tmpDir, 'huge.png');
      fs.writeFileSync(big, '');
      fs.truncateSync(big, 51 * 1024 * 1024); // sparse — instant, statSync still reports 51MB

      const mod = new SlackModule();
      const res = await mod.handleTool('slack_reply', { chat_id: 'D1', text: 'big', files: [big] });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/file too large.*max 50MB/i);
      expect(calls).toHaveLength(0);
    });

    test('retrying the same file path uploads it only once (retry-dedup)', async () => {
      const mod = new SlackModule();
      await mod.handleTool('slack_reply', { chat_id: 'D1', text: 'first', files: [imgPath] });
      const uploadsAfterFirst = calls.filter((c) => c.url.endsWith('/files.getUploadURLExternal')).length;
      expect(uploadsAfterFirst).toBe(1);

      // Same file again with new text: the file is suppressed, the text still posts.
      const res = await mod.handleTool('slack_reply', { chat_id: 'D1', text: 'retry', files: [imgPath] });
      expect(res.isError).toBeFalsy();
      expect(calls.filter((c) => c.url.endsWith('/files.getUploadURLExternal'))).toHaveLength(1);
      expect(bodyOf('/chat.postMessage')).toBeTruthy();

      // Same file, no text at all: whole reply is a duplicate → no-op success.
      const dup = await mod.handleTool('slack_reply', { chat_id: 'D1', files: [imgPath] });
      expect(dup.isError).toBeFalsy();
      expect(dup.content[0].text).toMatch(/duplicate suppressed/i);
      expect(calls.filter((c) => c.url.endsWith('/files.getUploadURLExternal'))).toHaveLength(1);
    });

    test('a failed upload leaves the file eligible for retry (not marked as sent)', async () => {
      global.fetch = (async (input: string, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/files.getUploadURLExternal')) {
          return { ok: true, json: async () => ({ ok: false, error: 'rate_limited' }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }) as typeof fetch;

      const mod = new SlackModule();
      const first = await mod.handleTool('slack_reply', { chat_id: 'D1', files: [imgPath] });
      expect(first.isError).toBe(true);
      expect(first.content[0].text).toMatch(/rate_limited/);

      // Second attempt must actually try again, not report a phantom duplicate.
      const second = await mod.handleTool('slack_reply', { chat_id: 'D1', files: [imgPath] });
      expect(second.content[0].text).not.toMatch(/duplicate suppressed/i);
      expect(calls.filter((c) => c.url.endsWith('/files.getUploadURLExternal'))).toHaveLength(2);
    });

    test('message_id still clears the ack-reaction after a file send', async () => {
      const mod = new SlackModule();
      await mod.handleTool('slack_reply', {
        chat_id: 'D1',
        files: [imgPath],
        message_id: '1700000000.000100',
      });
      const reaction = bodyOf('/reactions.remove');
      expect(Object.fromEntries(new URLSearchParams(String(reaction?.init?.body)))).toMatchObject({
        channel: 'D1',
        timestamp: '1700000000.000100',
      });
    });
  });
});
