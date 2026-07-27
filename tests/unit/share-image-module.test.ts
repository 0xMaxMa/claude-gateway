/**
 * Unit tests for the standalone share_image MCP tool (#70) —
 * mcp/tools/share-image/module.ts. Locks in: flag/env gating, create/revoke
 * plumbing through the authenticated gateway API, and the DELIBERATE absence
 * of any list action (plan §15).
 */
import { ShareImageModule } from '../../mcp/tools/share-image/module';

const GATEWAY = 'http://127.0.0.1:19999';

const ENV_KEYS = [
  'IMAGE_SHARE_ENABLED',
  'GATEWAY_API_URL',
  'GATEWAY_API_KEY',
  'GATEWAY_AGENT_ID',
  'GATEWAY_SESSION_ID',
] as const;

type Captured = { url: string; method: string; body?: Record<string, unknown> };

describe('share_image MCP module', () => {
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;
  let calls: Captured[];
  let responder: (url: string, method: string) => Response;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.IMAGE_SHARE_ENABLED = 'true';
    process.env.GATEWAY_API_URL = GATEWAY;
    process.env.GATEWAY_API_KEY = 'gw-key';
    process.env.GATEWAY_AGENT_ID = 'a1';
    process.env.GATEWAY_SESSION_ID = 'session-1';
    calls = [];
    responder = (url, method) => {
      if (method === 'POST') {
        return new Response(
          JSON.stringify({ items: [{ share_id: 'shr_1', url: 'https://vm.example.com/shared/tok1', expires_at: '2099-01-01T00:00:00Z' }] }),
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
    test('enabled only when the flag AND the full gateway env are present', () => {
      expect(new ShareImageModule().isEnabled()).toBe(true);
      process.env.IMAGE_SHARE_ENABLED = 'false';
      expect(new ShareImageModule().isEnabled()).toBe(false);
      process.env.IMAGE_SHARE_ENABLED = 'true';
      delete process.env.GATEWAY_SESSION_ID;
      expect(new ShareImageModule().isEnabled()).toBe(false);
    });

    test('exposes exactly one tool and NO list action', () => {
      const tools = new ShareImageModule().getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('share_image');
      const schema = JSON.stringify(tools[0]!.inputSchema);
      expect(schema).not.toContain('"list"');
      expect((JSON.parse(schema).properties.action.enum as string[])).toEqual(['create', 'revoke']);
    });
  });

  describe('create', () => {
    test('single path → POST /api/v1/image-shares with identity from env', async () => {
      const res = await new ShareImageModule().handleTool('share_image', {
        action: 'create',
        path: 'media/session-1/image.png',
        ttl_seconds: 900,
      });
      expect(res.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${GATEWAY}/api/v1/image-shares`);
      expect(calls[0]!.body).toMatchObject({
        agent_id: 'a1',
        session_id: 'session-1',
        purpose: 'codex_ref',
        ttl_seconds: 900,
        refs: [{ path: 'media/session-1/image.png' }],
      });
      const payload = JSON.parse(res.content[0]!.text) as { items: Array<{ url: string }> };
      expect(payload.items[0]!.url).toBe('https://vm.example.com/shared/tok1');
    });

    test('batch paths + artifact refs are classified correctly', async () => {
      await new ShareImageModule().handleTool('share_image', {
        action: 'create',
        paths: ['media/session-1/a.png', 'artifact:img_x'],
      });
      expect(calls[0]!.body!.refs).toEqual([{ path: 'media/session-1/a.png' }, { artifact_id: 'img_x' }]);
    });

    test('path AND paths together → error, no call', async () => {
      const res = await new ShareImageModule().handleTool('share_image', {
        action: 'create',
        path: 'a.png',
        paths: ['b.png'],
      });
      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });

    test('gateway error code is surfaced', async () => {
      responder = () => new Response(JSON.stringify({ error: 'nope', code: 'image_ref_not_found' }), { status: 404 });
      const res = await new ShareImageModule().handleTool('share_image', { action: 'create', path: 'gone.png' });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('image_ref_not_found');
    });
  });

  describe('revoke', () => {
    test('DELETE /api/v1/image-shares/:id', async () => {
      const res = await new ShareImageModule().handleTool('share_image', { action: 'revoke', share_id: 'shr_1' });
      expect(res.isError).toBeUndefined();
      expect(calls[0]!.method).toBe('DELETE');
      expect(calls[0]!.url).toBe(`${GATEWAY}/api/v1/image-shares/shr_1`);
    });

    test('missing share_id → error, no call', async () => {
      const res = await new ShareImageModule().handleTool('share_image', { action: 'revoke' });
      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  test('unknown action (including "list") → error, no call', async () => {
    const res = await new ShareImageModule().handleTool('share_image', { action: 'list' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
