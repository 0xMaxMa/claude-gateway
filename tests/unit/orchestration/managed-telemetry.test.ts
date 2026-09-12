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
  expect(inferenceFailureMessage({ code: 'INFERENCE_FAILED', message: 'API Error: 401 Unauthorized Bearer secret-value' })).toBe('401 Unauthorized Bearer [redacted]');
  expect(inferenceFailureMessage(new Error('internal stack detail'))).toBeUndefined();
});
