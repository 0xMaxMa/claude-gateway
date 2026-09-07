/**
 * Unit tests for the WhatsApp Cloud webhook's inbound media download path
 * (src/api/whatsapp-cloud-webhook-router.ts). `downloadWhatsAppCloudMedia` is
 * not exported (mirrors Slack's unexported `downloadSlackImage`) — the only
 * way to exercise it is to drive the REAL handler with a signed request
 * (mirrors tests/unit/slack-normalize.test.ts's "inbound image download"
 * suite) and inspect what gets forwarded to the agent's /channel callback.
 */
import { createHmac } from 'crypto';
import * as fs from 'fs';
import { createWhatsAppCloudWebhookHandler } from '../../src/api/whatsapp-cloud-webhook-router';
import type { AgentRunner } from '../../src/agent/runner';

const AGENT = 'wa-cloud-agent';
const ACCESS_TOKEN = 'test-access-token';
const PHONE_NUMBER_ID = '1234567890';
const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';
const FROM = '66812345678';
const META_URL = `https://graph.facebook.com/v20.0/media-1?access_token=${ACCESS_TOKEN}`;
const ALLOWED_CDN_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/media-1';
const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);

/**
 * Per-test overrides on the agent's whatsapp_cloud config — read lazily inside
 * getAgentConfig, so a test can flip the Phase-2 receipt switches after the
 * handler was built (the real handler re-reads the config per message too).
 */
let configExtra: Record<string, unknown> = {};

function fakeRunner(): AgentRunner {
  return {
    getAgentConfig: () => ({
      id: AGENT,
      whatsapp_cloud: {
        accessToken: ACCESS_TOKEN,
        phoneNumberId: PHONE_NUMBER_ID,
        appSecret: APP_SECRET,
        verifyToken: VERIFY_TOKEN,
        dmPolicy: 'open',
        ...configExtra,
      },
    }),
    getCallbackPort: () => 0,
  } as unknown as AgentRunner;
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn(), type: jest.fn(), send: jest.fn() };
  res.status.mockReturnValue(res as never);
  res.json.mockReturnValue(res as never);
  res.type.mockReturnValue(res as never);
  return res;
}

