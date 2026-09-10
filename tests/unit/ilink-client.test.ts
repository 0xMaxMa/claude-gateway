/**
 * Unit tests for src/wechat/ilink-client.ts's real implementation — the HTTP
 * contract against Tencent's iLink Bot API ("WeChat ClawBot"), as documented
 * in Tencent/openclaw-weixin's own docs/protocol.md (the canonical source —
 * see this module's doc comment for how that was confirmed). `global.fetch`
 * is always mocked here — there is no live account to test against.
 */
import {
  createILinkClient,
  encodeClientVersion,
  normalizeQrImage,
  type ILinkCredentials,
} from '../../src/wechat/ilink-client';

const CREDS: ILinkCredentials = {
  accountId: 'bot-1',
  token: 'tok-1',
  baseUrl: 'https://ilinkai.weixin.qq.com',
};

describe('encodeClientVersion()', () => {
  test('encodes major/minor/patch into one byte each, decimal-rendered', () => {
    expect(encodeClientVersion('1.0.0')).toBe(String((1 << 16) | (0 << 8) | 0));
    expect(encodeClientVersion('2.4.8')).toBe(String((2 << 16) | (4 << 8) | 8));
  });
  test('non-numeric or missing segments default to 0', () => {
    expect(encodeClientVersion('x.y.z')).toBe('0');
    expect(encodeClientVersion('1')).toBe(String(1 << 16));
  });
});

describe('normalizeQrImage()', () => {
  test('passes through an already-usable data: URI unchanged', async () => {
    await expect(normalizeQrImage('data:image/png;base64,AAA')).resolves.toBe(
      'data:image/png;base64,AAA',
    );
  });
  test('QR-encodes a URL into a scannable PNG data URI — confirmed 2026-09-10 against a real Tencent response that a bare URL is a liteapp.weixin.qq.com HTML deep link, not an image', async () => {
    const dataUri = await normalizeQrImage('https://liteapp.weixin.qq.com/q/abc?qrcode=xyz&bot_type=3');
    expect(dataUri).toMatch(/^data:image\/png;base64,/);
  });
  test('wraps bare content as base64 PNG (the fallback assumption for a shape neither confirmed response nor the doc describes)', async () => {
    await expect(normalizeQrImage('AAAB')).resolves.toBe('data:image/png;base64,AAAB');
  });
});

