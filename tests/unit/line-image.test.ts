/**
 * Unit: the `line_image` MCP tool's image delivery (mcp/tools/line/module.ts).
 *
 * LINE delivery mints a short-lived share token via the gateway share bridge (the
 * same `/shared/:token` primitive the image tools use) and builds a public URL from
 * the base the gateway derived from the inbound webhook (`<workspace>/../.public-base`).
 * We mock BOTH the LINE SDK (to inspect the built message without a network call)
 * and the share-bridge client (so no gateway HTTP call is made).
 *
 * NOTE: mcp/ has its OWN node_modules (bun install), so module.ts resolves
 * '@line/bot-sdk' from mcp/node_modules — NOT the repo root. The mock therefore
 * targets that physical copy so it actually intercepts the client the tool uses.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockPush = jest.fn(async (_req: unknown) => ({}));
const mockReply = jest.fn(async (_req: unknown) => ({}));

jest.mock('../../mcp/node_modules/@line/bot-sdk', () => ({
  messagingApi: {
    MessagingApiClient: class {
      pushMessage = mockPush;
      replyMessage = mockReply;
    },
  },
}));

// Share bridge: mock the client so no gateway HTTP call happens. createShares is
// controllable per-test; shareBridgeEnabled is forced on (the real one checks env).
const mockCreateShares = jest.fn();
jest.mock('../../mcp/tools/shared/share-client', () => ({
  createShares: (...args: unknown[]) => mockCreateShares(...args),
  shareBridgeEnabled: () => true,
  ShareClientError: class ShareClientError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

// eslint-disable-next-line import/first
import { LineModule } from '../../mcp/tools/line/module';

describe('line_image delivery via share bridge', () => {
  let tmpDir: string;
  let workspace: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'GATEWAY_WORKSPACE_DIR',
    'GATEWAY_API_KEY',
    'GATEWAY_AGENT_ID',
    'LINE_CHANNEL_ACCESS_TOKEN',
    'GATEWAY_MEDIA_URL_TTL_MS',
  ];

  beforeEach(() => {
    mockPush.mockClear();
    mockReply.mockClear();
    mockCreateShares.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-line-img-'));
    workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    process.env.GATEWAY_WORKSPACE_DIR = workspace;
    process.env.GATEWAY_API_KEY = 'sk-agent';
    process.env.GATEWAY_AGENT_ID = 'baerbel';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'line-token';
    delete process.env.GATEWAY_MEDIA_URL_TTL_MS;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('mints a share token and builds a /shared/<token> URL from .public-base', async () => {
    // <workspace>/../.public-base — trailing whitespace tolerated.
    fs.writeFileSync(path.resolve(workspace, '..', '.public-base'), 'https://pod.example.com/gateway\n');
    // The image must resolve under <workspace>/../media for the media-root check.
    const mediaDir = path.resolve(workspace, '..', 'media', 'U123');
    fs.mkdirSync(mediaDir, { recursive: true });
    const imgPath = path.join(mediaDir, 'pic.png');
    fs.writeFileSync(imgPath, 'x');

    mockCreateShares.mockResolvedValue([
      { share_id: 'shr_1', token: 'TOKENoriginalAAAAAAAAAAAAAAAAAAA', expires_at: '2026-01-01T00:00:00.000Z' },
      { share_id: 'shr_2', token: 'TOKENpreviewBBBBBBBBBBBBBBBBBBBB', expires_at: '2026-01-01T00:00:00.000Z' },
    ]);

    const mod = new LineModule();
    const res = await mod.handleTool('line_image', { chat_id: 'U123', image: imgPath });

    expect(res.isError).toBeFalsy();
    // Minted via the bridge with a media-relative path and the 'line' purpose — NOT
    // an HMAC-signed token anymore.
    expect(mockCreateShares).toHaveBeenCalledTimes(1);
    const [refs, opts] = mockCreateShares.mock.calls[0] as [Array<{ path: string }>, { purpose: string }];
    expect(refs).toEqual([{ path: 'media/U123/pic.png' }, { path: 'media/U123/pic.png' }]);
    expect(opts.purpose).toBe('line');

    expect(mockPush).toHaveBeenCalledTimes(1);
    const arg = mockPush.mock.calls[0][0] as unknown as {
      to: string;
      messages: Array<{ originalContentUrl: string; previewImageUrl: string }>;
    };
    expect(arg.to).toBe('U123');
    expect(arg.messages[0].originalContentUrl).toBe(
      'https://pod.example.com/gateway/shared/TOKENoriginalAAAAAAAAAAAAAAAAAAA',
    );
    expect(arg.messages[0].previewImageUrl).toBe(
      'https://pod.example.com/gateway/shared/TOKENpreviewBBBBBBBBBBBBBBBBBBBB',
    );
    // No /public/ HMAC route anymore.
    expect(arg.messages[0].originalContentUrl).not.toContain('/public/');
  });

  test('missing .public-base → graceful isError, no mint, no send attempted', async () => {
    const mod = new LineModule();
    const res = await mod.handleTool('line_image', {
      chat_id: 'U123',
      image: 'media/U123/pic.png',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/public base not resolved yet/i);
    expect(mockCreateShares).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });

  test('share bridge failure → graceful isError, no send attempted', async () => {
    fs.writeFileSync(path.resolve(workspace, '..', '.public-base'), 'https://pod.example.com/gateway');
    const mediaDir = path.resolve(workspace, '..', 'media', 'U123');
    fs.mkdirSync(mediaDir, { recursive: true });
    const imgPath = path.join(mediaDir, 'pic.png');
    fs.writeFileSync(imgPath, 'x');

    mockCreateShares.mockRejectedValue(new Error('gateway unreachable'));

    const mod = new LineModule();
    const res = await mod.handleTool('line_image', { chat_id: 'U123', image: imgPath });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/failed to mint share URL/i);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });
});