describe('WhatsApp Cloud inbound media download', () => {
  const realFetch = global.fetch;
  let handler: ReturnType<typeof createWhatsAppCloudWebhookHandler>;
  let forwarded: Array<{ content: string; meta: Record<string, string> }>;
  let fetchedUrls: string[];
  /** Bodies POSTed to /{phoneNumberId}/messages — the Phase-2 receipt signals. */
  let graphPosts: Array<Record<string, unknown>>;
  let mediaMetaResponse: () => { url?: string; mime_type?: string };
  let mediaBytesResponse: () => Response | Promise<Response>;
  const written: string[] = [];

  /** Drive the real handler with a correctly signed webhook POST. */
  function post(messages: Record<string, unknown>[]) {
    const buf = Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA1',
            changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages } }],
          },
        ],
      }),
    );
    const sig = `sha256=${createHmac('sha256', APP_SECRET).update(buf).digest('hex')}`;
    const req = {
      params: { agentId: AGENT },
      header: (h: string) => (h.toLowerCase() === 'x-hub-signature-256' ? sig : undefined),
      headers: {},
      body: buf,
    };
    return handler.handlePost(req as never, makeRes() as never);
  }

  beforeEach(() => {
    forwarded = [];
    fetchedUrls = [];
    graphPosts = [];
    configExtra = {};
    mediaMetaResponse = () => ({ url: ALLOWED_CDN_URL, mime_type: 'image/jpeg' });
    mediaBytesResponse = () => new Response(IMG);
    handler = createWhatsAppCloudWebhookHandler(new Map([[AGENT, fakeRunner()]]), '/tmp');

    global.fetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url === META_URL) {
        return { ok: true, json: async () => mediaMetaResponse() } as Response;
      }
      if (url === ALLOWED_CDN_URL) {
        return mediaBytesResponse();
      }
      if (url.endsWith('/channel')) {
        forwarded.push(JSON.parse(String(init?.body)));
        return { ok: true, json: async () => ({}) } as Response;
      }
      // Outbound Graph calls — read receipts and ack reactions land here.
      if (url.endsWith(`/${PHONE_NUMBER_ID}/messages`)) {
        graphPosts.push(JSON.parse(String(init?.body ?? '{}')));
        return { ok: true, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    for (const f of written) fs.rmSync(f, { force: true });
    written.length = 0;
  });

  test('image on an allowed host → downloaded, meta.image_path written', async () => {
    await post([{ from: FROM, id: 'wamid.1', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } }]);
    expect(forwarded).toHaveLength(1);
    const imgPath = forwarded[0].meta.image_path;
    expect(imgPath).toBeTruthy();
    written.push(imgPath);
    expect(fs.readFileSync(imgPath)).toEqual(IMG);
  });

  test('host-allowlist rejection: a non-fbcdn.net/graph/lookaside media url → refused before the bearer token is sent', async () => {
    const EVIL = 'https://evil.example.com/steal-my-token';
    mediaMetaResponse = () => ({ url: EVIL, mime_type: 'image/jpeg' });

    await post([{ from: FROM, id: 'wamid.2', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } }]);

    // The metadata endpoint (trusted, hardcoded Graph API host) was hit, but
    // the evil host never was — the bearer token can never leak to it.
    expect(fetchedUrls).toContain(META_URL);
    expect(fetchedUrls).not.toContain(EVIL);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].meta.image_path).toBeUndefined();
  });

  test('size-cap enforcement: declared content-length over the cap → rejected, no image_path, turn still forwards', async () => {
    mediaBytesResponse = () =>
      ({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? String(21 * 1024 * 1024) : null) },
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Response;

    await post([{ from: FROM, id: 'wamid.3', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } }]);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].meta.image_path).toBeUndefined();
  });

  test('size-cap enforcement: no declared content-length but the actual stream exceeds the cap → rejected mid-stream', async () => {
    const chunk = Buffer.alloc(11 * 1024 * 1024, 1); // 11MB; two chunks = 22MB > 20MB cap
    mediaBytesResponse = () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null }, // no content-length declared
        body: {
          async *[Symbol.asyncIterator]() {
            yield chunk;
            yield chunk;
          },
        },
      }) as unknown as Response;

    await post([{ from: FROM, id: 'wamid.4', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } }]);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].meta.image_path).toBeUndefined();
  });

  test('non-PDF document type → download skipped (MediaStore.isAllowedMime rejects it), caption still forwards', async () => {
    mediaMetaResponse = () => ({ url: ALLOWED_CDN_URL, mime_type: 'application/msword' });
    mediaBytesResponse = () => new Response(Buffer.from('fake-doc-bytes'));

    await post([{
      from: FROM,
      id: 'wamid.5',
      type: 'document',
      document: { id: 'media-1', mime_type: 'application/msword', filename: 'report.docx', caption: 'the report' },
    }]);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].meta.document_path).toBeUndefined();
    expect(forwarded[0].content).toBe('the report');
  });

  test('PDF document type → downloaded, meta.document_path written', async () => {
    mediaMetaResponse = () => ({ url: ALLOWED_CDN_URL, mime_type: 'application/pdf' });
    const PDF = Buffer.from('%PDF-1.4 fake');
    mediaBytesResponse = () => new Response(PDF);

    await post([{
      from: FROM,
      id: 'wamid.6',
      type: 'document',
      document: { id: 'media-1', mime_type: 'application/pdf', filename: 'report.pdf', caption: 'the report' },
    }]);

    expect(forwarded).toHaveLength(1);
    const docPath = forwarded[0].meta.document_path;
    expect(docPath).toBeTruthy();
    written.push(docPath);
    expect(fs.readFileSync(docPath)).toEqual(PDF);
    expect(docPath).toMatch(/\.pdf$/);
  });

  // ---- Phase 2 ------------------------------------------------------------

  test('sticker → downloaded onto meta.sticker_path, NEVER image_path', async () => {
    const WEBP = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP'),
      Buffer.from('fake-sticker'),
    ]);
    mediaMetaResponse = () => ({ url: ALLOWED_CDN_URL, mime_type: 'image/webp' });
    mediaBytesResponse = () => new Response(WEBP);

    await post([{ from: FROM, id: 'wamid.7', type: 'sticker', sticker: { id: 'media-1', mime_type: 'image/webp' } }]);

    expect(forwarded).toHaveLength(1);
    const stickerPath = forwarded[0].meta.sticker_path;
    expect(stickerPath).toBeTruthy();
    written.push(stickerPath);
    // image/webp passes MediaStore.isAllowedMime (image/ prefix) and the
    // RIFF/WEBP magic bytes are already recognized by the ext sniffer.
    expect(stickerPath).toMatch(/\.webp$/);
    expect(fs.readFileSync(stickerPath)).toEqual(WEBP);
    // Kept off image_path on purpose, so the agent can tell a sticker from a photo.
    expect(forwarded[0].meta.image_path).toBeUndefined();
  });

  describe('receipt signals', () => {
    const textMsg = [{ from: FROM, id: 'wamid.10', type: 'text', text: { body: 'hi' } }];

    /**
     * Both signals are fired-and-forgotten (`void client.markAsRead(...)`), so
     * give the microtask queue a turn before asserting rather than relying on
     * the handler's own awaits happening to drain them.
     */
    async function postAndSettle(msgs: Record<string, unknown>[]): Promise<void> {
      await post(msgs);
      await new Promise((r) => setImmediate(r));
    }

    test('an accepted message is marked read and gets the ⏳ ack', async () => {
      await postAndSettle(textMsg);
      expect(graphPosts).toEqual(
        expect.arrayContaining([
          { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.10' },
          {
            messaging_product: 'whatsapp',
            to: FROM,
            type: 'reaction',
            reaction: { message_id: 'wamid.10', emoji: '⏳' },
          },
        ]),
      );
      // Neither may block the turn — the forward still happened.
      expect(forwarded).toHaveLength(1);
    });

    test('sendReadReceipts:false drops the read receipt, keeps the ack', async () => {
      configExtra = { sendReadReceipts: false };
      await postAndSettle(textMsg);
      expect(graphPosts.some((b) => b.status === 'read')).toBe(false);
      expect(graphPosts.some((b) => b.type === 'reaction')).toBe(true);
    });

    test("reactionLevel:'off' drops the ack, keeps the read receipt", async () => {
      configExtra = { reactionLevel: 'off' };
      await postAndSettle(textMsg);
      expect(graphPosts.some((b) => b.status === 'read')).toBe(true);
      expect(graphPosts.some((b) => b.type === 'reaction')).toBe(false);
    });

    test('best-effort: a Graph API error on both signals never fails the turn', async () => {
      const failingFetch = global.fetch;
      global.fetch = (async (input: string, init?: RequestInit) => {
        if (String(input).endsWith(`/${PHONE_NUMBER_ID}/messages`)) {
          return { ok: true, json: async () => ({ error: { message: 'nope', code: 100 } }) } as Response;
        }
        return failingFetch(input as never, init);
      }) as typeof fetch;

      await postAndSettle(textMsg);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].content).toBe('hi');
    });
  });
});
