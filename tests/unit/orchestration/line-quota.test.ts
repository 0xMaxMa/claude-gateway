import { classifyLineRejection, insufficientForGroup, lineQuotaState, lineRetryBackoffMs, lowQuotaTransition, resetLineQuotaCache, resetLowQuotaWarnings, LINE_RATE_LIMIT_MAX_ATTEMPTS } from '../../../src/orchestration/line-quota';

beforeEach(() => { resetLineQuotaCache(); resetLowQuotaWarnings(); });

describe('classifyLineRejection', () => {
  test('a non-429 status is never classified', () => {
    expect(classifyLineRejection(500, { status: 'ok', remaining: 0 }, '1', 'monthly limit reached')).toBe('unclassified');
  });
  test('a known-empty cached quota overrides an unrelated rejection message', () => {
    expect(classifyLineRejection(429, { status: 'ok', remaining: 0 }, null, 'Too Many Requests')).toBe('quota_exhausted');
  });
  test('a nonzero cached remaining does not get overridden into exhaustion', () => {
    expect(classifyLineRejection(429, { status: 'ok', remaining: 50 }, '2', 'Too Many Requests')).toBe('rate_limited');
  });
  test('a rejection message naming the quota classifies as exhausted even without cached quota data', () => {
    expect(classifyLineRejection(429, { status: 'unavailable' }, null, 'You have reached your monthly limit.')).toBe('quota_exhausted');
  });
  test('Retry-After with no quota signal classifies as a rate limit', () => {
    expect(classifyLineRejection(429, { status: 'unavailable' }, '3', 'Too Many Requests')).toBe('rate_limited');
  });
  test('no quota data, no matching message, no Retry-After stays unclassified rather than guessed', () => {
    expect(classifyLineRejection(429, { status: 'unavailable' }, null, undefined)).toBe('unclassified');
  });
  test('a very long or non-string rejection message never reaches the log/regex unbounded', () => {
    const huge = 'quota ' + 'x'.repeat(10000);
    expect(classifyLineRejection(429, { status: 'unavailable' }, null, huge)).toBe('quota_exhausted');
    expect(classifyLineRejection(429, { status: 'unavailable' }, null, { nested: 'object' })).toBe('unclassified');
  });
});

describe('lineRetryBackoffMs', () => {
  test('doubles per attempt and caps', () => {
    expect(lineRetryBackoffMs(1)).toBe(2000);
    expect(lineRetryBackoffMs(2)).toBe(4000);
    expect(lineRetryBackoffMs(3)).toBe(8000);
    expect(lineRetryBackoffMs(20)).toBe(30000);
  });
  test('LINE_RATE_LIMIT_MAX_ATTEMPTS is a small bounded number', () => {
    expect(LINE_RATE_LIMIT_MAX_ATTEMPTS).toBe(3);
  });
});

describe('lowQuotaTransition', () => {
  test('unavailable quota data never warns', () => {
    expect(lowQuotaTransition('agent-a', { status: 'unavailable' })).toBe('none');
  });
  test('a nonzero but insufficient remaining warns once, then stays silent until it clears', () => {
    expect(lowQuotaTransition('agent-a', { status: 'ok', remaining: 5 })).toBe('warn');
    expect(lowQuotaTransition('agent-a', { status: 'ok', remaining: 5 })).toBe('none');
    expect(lowQuotaTransition('agent-a', { status: 'ok', remaining: 3 })).toBe('none');
  });
  test('recovering above the threshold clears the warning exactly once', () => {
    lowQuotaTransition('agent-a', { status: 'ok', remaining: 5 });
    expect(lowQuotaTransition('agent-a', { status: 'ok', remaining: 500 })).toBe('recovered');
    expect(lowQuotaTransition('agent-a', { status: 'ok', remaining: 500 })).toBe('none');
  });
  test('dropping low again after recovery re-arms the warning', () => {
    lowQuotaTransition('agent-a', { status: 'ok', remaining: 5 });
    lowQuotaTransition('agent-a', { status: 'ok', remaining: 500 });
    expect(lowQuotaTransition('agent-a', { status: 'ok', remaining: 5 })).toBe('warn');
  });
  test('agents are tracked independently', () => {
    expect(lowQuotaTransition('agent-a', { status: 'ok', remaining: 5 })).toBe('warn');
    expect(lowQuotaTransition('agent-b', { status: 'ok', remaining: 5 })).toBe('warn');
  });
});

