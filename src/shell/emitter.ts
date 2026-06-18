import type { AssistantRecord, UsageInfo } from './tailer';
import type { MenuOption } from './screen';

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

  /**
   * Signal that the TUI is blocked on an interactive select menu. The gateway
   * (runner.ts) renders this as channel-native UI — inline buttons on
   * Telegram/Discord — while the turn's result text carries the same numbered
   * list as a fallback (and for API, which has no buttons). callback_data /
   * custom_id only ever carry the 1-based choice index.
   */
  emitMenuPrompt(opts: { sessionId: string; prompt: string; options: MenuOption[] }): void {
    this.writeLine({
      type: 'system',
      subtype: 'menu_prompt',
      session_id: opts.sessionId,
      prompt: opts.prompt,
      options: opts.options,
    });
  }

  /**
   * Emitted by the PTY shell when the session returns to truly idle state:
   * no active turn and the user-message queue is empty. Signals runner.ts
   * that typing can stop. Contrast with `result` which fires after every
   * individual Claude API sub-turn (there can be many per user message).
   */
  emitSessionIdle(sessionId: string): void {
    this.writeLine({ type: 'session_idle', session_id: sessionId });
  }

  /**
   * Emitted when the TUI hit the recoverable "Request too large (max 32MB)"
   * error: the request payload (history + attachments) exceeded Anthropic's
   * 32MB limit. The wrapper has already dismissed the TUI overlay (double-ESC);
   * runner.ts handles this by notifying the user and restarting the session so
   * the oversized in-memory context is dropped — otherwise the next message
   * re-hits the same limit and the session is effectively bricked.
   */
  emitRequestTooLarge(sessionId: string): void {
    this.writeLine({ type: 'system', subtype: 'request_too_large', session_id: sessionId });
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
