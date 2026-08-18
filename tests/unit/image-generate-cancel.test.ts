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
import { ImageModule } from '../../mcp/tools/image/module';

const BASE = 'https://image.example.com';

const ENV_KEYS = ['IMAGE_BASE_URL', 'ANTHROPIC_BASE_URL', 'IMAGE_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

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
});
