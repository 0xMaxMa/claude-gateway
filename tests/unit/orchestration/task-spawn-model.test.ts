import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { TaskBridge } from '../../../src/orchestration/bridge';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';
import type { ModelConfig } from '../../../src/types';

/**
 * task_spawn model and effort (#581). Before this, a task always ran on the
 * conversation model (`task.model = context.model`) with the harness default
 * effort, so an agent had no way to put one task on GPT and another on a
 * different Claude model.
 */

const MODELS: ModelConfig[] = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', alias: 'sonnet', contextWindow: 200000 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', alias: 'haiku', contextWindow: 200000 },
  { id: 'gpt-6-astra[1m]', label: 'GPT 6 Astra', alias: 'gpt6astra', contextWindow: 1050000 },
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'spawn-model-')), workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new OrchestrationStore(join(root, 'db'), 'a'), tasks = new TaskService(store), decisions = new DecisionService(store);
  const scope = { agentId: 'a', agentSessionId: 'session', source: 'api' as const, accountId: 'u', chatId: 'c', threadKey: '', principalId: 'u' };
  const input = store.acceptInput({ scope, text: 'work' });
  const context = { ...input, ...decisions.begin(input.conversationId, 'u', [input.inputId]), principalId: 'u', execute: true, writeMemory: false, model: 'claude-opus-5-5' };
  const bridge = new TaskBridge(tasks);
  bridge.models = async () => MODELS;
  return { root, workspace, store, context, bridge, close: async () => { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

let n = 0;
async function call(f: ReturnType<typeof fixture>, args: Record<string, unknown>): Promise<any> {
  await f.bridge.start();
  const dir = join(f.root, `ticket-${++n}`);
  f.bridge.issue({ role: 'agent', context: f.context, capabilities: async () => ({}) } as any, dir, f.workspace);
  const auth = JSON.parse(readFileSync(join(dir, 'ticket.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const req = request(auth.url, { method: 'POST' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); });
    req.setHeader('Authorization', 'Bearer ' + auth.token);
    req.on('error', reject);
    req.end(JSON.stringify({ tool: 'task_spawn', args: { title: 'T', instructions: 'work', target_profile: 'default-worker', ...args }, action_id: `spawn-${n}` }));
  });
}

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => { await f.close(); jest.restoreAllMocks(); });

const stored = (taskId: string) => f.store.task(taskId)!;

test('a model id and effort are recorded on the task and override the conversation model', async () => {
  const reply = await call(f, { model: 'gpt-6-astra[1m]', effort: 'max' });
  expect(reply.error).toBeUndefined();
  expect(stored(reply.taskId)).toMatchObject({ model: 'gpt-6-astra[1m]', requestedModel: 'gpt-6-astra[1m]', effort: 'max' });
});

test('an alias resolves to its id; the requested name is kept', async () => {
  const reply = await call(f, { model: 'HAIKU' });
  expect(stored(reply.taskId)).toMatchObject({ model: 'claude-haiku-5-5', requestedModel: 'HAIKU' });
});

test('without model or effort a task keeps the conversation model and no effort (unchanged behaviour)', async () => {
  const reply = await call(f, {});
  const task = stored(reply.taskId);
  expect(task.model).toBe('claude-opus-5-5');
  expect(task.requestedModel).toBeUndefined();
  expect(task.effort).toBeUndefined();
});

test('an unknown model is rejected with UNKNOWN_MODEL, the valid ids, and a retry_of', async () => {
  const reply = await call(f, { model: 'gpt-7' });
  expect(reply.error).toBe('UNKNOWN_MODEL');
  expect(reply.retry_of).toBeDefined();
  const correction = reply.details[0].correction as string;
  expect(reply.details[0].field).toBe('model');
  for (const m of MODELS) expect(correction).toContain(m.id);
  expect(f.store.all('SELECT id FROM tasks')).toHaveLength(0);
});

test.each([
  [{ effort: 'minimal' }, 'effort'],
  [{ model: '' }, 'model'],
  [{ model: 42 }, 'model'],
])('rejects invalid input %j', async (args, field) => {
  const reply = await call(f, args);
  expect(reply.error).toBe('INVALID_INPUT');
  expect(reply.details.map((d: { field: string }) => d.field)).toContain(field);
});

test('task_status index rows show model and effort', async () => {
  await call(f, { model: 'sonnet', effort: 'high' });
  const rows = new TaskService(f.store).context(f.context.conversationId, 'u', f.context.decisionId);
  expect(rows[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
});

// Review of #581: say why instead of an unexplained INVALID_GATEWAY_TARGET.
test('gateway-managed tasks get a correctable INVALID_INPUT for model or effort', async () => {
  const reply = await call(f, { target_profile: 'gateway-managed', gateway_target: { adapter: 'safemode', session_id: 's' }, effort: 'high' });
  expect(reply.error).toBe('INVALID_INPUT');
  expect(reply.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'effort', reason: 'not_for_gateway_managed' })]));
  expect(reply.retry_of).toBeDefined();
});

// Review of #581: report every rejected field at once, so one retry can fix both.
test('gateway-managed tasks report both model and effort when both are given', async () => {
  const reply = await call(f, { target_profile: 'gateway-managed', gateway_target: { adapter: 'safemode', session_id: 's' }, model: 'sonnet', effort: 'high' });
  expect(reply.error).toBe('INVALID_INPUT');
  expect(reply.details).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'model', reason: 'not_for_gateway_managed' }),
    expect.objectContaining({ field: 'effort', reason: 'not_for_gateway_managed' }),
  ]));
});

// Review of #581: continue_task_id reuses the worker session "when compatible"; a follow-up must not drop to the conversation model.
test('a follow-up inherits the model and effort its predecessor was given', async () => {
  const first = await call(f, { model: 'gpt6astra', effort: 'xhigh' });
  const next = await call(f, { continue_task_id: first.taskId });
  expect(stored(next.taskId)).toMatchObject({ model: 'gpt-6-astra[1m]', requestedModel: 'gpt6astra', effort: 'xhigh' });
  const overridden = await call(f, { continue_task_id: first.taskId, model: 'sonnet' });
  expect(stored(overridden.taskId)).toMatchObject({ model: 'claude-sonnet-5-5' });
  expect(stored(overridden.taskId).effort).toBeUndefined();
  const plain = await call(f, {});
  const after = await call(f, { continue_task_id: plain.taskId });
  expect(stored(after.taskId)).toMatchObject({ model: 'claude-opus-5-5' });
  expect(stored(after.taskId).requestedModel).toBeUndefined();
});