describe('createILinkClient() — real HTTP contract', () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function mockFetchOnce(status: number, body: unknown) {
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }) as typeof fetch;
  }

  test('requestLinkQr() POSTs get_bot_qrcode?bot_type=3 without Authorization, with an empty local_token_list, and QR-encodes the returned liteapp URL', async () => {
    mockFetchOnce(200, {
      qrcode: 'qr-abc',
      qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc?qrcode=qr-abc&bot_type=3',
    });
    const client = createILinkClient();

    const session = await client.requestLinkQr();

    expect(session.loginSessionId).toBe('qr-abc');
    expect(session.qrDataUri).toMatch(/^data:image\/png;base64,/);
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['AuthorizationType']).toBe('ilink_bot_token');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['X-WECHAT-UIN']).toBeTruthy();
    expect(JSON.parse(init?.body as string)).toEqual({ local_token_list: [] });
  });

  test('pollLinkStatus() GETs get_qrcode_status with no auth headers at all', async () => {
    mockFetchOnce(200, { status: 'wait' });
    const client = createILinkClient();

    const result = await client.pollLinkStatus('qr-abc');

    expect(result).toEqual({ linked: false });
    const [{ url, init }] = calls;
    expect(url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr-abc');
    expect(init?.method).toBe('GET');
    const headers = init?.headers as Record<string, string>;
    expect(headers['AuthorizationType']).toBeUndefined();
    expect(headers['X-WECHAT-UIN']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
  });

  test('pollLinkStatus() maps a "confirmed" response to full credentials', async () => {
    mockFetchOnce(200, {
      status: 'confirmed',
      bot_token: 'bt-1',
      ilink_bot_id: 'bot-1',
      baseurl: 'https://redirected.example',
      ilink_user_id: 'user-1',
    });
    const client = createILinkClient();

    const result = await client.pollLinkStatus('qr-abc');

    expect(result).toEqual({
      linked: true,
      credentials: { accountId: 'bot-1', token: 'bt-1', baseUrl: 'https://redirected.example' },
    });
  });

  test.each(['need_verifycode', 'verify_code_blocked', 'expired', 'scaned'])(
    'pollLinkStatus() treats status %s as "not yet linked" (no verification-code UI path)',
    async (status) => {
      mockFetchOnce(200, { status });
      const client = createILinkClient();
      expect(await client.pollLinkStatus('qr-abc')).toEqual({ linked: false });
    },
  );

  test('getUpdates() sends the previous cursor and Authorization, filters out message_type 2 (bot echo), maps fields', async () => {
    mockFetchOnce(200, {
      ret: 0,
      get_updates_buf: 'cursor-2',
      msgs: [
        {
          message_id: 'm1',
          from_user_id: 'u1',
          to_user_id: 'bot-1',
          message_type: 1,
          create_time_ms: 1700000000000,
          context_token: 'ctx-1',
          item_list: [{ type: 1, text_item: { text: 'hello' } }],
        },
        {
          message_id: 'm2',
          from_user_id: 'bot-1',
          to_user_id: 'u1',
          message_type: 2,
          item_list: [{ type: 1, text_item: { text: 'echo of our own reply' } }],
        },
      ],
    });
    const client = createILinkClient();

    const updates = await client.getUpdates(CREDS, 35);

    expect(updates).toEqual([
      { id: 'm1', fromId: 'u1', text: 'hello', timestamp: 1700000000000, contextToken: 'ctx-1' },
    ]);
    const [{ url, init }] = calls;
    expect(url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/getupdates');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-1');
    expect(JSON.parse(init?.body as string)).toEqual({
      get_updates_buf: '',
      base_info: { channel_version: expect.any(String), bot_agent: 'GetPod' },
    });
  });

  test('getUpdates() persists the returned cursor and sends it on the next call', async () => {
    let call = 0;
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, json: async () => ({ ret: 0, get_updates_buf: 'cursor-A', msgs: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ret: 0, get_updates_buf: 'cursor-B', msgs: [] }) } as Response;
    }) as typeof fetch;
    const client = createILinkClient();

    await client.getUpdates(CREDS, 35);
    await client.getUpdates(CREDS, 35);

    expect(JSON.parse(calls[0].init?.body as string).get_updates_buf).toBe('');
    expect(JSON.parse(calls[1].init?.body as string).get_updates_buf).toBe('cursor-A');
  });

  test('getUpdates() throws on a non-zero ret', async () => {
    mockFetchOnce(200, { ret: -14, errmsg: 'session paused' });
    const client = createILinkClient();
    await expect(client.getUpdates(CREDS, 35)).rejects.toThrow(/ret=-14/);
  });

  test('sendText() posts the documented message shape and resolves on ret=0', async () => {
    mockFetchOnce(200, { ret: 0, errmsg: '' });
    const client = createILinkClient();

    await expect(client.sendText(CREDS, 'u1', 'hello', 'ctx-1')).resolves.toBeUndefined();

    const [{ url, init }] = calls;
    expect(url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
    const body = JSON.parse(init?.body as string);
    expect(body.msg).toMatchObject({
      to_user_id: 'u1',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    });
    expect(typeof body.msg.client_id).toBe('string');
    expect(body.msg.client_id.length).toBeGreaterThan(0);
    expect(body.base_info).toEqual({ channel_version: expect.any(String), bot_agent: 'GetPod' });
  });

  test('sendText() sends an empty string context_token when none is known yet', async () => {
    mockFetchOnce(200, { ret: 0 });
    const client = createILinkClient();
    await client.sendText(CREDS, 'u1', 'hi', undefined);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.msg.context_token).toBe('');
  });

  test('sendText() throws on a non-zero ret', async () => {
    mockFetchOnce(200, { ret: 1, errmsg: 'boom' });
    const client = createILinkClient();
    await expect(client.sendText(CREDS, 'u1', 'hi')).rejects.toThrow(/boom/);
  });

  test('a non-2xx HTTP response throws before any ret/errmsg parsing', async () => {
    mockFetchOnce(500, {});
    const client = createILinkClient();
    await expect(client.getUpdates(CREDS, 35)).rejects.toThrow(/HTTP 500/);
  });

  test('an explicit baseUrl overrides the default host for the pre-auth QR flow', async () => {
    mockFetchOnce(200, { qrcode: 'q', qrcode_img_content: 'AAA' });
    const client = createILinkClient('https://custom.example');
    await client.requestLinkQr();
    expect(calls[0].url).toBe('https://custom.example/ilink/bot/get_bot_qrcode?bot_type=3');
  });

  test('post-auth calls use the credentials baseUrl, not the QR-flow default', async () => {
    mockFetchOnce(200, { ret: 0, msgs: [] });
    const client = createILinkClient('https://ilinkai.weixin.qq.com');
    await client.getUpdates({ ...CREDS, baseUrl: 'https://redirected.example' }, 35);
    expect(calls[0].url).toBe('https://redirected.example/ilink/bot/getupdates');
  });
});
