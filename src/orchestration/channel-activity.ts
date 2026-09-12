import type { AgentConfig } from '../types';
import { OrchestrationStore } from './store';

/** Managed conversations have no legacy stdin/heartbeat turn. Derive typing
 * from durable work, including autonomous result decisions and queued inputs.
 * Agent/Worker deadlines and recovery remain owned by the orchestration. */
export class ChannelActivity {
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly pending = new Set<string>();
  private readonly pulses = new Map<string, number>();
  constructor(private readonly store: OrchestrationStore, private readonly agent: () => AgentConfig,
    private readonly enabled: () => boolean, private readonly request: typeof fetch = fetch) {}
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.closed) return;
    if (!this.enabled()) { this.pulses.clear(); return; }
    const rows = this.store.all(`SELECT DISTINCT c.source,c.chat_id,c.thread_key FROM conversations c WHERE c.source IN ('telegram','discord') AND (
      EXISTS (SELECT 1 FROM conversation_inputs i WHERE i.conversation_id=c.id AND i.status IN ('accepted','assigned')) OR
      EXISTS (SELECT 1 FROM conversation_decisions d WHERE d.conversation_id=c.id AND d.state IN ('running','interrupting')) OR
      EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id=c.id AND t.state IN ('queued','starting','running','interrupting','cancel_requested'))
    )`);
    const keys = new Set(rows.map(r => JSON.stringify([r.source, r.chat_id, r.thread_key])));
    for (const key of this.pulses.keys()) if (!keys.has(key)) this.pulses.delete(key);
    await Promise.all(rows.map(async row => {
      const telegram = row.source === 'telegram';
      const token = telegram ? this.agent().telegram?.botToken : this.agent().discord?.botToken;
      if (!token) return;
      const key = JSON.stringify([row.source, row.chat_id, row.thread_key]), now = Date.now();
      if (this.pending.has(key) || now - (this.pulses.get(key) ?? -Infinity) < 4000) return;
      this.pending.add(key); this.pulses.set(key, now);
      try {
        await this.request(telegram ? `https://api.telegram.org/bot${token}/sendChatAction` : `https://discord.com/api/v10/channels/${encodeURIComponent(String(row.chat_id))}/typing`, {
          method: 'POST', headers: telegram ? { 'Content-Type': 'application/json' } : { Authorization: `Bot ${token}`, 'Content-Length': '0' },
          body: telegram ? JSON.stringify({ chat_id: row.chat_id, action: 'typing', ...(row.thread_key ? { message_thread_id: Number(row.thread_key) } : {}) }) : undefined,
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(3000)]),
        });
      } catch { /* Typing is best effort; never infer a model stall from transport failure. */ }
      finally { this.pending.delete(key); }
    }));
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort(); this.pulses.clear();
  }
}
