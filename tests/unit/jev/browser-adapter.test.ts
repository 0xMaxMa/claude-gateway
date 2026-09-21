import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserTaskAdapter, BrowserTaskBinding } from '../../../src/orchestration/gateway-tasks/browser';
import { BrowserTransport } from '../../../src/jev/browser-runner';
import { JevResult } from '../../../src/jev/types';
import { CommandContext, TaskSnapshot, WorkerOutcome } from '../../../src/orchestration/types';
const observation = { revision: '1', fingerprint: 'f', state: 'Page', actions: [{ id: 'button', operation: 'click', description: 'Continue' }] };
function answer(operation = 'DONE', target = 'NONE'): JevResult {
  return { requestId: 'id', requestedModel: 'jev', model: 'jev', usage: { input_tokens: 2, output_tokens: 3 }, answers: {
    operation: { type: 'choice', choice: operation, probabilities: { [operation]: 1 }, confidence: .99 },
    target: { type: 'choice', choice: target, probabilities: { [target]: 1 }, confidence: .99 },
  } };
}
function task(id = 'task-a', overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return { agentId: 'alpha', taskId: id, ownerPrincipalId: 'owner', conversationId: 'chat-a', gatewayTarget: { adapter: 'browser', sessionId: 'browser-a', name: 'Private target' }, ...overrides } as TaskSnapshot;
}
const context = (principalId = 'owner', conversationId = 'chat-a') => ({ principalId, conversationId } as CommandContext);
let directory: string; let adapters: BrowserTaskAdapter[];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'jev-browser-adapter-')); adapters = []; });
afterEach(async () => { await Promise.all(adapters.map(a => a.close())); rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  let allowed = true;
  const transport: jest.Mocked<BrowserTransport> = {
    observe: jest.fn<ReturnType<BrowserTransport['observe']>, Parameters<BrowserTransport['observe']>>(async () => structuredClone(observation)),
    checkAccess: jest.fn<ReturnType<BrowserTransport['checkAccess']>, Parameters<BrowserTransport['checkAccess']>>(async () => true),
    execute: jest.fn<ReturnType<BrowserTransport['execute']>, Parameters<BrowserTransport['execute']>>(async () => ({ outcome: 'applied' })),
    verifyCompletion: jest.fn<ReturnType<BrowserTransport['verifyCompletion']>, Parameters<BrowserTransport['verifyCompletion']>>(async () => ({ verified: true, evidence: 'Verified expected result.' })),
  };
  const binding: BrowserTaskBinding = { version: 1, id: 'browser-a', name: 'Private target', principalId: 'owner', conversationId: 'chat-a', transport };
  let bindings = [binding];
  const evaluate = jest.fn(async () => answer());
  const options = { agentId: 'alpha', root: directory, allowed: () => allowed, bindings: () => bindings, evaluate };
  const make = () => { const adapter = new BrowserTaskAdapter(options); adapters.push(adapter); return adapter; };
  return { adapter: make(), make, transport, evaluate, revoke: () => { allowed = false; }, remove: () => { bindings = []; } };
}
async function settled(adapter: BrowserTaskAdapter, t: TaskSnapshot, id: string): Promise<WorkerOutcome> {
  for (let i = 0; i < 50; i++) {
    const result = await adapter.inspect(t, id);
    if (typeof result !== 'string') return result;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw Error('Adapter did not settle');
}
test('discovery and target resolution are private to principal AND conversation', () => {
  const f = fixture();
  expect(f.adapter.discover('', 0, context())).toMatchObject({ targets: [{ session_id: 'browser-a' }] });
  expect(f.adapter.discover('', 0, context('other'))).toMatchObject({ targets: [] });
  expect(f.adapter.discover('', 0, context('owner', 'chat-b'))).toMatchObject({ targets: [] });
  for (const ctx of [context('other'), context('owner', 'chat-b')]) expect(() => f.adapter.resolve({ adapter: 'browser', session_id: 'browser-a' }, ctx)).toThrow('BROWSER_TARGET_NOT_AVAILABLE');
  expect(() => f.adapter.resolve({ adapter: 'browser', session_id: 'browser-a', url: 'https://caller.example' }, context())).toThrow();
});
test('cross-agent and cross-owner submissions are rejected before touching transport', async () => {
  const f = fixture();
  await expect(f.adapter.submit(task('b', { agentId: 'beta' }), 'r', 'do work')).rejects.toThrow();
  await expect(f.adapter.submit(task('b', { ownerPrincipalId: 'other' }), 'r', 'do work')).rejects.toThrow();
  await expect(f.adapter.submit(task('b', { conversationId: 'chat-b' }), 'r', 'do work')).rejects.toThrow();
  expect(f.transport.observe).not.toHaveBeenCalled();
});
test('records a receipt before observation and persists only verified completion', async () => {
  const f = fixture(); f.transport.observe.mockImplementation(async () => {
    expect(readdirSync(directory)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')).status).toBe('running');
    return structuredClone(observation);
  });
  await f.adapter.submit(task(), 'r', 'Open result');
  expect(await settled(f.adapter, task(), 'r')).toMatchObject({ type: 'completed', result: { summary: expect.stringContaining('Verified expected result.') } });
  await expect(f.adapter.submit(task(), 'r', 'Open result')).rejects.toThrow('BROWSER_REQUEST_ALREADY_SUBMITTED');
});
test('restart reports a running receipt as uncertain and never replays actions', async () => {
  const f = fixture(); f.transport.observe.mockImplementation(() => new Promise(() => {}));
  await f.adapter.submit(task(), 'r', 'Open result'); await new Promise(resolve => setImmediate(resolve));
  const restarted = f.make();
  expect(await restarted.inspect(task(), 'r')).toMatchObject({ type: 'unknown', failure: { code: 'BROWSER_EXECUTION_INTERRUPTED' } });
  await expect(restarted.submit(task(), 'r', 'Open result')).rejects.toThrow('BROWSER_REQUEST_ALREADY_SUBMITTED');
  expect(f.transport.observe).toHaveBeenCalledTimes(1); expect(f.transport.execute).not.toHaveBeenCalled();
});
test('cancellation during inference stops work without executing', async () => {
  const f = fixture(); f.evaluate.mockImplementation(() => new Promise(() => {}));
  await f.adapter.submit(task(), 'r', 'Open result'); await new Promise(resolve => setImmediate(resolve));
  await f.adapter.cancel(task(), 'r'); expect(await settled(f.adapter, task(), 'r')).toMatchObject({ type: 'stopped' }); expect(f.transport.execute).not.toHaveBeenCalled();
});
test('revocation during inference prevents a formerly valid action', async () => {
  const f = fixture(); f.evaluate.mockImplementation(async () => { f.revoke(); return answer('click', 'button'); });
  await f.adapter.submit(task(), 'r', 'Open result'); expect(await settled(f.adapter, task(), 'r')).toMatchObject({ type: 'failed' }); expect(f.transport.execute).not.toHaveBeenCalled();
});
test('removing a binding during inference invalidates the target', async () => {
  const f = fixture(); f.evaluate.mockImplementation(async () => { f.remove(); return answer('click', 'button'); });
  await f.adapter.submit(task(), 'r', 'Open result'); expect(await settled(f.adapter, task(), 'r')).toMatchObject({ type: 'failed' }); expect(f.transport.execute).not.toHaveBeenCalled();
});
test('a different task cannot cancel an active request with the same caller ID', async () => {
  const f = fixture(); f.evaluate.mockImplementation(() => new Promise(() => {}));
  await f.adapter.submit(task(), 'r', 'Open result'); await new Promise(resolve => setImmediate(resolve));
  await f.adapter.cancel(task('other-task'), 'r'); await new Promise(resolve => setImmediate(resolve));
  expect(await f.adapter.inspect(task(), 'r')).toBe('running');
});
test('a mismatched owner or conversation cannot read another task receipt', async () => {
  const f = fixture(); await f.adapter.submit(task(), 'r', 'Open result'); await settled(f.adapter, task(), 'r');
  await expect(f.adapter.inspect(task('task-a', { ownerPrincipalId: 'other' }), 'r')).rejects.toThrow();
  await expect(f.adapter.inspect(task('task-a', { conversationId: 'chat-b' }), 'r')).rejects.toThrow();
});
test('revocation while independent completion verification runs cannot publish success', async () => {
  const f = fixture(); f.transport.verifyCompletion.mockImplementation(async () => { f.revoke(); return { verified: true, evidence: 'Result present' }; });
  await f.adapter.submit(task(), 'r', 'Open result'); const outcome = await settled(f.adapter, task(), 'r'); expect(outcome.type).not.toBe('completed');
});
