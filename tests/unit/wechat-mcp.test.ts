/**
 * Unit tests for the WeChat MCP tool module (mcp/tools/wechat/module.ts +
 * client.ts). Mirrors tests/unit/slack-mcp.test.ts's `isEnabled`/`handleTool`
 * conventions. Unlike Slack, this module never talks to the third-party API
 * directly — every send is proxied through this gateway's own `/wechat/send`
 * route (the live iLink session only exists in the main process), so the
 * mocked `global.fetch` calls here assert the CALLBACK request shape, not a
 * Tencent iLink one.
 */
import { WeChatModule } from '../../mcp/tools/wechat/module';

describe('WeChatModule.isEnabled()', () => {
  const restore: Record<string, string | undefined> = {};
  beforeEach(() => {
    restore.origin = process.env.GATEWAY_ORIGIN_CHANNEL;
    restore.apiUrl = process.env.GATEWAY_API_URL;
    restore.agentId = process.env.GATEWAY_AGENT_ID;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(restore)) {
      const envKey = k === 'origin' ? 'GATEWAY_ORIGIN_CHANNEL' : k === 'apiUrl' ? 'GATEWAY_API_URL' : 'GATEWAY_AGENT_ID';
      if (v === undefined) delete process.env[envKey];
      else process.env[envKey] = v;
    }
  });

  test('true only when origin is wechat AND the gateway API env vars are set', () => {
    process.env.GATEWAY_ORIGIN_CHANNEL = 'wechat';
    process.env.GATEWAY_API_URL = 'http://127.0.0.1:8787';
    process.env.GATEWAY_AGENT_ID = 'alfred';
    expect(new WeChatModule().isEnabled()).toBe(true);
  });

  test('false when origin channel is a different channel', () => {
    process.env.GATEWAY_ORIGIN_CHANNEL = 'slack';
    process.env.GATEWAY_API_URL = 'http://127.0.0.1:8787';
    process.env.GATEWAY_AGENT_ID = 'alfred';
    expect(new WeChatModule().isEnabled()).toBe(false);
  });

  test('false when the gateway API env vars are missing, even with the right origin', () => {
    process.env.GATEWAY_ORIGIN_CHANNEL = 'wechat';
    delete process.env.GATEWAY_API_URL;
    delete process.env.GATEWAY_AGENT_ID;
    expect(new WeChatModule().isEnabled()).toBe(false);
  });
});

describe('WeChatModule.getTools()', () => {
  test('advertises exactly one tool, wechat_reply, requiring chat_id + text', () => {
    const tools = new WeChatModule().getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('wechat_reply');
    expect((tools[0].inputSchema as { required: string[] }).required).toEqual(['chat_id', 'text']);
  });
});

describe('WeChatModule.handleTool()', () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    process.env.GATEWAY_API_URL = 'http://127.0.0.1:8787';
    process.env.GATEWAY_AGENT_ID = 'alfred';
    process.env.GATEWAY_API_KEY = 'sk-test';
    calls = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  test('unknown tool name → isError', async () => {
    const res = await new WeChatModule().handleTool('nope', {});
    expect(res.isError).toBe(true);
  });

  test('missing chat_id or text → isError, no network call', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const mod = new WeChatModule();
    const res1 = await mod.handleTool('wechat_reply', { text: 'hi' });
    expect(res1.isError).toBe(true);
    const res2 = await mod.handleTool('wechat_reply', { chat_id: 'u1', text: '' });
    expect(res2.isError).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('posts to this gateway\'s own /wechat/send route, not a third-party API', async () => {
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ ok: true }) } as Response;
    }) as typeof fetch;

    const res = await new WeChatModule().handleTool('wechat_reply', { chat_id: 'ilink-user-1', text: 'hello' });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8787/api/v1/agents/alfred/wechat/send');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ to_id: 'ilink-user-1', text: 'hello' });
    expect((calls[0]!.init?.headers as Record<string, string>)['X-Api-Key']).toBe('sk-test');
  });

  test('a failed send surfaces as isError with the HTTP status in the message', async () => {
    global.fetch = (async () => {
      return { ok: false, status: 500, text: async () => 'boom' } as Response;
    }) as typeof fetch;

    const res = await new WeChatModule().handleTool('wechat_reply', { chat_id: 'u1', text: 'hi' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/500/);
  });

  test('reuses the same client (and thus the same env-derived config) across calls', async () => {
    global.fetch = (async (url: string) => {
      calls.push({ url });
      return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ ok: true }) } as Response;
    }) as typeof fetch;

    const mod = new WeChatModule();
    await mod.handleTool('wechat_reply', { chat_id: 'u1', text: 'one' });
    await mod.handleTool('wechat_reply', { chat_id: 'u2', text: 'two' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(calls[1]!.url);
  });
});
