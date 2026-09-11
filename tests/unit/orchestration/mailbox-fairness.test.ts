import { OrchestrationStore } from '../../../src/orchestration/store';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';

test('a busy session spanning topics cannot hide another session behind the mailbox page limit', async () => {
  const store = new OrchestrationStore(':memory:', 'a');
  const scope = (id: string) => ({agentId: 'a', agentSessionId: id, source: 'slack' as const, accountId: 'key', chatId: id, threadKey: '', principalId: 'key'});
  const capabilities = {execute: false, writeMemory: false};
  try {
    const active = store.acceptInput({scope: scope('busy'), text: 'active', capabilities}, 100);
    store.run("UPDATE conversation_inputs SET status='assigned' WHERE id=?", active.inputId);
    store.acceptInput({scope: {...scope('busy'), threadKey: 'another-topic'}, text: 'queued', capabilities}, 100);
    for (let i = 0; i < 99; i++) store.acceptInput({scope: scope('busy'), text: `queued ${i}`, capabilities}, 100);
    store.acceptInput({scope: scope('healthy'), text: 'hello', capabilities}, 100);
    store.run("UPDATE conversation_inputs SET created_at=1000 WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_session_id='busy')");
    store.run("UPDATE conversation_inputs SET created_at=2000 WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_session_id='healthy')");
    const send = jest.fn(async () => 'ok');
    const runtime = Object.assign(Object.create(AgentOrchestrationRuntime.prototype), {
      store, closing: false, config: {conversation: {notificationPolicy: 'next_user_turn', maxActiveSessions: 2, maxDecisionDurationMs: 600000}},
      scheduledReports: new Set(), active: new Map([['busy', {}]]), send, deferred: new Map(),
    });
    runtime.pumpMailbox();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls as unknown[][])[0][0]).toMatchObject({scope: {agentSessionId: 'healthy'}});
  } finally { store.close(); }
});
