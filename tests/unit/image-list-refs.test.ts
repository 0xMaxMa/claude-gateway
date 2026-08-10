/**
 * Unit tests for generate_image action="list_refs" (#72) —
 * mcp/tools/image/module.ts + mcp/tools/shared/share-client.ts.
 *
 * list_refs is the agent's ONLY sanctioned way to resolve "image 2" / "the first
 * image" to a real file: the gateway computes the numbering, the agent never counts
 * from its own transcript. Locked in here:
 *
 *  1. happy path — the gateway's items come back verbatim in the tool result;
 *  2. bridge gating — with the share bridge unconfigured the action is inert and
 *     performs NO network call (legacy mode gains no new behavior);
 *  3. gateway errors (401 / 500, both error-body shapes) surface their code;
 *  4. wire shape — GET, correct path + query, Bearer auth, no body;
 *  5. the tool definition advertises the action.
 *
 * fetch is mocked, so these pass independently of the server-side endpoint.
 */
import { ImageModule } from '../../mcp/tools/image/module';

const GATEWAY = 'http://127.0.0.1:19999';

const ENV_KEYS = [
  'GATEWAY_API_URL',
  'GATEWAY_API_KEY',
  'GATEWAY_AGENT_ID',
  'GATEWAY_SESSION_ID',
] as const;

type Captured = { url: string; method: string; headers: Record<string, string>; body: unknown };

const ITEMS = [
  { index: 1, ref: 'artifact:img_a', relative_path: 'media/session-1/a.png', origin: 'upload', ts: 1700000000000, available: true },
  { index: 2, ref: 'media/session-1/b.png', relative_path: 'media/session-1/b.png', origin: 'generated', ts: 1700000001000, available: false },
];

describe('generate_image action="list_refs"', () => {
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;
  let calls: Captured[];
  let responder: () => Response;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GATEWAY_API_URL = GATEWAY;
    process.env.GATEWAY_API_KEY = 'gw-key';
    process.env.GATEWAY_AGENT_ID = 'agent one';
    process.env.GATEWAY_SESSION_ID = 'session-1';
    calls = [];
    responder = () => new Response(JSON.stringify({ items: ITEMS }), { status: 200 });
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
      calls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase(), headers, body: init?.body });
      return responder();
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const listRefs = () => new ImageModule().handleTool('generate_image', { action: 'list_refs' });

  test('happy path → catalog items returned verbatim, not an error', async () => {
    const res = await listRefs();
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0]!.text) as { images: typeof ITEMS; note: string };
    expect(payload.images).toEqual(ITEMS);
    // The note is what stops the agent counting images from its own memory.
    expect(payload.note).toContain('first appearance');
    expect(payload.note).toContain('Do NOT count images from conversation memory');
    expect(calls).toHaveLength(1);
  });

  test('empty session → empty images array, still a success', async () => {
    responder = () => new Response(JSON.stringify({ items: [] }), { status: 200 });
    const res = await listRefs();
    expect(res.isError).toBeUndefined();
    expect((JSON.parse(res.content[0]!.text) as { images: unknown[] }).images).toEqual([]);
  });

  test('share bridge not configured → inert error, NO network call', async () => {
    delete process.env.GATEWAY_SESSION_ID;
    const res = await listRefs();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(
      'generate_image: list_refs is unavailable (image share bridge is not configured).',
    );
    expect(calls).toHaveLength(0);
  });

  test('401 from the gateway → mapped error carrying the code', async () => {
    responder = () => new Response(JSON.stringify({ error: 'bad key', code: 'unauthorized' }), { status: 401 });
    const res = await listRefs();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('unauthorized');
    expect(res.content[0]!.text).toContain('bad key');
  });

  test('nested { error: { code, message } } body shape is mapped too', async () => {
    responder = () =>
      new Response(JSON.stringify({ error: { code: 'catalog_unavailable', message: 'history db missing' } }), { status: 500 });
    const res = await listRefs();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('catalog_unavailable');
    expect(res.content[0]!.text).toContain('history db missing');
  });

  test('500 with a non-JSON body → generic catalog_failed code', async () => {
    responder = () => new Response('<html>boom</html>', { status: 500 });
    const res = await listRefs();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('catalog_failed');
  });

  test('200 with a malformed payload (no items array) → error, not a crash', async () => {
    responder = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const res = await listRefs();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('catalog_failed');
  });

  test('request shape: GET /api/v1/image-catalog with encoded identity, Bearer auth, no body', async () => {
    await listRefs();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`${GATEWAY}/api/v1/image-catalog?agent_id=agent%20one&session_id=session-1`);
    expect(call.headers.authorization).toBe('Bearer gw-key');
    expect(call.body).toBeUndefined();
  });

  test('trailing slash on GATEWAY_API_URL is normalised away', async () => {
    process.env.GATEWAY_API_URL = `${GATEWAY}/`;
    await listRefs();
    expect(calls[0]!.url.startsWith(`${GATEWAY}/api/v1/image-catalog?`)).toBe(true);
  });

  test('tool definition advertises the list_refs action', () => {
    const tools = new ImageModule().getTools();
    const def = tools.find((t) => t.name === 'generate_image')!;
    const schema = JSON.parse(JSON.stringify(def.inputSchema)) as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toContain('list_refs');
    // …and the description tells the agent to call it before resolving "the second image".
    expect(def.description).toContain('list_refs');
  });

  test('an unknown action still errors and lists list_refs among the valid ones', async () => {
    const res = await new ImageModule().handleTool('generate_image', { action: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('list_refs');
    expect(calls).toHaveLength(0);
  });
});
