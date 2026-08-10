/**
 * Unit tests for generate_image reference normalization + artifact
 * registration (#70) — mcp/tools/image/module.ts + share-client.ts.
 *
 * Covers plan §20.1 MCP-level items: auto-normalization of path/artifact refs
 * through the gateway share API, image/images mutual exclusion, order
 * preservation, count/duplicate/http rejection BEFORE any billing call,
 * best-effort revoke on submit failure, artifact registration after file
 * write, and the no-gateway-context regression guarantee (raw pass-through,
 * zero share calls).
 *
 * global.fetch is mocked: calls to GATEWAY_API_URL (share/artifact API) and to
 * the image provider are captured and answered per test.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImageModule } from '../../mcp/tools/image/module';

const PROVIDER = 'https://img.example.com';
const GATEWAY = 'http://127.0.0.1:19999';

const ENV_KEYS = [
  'IMAGE_BASE_URL',
  'IMAGE_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'IMAGE_DISABLED',
  'IMAGE_POLL_TIMEOUT_MS',
  'IMAGE_SHARE_MAX_REFS',
  'GATEWAY_API_URL',
  'GATEWAY_API_KEY',
  'GATEWAY_AGENT_ID',
  'GATEWAY_SESSION_ID',
  'GATEWAY_SESSION_MEDIA_DIR',
  'GATEWAY_WORKSPACE_DIR',
] as const;

type Captured = { url: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> };

const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]).toString('base64');

describe('generate_image share-bridge normalization (#70)', () => {
  const saved: Record<string, string | undefined> = {};
  let mediaDir: string;
  let calls: Captured[];
  let shareItems: Array<{ share_id: string; url: string; expires_at: string }>;
  let shareStatus: number;
  let shareErrorBody: Record<string, unknown>;
  let submitStatus: number;
  let jobResult: Record<string, unknown>;
  const realFetch = global.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.IMAGE_BASE_URL = PROVIDER;
    process.env.IMAGE_API_KEY = 'image-secret';
    process.env.GATEWAY_API_URL = GATEWAY;
    process.env.GATEWAY_API_KEY = 'gw-key';
    process.env.GATEWAY_AGENT_ID = 'a1';
    process.env.GATEWAY_SESSION_ID = 'session-1';
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgshare-mcp-'));
    process.env.GATEWAY_SESSION_MEDIA_DIR = mediaDir;

    calls = [];
    shareStatus = 201;
    shareItems = [{ share_id: 'shr_1', url: 'https://vm.example.com/gateway/shared/tok1', expires_at: new Date(Date.now() + 60000).toISOString() }];
    shareErrorBody = {};
    submitStatus = 202;
    jobResult = { status: 'done', task_id: 't-1', images: [PNG_B64] };

    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === 'string') {
        try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { /* raw */ }
      }
      calls.push({ url, method, body, headers: (init?.headers ?? {}) as Record<string, string> });

      if (url.startsWith(`${GATEWAY}/api/v1/shares`) && method === 'POST') {
        return new Response(
          JSON.stringify(shareStatus === 201 ? { items: shareItems } : shareErrorBody),
          { status: shareStatus },
        );
      }
      if (url.startsWith(`${GATEWAY}/api/v1/shares/`) && method === 'DELETE') {
        return new Response(JSON.stringify({ revoked: true }), { status: 200 });
      }
      if (url.startsWith(`${GATEWAY}/api/v1/image-artifacts`) && method === 'POST') {
        const files = (body?.files as string[]) ?? [];
        return new Response(
          JSON.stringify({
            items: files.map((f, i) => ({ artifact_id: `img_${i}`, artifact_ref: `artifact:img_${i}`, index: i, path: f })),
          }),
          { status: 201 },
        );
      }
      if (url === `${PROVIDER}/v1/images/generations` && method === 'POST') {
        return new Response(
          submitStatus === 202 ? JSON.stringify({ task_id: 't-1', status: 'queued' }) : JSON.stringify({ error: { code: 'invalid_model', message: 'nope' } }),
          { status: submitStatus },
        );
      }
      if (url.startsWith(`${PROVIDER}/v1/images/jobs/`)) {
        return new Response(JSON.stringify(jobResult), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    fs.rmSync(mediaDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const generate = (extra: Record<string, unknown>) =>
    new ImageModule().handleTool('generate_image', {
      action: 'generate',
      model: 'codex-image/gpt-image',
      prompt: 'edit the duck',
      ...extra,
    });

  const shareCalls = () => calls.filter((c) => c.url === `${GATEWAY}/api/v1/shares` && c.method === 'POST');
  const revokeCalls = () => calls.filter((c) => c.method === 'DELETE' && c.url.includes('/api/v1/shares/'));
  const submitCall = () => calls.find((c) => c.url === `${PROVIDER}/v1/images/generations`);

  describe('no gateway context — regression guarantee', () => {
    test('local path passes through UNCHANGED and no share API is called', async () => {
      delete process.env.GATEWAY_SESSION_ID;
      submitStatus = 400; // end the flow right after submit
      await generate({ image: 'media/session-1/duck.png' });
      expect(shareCalls()).toHaveLength(0);
      expect(submitCall()!.body!.image).toBe('media/session-1/duck.png');
    });

    test('text-to-image with gateway context also makes zero share calls', async () => {
      submitStatus = 400;
      await generate({});
      expect(shareCalls()).toHaveLength(0);
      expect(submitCall()!.body!.image).toBeUndefined();
    });
  });

  describe('gateway context present — auto-normalization (§7)', () => {
    test('local path ref → share API mint, submit carries the share URL', async () => {
      const res = await generate({ image: 'media/session-1/duck.png' });
      expect(res.isError).toBeUndefined();
      const sc = shareCalls();
      expect(sc).toHaveLength(1);
      expect(sc[0]!.body).toMatchObject({
        agent_id: 'a1',
        session_id: 'session-1',
        purpose: 'codex_ref',
        refs: [{ path: 'media/session-1/duck.png' }],
      });
      expect(sc[0]!.headers['Authorization']).toBe('Bearer gw-key');
      expect(submitCall()!.body!.image).toBe('https://vm.example.com/gateway/shared/tok1');
    });

    test('artifact:<id> ref → share API receives artifact_id', async () => {
      await generate({ image: 'artifact:img_abc123' });
      expect(shareCalls()[0]!.body!.refs).toEqual([{ artifact_id: 'img_abc123' }]);
    });

    test('multiple refs preserve order, https passes through untouched', async () => {
      shareItems = [
        { share_id: 'shr_1', url: 'https://vm.example.com/gateway/shared/tok1', expires_at: '2099-01-01T00:00:00Z' },
        { share_id: 'shr_2', url: 'https://vm.example.com/gateway/shared/tok2', expires_at: '2099-01-01T00:00:00Z' },
      ];
      await generate({
        images: ['https://cdn.example.com/pic.png', 'media/session-1/a.png', 'artifact:img_b'],
      });
      // Only the two local refs go to the share API, in order.
      expect(shareCalls()[0]!.body!.refs).toEqual([{ path: 'media/session-1/a.png' }, { artifact_id: 'img_b' }]);
      // Submit merges back preserving the caller's order.
      expect(submitCall()!.body!.images).toEqual([
        'https://cdn.example.com/pic.png',
        'https://vm.example.com/gateway/shared/tok1',
        'https://vm.example.com/gateway/shared/tok2',
      ]);
    });

    test('image AND images together → rejected before ANY network call', async () => {
      const res = await generate({ image: 'a.png', images: ['b.png'] });
      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });

    test('more than 5 refs → rejected before any call', async () => {
      const res = await generate({ images: ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png'] });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('too many');
      expect(calls).toHaveLength(0);
    });

    test('duplicate refs → rejected before any call', async () => {
      const res = await generate({ images: ['a.png', 'a.png'] });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('duplicate');
      expect(calls).toHaveLength(0);
    });

    test('http:// ref → rejected (phase 1 requires https)', async () => {
      const res = await generate({ image: 'http://cdn.example.com/pic.png' });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('https');
      expect(calls).toHaveLength(0);
    });

    test('missing artifact → deterministic image_ref_not_found, no submit', async () => {
      shareStatus = 404;
      shareErrorBody = { error: 'referenced artifact was not found in this agent/session', code: 'image_ref_not_found' };
      const res = await generate({ image: 'artifact:img_gone' });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('image_ref_not_found');
      expect(submitCall()).toBeUndefined();
    });

    test('submit failure → freshly minted shares are best-effort revoked (§18)', async () => {
      submitStatus = 400;
      const res = await generate({ image: 'media/session-1/duck.png' });
      expect(res.isError).toBe(true);
      expect(revokeCalls().map((c) => c.url)).toEqual([`${GATEWAY}/api/v1/shares/shr_1`]);
    });
  });

  describe('artifact registration after delivery (§8)', () => {
    test('done job registers written files and returns artifact refs', async () => {
      const res = await generate({});
      expect(res.isError).toBeUndefined();
      const payload = JSON.parse(res.content[0]!.text) as {
        files: string[];
        artifacts: Array<{ artifact_id: string; artifact_ref: string; index: number; path: string; provider: string; model: string }>;
      };
      expect(payload.files).toHaveLength(1);
      expect(fs.existsSync(payload.files[0]!)).toBe(true);
      expect(payload.artifacts).toHaveLength(1);
      expect(payload.artifacts[0]).toMatchObject({
        artifact_ref: 'artifact:img_0',
        index: 0,
        path: payload.files[0],
        provider: 'codex-image',
        model: 'gpt-image',
      });
      const reg = calls.find((c) => c.url === `${GATEWAY}/api/v1/image-artifacts`);
      expect(reg).toBeDefined();
      expect(reg!.body).toMatchObject({
        agent_id: 'a1',
        session_id: 'session-1',
        provider: 'codex-image',
        model: 'gpt-image',
        task_id: 't-1',
        files: payload.files,
      });
    }, 20000);

    test('no gateway context → done job returns files with NO artifacts field (regression)', async () => {
      delete process.env.GATEWAY_SESSION_ID;
      const res = await generate({});
      const payload = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
      expect(payload.files).toBeDefined();
      expect(payload.artifacts).toBeUndefined();
      expect(calls.find((c) => c.url === `${GATEWAY}/api/v1/image-artifacts`)).toBeUndefined();
    }, 20000);
  });
});
