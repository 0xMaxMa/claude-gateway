import { EventEmitter } from 'events';
import { startProcessTurn } from '../../../src/orchestration/process-turn';
import type { SessionProcess } from '../../../src/session/process';

test('managed turns report deduplicated tool usage and elapsed start time exactly once', async () => {
  const p = new EventEmitter() as SessionProcess;
  const metrics=jest.fn();
  Object.assign(p,{runtimeProfile:{role:'worker'},start:async()=>{},stop:jest.fn(async()=>{}),sendMessage:()=>{
    p.emit('output',JSON.stringify({type:'system',subtype:'init',tools:['Bash']}));
    const e=JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'call-1',name:'Bash'}]}});
    p.emit('output',e);p.emit('output',e);
    p.emit('output',JSON.stringify({type:'result',result:'done',usage:{input_tokens:12,output_tokens:4}}));
    p.emit('exit',0);
  }});
  const before=Date.now();await expect(startProcessTurn(p,'task',1000,undefined,metrics).result).resolves.toMatchObject({text:'done'});
  expect(metrics).toHaveBeenCalledTimes(1);expect(metrics.mock.calls[0][0]).toMatchObject({toolIds:['call-1'],inputTokens:12,totalTokens:16});
  expect(metrics.mock.calls[0][0].startedAt).toBeGreaterThanOrEqual(before);
});

test.each([
  [{ result: 'API Error: 503 Provider capacity is fully in use right now.' }, 'PROVIDER_CAPACITY'],
  [{ errors: ['API Error: 503 Provider capacity is fully in use right now.'] }, 'PROVIDER_CAPACITY'],
  [{ result: 'API Error: 503 Service unavailable' }, 'PROVIDER_UNAVAILABLE'],
  [{ result: { error: { type: 'rate_limit', message: 'Daily credit limit reached. Resets in 2 hours.' } } }, 'INFERENCE_FAILED'],
  [{ result: { error: { status: 429 } } }, 'INFERENCE_FAILED'],
  [{ result: 'Other inference failure' }, 'INFERENCE_FAILED'],
])('managed turns retain actionable provider error codes: %j', async (body, code) => {
  const p = new EventEmitter() as SessionProcess;
  Object.assign(p, { start: async () => {}, stop: jest.fn(async () => {}), sendMessage: () => {
    p.emit('output', JSON.stringify({ type: 'result', is_error: true, ...body }));
  }});
  await expect(startProcessTurn(p, 'check', 1000).result).rejects.toMatchObject({ code });
});

test('provider messages stay actionable while internal failures and bearer values remain private', () => {
  const { inferenceFailureMessage } = require('../../../src/orchestration/inference-errors');
  expect(inferenceFailureMessage({ code: 'PROVIDER_CAPACITY' })).toContain('503: Provider capacity is fully in use right now');
  expect(inferenceFailureMessage({ code: 'INFERENCE_FAILED', message: 'API Error: 401 Unauthorized Bearer secret-value' })).toBe('Provider authentication failed. Check your provider credentials.');
  expect(inferenceFailureMessage({ code: 'INFERENCE_FAILED', message: 'Daily credit limit reached. Resets in 2 hours. Bearer secret-value /internal/path' })).toBe('Provider quota or billing limit reached. Try again after the limit resets in 2 hours.');
  expect(inferenceFailureMessage({ code: 'INFERENCE_FAILED', message: 'rate_limit: Too many requests. Retry after 45 seconds. sk-secret-value' })).toBe('Provider rate limit reached. Try again in 45 seconds.');
  expect(inferenceFailureMessage({ code: 'INFERENCE_FAILED', message: 'billing_error: payment required' })).toContain('provider usage or billing');
  expect(inferenceFailureMessage({ code: 'INFERENCE_FAILED', message: '503 Service unavailable at /internal/path' })).toBe('The model provider is temporarily unavailable. Please try again later.');
  expect(inferenceFailureMessage({ code: 'INFERENCE_FAILED', message: 'request failed with sk-secret-value at /internal/path' })).toBeUndefined();
  expect(inferenceFailureMessage({ code: 'INFERENCE_FAILED', message: 'claude-opus: Daily credit limit reached. Resets in 2 hours.' })).toContain('2 hours');
  expect(inferenceFailureMessage({ code: 'INFERENCE_FAILED', message: 'gpt-5: Daily credit limit reached. Resets in 2 hours.' })).toContain('2 hours');
  expect(inferenceFailureMessage(new Error('internal stack detail'))).toBeUndefined();
});

test('assistant error type remains actionable when provider omits text', async () => {
  const p = new EventEmitter() as SessionProcess;
  Object.assign(p, { start: async () => {}, stop: jest.fn(async () => {}), sendMessage: () => {
    p.emit('output', JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { content: [] } }));
    p.emit('output', JSON.stringify({ type: 'result', is_error: true, result: 'Inference failed' }));
  }});
  const { inferenceFailureMessage } = require('../../../src/orchestration/inference-errors');
  const error = await startProcessTurn(p, 'check', 1000).result.catch(error => error);
  expect(inferenceFailureMessage(error)).toBe('Provider rate limit reached. Please try again later.');
});

