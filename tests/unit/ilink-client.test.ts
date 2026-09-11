/**
 * Unit tests for src/wechat/ilink-client.ts's real implementation — the HTTP
 * contract against Tencent's iLink Bot API ("WeChat ClawBot"), as documented
 * in Tencent/openclaw-weixin's own docs/protocol.md (the canonical source —
 * see this module's doc comment for how that was confirmed). `global.fetch`
 * is always mocked here — there is no live account to test against.
 */
import * as crypto from 'crypto';
import {
  createILinkClient,
  encodeClientVersion,
  normalizeQrImage,
  resolveWeixinImageRef,
  resolveWeixinFileRef,
  aes128EcbDecryptPermissive,
  downloadWeixinImage,
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

    expect(result).toEqual({ linked: false, status: 'wait' });
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
      status: 'confirmed',
      credentials: { accountId: 'bot-1', token: 'bt-1', baseUrl: 'https://redirected.example' },
    });
  });

  test.each(['need_verifycode', 'verify_code_blocked', 'expired', 'scaned'])(
    'pollLinkStatus() treats status %s as "not yet linked" (no verification-code UI path)',
    async (status) => {
      mockFetchOnce(200, { status });
      const client = createILinkClient();
      expect(await client.pollLinkStatus('qr-abc')).toEqual({ linked: false, status });
    },
  );

  test('pollLinkStatus() switches to redirect_host after "scaned_but_redirect", then polls that host for the same loginSessionId', async () => {
    let call = 0;
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'scaned_but_redirect', redirect_host: 'https://redirect.example' }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'confirmed',
          bot_token: 'bt-1',
          ilink_bot_id: 'bot-1',
          ilink_user_id: 'user-1',
        }),
      } as Response;
    }) as typeof fetch;
    const client = createILinkClient();

    const first = await client.pollLinkStatus('qr-abc');
    expect(first).toEqual({ linked: false, status: 'scaned_but_redirect' });
    expect(calls[0].url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr-abc');

    const second = await client.pollLinkStatus('qr-abc');
    expect(second.linked).toBe(true);
    expect(calls[1].url).toBe('https://redirect.example/ilink/bot/get_qrcode_status?qrcode=qr-abc');
  });

  test('a schemeless redirect_host (confirmed live shape, e.g. "ilinkai2.weixin.qq.com") is normalized to https:// before the next poll', async () => {
    let call = 0;
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'scaned_but_redirect', redirect_host: 'ilinkai2.weixin.qq.com' }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'confirmed', bot_token: 'bt-1', ilink_bot_id: 'bot-1' }),
      } as Response;
    }) as typeof fetch;
    const client = createILinkClient();

    await client.pollLinkStatus('qr-abc');
    const second = await client.pollLinkStatus('qr-abc');

    expect(second.linked).toBe(true);
    expect(calls[1].url).toBe('https://ilinkai2.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr-abc');
  });

  test('a schemeless baseurl on a confirmed response is normalized before being stored as credentials', async () => {
    mockFetchOnce(200, {
      status: 'confirmed',
      bot_token: 'bt-1',
      ilink_bot_id: 'bot-1',
      baseurl: 'ilinkai3.weixin.qq.com',
    });
    const client = createILinkClient();
    const result = await client.pollLinkStatus('qr-abc');
    expect(result.credentials?.baseUrl).toBe('https://ilinkai3.weixin.qq.com');
  });

  test('an unrelated loginSessionId is unaffected by another attempt\'s redirect_host', async () => {
    let call = 0;
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'scaned_but_redirect', redirect_host: 'https://redirect.example' }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ status: 'wait' }) } as Response;
    }) as typeof fetch;
    const client = createILinkClient();

    await client.pollLinkStatus('qr-session-A');
    await client.pollLinkStatus('qr-session-B');

    expect(calls[1].url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr-session-B');
  });

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

  test('getUpdates() treats a response with NO ret field at all as success (confirmed live shape — ret is only ever present on failure)', async () => {
    mockFetchOnce(200, {
      msgs: [
        {
          message_id: 'm1',
          from_user_id: 'u1',
          to_user_id: 'bot-1',
          message_type: 1,
          item_list: [{ type: 1, text_item: { text: 'hi' } }],
        },
      ],
      get_updates_buf: 'cursor-1',
    });
    const client = createILinkClient();
    const updates = await client.getUpdates(CREDS, 35);
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toBe('hi');
  });

  test('getUpdates() populates image on the mapped update when the raw item is type=2', async () => {
    mockFetchOnce(200, {
      msgs: [
        {
          message_id: 'm1',
          from_user_id: 'u1',
          to_user_id: 'bot-1',
          message_type: 1,
          item_list: [
            {
              type: 2,
              image_item: { media: { encrypt_query_param: 'abc123' } },
            },
          ],
        },
      ],
    });
    const client = createILinkClient();
    const updates = await client.getUpdates(CREDS, 35);
    expect(updates[0].image).toEqual({
      url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc123',
      aesKey: undefined,
    });
  });

  test('getUpdates() drops just the image (not the whole message) when a full_url host fails the CDN allowlist', async () => {
    mockFetchOnce(200, {
      msgs: [
        {
          message_id: 'm1',
          from_user_id: 'u1',
          to_user_id: 'bot-1',
          message_type: 1,
          item_list: [{ type: 2, image_item: { media: { full_url: 'https://evil.example/x' } } }],
        },
      ],
    });
    const client = createILinkClient();
    const updates = await client.getUpdates(CREDS, 35);
    expect(updates).toHaveLength(1);
    expect(updates[0].image).toBeUndefined();
  });

  test('getUpdates() populates file on the mapped update when the raw item is type=4', async () => {
    mockFetchOnce(200, {
      msgs: [
        {
          message_id: 'm1',
          from_user_id: 'u1',
          to_user_id: 'bot-1',
          message_type: 1,
          item_list: [
            { type: 4, file_item: { file_name: 'report.pdf', media: { encrypt_query_param: 'xyz' } } },
          ],
        },
      ],
    });
    const client = createILinkClient();
    const updates = await client.getUpdates(CREDS, 35);
    expect(updates[0].file).toEqual({
      url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=xyz',
      aesKey: undefined,
      fileName: 'report.pdf',
    });
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

  test('sendText() resolves when the response has no ret field (confirmed live shape: {"message_id": ...} only)', async () => {
    mockFetchOnce(200, { message_id: '7503985423426090824' });
    const client = createILinkClient();
    await expect(client.sendText(CREDS, 'u1', 'hi')).resolves.toBeUndefined();
  });

  test('a non-2xx HTTP response throws before any ret/errmsg parsing', async () => {
    mockFetchOnce(500, {});
    const client = createILinkClient();
    await expect(client.getUpdates(CREDS, 35)).rejects.toThrow(/HTTP 500/);
  });

  test('notifyStart() POSTs msg/notifystart with base_info and Authorization, per Tencent\'s own client', async () => {
    mockFetchOnce(200, { ret: 0, errmsg: '' });
    const client = createILinkClient();

    await expect(client.notifyStart(CREDS)).resolves.toBeUndefined();

    const [{ url, init }] = calls;
    expect(url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystart');
    expect(JSON.parse(init?.body as string)).toEqual({
      base_info: { channel_version: expect.any(String), bot_agent: 'GetPod' },
    });
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-1');
  });

  test('notifyStop() POSTs msg/notifystop', async () => {
    mockFetchOnce(200, { ret: 0 });
    const client = createILinkClient();
    await client.notifyStop(CREDS);
    expect(calls[0].url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystop');
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

describe('resolveWeixinImageRef() — inbound image protocol (protocol.md + Hermes-agent, confirmed 2026-09-11)', () => {
  test('returns undefined for a text-only item list', () => {
    expect(resolveWeixinImageRef([{ type: 1, text_item: { text: 'hi' } }])).toBeUndefined();
  });

  test('returns undefined when items is undefined', () => {
    expect(resolveWeixinImageRef(undefined)).toBeUndefined();
  });

  test('builds the URL from encrypt_query_param against the default CDN base when full_url is absent', () => {
    const ref = resolveWeixinImageRef([
      { type: 2, image_item: { media: { encrypt_query_param: 'a b&c' } } },
    ]);
    expect(ref?.url).toBe(
      'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=' +
        encodeURIComponent('a b&c'),
    );
  });

  test('prefers full_url over encrypt_query_param when both are present, if the host is allowlisted', () => {
    const ref = resolveWeixinImageRef([
      {
        type: 2,
        image_item: {
          media: { full_url: 'https://mmbiz.qpic.cn/x/y.jpg', encrypt_query_param: 'unused' },
        },
      },
    ]);
    expect(ref?.url).toBe('https://mmbiz.qpic.cn/x/y.jpg');
  });

  test('throws when full_url\'s host is not in the CDN allowlist (SSRF guard)', () => {
    expect(() =>
      resolveWeixinImageRef([{ type: 2, image_item: { media: { full_url: 'https://evil.example/x' } } }]),
    ).toThrow(/non-allowlisted host/);
  });

  test('accepts the real .wechat.com CDN host confirmed live 2026-09-11 (docs/Hermes-agent\'s allowlist assumed .weixin.qq.com only)', () => {
    const ref = resolveWeixinImageRef([
      {
        type: 2,
        image_item: { media: { full_url: 'https://novac2c.cdn.wechat.com/c2c/download?encrypted_query_param=x' } },
      },
    ]);
    expect(ref?.url).toBe('https://novac2c.cdn.wechat.com/c2c/download?encrypted_query_param=x');
  });

  test('prefers image_item.aeskey (raw hex) over media.aes_key when both are present', () => {
    const rawKey = crypto.randomBytes(16);
    const ref = resolveWeixinImageRef([
      {
        type: 2,
        image_item: {
          aeskey: rawKey.toString('hex'),
          media: {
            encrypt_query_param: 'q',
            // A different, wrong key — proves aeskey won, not this.
            aes_key: Buffer.from(crypto.randomBytes(16)).toString('base64'),
          },
        },
      },
    ]);
    expect(ref?.aesKey).toEqual(rawKey);
  });

  test('falls back to media.aes_key (base64 of 16 raw bytes) when aeskey is absent', () => {
    const rawKey = crypto.randomBytes(16);
    const ref = resolveWeixinImageRef([
      { type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: rawKey.toString('base64') } } },
    ]);
    expect(ref?.aesKey).toEqual(rawKey);
  });

  test('decodes media.aes_key when it is base64 of a 32-char hex STRING (double-encoded form)', () => {
    const rawKey = crypto.randomBytes(16);
    const hexString = rawKey.toString('hex'); // 32 ASCII hex chars
    const doubleEncoded = Buffer.from(hexString, 'ascii').toString('base64');
    const ref = resolveWeixinImageRef([
      { type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: doubleEncoded } } },
    ]);
    expect(ref?.aesKey).toEqual(rawKey);
  });

  test('resolves no aesKey (plaintext bytes) when neither aeskey nor media.aes_key is present', () => {
    const ref = resolveWeixinImageRef([{ type: 2, image_item: { media: { encrypt_query_param: 'q' } } }]);
    expect(ref?.aesKey).toBeUndefined();
  });
});

describe('resolveWeixinFileRef() — inbound file protocol (type=4, e.g. a PDF)', () => {
  test('returns undefined for a text-only item list', () => {
    expect(resolveWeixinFileRef([{ type: 1, text_item: { text: 'hi' } }])).toBeUndefined();
  });

  test('returns undefined for an image item (type=2), not a file', () => {
    expect(
      resolveWeixinFileRef([{ type: 2, image_item: { media: { encrypt_query_param: 'q' } } }]),
    ).toBeUndefined();
  });

  test('resolves the filename, URL, and AES key from media.aes_key (files have no top-level aeskey per protocol.md)', () => {
    const rawKey = crypto.randomBytes(16);
    const ref = resolveWeixinFileRef([
      {
        type: 4,
        file_item: {
          file_name: 'report.pdf',
          media: { encrypt_query_param: 'q', aes_key: rawKey.toString('base64') },
        },
      },
    ]);
    expect(ref?.fileName).toBe('report.pdf');
    expect(ref?.aesKey).toEqual(rawKey);
    expect(ref?.url).toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=q');
  });

  test('falls back to a generic "file" name when file_name is absent', () => {
    const ref = resolveWeixinFileRef([{ type: 4, file_item: { media: { encrypt_query_param: 'q' } } }]);
    expect(ref?.fileName).toBe('file');
  });

  test('parses file_item.len into expectedLength', () => {
    const ref = resolveWeixinFileRef([
      { type: 4, file_item: { file_name: 'x.pdf', len: '12345', media: { encrypt_query_param: 'q' } } },
    ]);
    expect(ref?.expectedLength).toBe(12345);
  });

  test('leaves expectedLength undefined when len is absent or non-numeric', () => {
    const ref = resolveWeixinFileRef([
      { type: 4, file_item: { file_name: 'x.pdf', len: 'not-a-number', media: { encrypt_query_param: 'q' } } },
    ]);
    expect(ref?.expectedLength).toBeUndefined();
  });

  test('throws when full_url\'s host is not in the CDN allowlist (SSRF guard, same as images)', () => {
    expect(() =>
      resolveWeixinFileRef([{ type: 4, file_item: { file_name: 'x.pdf', media: { full_url: 'https://evil.example/x' } } }]),
    ).toThrow(/non-allowlisted host/);
  });
});

describe('aes128EcbDecryptPermissive()', () => {
  function encryptPkcs7(plaintext: Buffer, key: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
  }

  test('round-trips a real AES-128-ECB/PKCS#7 ciphertext', () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from('this is a real inbound WeChat image payload, padded by PKCS7');
    const ciphertext = encryptPkcs7(plaintext, key);
    expect(aes128EcbDecryptPermissive(ciphertext, key)).toEqual(plaintext);
  });

  test('round-trips an exact-block-size plaintext (full extra padding block)', () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.alloc(32, 0x41); // exactly 2 blocks
    const ciphertext = encryptPkcs7(plaintext, key);
    expect(aes128EcbDecryptPermissive(ciphertext, key)).toEqual(plaintext);
  });

  test('returns the padded bytes as-is when the trailing padding does not validate (permissive fallback)', () => {
    const key = crypto.randomBytes(16);
    // Encrypt raw, unpadded block-aligned bytes whose last byte (0x99) is not
    // a valid PKCS#7 pad — real-world data this protocol has to tolerate.
    const rawBlock = Buffer.concat([Buffer.alloc(15, 0x00), Buffer.from([0x99])]);
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    const ciphertext = Buffer.concat([cipher.update(rawBlock), cipher.final()]);
    expect(aes128EcbDecryptPermissive(ciphertext, key)).toEqual(rawBlock);
  });
});

