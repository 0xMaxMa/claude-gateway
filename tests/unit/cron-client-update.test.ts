import { CronClient } from '../../mcp/tools/cron/client';

/**
 * Regression test for the MCP cron client's timeout normalization (#239/#240).
 *
 * The MCP tool schema advertises `timeout_ms` (snake_case), but the REST API
 * expects `timeoutMs` (camelCase). CronClient.update() must run params through
 * normalizeParams() so a timeout set via cron_update is actually honored.
 *
 * PR #240 accidentally left a DUPLICATE update() method whose (winning) copy
 * sent params raw — silently dropping the timeout back to the default and, as a
 * TS2393 duplicate implementation, breaking compilation of every suite that
 * imports the MCP cron module. This test pins update() to the normalized body,
 * so a raw-params regression (or a re-introduced duplicate) goes red here.
 */
describe('CronClient.update — timeout normalization (#240)', () => {
  const realFetch = global.fetch;
  let lastCall: { url: string; init: RequestInit } | null;

  beforeEach(() => {
    lastCall = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      lastCall = { url, init };
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function sentBody(): Record<string, unknown> {
    if (!lastCall?.init?.body) throw new Error('fetch was not called with a body');
    return JSON.parse(lastCall.init.body as string);
  }

  it('maps timeout_ms -> timeoutMs on update (does not send params raw)', async () => {
    const client = new CronClient('http://gateway.local', 'agent-1', 'key');
    await client.update('job-1', { timeout_ms: 5000, name: 'nightly' });

    expect(lastCall?.init?.method).toBe('PUT');
    expect(lastCall?.url).toBe('http://gateway.local/api/v1/crons/job-1');

    const body = sentBody();
    expect(body).toEqual({ timeoutMs: 5000, name: 'nightly' });
    expect('timeout_ms' in body).toBe(false);
  });

  it('leaves an update without timeout_ms untouched', async () => {
    const client = new CronClient('http://gateway.local', 'agent-1', 'key');
    await client.update('job-1', { name: 'renamed' });

    expect(sentBody()).toEqual({ name: 'renamed' });
  });
});
