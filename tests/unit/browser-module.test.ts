import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserModule } from '../../mcp/tools/browser/module';

describe('BrowserModule', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    originalEnv = { ...process.env };
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    process.env = originalEnv;
    fetchMock.mockRestore();
  });

  // --- isEnabled ---

  describe('isEnabled', () => {
    it('returns true when GETPOD_BROWSER_DISABLED is not set', () => {
      delete process.env.GETPOD_BROWSER_DISABLED;
      const mod = new BrowserModule();
      expect(mod.isEnabled()).toBe(true);
    });

    it('returns false when GETPOD_BROWSER_DISABLED=true', () => {
      process.env.GETPOD_BROWSER_DISABLED = 'true';
      const mod = new BrowserModule();
      expect(mod.isEnabled()).toBe(false);
    });

    it('returns true when GETPOD_BROWSER_DISABLED is set to a value other than "true"', () => {
      process.env.GETPOD_BROWSER_DISABLED = '1';
      const mod = new BrowserModule();
      expect(mod.isEnabled()).toBe(true);
    });
  });

  // --- getTools ---

  describe('getTools', () => {
    it('returns exactly 17 browser tools', () => {
      const mod = new BrowserModule();
      expect(mod.getTools()).toHaveLength(17);
    });

    it('all tool names are browser_-prefixed', () => {
      const mod = new BrowserModule();
      for (const tool of mod.getTools()) {
        expect(tool.name).toMatch(/^browser_/);
      }
    });

    it('contains all expected tool names', () => {
      const mod = new BrowserModule();
      const names = mod.getTools().map(t => t.name);
      const expected = [
        'browser_create_session',
        'browser_close_session',
        'browser_get_stream_url',
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_fill',
        'browser_type',
        'browser_evaluate',
        'browser_scroll',
        'browser_wait',
        'browser_get_text',
        'browser_new_tab',
        'browser_close_tab',
        'browser_tabs',
        'browser_screenshot',
      ];
      for (const name of expected) {
        expect(names).toContain(name);
      }
    });

    it('browser_create_session has session_id as optional property (auto-injected)', () => {
      const mod = new BrowserModule();
      const tool = mod.getTools().find(t => t.name === 'browser_create_session')!;
      const schema = tool.inputSchema as any;
      expect(schema.properties).toHaveProperty('session_id');
      expect(schema.required ?? []).not.toContain('session_id');
    });

    it('browser_navigate requires url', () => {
      const mod = new BrowserModule();
      const tool = mod.getTools().find(t => t.name === 'browser_navigate')!;
      const schema = tool.inputSchema as any;
      expect(schema.required).toContain('url');
      expect(schema.required ?? []).not.toContain('session_id');
    });

    it('browser_scroll requires position and delta fields', () => {
      const mod = new BrowserModule();
      const tool = mod.getTools().find(t => t.name === 'browser_scroll')!;
      const schema = tool.inputSchema as any;
      for (const field of ['x', 'y', 'deltaX', 'deltaY']) {
        expect(schema.required).toContain(field);
      }
      expect(schema.required ?? []).not.toContain('session_id');
    });

    it('each tool has a non-empty description', () => {
      const mod = new BrowserModule();
      for (const tool of mod.getTools()) {
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });
  });

  // --- module metadata ---

  describe('module metadata', () => {
    it('id is "browser"', () => {
      expect(new BrowserModule().id).toBe('browser');
    });

    it('toolVisibility is "all-configured"', () => {
      expect(new BrowserModule().toolVisibility).toBe('all-configured');
    });
  });

  // --- handleTool / callGetpodBrowser ---

  describe('handleTool', () => {
    it('returns isError:true when fetch throws (getpod-browser down)', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_create_session', { session_id: 'test-session' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('getpod-browser unavailable');
      expect(result.content[0].text).toContain('ECONNREFUSED');
    });

    it('returns isError:true when response has no data: line', async () => {
      fetchMock.mockResolvedValue(new Response('event: ping\n\n', { status: 200 }));
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_navigate', {
        session_id: 'test-session',
        url: 'https://example.com',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('empty response from getpod-browser');
    });

    it('returns isError:true when data line contains invalid JSON', async () => {
      fetchMock.mockResolvedValue(new Response('data: {not-valid-json}\n\n', { status: 200 }));
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_snapshot', { session_id: 'test-session' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('invalid JSON from getpod-browser');
    });

    it('returns isError:true when JSON-RPC returns error field', async () => {
      const rpc = { jsonrpc: '2.0', id: 1, error: { message: 'session not found' } };
      fetchMock.mockResolvedValue(new Response(`data: ${JSON.stringify(rpc)}\n\n`, { status: 200 }));
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_close_session', { session_id: 'bad-session' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('session not found');
    });

    it('returns isError:true when result field is missing', async () => {
      const rpc = { jsonrpc: '2.0', id: 1 };
      fetchMock.mockResolvedValue(new Response(`data: ${JSON.stringify(rpc)}\n\n`, { status: 200 }));
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_tabs', { session_id: 'test-session' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('no result in response');
    });

    it('returns successful result on valid SSE response', async () => {
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: '{"session_id":"test","stream_url":"ws://127.0.0.1:59000"}' }],
          isError: false,
        },
      };
      fetchMock.mockResolvedValue(new Response(`data: ${JSON.stringify(rpc)}\n\n`, { status: 200 }));
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_create_session', { session_id: 'test-session' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      // stream_url is stripped by handleTool before returning to agent
      expect(result.content[0].text).not.toContain('stream_url');
      expect(result.content[0].text).toContain('session_id');
    });

    it('sends correct JSON-RPC body to getpod-browser', async () => {
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
      };
      fetchMock.mockResolvedValue(new Response(`data: ${JSON.stringify(rpc)}\n\n`, { status: 200 }));
      const mod = new BrowserModule();
      await mod.handleTool('browser_navigate', { session_id: 'test-session', url: 'https://example.com' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/mcp');
      expect(init.method).toBe('POST');
      const parsedBody = JSON.parse(init.body as string);
      expect(parsedBody.method).toBe('tools/call');
      expect(parsedBody.params.name).toBe('browser_navigate');
      expect(parsedBody.params.arguments).toEqual({
        session_id: 'test-session',
        url: 'https://example.com',
      });
    });

    it('uses GETPOD_BROWSER_URL env var for endpoint', async () => {
      process.env.GETPOD_BROWSER_URL = 'http://custom-host:9999';
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
      };
      fetchMock.mockResolvedValue(new Response(`data: ${JSON.stringify(rpc)}\n\n`, { status: 200 }));
      const mod = new BrowserModule();
      await mod.handleTool('browser_tabs', { session_id: 'test-session' });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://custom-host:9999/mcp');
    });

    it('sends Authorization: Bearer header when GETPOD_BROWSER_API_KEY is set', async () => {
      process.env.GETPOD_BROWSER_API_KEY = 'test-api-key-abc123';
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
      };
      fetchMock.mockResolvedValue(new Response(`data: ${JSON.stringify(rpc)}\n\n`, { status: 200 }));
      const mod = new BrowserModule();
      await mod.handleTool('browser_snapshot', { session_id: 'test-session' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-api-key-abc123');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('omits Authorization header when GETPOD_BROWSER_API_KEY is not set', async () => {
      delete process.env.GETPOD_BROWSER_API_KEY;
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
      };
      fetchMock.mockResolvedValue(new Response(`data: ${JSON.stringify(rpc)}\n\n`, { status: 200 }));
      const mod = new BrowserModule();
      await mod.handleTool('browser_snapshot', { session_id: 'test-session' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('omits Authorization header when GETPOD_BROWSER_API_KEY is empty string', async () => {
      process.env.GETPOD_BROWSER_API_KEY = '';
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
      };
      fetchMock.mockResolvedValue(new Response(`data: ${JSON.stringify(rpc)}\n\n`, { status: 200 }));
      const mod = new BrowserModule();
      await mod.handleTool('browser_navigate', { session_id: 'test-session', url: 'https://example.com' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  // --- browser_screenshot URL construction ---

  describe('browser_screenshot', () => {
    const smallJpegB64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC';
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-screenshot-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeScreenshotRpc(b64: string, mime = 'image/jpeg') {
      return {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'image', data: b64, mimeType: mime }] },
      };
    }

    it('returns filesystem path when GATEWAY_SESSION_MEDIA_DIR is not set', async () => {
      delete process.env.GATEWAY_SESSION_MEDIA_DIR;
      fetchMock.mockResolvedValue(
        new Response(`data: ${JSON.stringify(makeScreenshotRpc(smallJpegB64))}\n\n`, { status: 200 }),
      );
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_screenshot', { session_id: 'sess1' });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text as string;
      expect(text).toMatch(/^\/tmp\//);
      expect(text).toMatch(/browser_shot_sess1.*\.jpg$/);
    });

    it('returns HTTP URL when GATEWAY_SESSION_MEDIA_DIR, GATEWAY_API_URL, GATEWAY_AGENT_ID are set', async () => {
      const mediaDir = path.join(tmpDir, 'api-sess2');
      process.env.GATEWAY_SESSION_MEDIA_DIR = mediaDir;
      process.env.GATEWAY_API_URL = 'http://127.0.0.1:10850';
      process.env.GATEWAY_AGENT_ID = 'my-agent';
      fetchMock.mockResolvedValue(
        new Response(`data: ${JSON.stringify(makeScreenshotRpc(smallJpegB64))}\n\n`, { status: 200 }),
      );
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_screenshot', { session_id: 'sess2' });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text as string;
      expect(text).toMatch(/^http:\/\/127\.0\.0\.1:10850\/v1\/agents\/my-agent\/media\/api-sess2\/browser_shot_sess2_/);
      expect(text).toMatch(/\.jpg$/);
      // File must exist on disk — decode percent-encoded filename from URL
      const encodedFilename = text.split('/').pop()!;
      const filename = decodeURIComponent(encodedFilename);
      expect(fs.existsSync(path.join(mediaDir, filename))).toBe(true);
    });

    it('falls back to filesystem path in mediaDir when GATEWAY_API_URL is missing', async () => {
      const mediaDir = path.join(tmpDir, 'api-sess3');
      process.env.GATEWAY_SESSION_MEDIA_DIR = mediaDir;
      delete process.env.GATEWAY_API_URL;
      process.env.GATEWAY_AGENT_ID = 'my-agent';
      fetchMock.mockResolvedValue(
        new Response(`data: ${JSON.stringify(makeScreenshotRpc(smallJpegB64))}\n\n`, { status: 200 }),
      );
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_screenshot', { session_id: 'sess3' });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text as string;
      // No URL available → returns absolute filesystem path inside mediaDir
      expect(text).not.toMatch(/^http/);
      expect(text).toMatch(/browser_shot_sess3.*\.jpg$/);
      expect(text.startsWith(mediaDir)).toBe(true);
    });

    it('falls back to filesystem path in mediaDir when GATEWAY_AGENT_ID is missing', async () => {
      const mediaDir = path.join(tmpDir, 'api-sess4');
      process.env.GATEWAY_SESSION_MEDIA_DIR = mediaDir;
      process.env.GATEWAY_API_URL = 'http://127.0.0.1:10850';
      delete process.env.GATEWAY_AGENT_ID;
      fetchMock.mockResolvedValue(
        new Response(`data: ${JSON.stringify(makeScreenshotRpc(smallJpegB64))}\n\n`, { status: 200 }),
      );
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_screenshot', { session_id: 'sess4' });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text as string;
      // No agent ID → cannot build URL → returns absolute filesystem path inside mediaDir
      expect(text).not.toMatch(/^http/);
      expect(text).toMatch(/browser_shot_sess4.*\.jpg$/);
      expect(text.startsWith(mediaDir)).toBe(true);
    });

    it('URL-encodes agent ID with special characters', async () => {
      const mediaDir = path.join(tmpDir, 'api-sess5');
      process.env.GATEWAY_SESSION_MEDIA_DIR = mediaDir;
      process.env.GATEWAY_API_URL = 'http://localhost:10850';
      process.env.GATEWAY_AGENT_ID = 'my agent/v2';
      fetchMock.mockResolvedValue(
        new Response(`data: ${JSON.stringify(makeScreenshotRpc(smallJpegB64))}\n\n`, { status: 200 }),
      );
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_screenshot', { session_id: 'sess5' });
      const text = result.content[0].text as string;
      expect(text).toContain('/v1/agents/my%20agent%2Fv2/media/');
    });

    it('saves PNG when mimeType is image/png', async () => {
      const mediaDir = path.join(tmpDir, 'api-sess6');
      process.env.GATEWAY_SESSION_MEDIA_DIR = mediaDir;
      process.env.GATEWAY_API_URL = 'http://localhost:10850';
      process.env.GATEWAY_AGENT_ID = 'agent1';
      fetchMock.mockResolvedValue(
        new Response(
          `data: ${JSON.stringify(makeScreenshotRpc('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'image/png'))}\n\n`,
          { status: 200 },
        ),
      );
      const mod = new BrowserModule();
      const result = await mod.handleTool('browser_screenshot', { session_id: 'sess6' });
      const text = result.content[0].text as string;
      expect(text).toMatch(/\.png$/);
    });
  });
});
