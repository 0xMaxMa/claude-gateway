/**
 * Unit: the inbound-media download branch of the REAL LINE webhook handler
 * (`handlePost` in src/api/line-webhook-router.ts).
 *
 * These paths are the ones a mocked-away blob client normally hides: what the
 * agent is told when the bytes DON'T arrive, and what is left behind on disk when
 * a transfer dies half-way. Both are driven end-to-end here — signed events go in,
 * a throwaway HTTP server stands in for the agent's /channel intake and captures
 * exactly what the agent would have received.
 *
 * Only the LINE SDK is mocked (its blob client is scripted per-test);
 * `validateSignature`, the access gate, the normalizer, the sanitisers and the
 * temp-file handling are all the real ones.
 */
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

// jest.mock factories may only close over names starting with "mock".
const mockGetMessageContent = jest.fn();

jest.mock('@line/bot-sdk', () => {
  const actual = jest.requireActual('@line/bot-sdk');
  class MockMessagingApiClient {
    constructor(_opts: unknown) {}
    async replyMessage() { return {}; }
    async pushMessage() { return {}; }
    async showLoadingAnimation() { return {}; }
    async getProfile() { return { displayName: 'x' }; }
  }
  class MockBlobClient {
    constructor(_opts: unknown) {}
    async getMessageContent(id: string) { return mockGetMessageContent(id); }
  }
  return {
    ...actual,
    messagingApi: {
      ...actual.messagingApi,
      MessagingApiClient: MockMessagingApiClient,
      MessagingApiBlobClient: MockBlobClient,
    },
  };
});

// eslint-disable-next-line import/first
import { createLineWebhookHandler } from '../../src/api/line-webhook-router';
// eslint-disable-next-line import/first
import { MediaStore } from '../../src/history/media-store';
// eslint-disable-next-line import/first
import type { AgentRunner } from '../../src/agent/runner';

const AGENT = 'line-agent';
const SECRET = 'test-channel-secret';
const USER = 'U-line-1';

type Forwarded = { content?: string; meta?: Record<string, string> };

/** Async iterable of the given chunks; optionally throws after emitting them. */
function streamOf(chunks: Buffer[], throwAfter?: Error): AsyncIterable<Buffer> & { destroy?: () => void } {
  return {
    destroy() { /* the handler calls this to stop an over-cap transfer */ },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
      if (throwAfter) throw throwAfter;
    },
  };
}

function fakeRunner(port: number): AgentRunner {
  return {
    getAgentConfig: () => ({
      id: AGENT,
      line: { channelSecret: SECRET, channelAccessToken: 'tok', dmPolicy: 'open' },
    }),
    getGatewayPublicUrl: () => undefined,
    getCallbackPort: () => port,
  } as unknown as AgentRunner;
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res as never);
  res.json.mockReturnValue(res as never);
  return res;
}

