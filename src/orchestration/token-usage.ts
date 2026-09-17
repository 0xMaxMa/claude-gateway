import type { RequestToolSchemas } from '../session/request-tool-capture';
import { executionTool } from './tool-name';
/** Model token volume, not billing cost. Output already includes thinking. */
export interface TokenUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
}
export interface RequestUsage { id: string; model?: string; usage: TokenUsage; toolSchemas?: RequestToolSchemas; }
const fields = ['inputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'outputTokens', 'cacheCreation5mTokens', 'cacheCreation1hTokens'] as const;
export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 };
}
function count(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function normalize(value: any): TokenUsage {
  const usage = emptyUsage();
  usage.inputTokens = count(value.input_tokens);
  usage.cacheCreationTokens = count(value.cache_creation_input_tokens);
  usage.cacheReadTokens = count(value.cache_read_input_tokens);
  usage.outputTokens = count(value.output_tokens);
  if (typeof value.cache_creation?.ephemeral_5m_input_tokens === 'number') usage.cacheCreation5mTokens = count(value.cache_creation.ephemeral_5m_input_tokens);
  if (typeof value.cache_creation?.ephemeral_1h_input_tokens === 'number') usage.cacheCreation1hTokens = count(value.cache_creation.ephemeral_1h_input_tokens);
  usage.totalTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens;
  return usage;
}
export function sumUsage(values: TokenUsage[]): TokenUsage {
  const sum = emptyUsage();
  for (const value of values) for (const key of fields) if (value[key] !== undefined) sum[key] = (sum[key] ?? 0) + value[key]!;
  sum.totalTokens = sum.inputTokens + sum.cacheCreationTokens + sum.cacheReadTokens + sum.outputTokens;
  return sum;
}
/** Deduplicate assistant blocks and partial stream usage by the provider message ID.
 * CLI result usage is a turn aggregate, never another request to add to the sum. */
export class TurnUsageCollector {
  private readonly messages = new Map<string, RequestUsage>();
  private currentId?: string;
  private readonly schemas = new Map<string, RequestToolSchemas>();
  observeSchemas(value: RequestToolSchemas): void {
    this.schemas.set(value.messageId, value);
    const request=this.messages.get(value.messageId);if(request)request.toolSchemas=value;
  }
  private aggregate: TokenUsage | null = null;
  loadedTools: string[] | null = null;
  readonly usedTools = new Set<string>();
  model?: string;
  observe(event: any): void {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'system' && event.subtype === 'init') {
      if (Array.isArray(event.tools) && event.tools.every((name: unknown) => typeof name === 'string')) this.loadedTools = [...new Set<string>(event.tools)].sort();
      if (typeof event.model === 'string') this.model = event.model;
    }
    const stream = event.type === 'stream_event' ? event.event : undefined;
    const message = event.type === 'assistant' ? event.message : stream?.type === 'message_start' ? stream.message : undefined;
    if (message && typeof message.id === 'string') {
      this.currentId = message.id;
      if (message.usage) this.merge(message.id, message.usage, message.model);
    }
    if (stream?.type === 'message_delta' && this.currentId && stream.usage) this.merge(this.currentId, stream.usage);
    if (event.type === 'result' && event.usage && typeof event.usage === 'object') this.aggregate = normalize(event.usage);
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of [...blocks, stream?.content_block]) if (block?.type === 'tool_use' && typeof block.name === 'string' && !(block.name === 'mcp__gateway__tool_call' && !block.input?.name)) this.usedTools.add(executionTool(block).name);
  }
  private merge(id: string, raw: any, model?: unknown): void {
    const next = normalize(raw), previous = this.messages.get(id);
    if (previous) for (const key of fields) if (previous.usage[key] !== undefined || next[key] !== undefined) next[key] = Math.max(previous.usage[key] ?? 0, next[key] ?? 0);
    next.totalTokens = next.inputTokens + next.cacheCreationTokens + next.cacheReadTokens + next.outputTokens;
    this.messages.set(id, {id, model: typeof model === 'string' ? model : previous?.model, usage: next, toolSchemas:this.schemas.get(id)});
  }
  snapshot(): { usage: TokenUsage | null; requests: RequestUsage[]; loadedTools: string[] | null; usedTools: string[]; contextTools: string[] | null; schemaCoverage: {measured:number;total:number}; model?: string } {
    const requests = [...this.messages.values()];
    // The CLI aggregate includes otherwise unreported subcalls. It is a fallback
    // and reconciliation source, not an extra request or fabricated request ID.
    let usage = requests.length ? sumUsage(requests.map(request => request.usage)) : this.aggregate;
    if (usage && this.aggregate) {
      usage = {...usage};
      for (const key of fields) if (usage[key] !== undefined || this.aggregate[key] !== undefined) usage[key] = Math.max(usage[key] ?? 0, this.aggregate[key] ?? 0);
      usage.totalTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens;
    }
    const measured=requests.filter(r=>r.toolSchemas);
    const contextTools=measured.length?[...new Set(measured.flatMap(r=>r.toolSchemas!.loaded))].sort():null;
    return {usage, requests, contextTools, schemaCoverage:{measured:measured.length,total:requests.length}, loadedTools: this.loadedTools, usedTools: [...this.usedTools].sort(), model: this.model};
  }
}
