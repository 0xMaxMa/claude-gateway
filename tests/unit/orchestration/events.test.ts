import { OrchestrationStore } from '../../../src/orchestration/store';
import { ConversationEvents } from '../../../src/orchestration/events';

test('event replay is ordered, authorization scoped, and stale cursors request a snapshot', () => {
  const store = new OrchestrationStore(':memory:', 'a'), events = new ConversationEvents(store);
  try {
    const { conversationId } = store.acceptInput({ scope: { agentId: 'a', source: 'api', accountId: 'key', chatId: 'c', threadKey: '', agentSessionId: 'p', principalId: 'owner' }, text: 'hello' });
    const initial = events.read(conversationId, 'owner');
    expect(initial.snapshotRequired).toBe(true);
    store.transaction(() => { store.appendEvent(conversationId, 'one', {}); store.appendEvent(conversationId, 'two', {}); });
    const replay = events.read(conversationId, 'owner', initial.cursor);
    expect(replay.snapshotRequired).toBe(false);
    if (!replay.snapshotRequired) expect(replay.events.map(event => event.type)).toEqual(['one', 'two']);
    expect(() => events.read(conversationId, 'other', initial.cursor)).toThrow('ACCESS_DENIED');
    store.run('UPDATE conversation_events SET occurred_at=0'); events.prune(1);
    expect(events.read(conversationId, 'owner', initial.cursor).snapshotRequired).toBe(true);
    expect(events.read(conversationId, 'owner', { streamId: 'wrong', seq: 0 }).snapshotRequired).toBe(true);
  } finally { events.close(); store.close(); }
});
