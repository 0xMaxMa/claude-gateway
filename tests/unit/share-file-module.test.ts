/**
 * Unit tests for the standalone share_file MCP tool (#70, renamed from
 * share_image in #444) — mcp/tools/share-file/module.ts. Locks in:
 * gateway-context gating, create/revoke plumbing through the authenticated
 * gateway API, the deprecated share_image alias, and the DELIBERATE absence of
 * any list action (plan §15).
 */
import { ShareFileModule } from '../../mcp/tools/share-file/module';

const GATEWAY = 'http://127.0.0.1:19999';

const ENV_KEYS = [
  'GATEWAY_API_URL',
  'GATEWAY_API_KEY',
  'GATEWAY_AGENT_ID',
  'GATEWAY_SESSION_ID',
] as const;

type Captured = { url: string; method: string; body?: Record<string, unknown> };

describe('share_file MCP module', () => {
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;
  let calls: Captured[];
  let responder: (url: string, method: string) => Response;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GATEWAY_API_URL = GATEWAY;
    process.env.GATEWAY_API_KEY = 'gw-key';
    process.env.GATEWAY_AGENT_ID = 'a1';
    process.env.GATEWAY_SESSION_ID = 'session-1';
    calls = [];
    responder = (url, method) => {
      if (method === 'POST') {
        return new Response(
          JSON.stringify({ items: [{ share_id: 'shr_1', url: 'https://vm.example.com/gateway/shared/tok1', expires_at: '2099-01-01T00:00:00Z' }] }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    };
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === 'string') {
        try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { /* raw */ }
      }
      calls.push({ url, method, body });
      return responder(url, method);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('gating', () => {
    test('enabled only when the full gateway API context is present', () => {
      expect(new ShareFileModule().isEnabled()).toBe(true);
      delete process.env.GATEWAY_SESSION_ID;
      expect(new ShareFileModule().isEnabled()).toBe(false);
    });

    test('exposes share_file plus the deprecated alias, and NO list action', () => {
      const tools = new ShareFileModule().getTools();
      expect(tools.map((t) => t.name)).toEqual(['share_file', 'share_image']);
      for (const tool of tools) {
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).not.toContain('"list"');
        expect((JSON.parse(schema).properties.action.enum as string[])).toEqual(['create', 'revoke']);
      }
    });

    // #444: the alias exists to keep agent instructions written against the old
    // name working — it must not cost a second copy of the real description.
    test('the alias description is a one-liner pointing at share_file', () => {
      const [primary, alias] = new ShareFileModule().getTools();
      expect(alias!.description).toContain('Deprecated');
      expect(alias!.description).toContain('share_file');
      expect(alias!.description.length).toBeLessThan(primary!.description.length / 3);
    });
  });

  describe('create', () => {
    test('single path → POST /api/v1/shares with identity from env', async () => {
      const res = await new ShareFileModule().handleTool('share_file', {
        action: 'create',
        path: 'media/session-1/image.png',
        ttl_seconds: 900,
      });
      expect(res.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${GATEWAY}/api/v1/shares`);
      expect(calls[0]!.body).toMatchObject({
        agent_id: 'a1',
        session_id: 'session-1',
        purpose: 'codex_ref',
        ttl_seconds: 900,
        refs: [{ path: 'media/session-1/image.png' }],
      });
      const payload = JSON.parse(res.content[0]!.text) as { items: Array<{ url: string }> };
      expect(payload.items[0]!.url).toBe('https://vm.example.com/gateway/shared/tok1');
    });

    test('batch paths + artifact refs are classified correctly', async () => {
      await new ShareFileModule().handleTool('share_file', {
        action: 'create',
        paths: ['media/session-1/a.png', 'artifact:img_x'],
      });
      expect(calls[0]!.body!.refs).toEqual([{ path: 'media/session-1/a.png' }, { artifact_id: 'img_x' }]);
    });

    test('path AND paths together → error, no call', async () => {
      const res = await new ShareFileModule().handleTool('share_file', {
        action: 'create',
        path: 'a.png',
        paths: ['b.png'],
      });
      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });

    // #444: this tool is the agent's explicit "publish this file" verb, so it
    // opts into the full share allowlist (images + PDF). The narrow image
    // consumers (line_image, generate_image ref normalization) must NOT.
    test('always opts into documents so a PDF can be shared', async () => {
      await new ShareFileModule().handleTool('share_file', {
        action: 'create',
        path: 'media/session-1/report.pdf',
      });
      expect(calls[0]!.body!.allow_documents).toBe(true);
    });

    test('gateway error code is surfaced', async () => {
      responder = () => new Response(JSON.stringify({ error: 'nope', code: 'share_ref_not_found' }), { status: 404 });
      const res = await new ShareFileModule().handleTool('share_file', { action: 'create', path: 'gone.png' });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('share_ref_not_found');
    });
  });

  describe('revoke', () => {
    test('DELETE /api/v1/shares/:id', async () => {
      const res = await new ShareFileModule().handleTool('share_file', { action: 'revoke', share_id: 'shr_1' });
      expect(res.isError).toBeUndefined();
      expect(calls[0]!.method).toBe('DELETE');
      expect(calls[0]!.url).toBe(`${GATEWAY}/api/v1/shares/shr_1`);
    });

    test('missing share_id → error, no call', async () => {
      const res = await new ShareFileModule().handleTool('share_file', { action: 'revoke' });
      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  // #444: agent workspaces (AGENTS.md, skills, memories) still say share_image,
  // and we do not get to rewrite them — the old name must keep working.
  describe('deprecated share_image alias', () => {
    test('create behaves identically to share_file', async () => {
      const res = await new ShareFileModule().handleTool('share_image', {
        action: 'create',
        path: 'media/session-1/report.pdf',
      });
      expect(res.isError).toBeUndefined();
      expect(calls[0]!.url).toBe(`${GATEWAY}/api/v1/shares`);
      expect(calls[0]!.body!.allow_documents).toBe(true);
    });

    test('revoke behaves identically to share_file', async () => {
      const res = await new ShareFileModule().handleTool('share_image', { action: 'revoke', share_id: 'shr_1' });
      expect(res.isError).toBeUndefined();
      expect(calls[0]!.method).toBe('DELETE');
    });
  });

  test('unknown tool name → error, no call', async () => {
    const res = await new ShareFileModule().handleTool('share_document', { action: 'create', path: 'a.png' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Unknown tool');
    expect(calls).toHaveLength(0);
  });

  test('unknown action (including "list") → error, no call', async () => {
    const res = await new ShareFileModule().handleTool('share_file', { action: 'list' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
