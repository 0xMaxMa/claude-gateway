import { LineLoading } from '../../../src/orchestration/line-loading';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DeliveryOutbox } from '../../../src/orchestration/delivery';
import { AgentConfig } from '../../../src/types';

function fixture() {
  const store = new OrchestrationStore(':memory:', 'a');
  const agent = { line: { channelAccessToken: 'fixture' } } as AgentConfig;
  const request = jest.fn(async () => new Response('{}', { status: 202 }));
  let enabled = true;
  const loading = new LineLoading(store, () => agent, () => enabled, request as typeof fetch);
  const input = (chat = 'U1', source: 'line' | 'telegram' = 'line', session = chat) => store.acceptInput({
    scope: { agentId: 'a', agentSessionId: session, source, accountId: 'bot', chatId: chat, threadKey: '', principalId: 'owner' }, text: 'Do work',
  });
  return { store, agent, request, loading, input, disable: () => { enabled = false; } };
}

afterEach(() => jest.useRealTimers());

test('renews while thinking beyond 60 seconds, after an acknowledgement and while workers run; stops at idle', async () => {
  jest.useFakeTimers();
  const f = fixture(), tasks = new TaskService(f.store);
  const delivery = new DeliveryOutbox(f.store, async () => ({ state: 'delivered', providerId: 'reply' }));
  const decisions = new DecisionService(f.store, (r, b, t) => delivery.enqueue(r, b, t));
  try {
    const input = f.input();
    f.loading.start();
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.request).toHaveBeenCalledTimes(1);
    const decision = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    await jest.advanceTimersByTimeAsync(65000);
    expect(f.request.mock.calls.length).toBeGreaterThan(15);
    const task = tasks.spawn({ ...input, ...decision, principalId: 'owner', actionId: 'work', execute: true, writeMemory: false },
      { title: 'Review', instructions: 'Review PR', targetProfile: 'default-worker' });
    decisions.finish(decision, 'Reviewing now');
    await delivery.tick();
    const before = f.request.mock.calls.length;
    await f.loading.tick(); // A new message clears LINE's indicator, so renew without waiting four seconds.
    expect(f.request).toHaveBeenCalledTimes(before + 1);
    f.store.run("UPDATE tasks SET state='running' WHERE id=?", task.taskId);
    await jest.advanceTimersByTimeAsync(8000);
    expect(f.request.mock.calls.length).toBeGreaterThan(before + 1);
    f.store.run("UPDATE tasks SET state='completed' WHERE id=?", task.taskId);
    const finished = f.request.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10000);
    expect(f.request).toHaveBeenCalledTimes(finished);
    const call = (f.request.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(call[0]).toBe('https://api.line.me/v2/bot/chat/loading/start');
    expect(JSON.parse(String(call[1].body))).toEqual({ chatId: 'U1', loadingSeconds: 5 });
  } finally { f.loading.close(); f.store.close(); }
});

test('filters groups and other channels, coalesces sessions in one chat, and stops on disable/close', async () => {
  const f = fixture();
  try {
    f.input('Cgroup'); f.input('Rroom'); f.input('Utelegram', 'telegram');
    await f.loading.tick(); expect(f.request).not.toHaveBeenCalled();
    f.input(); f.input('U1', 'line', 'another-session');
    await f.loading.tick(); expect(f.request).toHaveBeenCalledTimes(1);
    f.disable(); await f.loading.tick(); expect(f.request).toHaveBeenCalledTimes(1);
    f.loading.close(); await f.loading.tick(); expect(f.request).toHaveBeenCalledTimes(1);
  } finally { f.loading.close(); f.store.close(); }
});

test.each(['waiting_input', 'needs_reconciliation', 'failed', 'cancelled'])('%s is not active typing', async state => {
  const f = fixture();
  try {
    const input = f.input(), decisions = new DecisionService(f.store), decision = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    const task = new TaskService(f.store).spawn({ ...input, ...decision, principalId: 'owner', actionId: 'work', execute: true, writeMemory: false },
      { title: 'Review', instructions: 'Review PR', targetProfile: 'default-worker' });
    decisions.finish(decision, 'Waiting');
    f.store.run('UPDATE tasks SET state=? WHERE id=?', state, task.taskId);
    await f.loading.tick(); expect(f.request).not.toHaveBeenCalled();
  } finally { f.loading.close(); f.store.close(); }
});

test('loading API failures are best effort and in-flight renewals do not overlap', async () => {
  jest.useFakeTimers();
  const f = fixture();
  try {
    f.input();
    let reject!: (error: Error) => void;
    f.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = f.loading.tick();
    await jest.advanceTimersByTimeAsync(5000);
    await f.loading.tick(); expect(f.request).toHaveBeenCalledTimes(1);
    reject(new Error('network unavailable')); await expect(pending).resolves.toBeUndefined();
    await f.loading.tick(); expect(f.request).toHaveBeenCalledTimes(2);
    f.loading.close();
  } finally { f.loading.close(); f.store.close(); }
});

test('a menu reply waits for the in-flight loading renewal', async () => {
  const f = fixture();
  const { sendControlMenu } = await import('../../../src/orchestration/control-delivery');
  const order: string[] = [];
  let release!: () => void;
  f.request.mockImplementationOnce(async () => {
    order.push('loading'); await new Promise<void>(resolve => { release = resolve; });
    order.push('loading-finished'); return new Response('{}', {status:202});
  });
  try {
    f.input(); const loading = f.loading.tick();
    await Promise.resolve(); await Promise.resolve();
    const menu = sendControlMenu(f.agent,'line','U1',{text:'Voice menu',buttons:[]},{},
      (async () => { order.push('menu'); return new Response('{}'); }) as typeof fetch);
    await Promise.resolve(); expect(order).toEqual(['loading']);
    release(); await Promise.all([loading,menu]);
    expect(order).toEqual(['loading','loading-finished','menu']);
  } finally { release?.(); f.loading.close(); f.store.close(); }
});

test('a queued renewal rechecks activity after the final reply finishes', async () => {
  const f = fixture();
  const { orderLineRequest } = await import('../../../src/shared/line-request-order');
  let release!: () => void;
  try {
    const input = f.input();
    const reply = orderLineRequest(f.agent.id,'U1',async () => { await new Promise<void>(resolve => {release=resolve;}); });
    await Promise.resolve();
    const loading = f.loading.tick();
    f.store.run("UPDATE conversation_inputs SET status='handled' WHERE id=?",input.inputId);
    release(); await Promise.all([reply,loading]);
    expect(f.request).not.toHaveBeenCalled();
  } finally { release?.(); f.loading.close(); f.store.close(); }
});
