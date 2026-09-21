import { JevService, jevEndpoint, resolveDirectJevConnection } from '../../../src/jev/service';
import { JevConfig, JevRequest } from '../../../src/jev/types';
import { validateJevRequest, validateJevResponse } from '../../../src/jev/validation';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const request: JevRequest = { state: 'hello', questions: { urgent: { type: 'noul', instructions: 'Urgent?' } } };
const body = { model: 'jev-1.13.0', answers: { urgent: { type: 'noul', noul: .9 } }, usage: { input_tokens: 10, output_tokens: 1 } };
const response = () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const context = { principalId: 'agent:a', consumer: 'test' };
function fixture(overrides: Partial<JevConfig> = {}) {
  let config: JevConfig = { enabled: true, provider: 'upstream', model: 'opaque/provider/model', ...overrides };
  const fetcher = jest.fn(async () => response());
  const observer = jest.fn();
  const service = new JevService({ getConfig: () => config, resolveConnection: async () => ({ baseUrl: 'https://provider.example/v1', apiKey: 'secret-key' }), fetch: fetcher as any, onEvaluation: observer });
  return { service, fetcher, observer, update: (value: Partial<JevConfig>) => { config = { ...config, ...value }; } };
}
describe('Jev evaluation boundary', () => {
  it('preserves opaque model and upstream request identity without leaking data into telemetry', async () => {
    const f = fixture(); const result = await f.service.evaluate({ ...request, requestId: 'request-1' }, context);
    expect(result.requestedModel).toBe('opaque/provider/model');
    const call = f.fetcher.mock.calls[0] as any[];
    expect(String(call[0])).toBe('https://provider.example/v1/jev/evaluate');
    expect(JSON.parse(call[1].body)).toEqual({ model: 'opaque/provider/model', state: request.state, questions: request.questions, request_id: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(f.observer.mock.calls)).not.toMatch(/hello|Urgent|secret-key/);
  });
  it('sends only the native TypeSafe contract for direct evaluation', async () => {
    const f = fixture({ provider: 'typesafe' }); await f.service.evaluate(request, context);
    const call = f.fetcher.mock.calls[0] as any[];
    expect(String(call[0])).toBe('https://provider.example/v1/systemone');
    expect(Object.keys(JSON.parse(call[1].body)).sort()).toEqual(['model','questions','state']);
  });
  it.each(['file:///tmp/key', 'https://user:secret@example.com', 'http://public.example', 'https://example.com?a=secret', 'https://example.com/#fragment'])('rejects unsafe configured endpoint %s', url => {
    expect(() => jevEndpoint({ baseUrl: url, apiKey: 'x' }, 'upstream')).toThrow();
  });
  it('permits explicit loopback development and prevents redirect following', async () => {
    expect(String(jevEndpoint({ baseUrl: 'http://127.0.0.1:4000', apiKey: 'x' }, 'upstream'))).toBe('http://127.0.0.1:4000/v1/jev/evaluate');
    const f = fixture(); await f.service.evaluate(request, context);
    expect((f.fetcher.mock.calls[0] as any[])[1].redirect).toBe('error');
  });
  it('rejects caller URL and model overrides before making a paid request', async () => {
    const f = fixture(); await expect(f.service.evaluate({ ...request, model: 'other', baseUrl: 'http://evil' } as any, context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects oversized, non-JSON and incomplete inputs rather than truncating', () => {
    expect(() => validateJevRequest(request, { maxInputBytes: 3 })).toThrow();
    expect(() => validateJevRequest({ ...request, state: { x: undefined } }, {})).toThrow();
    expect(() => validateJevRequest({ state: 'x', questions: {} }, {})).toThrow();
    expect(() => validateJevRequest({ ...request, questions: { bad: { type: 'score', instructions: 'x', criteria: ['one'] } } }, {})).toThrow();
  });
  it('rejects duplicate IDs within one principal and isolates other principals', async () => {
    const f = fixture(); await f.service.evaluate({ ...request, requestId: 'same' }, context);
    await expect(f.service.evaluate({ ...request, requestId: 'same' }, context)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await f.service.evaluate({ ...request, requestId: 'same' }, { ...context, principalId: 'agent:b' }); expect(f.fetcher).toHaveBeenCalledTimes(2);
    const calls = f.fetcher.mock.calls as any[][]; expect(JSON.parse(calls[0][1].body).request_id).not.toBe(JSON.parse(calls[1][1].body).request_id);
  });
  it('revalidates permission after inference and retains usage evidence for revoked results', async () => {
    const f = fixture(); let allowed = true;
    f.fetcher.mockImplementation(async () => { allowed = false; return response(); });
    await expect(f.service.evaluate(request, { ...context, authorize: () => allowed })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.observer.mock.calls[0][0]).toMatchObject({ outcome: 'failed', usage: body.usage });
  });
  it('bounds queue and deadlines and cancels waiting work without dispatch', async () => {
    const f = fixture({ maxConcurrentRequests: 1, maxQueueSize: 1, timeoutMs: 1000 });
    let release!: () => void; f.fetcher.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(response()); }));
    const first = f.service.evaluate(request, context);
    await new Promise(resolve => setImmediate(resolve));
    const abort = new AbortController(); const second = f.service.evaluate(request, { ...context, signal: abort.signal });
    await expect(f.service.evaluate(request, context)).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    abort.abort(); await expect(second).rejects.toMatchObject({ code: 'CANCELLED' }); release(); await first;
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('includes hung credential resolution in the request deadline', async () => {
    const f = new JevService({ getConfig: () => ({ enabled: true, provider: 'typesafe', model: 'jev', timeoutMs: 10 }), resolveConnection: () => new Promise(() => {}) });
    await expect(f.evaluate(request, context)).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  });
  it('captures config per request and disables queued dispatch after revocation', async () => {
    const f = fixture({ maxConcurrentRequests: 1 }); let release!: () => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(response()); }));
    const first = f.service.evaluate(request, context); await new Promise(resolve => setImmediate(resolve));
    const second = f.service.evaluate(request, context); f.update({ enabled: false }); release();
    await expect(first).rejects.toMatchObject({ code: 'ACCESS_DENIED' }); await expect(second).rejects.toMatchObject({ code: 'ACCESS_DENIED' }); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps safe error/reset metadata and discards provider bodies', async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response('secret-key + hello', { status: 429, headers: { 'retry-after': '60', 'x-ratelimit-reset': '12345' } }));
    await expect(f.service.evaluate(request, context)).rejects.toMatchObject({ code: 'RATE_LIMITED', metadata: { status: 429, retryAfter: '60', resetAt: '12345' } });
  });
  it('rotates direct credential files without restarting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-key-'));
    try {
      const path = join(dir, 'key'); await writeFile(path, 'first');
      expect((await resolveDirectJevConnection({ provider: 'typesafe', apiKeyFile: path })).apiKey).toBe('first');
      await writeFile(path, 'second'); expect((await resolveDirectJevConnection({ provider: 'typesafe', apiKeyFile: path })).apiKey).toBe('second');
      await expect(resolveDirectJevConnection({ provider: 'typesafe', apiKeyFile: path, apiKeyEnv: 'OTHER' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
describe('typed answer validation', () => {
  const typed: JevRequest = { state: 'x', questions: {
    choice: { type: 'choice', instructions: 'Pick', criteria: { a: null, b: 'B' } },
    score: { type: 'score', instructions: 'Rate', criteria: ['low', 'high'] },
    urgent: request.questions.urgent,
  } };
  const valid = { model: 'jev', answers: { choice: { type: 'choice', choice: 'b', confidence: .5, probabilities: { a: .2, b: .8 } }, score: { type: 'score', score: .4, confidence: .2, probabilities: { '0': .6, '1': .4 }, legend: { '0': 'low', '1': 'high' } }, urgent: { type: 'noul', noul: .8 } }, usage: body.usage };
  it('accepts all three types without inventing Noul confidence', () => {
    expect(validateJevResponse(valid, typed, 'opaque', 'id').answers.urgent).toEqual({ type: 'noul', noul: .8 });
  });
  it.each(['missing', 'extra', 'wrongChoice', 'badDistribution', 'wrongScore', 'usage', 'identity'])('rejects invalid %s', mode => {
    const broken: any = structuredClone(valid);
    if (mode === 'missing') delete broken.answers.urgent;
    if (mode === 'extra') broken.answers.extra = { type: 'noul', noul: .3 };
    if (mode === 'wrongChoice') broken.answers.choice.choice = 'a';
    if (mode === 'badDistribution') broken.answers.choice.probabilities.b = 1;
    if (mode === 'wrongScore') broken.answers.score.score = 1;
    if (mode === 'usage') broken.usage.input_tokens = -1;
    if (mode === 'identity') broken.request_id = 'different';
    expect(() => validateJevResponse(broken, typed, 'opaque', 'id')).toThrow();
  });
});

describe('upstream structured failures',()=>{
 it('distinguishes quota from rate limiting and preserves reset without provider prose',async()=>{
  const service=new JevService({getConfig:()=>({enabled:true,provider:'upstream',model:'example/jev'}),resolveConnection:async()=>({baseUrl:'https://provider.example',apiKey:'fake'}),fetch:async()=>new Response(JSON.stringify({error:{code:'QUOTA_EXHAUSTED',resets_at:'2026-10-01T00:00:00Z',message:'never echo credential'}}),{status:429,headers:{'content-type':'application/json'}})});
  await expect(service.evaluate({state:'hello',questions:{q:{type:'noul',instructions:'Greeting?'}}},{principalId:'p',consumer:'test'})).rejects.toMatchObject({code:'QUOTA_EXCEEDED',metadata:{resetAt:'2026-10-01T00:00:00Z'}});
 });
 it('reports ambiguous upstream timeout as outcome unknown, not a free retry',async()=>{
  const service=new JevService({getConfig:()=>({enabled:true,provider:'upstream',model:'example/jev'}),resolveConnection:async()=>({baseUrl:'https://provider.example',apiKey:'fake'}),fetch:async()=>new Response(JSON.stringify({error:{code:'UPSTREAM_TIMEOUT'}}),{status:502,headers:{'content-type':'application/json'}})});
  await expect(service.evaluate({state:'hello',questions:{q:{type:'noul',instructions:'Greeting?'}}},{principalId:'p',consumer:'test'})).rejects.toMatchObject({code:'OUTCOME_UNKNOWN'});
 });
});
