import { probeHealth } from '../../src/cli/health';

/**
 * `doctor`, `gateway status` and `service install` all ask the same question,
 * and used to ask it three different ways — a fix in one (a leaked abort timer)
 * had to be made three times, and was missed once. These specs cover the single
 * probe they now share.
 */
describe('probeHealth', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('reports a 2xx as healthy', async () => {
    global.fetch = jest.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    expect(await probeHealth('http://gw')).toEqual({ ok: true, answered: true, status: 200, detail: 'gateway responding' });
  });

  it('appends /health to the base URL', async () => {
    const fetchMock = jest.fn(async () => new Response('ok', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await probeHealth('http://gw:10850');
    expect(fetchMock).toHaveBeenCalledWith('http://gw:10850/health', expect.anything());
  });

  /** An address that answers 401 is up. Calling it "no response" sends the
   *  operator to debug a proxy that is working exactly as configured. */
  it('reports the status verbatim rather than collapsing it into no-response', async () => {
    for (const status of [401, 404, 500, 502]) {
      global.fetch = jest.fn(async () => new Response('nope', { status })) as unknown as typeof fetch;
      const probe = await probeHealth('http://gw');
      expect(probe).toMatchObject({ ok: false, answered: true, status });
      expect(probe.detail).toBe(`HTTP ${status} (answered, but not a healthy gateway)`);
    }
  });

  it('distinguishes nothing-there from a timeout', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await probeHealth('http://gw')).toEqual({ ok: false, answered: false, detail: 'no response' });

    global.fetch = jest.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    expect(await probeHealth('http://gw', 250)).toEqual({ ok: false, answered: false, detail: 'no response (timed out after 250ms)' });
  });

  /** The unreachable case is the one these commands are run for, so the abort
   *  timer must not survive a rejected fetch and hold the event loop open. */
  it('clears its abort timer even when the request rejects', async () => {
    const clear = jest.spyOn(global, 'clearTimeout');
    global.fetch = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    clear.mockClear();
    await probeHealth('http://gw');
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
