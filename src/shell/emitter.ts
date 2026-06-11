import type { AssistantRecord, UsageInfo } from './tailer';

/**
 * Synthesizes the stream-json events the gateway's SessionProcess stdout
 * parser consumes (src/session/process.ts). Every assistant event is emitted
 * as a FINAL message (top-level stop_reason set): the parser then appends the
 * full text as a fresh delta and resets its partial tracking, which is what
 * makes mid-turn (message-level streaming) emission safe.
 */
export class ProtocolEmitter {
  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}

  private writeLine(obj: Record<string, unknown>): void {
    this.out.write(JSON.stringify(obj) + '\n');
  }

  emitInit(sessionId: string, model: string, cwd: string): void {
    this.writeLine({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model,
      cwd,
      tools: [],
    });
  }

  /**
   * Context-size shim: the gateway reads usage from stream_event/message_start
   * to display context %. Transcript assistant records carry the same usage,
   * so replay it. Emitted before each assistant event; the gateway keeps the
   * latest value and applies it at result time.
   */
  emitMessageStartShim(usage: UsageInfo, sessionId: string): void {
    this.writeLine({
      type: 'stream_event',
      session_id: sessionId,
      event: {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: usage.input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          },
        },
      },
    });
  }

  /**
   * Emit one transcript assistant record as a final assistant event.
   * Thinking blocks are stripped (the gateway only consumes text and
   * tool_use blocks; thinking content must not leak into chat history).
   * Returns the text contained in the record, '' if none.
   */
  emitAssistant(record: AssistantRecord, sessionId: string): string {
    const blocks = record.message.content.filter(
      (b) => b.type === 'text' || b.type === 'tool_use',
    );
    if (blocks.length === 0) return '';

    this.writeLine({
      type: 'assistant',
      session_id: sessionId,
      stop_reason: record.message.stop_reason ?? 'end_turn',
      message: { role: 'assistant', content: blocks },
    });

    return blocks
      .filter((b) => b.type === 'text')
      .map((b) => String((b as { text?: unknown }).text ?? ''))
      .join('');
  }

  emitResult(opts: {
    sessionId: string;
    isError: boolean;
    text: string;
    durationMs: number;
    usage: UsageInfo | null;
  }): void {
    this.writeLine({
      type: 'result',
      subtype: opts.isError ? 'error_during_execution' : 'success',
      is_error: opts.isError,
      result: opts.text,
      duration_ms: opts.durationMs,
      num_turns: 1,
      session_id: opts.sessionId,
      usage: { output_tokens: opts.usage?.output_tokens ?? 0 },
    });
  }

}
