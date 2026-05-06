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

    it('returns false when GETPOD_BROWSER_DISABLED=1', () => {
      process.env.GETPOD_BROWSER_DISABLED = '1';
      const mod = new BrowserModule();
      expect(mod.isEnabled()).toBe(false);
    });

    it('returns true when GETPOD_BROWSER_DISABLED is set to a value other than "1"', () => {
      process.env.GETPOD_BROWSER_DISABLED = '0';
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
      expect(result.content[0].text).toContain('stream_url');
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
  });
});
