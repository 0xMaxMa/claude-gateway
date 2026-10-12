import { sanitizeProviderMessage } from '../orchestration/provider-message';

/** A provider-declared refusal, read only from typed protocol fields (#586). An
 * absent category/explanation means the provider supplied none; never infer one. */
export interface ProviderRefusal { messageId?: string; category?: string; explanation?: string; }

const MAX_REFUSALS = 16;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? sanitizeProviderMessage(value)?.slice(0, max) : undefined;

/** Turn-scoped refusal evidence from Claude Code stream-json. One native message
 * can appear as a stream `message_delta`, a final assistant record and a synthetic
 * API-error record; all of them collapse into one entry keyed by the native id. */
export class ProviderRefusals {
  private current?: string;
  private readonly entries: ProviderRefusal[] = [];
  observe(event: Record<string, any>): void {
    const stream = event.type === 'stream_event' ? event.event : undefined;
    if (stream?.type === 'message_start') { this.current = typeof stream.message?.id === 'string' ? stream.message.id : undefined; return; }
    if (stream?.type === 'message_delta' && stream.delta?.stop_reason === 'refusal') { this.record(this.current, stream.delta.stop_details); return; }
    if (event.type !== 'assistant' || event.message?.stop_reason !== 'refusal') return;
    // A synthetic API-error record replaces the message being streamed; it names
    // that message in refusedMessageId when the CLI provides it.
    const id = typeof event.refusedMessageId === 'string' ? event.refusedMessageId
      : event.isApiErrorMessage === true && this.current ? this.current : event.message.id;
    this.record(typeof id === 'string' ? id : undefined, event.message.stop_details);
  }
  private record(messageId: string | undefined, details: unknown): void {
    const typed = details && typeof details === 'object' && (details as { type?: unknown }).type === 'refusal' ? details as Record<string, unknown> : {};
    const category = text(typed.category, 64), explanation = text(typed.explanation, 2048);
    const existing = messageId ? this.entries.find(entry => entry.messageId === messageId) : undefined;
    if (existing) { existing.category ??= category; existing.explanation ??= explanation; return; }
    if (this.entries.length >= MAX_REFUSALS) return;
    this.entries.push({ ...(messageId ? { messageId } : {}), ...(category ? { category } : {}), ...(explanation ? { explanation } : {}) });
  }
  list(): ProviderRefusal[] { return this.entries.map(entry => ({ ...entry })); }
  reset(): void { this.current = undefined; this.entries.length = 0; }
}