describe('downloadWeixinImage()', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('downloads and decrypts when aesKey is present', async () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from('a decrypted image byte stream');
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    global.fetch = (async () =>
      ({ ok: true, status: 200, arrayBuffer: async () => ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) }) as Response) as typeof fetch;

    const result = await downloadWeixinImage({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/x', aesKey: key });
    expect(result).toEqual(plaintext);
  });

  test('returns raw bytes unchanged when aesKey is absent', async () => {
    const raw = Buffer.from('already-plaintext bytes');
    global.fetch = (async () =>
      ({ ok: true, status: 200, arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) }) as Response) as typeof fetch;

    const result = await downloadWeixinImage({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' });
    expect(result).toEqual(raw);
  });

  test('trims a leading prefix to expectedLength (confirmed live 2026-09-11: a real decrypted PDF carried 3 extra bytes before %PDF-)', async () => {
    const key = crypto.randomBytes(16);
    const realContent = Buffer.from('%PDF-1.7 this is the real file content');
    const withPrefix = Buffer.concat([Buffer.from([0x0d, 0x0a, 0x09]), realContent]);
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    const ciphertext = Buffer.concat([cipher.update(withPrefix), cipher.final()]);
    global.fetch = (async () =>
      ({ ok: true, status: 200, arrayBuffer: async () => ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) }) as Response) as typeof fetch;

    const result = await downloadWeixinImage({
      url: 'https://novac2c.cdn.weixin.qq.com/c2c/x',
      aesKey: key,
      expectedLength: realContent.length,
    });
    expect(result).toEqual(realContent);
  });

  test('leaves bytes untouched when expectedLength matches (or is not shorter than) the decrypted length', async () => {
    const raw = Buffer.from('exact-length content, no trimming needed');
    global.fetch = (async () =>
      ({ ok: true, status: 200, arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) }) as Response) as typeof fetch;

    const result = await downloadWeixinImage({
      url: 'https://novac2c.cdn.weixin.qq.com/c2c/x',
      expectedLength: raw.length,
    });
    expect(result).toEqual(raw);
  });

  test('throws on a non-2xx HTTP response', async () => {
    global.fetch = (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch;
    await expect(
      downloadWeixinImage({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' }),
    ).rejects.toThrow(/HTTP 404/);
  });

  test('rejects on a declared Content-Length above maxBytes without buffering the body', async () => {
    let bodyRead = false;
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h === 'content-length' ? '999999' : null) },
        arrayBuffer: async () => {
          bodyRead = true;
          return new ArrayBuffer(0);
        },
      }) as unknown as Response) as typeof fetch;

    await expect(
      downloadWeixinImage({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' }, { maxBytes: 100 }),
    ).rejects.toThrow(/exceeds 100 byte cap/);
    expect(bodyRead).toBe(false);
  });

  test('rejects when the actual downloaded size exceeds maxBytes (no honest Content-Length header)', async () => {
    const big = Buffer.alloc(200, 0x41);
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
      }) as unknown as Response) as typeof fetch;

    await expect(
      downloadWeixinImage({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' }, { maxBytes: 100 }),
    ).rejects.toThrow(/exceeds 100 byte cap/);
  });

  test('accepts a response with no headers object at all (defensive — not every fetch impl guarantees one)', async () => {
    const raw = Buffer.from('small payload');
    global.fetch = (async () =>
      ({ ok: true, status: 200, arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) }) as Response) as typeof fetch;

    const result = await downloadWeixinImage({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' });
    expect(result).toEqual(raw);
  });

  test('refuses to follow a redirect — an allowlisted host redirecting elsewhere must not bypass the SSRF guard', async () => {
    let calls = 0;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      expect(init?.redirect).toBe('manual');
      return { ok: false, status: 0, type: 'opaqueredirect' } as unknown as Response;
    }) as typeof fetch;

    await expect(
      downloadWeixinImage({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' }),
    ).rejects.toThrow(/refusing to follow a redirect/);
    expect(calls).toBe(1);
  });

  test('refuses a plain 3xx response too (in case a fetch impl surfaces it that way instead of opaqueredirect)', async () => {
    global.fetch = (async () => ({ ok: false, status: 302 }) as Response) as typeof fetch;
    await expect(
      downloadWeixinImage({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' }),
    ).rejects.toThrow(/refusing to follow a redirect/);
  });
});
