import { sanitizeProviderMessage } from '../orchestration/provider-message';

/** A tool call carried by a refused message. `result` is true only when a tool_result
 * for it was observed in the same turn; otherwise no execution receipt exists. */
export interface RefusedToolCall { id: string; name?: string; result: boolean; }
/** A provider-declared refusal, read only from typed protocol fields (#586). An
 * absent category/explanation means the provider supplied none; never infer one. */
export interface ProviderRefusal { messageId?: string; category?: string; explanation?: string; toolCalls?: RefusedToolCall[]; }

const MAX_REFUSALS = 16, MAX_TOOL_CALLS = 16, RECENT_TOOL_USES = 256;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? sanitizeProviderMessage(value)?.slice(0, max) : undefined;

/** Turn-scoped refusal evidence from Claude Code stream-json. One native message
 * can appear as a stream `message_delta`, a final assistant record and a synthetic
 * API-error record; all of them collapse into one entry keyed by the native id. */
export class ProviderRefusals {
  private current?: string;
  private readonly entries: (Omit<ProviderRefusal, 'toolCalls'> & { toolCalls: Map<string, RefusedToolCall> })[] = [];
  /** Recent tool_use blocks by id; only those of a refused message are kept beyond this window. */
  private readonly toolUses = new Map<string, { messageId?: string; name?: string }>();
  observe(event: Record<string, any>): void {
    const stream = event.type === 'stream_event' ? event.event : undefined;
    if (stream?.type === 'message_start') { this.current = typeof stream.message?.id === 'string' ? stream.message.id : undefined; return; }
    if (stream?.type === 'content_block_start' && stream.content_block?.type === 'tool_use') { this.toolUse(this.current, stream.content_block); return; }
    if (stream?.type === 'message_delta' && stream.delta?.stop_reason === 'refusal') { this.record(this.current, stream.delta.stop_details); return; }
    const blocks: any[] = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'user') for (const block of blocks) if (block?.type === 'tool_result') for (const entry of this.entries) { const call = entry.toolCalls.get(block.tool_use_id); if (call) call.result = true; }
    if (event.type !== 'assistant') return;
    if (event.isApiErrorMessage !== true) for (const block of blocks) if (block?.type === 'tool_use') this.toolUse(typeof event.message.id === 'string' ? event.message.id : undefined, block);
    if (event.message?.stop_reason !== 'refusal') return;
    // A synthetic API-error record replaces the message being streamed; it names
    // that message in refusedMessageId when the CLI provides it.
    const id = typeof event.refusedMessageId === 'string' ? event.refusedMessageId
      : event.isApiErrorMessage === true && this.current ? this.current : event.message.id;
    this.record(typeof id === 'string' ? id : undefined, event.message.stop_details);
  }
  private toolUse(messageId: string | undefined, block: Record<string, unknown>): void {
    if (typeof block.id !== 'string' || this.toolUses.has(block.id)) return;
    if (this.toolUses.size >= RECENT_TOOL_USES) this.toolUses.delete(this.toolUses.keys().next().value!);
    const use = { messageId, ...(typeof block.name === 'string' ? { name: block.name.slice(0, 128) } : {}) };
    this.toolUses.set(block.id, use);
    // A final record can name a tool call only after the stream already reported the refusal.
    const refused = messageId ? this.entries.find(entry => entry.messageId === messageId) : undefined;
    if (refused) this.pin(refused, block.id, use.name);
  }
  private pin(entry: ProviderRefusals['entries'][number], id: string, name?: string): void {
    if (!entry.toolCalls.has(id) && entry.toolCalls.size < MAX_TOOL_CALLS) entry.toolCalls.set(id, { id, ...(name ? { name } : {}), result: false });
  }
  private record(messageId: string | undefined, details: unknown): void {
    const typed = details && typeof details === 'object' && (details as { type?: unknown }).type === 'refusal' ? details as Record<string, unknown> : {};
    const category = text(typed.category, 64), explanation = text(typed.explanation, 2048);
    const existing = messageId ? this.entries.find(entry => entry.messageId === messageId) : undefined;
    if (existing) { existing.category ??= category; existing.explanation ??= explanation; return; }
    if (this.entries.length >= MAX_REFUSALS) return;
    const entry = { ...(messageId ? { messageId } : {}), ...(category ? { category } : {}), ...(explanation ? { explanation } : {}), toolCalls: new Map<string, RefusedToolCall>() };
    this.entries.push(entry);
    if (messageId) for (const [id, use] of this.toolUses) if (use.messageId === messageId) this.pin(entry, id, use.name);
  }
  list(): ProviderRefusal[] {
    return this.entries.map(({ toolCalls, ...entry }) => ({ ...entry, ...(toolCalls.size ? { toolCalls: [...toolCalls.values()].map(call => ({ ...call })) } : {}) }));
  }
  reset(): void { this.current = undefined; this.entries.length = 0; this.toolUses.clear(); }
}