describe('LINE inbound file download (real handlePost)', () => {
  let server: http.Server;
  let forwarded: Forwarded[];
  let handler: ReturnType<typeof createLineWebhookHandler>;
  let logDir: string;
  let msgId: string;
  let seq = 0;

  beforeAll(async () => {
    forwarded = [];
    server = http.createServer((req, res) => {
      const body: Buffer[] = [];
      req.on('data', (c: Buffer) => body.push(c));
      req.on('end', () => {
        try { forwarded.push(JSON.parse(Buffer.concat(body).toString('utf8')) as Forwarded); } catch { /* ignore */ }
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    forwarded.length = 0;
    mockGetMessageContent.mockReset();
    logDir = logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'gw-line-log-'));
    // A distinct id per test so the temp-file scan below can never see another
    // test's staging file.
    msgId = `m${Date.now()}x${seq++}`;
    const port = (server.address() as { port: number }).port;
    handler = createLineWebhookHandler(new Map([[AGENT, fakeRunner(port)]]), logDir);
  });

  /** Staging files this message would have produced, still on disk. */
  function stagedLeftovers(): string[] {
    return fs.readdirSync(os.tmpdir()).filter((f) => f.includes(`-${msgId}-`));
  }

  function post(events: unknown[]) {
    const buf = Buffer.from(JSON.stringify({ events }));
    const sig = createHmac('sha256', SECRET).update(buf).digest('base64');
    const req = {
      params: { agentId: AGENT },
      header: (h: string) => (h.toLowerCase() === 'x-line-signature' ? sig : undefined),
      headers: {},
      body: buf,
    };
    return handler.handlePost(req as never, makeRes() as never);
  }

  function fileEvent(fileName: string, fileSize = 1234) {
    return {
      type: 'message',
      mode: 'active',
      timestamp: 1,
      source: { type: 'user', userId: USER },
      replyToken: 'rt-1',
      message: { id: msgId, type: 'file', fileName, fileSize },
    };
  }

  afterEach(() => {
    for (const f of stagedLeftovers()) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  });

  test('a successful download hands the agent a readable path and marks it ephemeral', async () => {
    mockGetMessageContent.mockResolvedValue(streamOf([Buffer.from('%PDF-1.4 hello')]));
    await post([fileEvent('report.pdf')]);

    expect(forwarded).toHaveLength(1);
    const { content, meta } = forwarded[0]!;
    expect(content).toBe('(file: report.pdf)');
    expect(meta!.image_path).toMatch(/line-file-.*\.pdf$/);
    expect(fs.existsSync(meta!.image_path!)).toBe(true);
    expect(fs.readFileSync(meta!.image_path!, 'utf8')).toBe('%PDF-1.4 hello');
    // The runner deletes the staging copy once MediaStore has its own.
    expect(meta!.media_ephemeral).toBe('1');
  });

  test('a failed download says so instead of looking like an attachment to open', async () => {
    // Pre-fix this forwarded `(file: report.pdf)` + attachment_kind with no
    // image_path — indistinguishable from a file the agent simply hasn't read.
    mockGetMessageContent.mockRejectedValue(new Error('socket hang up'));
    await post([fileEvent('report.pdf')]);

    expect(forwarded).toHaveLength(1);
    const { content, meta } = forwarded[0]!;
    expect(content).toBe('(file: report.pdf — not available: the download failed)');
    expect(meta!.image_path).toBeUndefined();
    expect(meta!.media_ephemeral).toBeUndefined();
    // The turn still reaches the agent — dropping it would be the #429 bug again.
    expect(meta!.attachment_name).toBe('report.pdf');
  });

  test('an oversized file is rejected on the declared size, before a byte is fetched', async () => {
    await post([fileEvent('huge.zip', MediaStore.maxUploadBytes + 1)]);

    expect(mockGetMessageContent).not.toHaveBeenCalled();
    const { content, meta } = forwarded[0]!;
    expect(content).toContain('not available: larger than the');
    expect(content).toContain('MB limit');
    expect(meta!.image_path).toBeUndefined();
  });

  test('a transfer that dies mid-stream leaves no partial file behind', async () => {
    mockGetMessageContent.mockResolvedValue(
      streamOf([Buffer.from('partial bytes')], new Error('ECONNRESET')),
    );
    await post([fileEvent('report.pdf')]);

    // Pre-fix the partial `.tmp` stayed in os.tmpdir() forever (nothing sweeps it)
    // along with the write handle that was never closed.
    expect(stagedLeftovers()).toEqual([]);
    expect(forwarded[0]!.content).toBe('(file: report.pdf — not available: the download failed)');
    expect(forwarded[0]!.meta!.image_path).toBeUndefined();
  });

  test('a stream that overruns the cap is cut off, cleaned up, and reported as too large', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    const chunks = Array.from({ length: Math.ceil(MediaStore.maxUploadBytes / chunk.length) + 1 }, () => chunk);
    mockGetMessageContent.mockResolvedValue(streamOf(chunks));
    // Declared size understates the truth, so only the streaming cap can catch it.
    await post([fileEvent('sneaky.zip', 10)]);

    expect(stagedLeftovers()).toEqual([]);
    expect(forwarded[0]!.content).toContain('not available: larger than the');
    expect(forwarded[0]!.meta!.image_path).toBeUndefined();
  });

  test('an empty upload is reported rather than forwarded as a readable file', async () => {
    mockGetMessageContent.mockResolvedValue(streamOf([]));
    await post([fileEvent('empty.pdf')]);

    expect(stagedLeftovers()).toEqual([]);
    expect(forwarded[0]!.content).toBe('(file: empty.pdf — not available: the sender uploaded no content)');
    expect(forwarded[0]!.meta!.image_path).toBeUndefined();
  });

  test('a browser-active name is staged as .bin, and the agent still gets the real name', async () => {
    mockGetMessageContent.mockResolvedValue(streamOf([Buffer.from('<svg onload=alert(1)>')]));
    await post([fileEvent('logo.svg')]);

    const { meta } = forwarded[0]!;
    expect(meta!.image_path).toMatch(/\.bin$/);
    expect(meta!.attachment_name).toBe('logo.svg');
  });

  test('a text message is untouched by any of this', async () => {
    await post([{
      type: 'message',
      mode: 'active',
      timestamp: 1,
      source: { type: 'user', userId: USER },
      replyToken: 'rt-1',
      message: { id: msgId, type: 'text', text: 'hello' },
    }]);

    expect(mockGetMessageContent).not.toHaveBeenCalled();
    expect(forwarded[0]!.content).toBe('hello');
    expect(forwarded[0]!.meta!.image_path).toBeUndefined();
    expect(forwarded[0]!.meta!.media_ephemeral).toBeUndefined();
  });
});
