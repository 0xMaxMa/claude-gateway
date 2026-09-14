import { ChannelActivity } from '../../../src/orchestration/channel-activity';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DeliveryOutbox } from '../../../src/orchestration/delivery';
import { AgentConfig } from '../../../src/types';

function fixture() {
  const store = new OrchestrationStore(':memory:', 'a');
  const agent = { telegram: { botToken: 'fixture' } } as AgentConfig;
  const request = jest.fn(async () => new Response('{}', { status: 202 }));
  let enabled = true;
  const loading = new ChannelActivity(store, () => agent, () => enabled, request as typeof fetch);
  const input = (chat = '123', source: 'line' | 'telegram' = 'telegram', session = chat) => store.acceptInput({
    scope: { agentId: 'a', agentSessionId: session, source, accountId: 'bot', chatId: chat, threadKey: '', principalId: 'owner' }, text: 'Do work',
  });
  return { store, agent, request, loading, input, disable: () => { enabled = false; } };
}

afterEach(() => jest.useRealTimers());

test('renews while thinking beyond 10 minutes, after an acknowledgement and while workers run; stops at idle', async () => {
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
    await jest.advanceTimersByTimeAsync(660000);
    expect(f.request.mock.calls.length).toBeGreaterThan(15);
    const task = tasks.spawn({ ...input, ...decision, principalId: 'owner', actionId: 'work', execute: true, writeMemory: false },
      { title: 'Review', instructions: 'Review PR', targetProfile: 'default-worker' });
    decisions.finish(decision, 'Reviewing now');
    await delivery.tick();
    const before = f.request.mock.calls.length;
    await f.loading.tick(); // Recent pulses are coalesced.
    expect(f.request).toHaveBeenCalledTimes(before);
    f.store.run("UPDATE tasks SET state='running' WHERE id=?", task.taskId);
    await jest.advanceTimersByTimeAsync(8000);
    expect(f.request.mock.calls.length).toBeGreaterThan(before + 1);
    f.store.run("UPDATE tasks SET state='completed' WHERE id=?", task.taskId);
    const finished = f.request.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10000);
    expect(f.request).toHaveBeenCalledTimes(finished);
    const call = (f.request.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(call[0]).toBe('https://api.telegram.org/botfixture/sendChatAction');
    expect(JSON.parse(String(call[1].body))).toEqual({ chat_id: '123', action: 'typing' });
  } finally { f.loading.close(); f.store.close(); }
});


test('autonomous result decisions restart activity, then stay quiet after completion; Off and close stop renewal', async () => {
  jest.useFakeTimers();
  const f = fixture();
  const decisions = new DecisionService(f.store);
  try {
    const input = f.input();
    const decision = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    decisions.finish(decision, 'done');
    f.loading.start();
    await jest.advanceTimersByTimeAsync(660000);
    expect(f.request).not.toHaveBeenCalled();
    const report = f.input();
    const reportDecision = decisions.begin(report.conversationId, 'owner', [report.inputId]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.request).toHaveBeenCalledTimes(1);
    decisions.finish(reportDecision, 'Worker finished');
    await jest.advanceTimersByTimeAsync(660000);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.input(); f.disable();
    await jest.advanceTimersByTimeAsync(10000);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.loading.close(); await f.loading.tick();
    expect(f.request).toHaveBeenCalledTimes(1);
  } finally { f.loading.close(); f.store.close(); }
});
test('coalesces sessions per chat/thread, excludes other channels, and ignores transport failures', async () => {
  const f = fixture();
  try {
    f.input('Uline', 'line'); await f.loading.tick(); expect(f.request).not.toHaveBeenCalled();
    f.input(); f.input('123', 'telegram', 'second-session');
    f.request.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(f.loading.tick()).resolves.toBeUndefined();
    expect(f.request).toHaveBeenCalledTimes(1);
  } finally { f.loading.close(); f.store.close(); }
});

test.each(['telegram', 'discord'] as const)('%s keeps typing until every worker finishes and while result delivery is being composed', async source => {
  jest.useFakeTimers();
  const f = fixture(); f.agent.discord = { botToken: 'discord-fixture' };
  const decisions = new DecisionService(f.store), tasks = new TaskService(f.store);
  try {
    const input = f.store.acceptInput({ scope: { agentId: 'a', agentSessionId: 's', source, accountId: 'bot', chatId: '123', threadKey: '', principalId: 'owner' }, text: 'Two tasks' });
    const decision = decisions.begin(input.conversationId, 'owner', [input.inputId]);
    const spawn = (actionId: string) => tasks.spawn({ ...input, ...decision, principalId: 'owner', actionId, execute: true, writeMemory: false }, { title: actionId, instructions: 'Do work', targetProfile: 'default-worker' });
    const a = spawn('A'), b = spawn('B'); decisions.finish(decision, 'Queued');
    f.store.run("UPDATE tasks SET state='running'");
    f.loading.start(); await jest.advanceTimersByTimeAsync(1000);
    f.store.run("UPDATE tasks SET state='completed' WHERE id=?", a.taskId);
    const count = f.request.mock.calls.length;
    await jest.advanceTimersByTimeAsync(660000);
    expect(f.request.mock.calls.length).toBeGreaterThan(count);
    f.store.run("UPDATE tasks SET state='waiting_input' WHERE id=?", b.taskId);
    const waiting = f.request.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10000);
    expect(f.request).toHaveBeenCalledTimes(waiting);
    const calls = f.request.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe(source === 'telegram' ? 'https://api.telegram.org/botfixture/sendChatAction' : 'https://discord.com/api/v10/channels/123/typing');
  } finally { f.loading.close(); f.store.close(); }
});
