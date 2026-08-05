/**
 * Unit: the `line_image` MCP tool's public-base resolution (mcp/tools/line/module.ts).
 *
 * The gateway derives its public base URL from the inbound LINE webhook and writes
 * it to `<workspace>/../.public-base`; this tool reads that file at call-time to
 * mint signed `/public/<token>` URLs (no public-base-URL env var). We mock the
 * LINE SDK so we can inspect the built message without hitting the network.
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

// eslint-disable-next-line import/first
import { LineModule } from '../../mcp/tools/line/module';

describe('line_image public-base resolution', () => {
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

  test('reads base from .public-base and builds a signed /public URL', async () => {
    // <workspace>/../.public-base — trailing whitespace tolerated.
    fs.writeFileSync(path.resolve(workspace, '..', '.public-base'), 'https://pod.example.com/gateway\n');
    // The image must resolve under <workspace>/../media for the media-root check.
    const mediaDir = path.resolve(workspace, '..', 'media', 'U123');
    fs.mkdirSync(mediaDir, { recursive: true });
    const imgPath = path.join(mediaDir, 'pic.png');
    fs.writeFileSync(imgPath, 'x');

    const mod = new LineModule();
    const res = await mod.handleTool('line_image', { chat_id: 'U123', image: imgPath });

    expect(res.isError).toBeFalsy();
    expect(mockPush).toHaveBeenCalledTimes(1);
    const arg = mockPush.mock.calls[0][0] as unknown as {
      to: string;
      messages: Array<{ originalContentUrl: string; previewImageUrl: string }>;
    };
    expect(arg.to).toBe('U123');
    expect(arg.messages[0].originalContentUrl).toMatch(
      /^https:\/\/pod\.example\.com\/gateway\/public\//,
    );
    expect(arg.messages[0].previewImageUrl).toMatch(
      /^https:\/\/pod\.example\.com\/gateway\/public\//,
    );
  });

  test('missing .public-base → graceful isError, no send attempted', async () => {
    const mod = new LineModule();
    const res = await mod.handleTool('line_image', {
      chat_id: 'U123',
      image: 'media/U123/pic.png',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/public base not resolved yet/i);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });
});