describe('insufficientForGroup', () => {
  test('a nonzero remaining quota that cannot cover the pending group is insufficient', () => {
    expect(insufficientForGroup({ status: 'ok', remaining: 3 }, 5)).toBe(true);
  });
  test('a remaining quota that covers the pending group is not insufficient', () => {
    expect(insufficientForGroup({ status: 'ok', remaining: 5 }, 5)).toBe(false);
    expect(insufficientForGroup({ status: 'ok', remaining: 10 }, 5)).toBe(false);
  });
  test('an empty pending group is never insufficient, however low the quota', () => {
    expect(insufficientForGroup({ status: 'ok', remaining: 0 }, 0)).toBe(false);
  });
  test('unavailable quota data never claims insufficiency', () => {
    expect(insufficientForGroup({ status: 'unavailable' }, 5)).toBe(false);
  });
});

describe('lineQuotaState', () => {
  const okResponses = (quotaValue: number, totalUsage: number) => jest.fn(async (url: string | URL | Request) => {
    if (String(url).includes('/quota/consumption')) return new Response(JSON.stringify({ totalUsage }));
    if (String(url).includes('/quota')) return new Response(JSON.stringify({ type: 'limited', value: quotaValue }));
    throw new Error(`unexpected url ${url}`);
  });

  test('reports remaining as quota value minus consumption', async () => {
    const request = okResponses(1000, 940);
    expect(await lineQuotaState('a', 'token', request as unknown as typeof fetch)).toEqual({ status: 'ok', remaining: 60 });
  });
  test('caches within the TTL so a burst of sends costs one fetch, not one per send', async () => {
    const request = okResponses(1000, 0);
    const now = Date.now();
    await lineQuotaState('a', 'token', request as unknown as typeof fetch, now);
    await lineQuotaState('a', 'token', request as unknown as typeof fetch, now + 1000);
    expect(request).toHaveBeenCalledTimes(2); // quota + consumption, once
  });
  test('a stale cache entry is refetched after the TTL', async () => {
    const request = okResponses(1000, 0);
    const now = Date.now();
    await lineQuotaState('a', 'token', request as unknown as typeof fetch, now);
    await lineQuotaState('a', 'token', request as unknown as typeof fetch, now + 61000);
    expect(request).toHaveBeenCalledTimes(4);
  });
  test('an unlimited quota type is reported as unavailable rather than an invented remaining count', async () => {
    const request = jest.fn(async (url: string | URL | Request) => String(url).includes('consumption') ? new Response(JSON.stringify({ totalUsage: 5 })) : new Response(JSON.stringify({ type: 'none' })));
    expect(await lineQuotaState('a', 'token', request as unknown as typeof fetch)).toEqual({ status: 'unavailable' });
  });
  test('a non-ok response from either endpoint is unavailable, not a false zero', async () => {
    const request = jest.fn(async (url: string | URL | Request) => String(url).includes('consumption') ? new Response('', { status: 500 }) : new Response(JSON.stringify({ type: 'limited', value: 1000 })));
    expect(await lineQuotaState('a', 'token', request as unknown as typeof fetch)).toEqual({ status: 'unavailable' });
  });
  test('a network failure is unavailable, never a thrown error', async () => {
    const request = jest.fn(async () => { throw new Error('network down'); });
    expect(await lineQuotaState('a', 'token', request as unknown as typeof fetch)).toEqual({ status: 'unavailable' });
  });
});
