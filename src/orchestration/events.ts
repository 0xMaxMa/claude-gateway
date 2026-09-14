import { OrchestrationStore } from './store';
import { OrchestrationEvent, OrchestrationError } from './types';
import { BoundedQueue } from './bounded-queue';

export interface EventCursor { streamId: string; seq: number; }
export type EventPage = { snapshotRequired: false; cursor: EventCursor; events: OrchestrationEvent[] } |
  { snapshotRequired: true; cursor: EventCursor; tasks: unknown[] };

/** Internal subscribers only. This is not a new public task-management API. */
export class ConversationEvents {
  private readonly stops = new Set<() => void>();
  constructor(private readonly store: OrchestrationStore, private readonly maxBufferBytes = 1048576) {}
  read(conversationId: string, principalId: string, cursor?: EventCursor, limit = 100): EventPage {
    const conversation = this.store.assertMember(conversationId, principalId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new OrchestrationError('INVALID_CURSOR');
    const latest = { streamId: String(conversation.stream_id), seq: Number(conversation.last_event_seq) };
    const earliest = Number(this.store.get('SELECT MIN(seq) seq FROM conversation_events WHERE conversation_id=?', conversationId)?.seq ?? latest.seq + 1);
    if (!cursor || cursor.streamId !== latest.streamId || cursor.seq < earliest - 1 || cursor.seq > latest.seq) {
      return { snapshotRequired: true, cursor: latest, tasks: this.store.all('SELECT snapshot_json FROM tasks WHERE conversation_id=? ORDER BY created_at DESC LIMIT 100', conversationId).map(row => JSON.parse(String(row.snapshot_json))) };
    }
    if (!Number.isSafeInteger(cursor.seq) || cursor.seq < 0) throw new OrchestrationError('INVALID_CURSOR');
    const events = this.store.all('SELECT payload_json FROM conversation_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?', conversationId, cursor.seq, limit).map(row => JSON.parse(String(row.payload_json)) as OrchestrationEvent);
    return { snapshotRequired: false, cursor: { streamId: latest.streamId, seq: events.at(-1)?.seq ?? cursor.seq }, events };
  }
  subscribe(conversationId: string, principalId: string, cursor?: EventCursor): { pages: AsyncIterable<EventPage>; close(): void } {
    if (this.stops.size >= 100) throw new OrchestrationError('SUBSCRIBER_CAPACITY_EXCEEDED');
    this.store.assertMember(conversationId, principalId);
    const queue = new BoundedQueue<EventPage>(this.maxBufferBytes, page => Buffer.byteLength(JSON.stringify(page)));
    let current = cursor;
    const close = () => { clearInterval(timer); queue.close(); this.stops.delete(close); };
    const poll = () => {
      try {
        const page = this.read(conversationId, principalId, current);
        if (page.snapshotRequired || page.events.length) queue.push(page);
        current = page.cursor;
      } catch (error) { queue.close(error instanceof Error ? error : new OrchestrationError('SUBSCRIBER_FAILED')); close(); }
    };
    const timer = setInterval(poll, 100); timer.unref(); this.stops.add(close); poll();
    return { pages: queue, close };
  }
  prune(retentionDays: number): void {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new OrchestrationError('INVALID_CONFIG');
    const cutoff = Date.now() - retentionDays * 86400000;
    this.store.transaction(() => {
      this.store.run('DELETE FROM conversation_events WHERE occurred_at<?', cutoff);
      this.store.run("DELETE FROM outbox WHERE state='completed' AND created_at<?", cutoff);
    });
  }
  close(): void { for (const stop of this.stops) stop(); }
}
