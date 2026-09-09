/**
 * Unit tests for generate_video's full generate → poll → deliver pipeline and
 * the image-to-video source-frame reference resolver (normalizeRef). Neither
 * had any coverage before — video-module.test.ts only covers config resolution
 * and validation errors, and video-generate-cancel.test.ts only covers the E3
 * cancel path. Locked in here (fetch is mocked, no real network):
 *
 *  1. happy path: submit → immediate done → deliver saves the mp4 into the
 *     session media dir and returns its path.
 *  2. deliver() rejects a 200 response whose body is not a recognized mp4
 *     (the anti-garbage magic-byte backstop).
 *  3. deliver() maps a 404 on the file fetch to result_expired.
 *  4. action="status" re-entering in a later turn (no `model` in scope) still
 *     delivers, just without the model field/note.
 *  5. normalizeRef(): https pass-through, http rejected, share-bridge mint
 *     (local path + artifact:), and legacy pass-through when the bridge is off.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VideoModule } from '../../mcp/tools/video/module';

const BASE = 'https://video.example.com';
const GATEWAY = 'http://127.0.0.1:19999';

const ENV_KEYS = [
  'VIDEO_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'VIDEO_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GATEWAY_SESSION_MEDIA_DIR',
  'GATEWAY_API_URL',
  'GATEWAY_API_KEY',
  'GATEWAY_AGENT_ID',
  'GATEWAY_SESSION_ID',
] as const;

type Captured = { url: string; method: string; body: unknown };

// A minimal, valid ISO-BMFF "ftyp" box: size(4) + 'ftyp' + 'isom' brand.
const VALID_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70, // 'ftyp'
  0x69, 0x73, 0x6f, 0x6d, // 'isom'
  0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
]);

describe('generate_video — generate → poll → deliver pipeline', () => {
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;
  let mediaDir: string;
  let calls: Captured[];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.ANTHROPIC_BASE_URL = BASE;
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-deliver-'));
    process.env.GATEWAY_SESSION_MEDIA_DIR = mediaDir;
    calls = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
    fs.rmSync(mediaDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('happy path: submit → done on first poll → clip saved and file path returned', async () => {
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body });
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-ok', status: 'queued' }), { status: 202 });
      }
      if (url.endsWith('/v1/videos/jobs/tid-ok') && method === 'GET') {
        return new Response(JSON.stringify({ task_id: 'tid-ok', status: 'done' }), { status: 200 });
      }
      if (url.endsWith('/v1/videos/files/tid-ok.mp4') && method === 'GET') {
        return new Response(VALID_MP4, { status: 200, headers: { 'content-length': String(VALID_MP4.length) } });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'a cat surfing',
    });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0]!.text) as { status: string; task_id: string; model?: string; files: string[] };
    expect(payload.status).toBe('done');
    expect(payload.task_id).toBe('tid-ok');
    expect(payload.model).toBe('grok-video/grok-imagine');
    expect(payload.files).toHaveLength(1);
    const savedPath = payload.files[0]!;
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(fs.readFileSync(savedPath)).toEqual(VALID_MP4);
    expect(path.dirname(savedPath)).toBe(mediaDir);
  }, 15_000);

  test('a done job whose clip is not a recognized mp4 is rejected, not saved', async () => {
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-bad', status: 'queued' }), { status: 202 });
      }
      if (url.endsWith('/v1/videos/jobs/tid-bad') && method === 'GET') {
        return new Response(JSON.stringify({ task_id: 'tid-bad', status: 'done' }), { status: 200 });
      }
      if (url.endsWith('/v1/videos/files/tid-bad.mp4') && method === 'GET') {
        return new Response('<html>not a video</html>', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'a cat surfing',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not a recognized mp4');
    expect(fs.readdirSync(mediaDir)).toHaveLength(0);
  }, 15_000);

  test('a 404 on the file fetch maps to result_expired', async () => {
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-404', status: 'queued' }), { status: 202 });
      }
      if (url.endsWith('/v1/videos/jobs/tid-404') && method === 'GET') {
        return new Response(JSON.stringify({ task_id: 'tid-404', status: 'done' }), { status: 200 });
      }
      if (url.endsWith('/v1/videos/files/tid-404.mp4') && method === 'GET') {
        return new Response(JSON.stringify({ error: { code: 'result_expired' } }), { status: 404 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'a cat surfing',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('result_expired');
  }, 15_000);

  test('action="status" re-entering later (no model in scope) still delivers, without a model field', async () => {
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/videos/jobs/tid-status') && method === 'GET') {
        return new Response(JSON.stringify({ task_id: 'tid-status', status: 'done' }), { status: 200 });
      }
      if (url.endsWith('/v1/videos/files/tid-status.mp4') && method === 'GET') {
        return new Response(VALID_MP4, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool('generate_video', { action: 'status', task_id: 'tid-status' });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0]!.text) as { status: string; model?: string; files: string[] };
    expect(payload.status).toBe('done');
    expect(payload.model).toBeUndefined();
    expect(payload.files).toHaveLength(1);
  });

  test('a job that failed maps to its error code and hint', async () => {
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-fail', status: 'queued' }), { status: 202 });
      }
      if (url.endsWith('/v1/videos/jobs/tid-fail') && method === 'GET') {
        return new Response(JSON.stringify({ task_id: 'tid-fail', status: 'failed', error: { code: 'content_policy' } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'a cat surfing',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('content_policy');
    expect(res.content[0]!.text).toContain('content policy');
  }, 15_000);
});

describe('generate_video image-to-video source-frame resolution (normalizeRef)', () => {
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;
  let calls: Captured[];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.ANTHROPIC_BASE_URL = BASE;
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    calls = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const captureSubmitBody = () => {
    const controller = new AbortController();
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body });
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        // Abort right after submit so the poll loop bails on its very first check
        // instead of waiting out the real (multi-minute) poll budget — this
        // describe block only cares about the submitted request body.
        controller.abort();
        return new Response(JSON.stringify({ task_id: 'tid-i2v', status: 'running' }), { status: 202 });
      }
      if (url.endsWith('/v1/videos/jobs/tid-i2v/cancel') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-i2v', cancelled: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;
    return { fetchMock, signal: controller.signal };
  };

  test('share bridge OFF: an https image ref is passed straight through, unmodified', async () => {
    const { fetchMock, signal } = captureSubmitBody();
    global.fetch = fetchMock;
    await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'animate this',
      image: 'https://cdn.example.com/frame.png',
    }, signal);
    const submit = calls.find((c) => c.url.endsWith('/v1/videos/generations'))!;
    const body = JSON.parse(submit.body as string) as { image?: string };
    expect(body.image).toBe('https://cdn.example.com/frame.png');
  });

  test('share bridge OFF: a local media path is passed straight through as legacy behavior', async () => {
    const { fetchMock, signal } = captureSubmitBody();
    global.fetch = fetchMock;
    await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'animate this',
      image: 'media/session-1/frame.png',
    }, signal);
    const submit = calls.find((c) => c.url.endsWith('/v1/videos/generations'))!;
    const body = JSON.parse(submit.body as string) as { image?: string };
    expect(body.image).toBe('media/session-1/frame.png');
  });

  test('share bridge ON: an http:// image ref is rejected — https required', async () => {
    process.env.GATEWAY_API_URL = GATEWAY;
    process.env.GATEWAY_API_KEY = 'gw-key';
    process.env.GATEWAY_AGENT_ID = 'agent-1';
    process.env.GATEWAY_SESSION_ID = 'session-1';
    const { fetchMock } = captureSubmitBody();
    global.fetch = fetchMock;
    const res = await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'animate this',
      image: 'http://cdn.example.com/frame.png',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('https');
    expect(calls.some((c) => c.url.endsWith('/v1/videos/generations'))).toBe(false);
  });

  test('share bridge ON: a local path is minted to a public share URL before submit', async () => {
    process.env.GATEWAY_API_URL = GATEWAY;
    process.env.GATEWAY_API_KEY = 'gw-key';
    process.env.GATEWAY_AGENT_ID = 'agent-1';
    process.env.GATEWAY_SESSION_ID = 'session-1';

    const controller = new AbortController();
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body });
      if (url.endsWith('/api/v1/shares') && method === 'POST') {
        return new Response(
          JSON.stringify({ items: [{ share_id: 'sh-1', token: 'tok-1', url: 'https://gw.example.com/shared/tok-1', expires_at: '2099-01-01T00:00:00Z' }] }),
          { status: 201 },
        );
      }
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        // Abort right after submit — this test only cares about the request
        // bodies (mint + submit), not the poll outcome.
        controller.abort();
        return new Response(JSON.stringify({ task_id: 'tid-mint', status: 'running' }), { status: 202 });
      }
      if (url.endsWith('/v1/videos/jobs/tid-mint/cancel') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-mint', cancelled: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'animate this',
      image: 'media/session-1/frame.png',
    }, controller.signal);

    const mintCall = calls.find((c) => c.url.endsWith('/api/v1/shares'));
    expect(mintCall).toBeDefined();
    const mintBody = JSON.parse(mintCall!.body as string) as { refs: { path?: string }[] };
    expect(mintBody.refs).toEqual([{ path: 'media/session-1/frame.png' }]);

    const submit = calls.find((c) => c.url.endsWith('/v1/videos/generations'))!;
    const submitBody = JSON.parse(submit.body as string) as { image?: string };
    expect(submitBody.image).toBe('https://gw.example.com/shared/tok-1');
  });

  // #472: on a host with gateway.publicUrl unset, share mint succeeds (token,
  // no url) but the source frame cannot be made into a fetchable https:// URL.
  // Mirrors the generate_image fix — same actionable remedy + workaround, and
  // the now-unusable share is still revoked rather than leaked.
  test('share bridge ON but the minted share has no url (gateway.publicUrl unset) → actionable error, share revoked', async () => {
    process.env.GATEWAY_API_URL = GATEWAY;
    process.env.GATEWAY_API_KEY = 'gw-key';
    process.env.GATEWAY_AGENT_ID = 'agent-1';
    process.env.GATEWAY_SESSION_ID = 'session-1';

    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body });
      if (url.endsWith('/api/v1/shares') && method === 'POST') {
        return new Response(
          JSON.stringify({ items: [{ share_id: 'sh-1', token: 'tok-1', url: '', expires_at: '2099-01-01T00:00:00Z' }] }),
          { status: 201 },
        );
      }
      if (url.includes('/api/v1/shares/') && method === 'DELETE') {
        return new Response(JSON.stringify({ revoked: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'animate this',
      image: 'media/session-1/frame.png',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('generate_video: source-frame sharing requires gateway.publicUrl to be configured');
    expect(res.content[0]!.text).toContain('~/.claude-gateway/config.json');
    expect(res.content[0]!.text).toContain('restart the gateway');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/api/v1/shares/sh-1'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/v1/videos/generations'))).toBe(false);
  });

  test('share bridge ON but an artifact ref does not exist → error surfaced, no submit', async () => {
    process.env.GATEWAY_API_URL = GATEWAY;
    process.env.GATEWAY_API_KEY = 'gw-key';
    process.env.GATEWAY_AGENT_ID = 'agent-1';
    process.env.GATEWAY_SESSION_ID = 'session-1';

    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body });
      if (url.endsWith('/api/v1/shares') && method === 'POST') {
        return new Response(JSON.stringify({ error: 'not found', code: 'share_ref_not_found' }), { status: 404 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool('generate_video', {
      action: 'generate',
      model: 'grok-video/grok-imagine',
      prompt: 'animate this',
      image: 'artifact:missing-id',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('share_ref_not_found');
    expect(calls.some((c) => c.url.endsWith('/v1/videos/generations'))).toBe(false);
  });
});
