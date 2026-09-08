/**
 * Unit tests for generate_video's Stop-mid-generation cancellation — mirrors
 * image-generate-cancel.test.ts for mcp/tools/video/module.ts's handleGenerate
 * poll loop + its E3 cancel call (both modules share the same mechanism: the MCP
 * SDK's per-call AbortSignal, threaded into VideoModule.handleTool by
 * mcp/server.ts).
 *
 * Locked in here, entirely at the module level (no real CLI/MCP transport
 * involved — fetch is mocked):
 *
 *  1. An aborted signal stops the poll loop promptly (does not run to
 *     VIDEO_POLL_TIMEOUT_MS) and fires POST /v1/videos/jobs/:id/cancel for the
 *     submitted task_id.
 *  2. The tool result reports the cancellation (isError, mentions the task_id) —
 *     not a generic timeout/error.
 *  3. A cancel-call failure (network error) never throws out of handleTool — the
 *     caller's own (already-cancelled) result still returns cleanly.
 *  4. drainCancel() lets a process-exiting shutdown wait for an in-flight E3 call.
 */
import { VideoModule } from '../../mcp/tools/video/module';

const BASE = 'https://video.example.com';

const ENV_KEYS = ['VIDEO_BASE_URL', 'ANTHROPIC_BASE_URL', 'VIDEO_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'VIDEO_POLL_TIMEOUT_MS'] as const;

type Captured = { url: string; method: string };

describe('generate_video action="generate" — Stop mid-poll cancels the job', () => {
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

  test('aborting mid-poll cancels the job and returns promptly, not after the full poll timeout', async () => {
    const controller = new AbortController();
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        // Abort right after submit — the poll loop's very first check (before its
        // first sleep) must catch this, so the test never waits out a real
        // DEFAULT_POLL_INTERVAL_MS.
        controller.abort();
        return new Response(JSON.stringify({ task_id: 'tid-1', status: 'queued' }), { status: 202 });
      }
      if (url.includes('/v1/videos/jobs/tid-1/cancel') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-1', cancelled: true, status: 'cancelling' }), { status: 200 });
      }
      // The poll loop must never reach GET .../jobs/tid-1 once aborted.
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool(
      'generate_video',
      { action: 'generate', model: 'grok-video/grok-imagine', prompt: 'a cat surfing' },
      controller.signal
    );

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('cancelled');
    expect((res.content[0] as { text: string }).text).toContain('tid-1');

    const cancelCalls = calls.filter((c) => c.url.includes('/cancel'));
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.method).toBe('POST');

    // The poll loop bailed BEFORE ever GETting the job status.
    expect(calls.some((c) => c.url.endsWith('/v1/videos/jobs/tid-1'))).toBe(false);
  });

  test('a failed cancel call does not throw — the tool call still resolves cleanly', async () => {
    const controller = new AbortController();
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        controller.abort();
        return new Response(JSON.stringify({ task_id: 'tid-2', status: 'queued' }), { status: 202 });
      }
      if (url.includes('/v1/videos/jobs/tid-2/cancel')) {
        throw new TypeError('network error');
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool(
      'generate_video',
      { action: 'generate', model: 'grok-video/grok-imagine', prompt: 'a cat surfing' },
      controller.signal
    );

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('cancelled');
  });

  test('the poll loop reports "still generating" when the budget runs out without done/failed', async () => {
    process.env.VIDEO_POLL_TIMEOUT_MS = '6000'; // ~3 real 2s sleeps, then deadline exit... 3s interval => ~2 polls
    const controller = new AbortController();
    let polls = 0;
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-leak', status: 'queued' }), { status: 202 });
      }
      if (url.endsWith('/v1/videos/jobs/tid-leak') && method === 'GET') {
        polls++;
        return new Response(JSON.stringify({ task_id: 'tid-leak', status: 'running' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool(
      'generate_video',
      { action: 'generate', model: 'grok-video/grok-imagine', prompt: 'a cat surfing' },
      controller.signal
    );

    expect(polls).toBeGreaterThanOrEqual(1);
    expect(controller.signal.aborted).toBe(false);
    expect((res.content[0] as { text: string }).text).toContain('still generating');
  }, 20_000);

  test('a transport error that coincides with an abort is not swallowed as retryable — it cancels', async () => {
    // fetchJob maps a thrown fetch (network error / abort) to { __transportError }. The
    // poll loop treats that as transient and would `continue` to retry — but it first
    // checks signal.aborted so a Stop-triggered abort mid-fetch resolves to a cancel
    // instead of silently looping.
    const controller = new AbortController();
    let getCount = 0;
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-terr', status: 'queued' }), { status: 202 });
      }
      if (url.endsWith('/v1/videos/jobs/tid-terr') && method === 'GET') {
        getCount++;
        controller.abort();
        throw new TypeError('network error'); // → fetchJob returns { __transportError }
      }
      if (url.includes('/v1/videos/jobs/tid-terr/cancel') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-terr', cancelled: true, status: 'cancelling' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new VideoModule().handleTool(
      'generate_video',
      { action: 'generate', model: 'grok-video/grok-imagine', prompt: 'a cat surfing' },
      controller.signal
    );

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('cancelled');
    expect((res.content[0] as { text: string }).text).toContain('tid-terr');
    // The abort was honored immediately: exactly one GET (no retry), and a cancel fired.
    expect(getCount).toBe(1);
    expect(calls.filter((c) => c.url.includes('/cancel'))).toHaveLength(1);
  });
});

describe('drainCancel() — lets a process-exiting shutdown wait for the E3 call', () => {
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.ANTHROPIC_BASE_URL = BASE;
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
  });

  afterEach(() => {
    global.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('resolves immediately when nothing is in flight', async () => {
    const mod = new VideoModule();
    // No cancelledResult() ever ran — activeCancelPromise is still null.
    await expect(mod.drainCancel()).resolves.toBeUndefined();
  });

  test('waits for an in-flight cancel call to actually finish before resolving', async () => {
    const controller = new AbortController();
    let resolveCancelFetch!: (res: Response) => void;
    const cancelFetchGate = new Promise<Response>((resolve) => { resolveCancelFetch = resolve; });
    let cancelFetchSettled = false;

    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/videos/generations') && method === 'POST') {
        controller.abort();
        return new Response(JSON.stringify({ task_id: 'tid-drain', status: 'queued' }), { status: 202 });
      }
      if (url.includes('/v1/videos/jobs/tid-drain/cancel') && method === 'POST') {
        // Held open deliberately — drainCancel() must not resolve before this does.
        const res = await cancelFetchGate;
        cancelFetchSettled = true;
        return res;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const mod = new VideoModule();
    // Don't await yet — the cancel HTTP call is parked on cancelFetchGate.
    const genPromise = mod.handleTool(
      'generate_video',
      { action: 'generate', model: 'grok-video/grok-imagine', prompt: 'a cat surfing' },
      controller.signal
    );

    // Give handleGenerate's poll loop a tick to reach cancelledResult() and set
    // activeCancelPromise before we start racing drainCancel() against it.
    await new Promise((r) => setImmediate(r));

    let drainSettled = false;
    const drainPromise = mod.drainCancel().then(() => { drainSettled = true; });

    // The cancel fetch is still parked — neither the tool call nor drainCancel
    // should have settled yet.
    await new Promise((r) => setImmediate(r));
    expect(cancelFetchSettled).toBe(false);
    expect(drainSettled).toBe(false);

    resolveCancelFetch(new Response(JSON.stringify({ task_id: 'tid-drain', cancelled: true, status: 'cancelling' }), { status: 200 }));

    await drainPromise;
    expect(drainSettled).toBe(true);
    expect(cancelFetchSettled).toBe(true);

    await genPromise;
  });
});
