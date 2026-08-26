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
});
