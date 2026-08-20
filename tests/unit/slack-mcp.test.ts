/**
 * Unit tests for the Slack channel's pure logic and MCP tool module:
 *  - normalizeSlackEvent (src/api/slack-webhook-router.ts) — inbound parsing
 *  - SlackModule (mcp/tools/slack/module.ts) — outbound slack_reply tool
 *
 * Signature validation is covered in slack-access.test.ts / slack.test.ts
 * (crypto-level, no network). This file mocks `global.fetch` (mirrors
 * tests/unit/cron-client-update.test.ts's pattern) rather than hitting a real
 * Slack API.
 */
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

  test('getTools() exposes exactly slack_reply, requiring chat_id + text', () => {
    const tools = new SlackModule().getTools();
    expect(tools.map((t) => t.name)).toEqual(['slack_reply']);
    expect((tools[0].inputSchema as { required: string[] }).required).toEqual(['chat_id', 'text']);
  });

  test('missing chat_id → error, no network attempted', async () => {
    const mod = new SlackModule();
    const res = await mod.handleTool('slack_reply', { text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing chat_id/i);
  });

  test('empty text → error', async () => {
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
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
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
        unfurl_links: false,
        unfurl_media: false,
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
});
