/**
 * Unit tests for generate_image's Stop-mid-generation cancellation (getpod #2216
 * follow-up) — mcp/tools/image/module.ts's handleGenerate poll loop + the new E3
 * cancel call.
 *
 * mcp/server.ts threads the MCP SDK's per-call AbortSignal (fired by the SDK when
 * the client sends notifications/cancelled for this tool call — the mechanism the
 * CLI uses to propagate a user Stop/Ctrl-C into an in-flight tool call) into
 * ImageModule.handleTool. Locked in here, entirely at the module level (no real
 * CLI/MCP transport involved — fetch is mocked):
 *
 *  1. An aborted signal stops the poll loop promptly (does not run to
 *     IMAGE_POLL_TIMEOUT_MS) and fires POST /v1/images/jobs/:id/cancel for the
 *     submitted task_id.
 *  2. The tool result reports the cancellation (isError, mentions the task_id) —
 *     not a generic timeout/error.
 *  3. A cancel-call failure (network error) never throws out of handleTool — the
 *     caller's own (already-cancelled) result still returns cleanly.
 *  4. status/list/list_refs do NOT receive the signal at all (only "generate" has
 *     a poll loop worth reacting to) — handleTool's dispatch, not re-tested per
 *     action here since it's a single `case 'generate':` line change.
 */
import { getEventListeners } from 'events';
import { ImageModule } from '../../mcp/tools/image/module';

const BASE = 'https://image.example.com';

const ENV_KEYS = ['IMAGE_BASE_URL', 'ANTHROPIC_BASE_URL', 'IMAGE_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'IMAGE_POLL_TIMEOUT_MS'] as const;

type Captured = { url: string; method: string };

describe('generate_image action="generate" — Stop mid-poll cancels the job', () => {
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
      if (url.endsWith('/v1/images/generations') && method === 'POST') {
        // Abort right after submit — the poll loop's very first check (before its
        // first sleep) must catch this, so the test never waits out a real
        // DEFAULT_POLL_INTERVAL_MS.
        controller.abort();
        return new Response(JSON.stringify({ task_id: 'tid-1', status: 'queued' }), { status: 202 });
      }
      if (url.includes('/v1/images/jobs/tid-1/cancel') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-1', cancelled: true, status: 'cancelling' }), { status: 200 });
      }
      // The poll loop must never reach GET .../jobs/tid-1 once aborted.
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new ImageModule().handleTool(
      'generate_image',
      { action: 'generate', model: 'gemini/gemini-2.5-flash-image', prompt: 'a red apple' },
      controller.signal
    );

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('cancelled');
    expect((res.content[0] as { text: string }).text).toContain('tid-1');

    const cancelCalls = calls.filter((c) => c.url.includes('/cancel'));
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.method).toBe('POST');

    // The poll loop bailed BEFORE ever GETting the job status.
    expect(calls.some((c) => c.url.endsWith('/v1/images/jobs/tid-1'))).toBe(false);
  });

  test('a failed cancel call does not throw — the tool call still resolves cleanly', async () => {
    const controller = new AbortController();
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/images/generations') && method === 'POST') {
        controller.abort();
        return new Response(JSON.stringify({ task_id: 'tid-2', status: 'queued' }), { status: 202 });
      }
      if (url.includes('/v1/images/jobs/tid-2/cancel')) {
        throw new TypeError('network error');
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new ImageModule().handleTool(
      'generate_image',
      { action: 'generate', model: 'gemini/gemini-2.5-flash-image', prompt: 'a red apple' },
      controller.signal
    );

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('cancelled');
  });

  test('an already-aborted signal short-circuits before even submitting is NOT assumed — generate still submits once', async () => {
    // handleGenerate only starts checking the signal once it reaches the poll loop
    // (after submit) — the initial POST always fires. This locks in that the
    // signal is a poll-loop concern, not a submit-time short-circuit, since the
    // job must exist server-side before there is anything to cancel.
    const controller = new AbortController();
    controller.abort();
    let submitCount = 0;
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/images/generations') && method === 'POST') {
        submitCount++;
        return new Response(JSON.stringify({ task_id: 'tid-3', status: 'queued' }), { status: 202 });
      }
      if (url.includes('/v1/images/jobs/tid-3/cancel')) {
        return new Response(JSON.stringify({ task_id: 'tid-3', cancelled: true, status: 'cancelling' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new ImageModule().handleTool(
      'generate_image',
      { action: 'generate', model: 'gemini/gemini-2.5-flash-image', prompt: 'a red apple' },
      controller.signal
    );

    expect(submitCount).toBe(1);
    expect(res.isError).toBe(true);
  });

  test('the poll loop does not leak an abort listener per iteration on the normal (non-aborted) path', async () => {
    // Regression: sleep() adds an { once:true } abort listener each poll iteration
    // against the SAME long-lived per-call signal. { once:true } only removes it
    // when abort actually fires — so on the normal path (timer fires, never
    // aborted) an un-removed listener piles up every iteration (up to ~75 for the
    // default 150s/2s budget), tripping Node's MaxListenersExceededWarning. Here
    // the signal is NEVER aborted and the job stays 'processing' until the poll
    // budget runs out, so after handleTool returns the signal must hold ZERO abort
    // listeners. Before the fix this was one-per-iteration.
    process.env.IMAGE_POLL_TIMEOUT_MS = '6000'; // ~3 real 2s sleeps, then deadline exit
    const controller = new AbortController();
    let polls = 0;
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/images/generations') && method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'tid-leak', status: 'queued' }), { status: 202 });
      }
      if (url.endsWith('/v1/images/jobs/tid-leak') && method === 'GET') {
        polls++;
        return new Response(JSON.stringify({ task_id: 'tid-leak', status: 'processing' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const res = await new ImageModule().handleTool(
      'generate_image',
      { action: 'generate', model: 'gemini/gemini-2.5-flash-image', prompt: 'a red apple' },
      controller.signal
    );

    // Loop ran several iterations (proving multiple sleeps happened) and exited via
    // the poll-budget deadline, not via abort.
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(controller.signal.aborted).toBe(false);
    expect((res.content[0] as { text: string }).text).toContain('still generating');
    // The invariant: no abort listeners left dangling on the signal.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  }, 20_000);
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
    const mod = new ImageModule();
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
      if (url.endsWith('/v1/images/generations') && method === 'POST') {
        controller.abort();
        return new Response(JSON.stringify({ task_id: 'tid-drain', status: 'queued' }), { status: 202 });
      }
      if (url.includes('/v1/images/jobs/tid-drain/cancel') && method === 'POST') {
        // Held open deliberately — drainCancel() must not resolve before this does.
        const res = await cancelFetchGate;
        cancelFetchSettled = true;
        return res;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const mod = new ImageModule();
    // Don't await yet — the cancel HTTP call is parked on cancelFetchGate.
    const genPromise = mod.handleTool(
      'generate_image',
      { action: 'generate', model: 'gemini/gemini-2.5-flash-image', prompt: 'a red apple' },
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
