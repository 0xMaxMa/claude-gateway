/**
 * Unit tests for the WhatsApp MCP tool module (mcp/tools/whatsapp/module.ts).
 * Unlike Slack/SMS's reply tools, this one never touches the platform
 * directly — it POSTs to the gateway's own internal /whatsapp/send route.
 * Mocks `global.fetch` (mirrors tests/unit/slack-mcp.test.ts's pattern)
 * rather than hitting a real HTTP server.
 */
import { WhatsAppModule } from '../../mcp/tools/whatsapp/module';

describe('WhatsAppModule', () => {
  const restore: Record<string, string | undefined> = {};
  const ENV_KEYS = ['GATEWAY_ORIGIN_CHANNEL', 'GATEWAY_AGENT_ID', 'GATEWAY_API_URL', 'GATEWAY_API_KEY'];
  beforeEach(() => {
    for (const k of ENV_KEYS) restore[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  });

  test('isEnabled() true only when GATEWAY_ORIGIN_CHANNEL is whatsapp', () => {
    process.env.GATEWAY_ORIGIN_CHANNEL = 'whatsapp';
    expect(new WhatsAppModule().isEnabled()).toBe(true);
    process.env.GATEWAY_ORIGIN_CHANNEL = 'line';
    expect(new WhatsAppModule().isEnabled()).toBe(false);
  });

  test('getTools() exposes exactly whatsapp_reply, requiring only chat_id', () => {
    const tools = new WhatsAppModule().getTools();
    expect(tools.map((t) => t.name)).toEqual(['whatsapp_reply']);
    expect((tools[0].inputSchema as { required: string[] }).required).toEqual(['chat_id']);
  });

  test('missing chat_id → error, no network attempted', async () => {
    const mod = new WhatsAppModule();
    const res = await mod.handleTool('whatsapp_reply', { text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing chat_id/i);
  });

  test('missing both text and image_path → error', async () => {
    const mod = new WhatsAppModule();
    const res = await mod.handleTool('whatsapp_reply', { chat_id: '66812345678@s.whatsapp.net' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/text or image_path is required/i);
  });

  test('missing gateway API bridge env vars → error', async () => {
    delete process.env.GATEWAY_AGENT_ID;
    delete process.env.GATEWAY_API_URL;
    delete process.env.GATEWAY_API_KEY;
    const mod = new WhatsAppModule();
    const res = await mod.handleTool('whatsapp_reply', { chat_id: '66812345678@s.whatsapp.net', text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing gateway API bridge/i);
  });

  test('unknown tool name → error', async () => {
    const mod = new WhatsAppModule();
    const res = await mod.handleTool('nope', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/unknown tool/i);
  });

  describe('successful reply (mocked fetch)', () => {
    const realFetch = global.fetch;
    let calls: { url: string; init: RequestInit }[];

    beforeEach(() => {
      process.env.GATEWAY_AGENT_ID = 'getpod';
      process.env.GATEWAY_API_URL = 'http://127.0.0.1:10850';
      process.env.GATEWAY_API_KEY = 'test-key';
      calls = [];
      global.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }) as typeof fetch;
    });
    afterEach(() => {
      global.fetch = realFetch;
    });

    test('POSTs jid/text/image_path to the internal send route with the API key bearer', async () => {
      const mod = new WhatsAppModule();
      const res = await mod.handleTool('whatsapp_reply', {
        chat_id: '66812345678@s.whatsapp.net',
        text: 'hello back',
        image_path: '/tmp/photo.jpg',
      });
      expect(res.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:10850/api/v1/agents/getpod/whatsapp/send');
      expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        jid: '66812345678@s.whatsapp.net',
        text: 'hello back',
        image_path: '/tmp/photo.jpg',
      });
    });

    test('forwards account_id so the reply goes out from the number it arrived on', async () => {
      const mod = new WhatsAppModule();
      await mod.handleTool('whatsapp_reply', {
        chat_id: '66812345678@s.whatsapp.net',
        text: 'hi',
        account_id: 'work',
      });
      expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ account_id: 'work' });
    });

    // ---- Phase 2 ----------------------------------------------------------

    test('quote / ack-clear / document flags are forwarded for the route to act on', async () => {
      const mod = new WhatsAppModule();
      await mod.handleTool('whatsapp_reply', {
        chat_id: '66812345678@s.whatsapp.net',
        text: 'answering that',
        image_path: '/tmp/chart.png',
        reply_to_message_id: 'IN-1',
        message_id: 'IN-1',
        as_document: true,
      });
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        jid: '66812345678@s.whatsapp.net',
        text: 'answering that',
        image_path: '/tmp/chart.png',
        reply_to_message_id: 'IN-1',
        message_id: 'IN-1',
        as_document: true,
      });
    });

    test('as_document:false is omitted entirely, so the body keeps its v1 shape', async () => {
      const mod = new WhatsAppModule();
      await mod.handleTool('whatsapp_reply', {
        chat_id: '66812345678@s.whatsapp.net',
        text: 'hi',
        as_document: false,
      });
      // JSON.stringify drops undefined values — an unused Phase-2 field never
      // reaches the wire at all.
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        jid: '66812345678@s.whatsapp.net',
        text: 'hi',
      });
    });

    test('non-string / empty Phase-2 ids are dropped rather than forwarded as junk', async () => {
      const mod = new WhatsAppModule();
      await mod.handleTool('whatsapp_reply', {
        chat_id: '66812345678@s.whatsapp.net',
        text: 'hi',
        reply_to_message_id: 42,
        message_id: '',
        as_document: 'yes',
      });
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        jid: '66812345678@s.whatsapp.net',
        text: 'hi',
      });
    });

    test('a non-ok response surfaces the server error message', async () => {
      global.fetch = (async () =>
        ({ ok: false, status: 502, json: async () => ({ error: 'WhatsApp is not linked' }) }) as Response) as typeof fetch;
      const mod = new WhatsAppModule();
      const res = await mod.handleTool('whatsapp_reply', { chat_id: '66812345678@s.whatsapp.net', text: 'hi' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/WhatsApp is not linked/);
    });
  });
});