test('assistant error without API Error prefix survives a generic terminal result', async () => {
  const p = new EventEmitter() as SessionProcess;
  Object.assign(p, { start: async () => {}, stop: jest.fn(async () => {}), sendMessage: () => {
    p.emit('output', JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Daily credit limit reached. Resets in 3 hours.' }] } }));
    p.emit('output', JSON.stringify({ type: 'result', is_error: true, result: 'Inference failed' }));
  }});
  const { inferenceFailureMessage } = require('../../../src/orchestration/inference-errors');
  const error = await startProcessTurn(p, 'check', 1000).result.catch(error => error);
  expect(error).toMatchObject({ code: 'INFERENCE_FAILED', message: expect.stringContaining('Daily credit limit reached') });
  expect(inferenceFailureMessage(error)).toBe('Provider quota or billing limit reached. Try again after the limit resets in 3 hours.');
});

test('long terminal errors do not hide an earlier actionable assistant error', async () => {
  const p = new EventEmitter() as SessionProcess;
  Object.assign(p, { start: async () => {}, stop: jest.fn(async () => {}), sendMessage: () => {
    p.emit('output', JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Daily credit limit reached. Resets in 2 hours.' }] } }));
    p.emit('output', JSON.stringify({ type: 'result', is_error: true, result: 'Inference failed ' + 'x'.repeat(4096) }));
  }});
  const { inferenceFailureMessage } = require('../../../src/orchestration/inference-errors');
  const error = await startProcessTurn(p, 'check', 1000).result.catch(error => error);
  expect(inferenceFailureMessage(error)).toBe('Provider quota or billing limit reached. Try again after the limit resets in 2 hours.');
});

test('structured provider errors retain their message for web and channel presentation', async () => {
  const p = new EventEmitter() as SessionProcess;
  Object.assign(p, { start: async () => {}, stop: jest.fn(async () => {}), sendMessage: () => {
    p.emit('output', JSON.stringify({ type: 'result', is_error: true, result: { error: { type: 'rate_limit', message: 'Daily credit limit reached. Resets in 20 minutes.' } } }));
  }});
  const error = await startProcessTurn(p, 'check', 1000).result.catch(error => error);
  expect(error.message).toContain('Daily credit limit reached');
  const { inferenceFailureMessage } = require('../../../src/orchestration/inference-errors');
  expect(inferenceFailureMessage(error)).toContain('20 minutes');
});

test.each([[429, 'Provider rate limit reached.'], [401, 'Provider authentication failed.'], [402, 'Provider quota or billing limit reached.']])('structured HTTP %s provider status stays actionable', async (status, message) => {
  const p = new EventEmitter() as SessionProcess;
  Object.assign(p, { start: async () => {}, stop: jest.fn(async () => {}), sendMessage: () => {
    p.emit('output', JSON.stringify({ type: 'result', is_error: true, result: { error: { status } } }));
  }});
  const { inferenceFailureMessage } = require('../../../src/orchestration/inference-errors');
  const error = await startProcessTurn(p, 'check', 1000).result.catch(error => error);
  expect(inferenceFailureMessage(error)).toContain(message);
});

test('deeply nested provider errors remain bounded and safely generic', async () => {
  const p = new EventEmitter() as SessionProcess;
  let nested: unknown = { message: 'Daily credit limit reached.' };
  for (let i = 0; i < 40; i++) nested = { error: nested };
  Object.assign(p, { start: async () => {}, stop: jest.fn(async () => {}), sendMessage: () => {
    p.emit('output', JSON.stringify({ type: 'result', is_error: true, result: nested }));
  }});
  const { inferenceFailureMessage } = require('../../../src/orchestration/inference-errors');
  const error = await startProcessTurn(p, 'check', 1000).result.catch(error => error);
  expect(error.code).toBe('INFERENCE_FAILED');
  expect(inferenceFailureMessage(error)).toBeUndefined();
});

test.each(['final-only','replacement','structured'])('oversized %s result fails before a successful report is published',async kind=>{
 const p=new EventEmitter() as SessionProcess,publish=jest.fn();
 const text='🎯'.repeat(65537);
 Object.assign(p,{runtimeProfile:kind==='structured'?{role:'agent',responseSchema:{type:'object'}}:undefined,
  start:async()=>{},stop:jest.fn(async()=>{}),sendMessage:()=>{
   if(kind==='replacement')p.emit('output',JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text:'Starting'}}}));
   p.emit('output',JSON.stringify({type:'result',...(kind==='structured'?{structured_output:{display_text:text}}:{result:text})}));
  }});
 await expect(startProcessTurn(p,'task',1000,publish).result).rejects.toMatchObject({code:'RESPONSE_TOO_LARGE'});
 expect(p.stop).toHaveBeenCalled();
 expect(publish.mock.calls.flat()).toEqual(kind==='replacement'?['Starting']:[]);
});
