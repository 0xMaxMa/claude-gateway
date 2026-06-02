import { ApiModule } from '../../mcp/tools/api/module';

describe('ApiModule', () => {
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

  // --- module metadata ---

  describe('module metadata', () => {
    it('id is "api"', () => {
      expect(new ApiModule().id).toBe('api');
    });

    it('toolVisibility is "current-channel"', () => {
      expect(new ApiModule().toolVisibility).toBe('current-channel');
    });

    it('isEnabled returns true when GATEWAY_ORIGIN_CHANNEL is api', () => {
      process.env.GATEWAY_ORIGIN_CHANNEL = 'api';
      expect(new ApiModule().isEnabled()).toBe(true);
      delete process.env.GATEWAY_ORIGIN_CHANNEL;
    });

    it('isEnabled returns false when GATEWAY_ORIGIN_CHANNEL is not api', () => {
      delete process.env.GATEWAY_ORIGIN_CHANNEL;
      expect(new ApiModule().isEnabled()).toBe(false);
    });
  });

  // --- getTools ---

  describe('getTools', () => {
    it('exposes exactly one tool: api_reply', () => {
      const mod = new ApiModule();
      const tools = mod.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('api_reply');
    });

    it('api_reply requires files array', () => {
      const tool = new ApiModule().getTools()[0]!;
      const schema = tool.inputSchema as Record<string, unknown>;
      const required = schema['required'] as string[];
      expect(required).toContain('files');
    });

    it('api_reply has a non-empty description', () => {
      const tool = new ApiModule().getTools()[0]!;
      expect(tool.description.length).toBeGreaterThan(0);
    });
  });

  // --- handleTool ---

  describe('handleTool', () => {
    it('returns isError for unknown tool', async () => {
      const mod = new ApiModule();
      const result = await mod.handleTool('unknown_tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('returns success message when no files provided', async () => {
      const mod = new ApiModule();
      process.env.GATEWAY_API_URL = 'http://localhost:10850';
      process.env.GATEWAY_AGENT_ID = 'test-agent';
      process.env.GATEWAY_SESSION_ID = 'sess-1';
      const result = await mod.handleTool('api_reply', { files: [] });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('No files');
    });

    it('returns isError when env vars are missing', async () => {
      delete process.env.GATEWAY_API_URL;
      delete process.env.GATEWAY_AGENT_ID;
      delete process.env.GATEWAY_SESSION_ID;
      const mod = new ApiModule();
      const result = await mod.handleTool('api_reply', { files: ['/some/file.jpg'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('missing');
    });

    it('calls gateway attachments endpoint with correct body', async () => {
      process.env.GATEWAY_API_URL = 'http://localhost:10850';
      process.env.GATEWAY_AGENT_ID = 'test-agent';
      process.env.GATEWAY_SESSION_ID = 'sess-123';
      process.env.GATEWAY_API_KEY = 'test-key';

      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, count: 2 }), { status: 200 }));

      const mod = new ApiModule();
      const result = await mod.handleTool('api_reply', {
        files: ['/abs/path/a.jpg', '/abs/path/b.jpg'],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('2 file(s)');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:10850/api/v1/agents/test-agent/sessions/sess-123/attachments');
      const body = JSON.parse(init.body as string) as { files: string[] };
      expect(body.files).toEqual(['/abs/path/a.jpg', '/abs/path/b.jpg']);
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Api-Key']).toBe('test-key');
    });

    it('returns isError when gateway returns non-OK status', async () => {
      process.env.GATEWAY_API_URL = 'http://localhost:10850';
      process.env.GATEWAY_AGENT_ID = 'agent';
      process.env.GATEWAY_SESSION_ID = 'sess';

      fetchMock.mockResolvedValue(new Response('Forbidden', { status: 403 }));

      const mod = new ApiModule();
      const result = await mod.handleTool('api_reply', { files: ['/a.jpg'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('403');
    });

    it('returns isError when fetch throws', async () => {
      process.env.GATEWAY_API_URL = 'http://localhost:10850';
      process.env.GATEWAY_AGENT_ID = 'agent';
      process.env.GATEWAY_SESSION_ID = 'sess';

      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const mod = new ApiModule();
      const result = await mod.handleTool('api_reply', { files: ['/a.jpg'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ECONNREFUSED');
    });

    it('sends request without Authorization header when GATEWAY_API_KEY is not set', async () => {
      process.env.GATEWAY_API_URL = 'http://localhost:10850';
      process.env.GATEWAY_AGENT_ID = 'agent';
      process.env.GATEWAY_SESSION_ID = 'sess';
      delete process.env.GATEWAY_API_KEY;

      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 }));

      const mod = new ApiModule();
      await mod.handleTool('api_reply', { files: ['/a.jpg'] });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Api-Key']).toBeUndefined();
    });
  });
});
