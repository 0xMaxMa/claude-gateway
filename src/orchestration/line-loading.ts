import { orderLineRequest } from '../shared/line-request-order';
import type { AgentConfig } from '../types';
import { OrchestrationStore } from './store';

/** LINE clears loading on every outbound message, including task acknowledgements.
 * Renew from durable work state, not the lifetime of the ingress HTTP request. */
export class LineLoading {
  private timer?: ReturnType<typeof setInterval>;
  private readonly abort = new AbortController();
  private readonly pulses = new Map<string, { at: number; receipt: number }>();
  private readonly pending = new Set<string>();
  private closed = false;

  constructor(private readonly store: OrchestrationStore, private readonly agent: () => AgentConfig,
    private readonly enabled: () => boolean, private readonly request: typeof fetch = fetch) {}

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    const token = this.agent().line?.channelAccessToken;
    if (!this.enabled() || !token) { this.pulses.clear(); return; }
    // User IDs start with U; LINE does not support this API for groups or rooms.
    // Waiting for user input / reconciliation is not active work.
    const chats = this.store.all(`SELECT c.chat_id,
      COALESCE((SELECT MAX(d.rowid) FROM deliveries d JOIN conversation_bindings b ON b.id=d.binding_id
        WHERE b.channel='line' AND b.chat_id=c.chat_id AND d.state='delivered'),0) AS receipt
      FROM conversations c WHERE c.source='line' AND c.chat_id GLOB 'U*' AND (
        EXISTS (SELECT 1 FROM conversation_inputs i WHERE i.conversation_id=c.id AND i.status IN ('accepted','assigned')) OR
        EXISTS (SELECT 1 FROM conversation_decisions d WHERE d.conversation_id=c.id AND d.state IN ('running','interrupting')) OR
        EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.id AND t.state IN ('queued','starting','running','interrupting','cancel_requested'))
      ) GROUP BY c.chat_id`);
    const busy = new Set(chats.map(row => String(row.chat_id)));
    for (const chat of this.pulses.keys()) if (!busy.has(chat)) this.pulses.delete(chat);
    await Promise.all(chats.map(async row => {
      const chat = String(row.chat_id), receipt = Number(row.receipt), now = Date.now();
      const previous = this.pulses.get(chat);
      if (this.pending.has(chat) || (previous && now - previous.at < 4000 && previous.receipt === receipt)) return;
      this.pulses.set(chat, { at: now, receipt });
      this.pending.add(chat);
      try {
        // Five-second expiry bounds a stale indicator if a request races the final
        // reply or work fails without a reply. LINE offers no explicit stop API.
        await orderLineRequest(this.agent().id, chat, async () => {
          // A final reply may have finished while this renewal was queued.
          if (this.closed || !this.enabled() || !this.busy(chat)) return;
          await this.request('https://api.line.me/v2/bot/chat/loading/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ chatId: chat, loadingSeconds: 5 }),
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(3000)]),
          });
        });
      } catch { /* Best effort; never fail or delay inference/delivery. Retry on the next renewal. */ }
      finally { this.pending.delete(chat); }
    }));
  }

  private busy(chat: string): boolean {
    return !!this.store.get(`SELECT c.id FROM conversations c WHERE c.source='line' AND c.chat_id=? AND (
      EXISTS (SELECT 1 FROM conversation_inputs i WHERE i.conversation_id=c.id AND i.status IN ('accepted','assigned')) OR
      EXISTS (SELECT 1 FROM conversation_decisions d WHERE d.conversation_id=c.id AND d.state IN ('running','interrupting')) OR
      EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.id AND t.state IN ('queued','starting','running','interrupting','cancel_requested'))
    ) LIMIT 1`, chat);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    this.pulses.clear();
  }
}
