/**
 * Resumable turn streams (#421).
 *
 * A streamed turn used to be bound to exactly one HTTP request: every event was
 * written straight to `res` behind an `if (!clientGone)` guard, so a client
 * disconnect (or the soft timeout, which set the same flag) discarded the rest
 * of the turn even though it kept running server-side and landed in history.
 *
 * A TurnStream decouples the two: the producer always records into an ordered,
 * sequence-numbered buffer, and a *sink* — the thing that writes to a socket —
 * is attached, detached and re-attached independently. A new SSE connection can
 * therefore replay the tail from a cursor and then keep receiving live events,
 * with no gap and no duplicate at the seam (attach() replays and installs in one
 * synchronous block, so no event can slip between the two).
 */
import { ApiAttachment, StreamEvent } from '../types';

/** Max events retained per turn before the oldest are evicted. */
export const TURN_BUFFER_MAX_EVENTS = 2_000;
/** Max approximate payload bytes retained per turn (heavy tool output). */
export const TURN_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
/** How long a completed turn stays replayable after its terminal frame. */
export const TURN_REPLAY_GRACE_MS = 120_000;

/** Fraction of the cap evicted at once, so eviction is amortised O(1) per event. */
const EVICT_BATCH_RATIO = 0.1;

/** A buffered event plus its per-turn sequence number. */
export interface SeqEvent {
  seq: number;
  event: StreamEvent;
  /**
   * Terminal `error` frames only: the original Error, so an in-process sink can
   * hand callers the real object (with its `code`) rather than a re-wrapped
   * message. SSE sinks ignore it and serialise `event` alone.
   */
  error?: Error;
}

/** Whatever is currently writing a turn's events out (an SSE response, a test spy). */
export interface TurnSink {
  /** A non-terminal event. */
  write(e: SeqEvent): void;
  /** The terminal `result` / `error` frame. The sink should close after this. */
  finish(e: SeqEvent): void;
}

export type AttachFailure = 'truncated';

/**
 * One in-flight (or recently completed) turn: its ordered event buffer, its
 * terminal frame once known, and the sink currently draining it.
 */
export class TurnStream {
  readonly startedAt = Date.now();
  completedAt: number | null = null;

  private readonly events: SeqEvent[] = [];
  private nextSeq = 1;
  /** seq of the oldest event ever evicted — anything at or below this is unreplayable. */
  private evictedThroughSeq = 0;
  private bytes = 0;
  private terminalEvent: SeqEvent | null = null;
  private sink: TurnSink | null = null;

  constructor(
    readonly sessionId: string,
    readonly requestId: string,
  ) {}

  get isComplete(): boolean {
    return this.terminalEvent !== null;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** True once the head of the buffer has been evicted (a from-scratch replay is no longer possible). */
  get isTruncated(): boolean {
    return this.evictedThroughSeq > 0;
  }

  /** Record a non-terminal event and, if a sink is attached, write it out. */
  emit(event: StreamEvent): void {
    if (this.terminalEvent) return; // nothing may follow the terminal frame
    const e: SeqEvent = { seq: this.nextSeq++, event };
    this.events.push(e);
    this.bytes += approxSize(event);
    this.evictIfOverCap();
    this.sink?.write(e);
  }

  /**
   * Record the terminal frame (`result` or `error`), flush it to the sink and
   * detach — the turn is over, and anything that attaches later replays instead.
   */
  complete(event: StreamEvent, error?: Error): void {
    if (this.terminalEvent) return;
    const e: SeqEvent = { seq: this.nextSeq++, event, ...(error ? { error } : {}) };
    this.terminalEvent = e;
    this.completedAt = Date.now();
    const sink = this.sink;
    this.sink = null;
    sink?.finish(e);
  }

  /**
   * Replay everything after `afterSeq`, then install `sink` as the live one.
   * Deliberately synchronous end to end: an event produced during an `await`
   * here would land in the buffer but miss the sink (gap) or arrive twice (dup).
   *
   * Returns `'truncated'` — installing nothing — when `afterSeq` sits inside a
   * region the buffer has already evicted, since the seamless replay the caller
   * asked for cannot be honoured.
   */
  attach(sink: TurnSink, afterSeq: number): AttachFailure | null {
    if (afterSeq < this.evictedThroughSeq) return 'truncated';

    for (const e of this.events) {
      if (e.seq > afterSeq) sink.write(e);
    }
    if (this.terminalEvent) {
      sink.finish(this.terminalEvent);
      return null;
    }
    this.sink = sink;
    return null;
  }

  /**
   * Detach `sink` if it is still the live one. Passing the sink (rather than
   * clearing unconditionally) keeps a stale `res.on('close')` from a superseded
   * connection from silencing the sink that replaced it.
   */
  detach(sink: TurnSink): void {
    if (this.sink === sink) this.sink = null;
  }

  private evictIfOverCap(): void {
    if (this.events.length <= TURN_BUFFER_MAX_EVENTS && this.bytes <= TURN_BUFFER_MAX_BYTES) return;
    const batch = Math.max(1, Math.floor(TURN_BUFFER_MAX_EVENTS * EVICT_BATCH_RATIO));
    while (
      this.events.length > 0 &&
      (this.events.length > TURN_BUFFER_MAX_EVENTS - batch || this.bytes > TURN_BUFFER_MAX_BYTES)
    ) {
      const dropped = this.events.shift()!;
      this.bytes -= approxSize(dropped.event);
      this.evictedThroughSeq = dropped.seq;
    }
  }
}

/**
 * Per-session registry of turn streams, with the completed-turn grace window.
 *
 * Keyed by session id; each record carries its request id, so a client that
 * re-attaches can assert it is resuming the turn it thinks it is.
 */
export class TurnStreamRegistry {
  private readonly turns = new Map<string, TurnStream>();
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly graceMs: number = TURN_REPLAY_GRACE_MS) {}

  /**
   * Begin a new turn, replacing (and un-scheduling) any previous record for the
   * session so a fresh turn never inherits the last one's buffer — the same
   * reason `pendingApiAttachments` is cleared at the top of every turn.
   */
  start(sessionId: string, requestId: string): TurnStream {
    this.release(sessionId);
    const turn = new TurnStream(sessionId, requestId);
    this.turns.set(sessionId, turn);
    return turn;
  }

  get(sessionId: string): TurnStream | undefined {
    return this.turns.get(sessionId);
  }

  /** Record the terminal frame and keep the turn replayable for the grace window. */
  complete(sessionId: string, event: StreamEvent, error?: Error): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    turn.complete(event, error);
    const timer = setTimeout(() => this.release(sessionId), this.graceMs);
    timer.unref?.();
    this.releaseTimers.set(sessionId, timer);
  }

  /** Drop the record and its grace timer. */
  release(sessionId: string): void {
    const timer = this.releaseTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.releaseTimers.delete(sessionId);
    }
    this.turns.delete(sessionId);
  }

  clear(): void {
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    this.turns.clear();
  }
}

/** Cheap stand-in for the serialised size — exact bytes aren't worth the hot-path cost. */
function approxSize(event: StreamEvent): number {
  switch (event.type) {
    case 'text_delta':
    case 'thinking':
      return event.text.length + 32;
    case 'result':
      return event.text.length + 32 + (event.attachments?.length ?? 0) * 128;
    case 'error':
    case 'timeout':
      return event.message.length + 32;
    case 'tool_use':
      return event.name.length + event.id.length + (event.input ? JSON.stringify(event.input).length : 0) + 32;
  }
}

/** Terminal frame for a turn that finished normally. */
export function resultEvent(text: string, attachments: ApiAttachment[]): StreamEvent {
  return attachments.length ? { type: 'result', text, attachments } : { type: 'result', text };
}

/**
 * The callback shape every streaming producer in AgentRunner emits into. `seq`
 * is the event's per-turn sequence number — the cursor a client passes back to
 * `GET …/sessions/:sessionId/stream?after_seq=` to resume without a gap.
 */
export interface ApiStreamCallbacks {
  onChunk: (event: StreamEvent, seq?: number) => void;
  onDone: (fullText: string, attachments: ApiAttachment[], seq?: number) => void;
  onError: (err: Error, seq?: number) => void;
}

/** Adapt a callback trio into a sink a TurnStream can drive. */
export function callbackSink(callbacks: ApiStreamCallbacks): TurnSink {
  return {
    write: (e: SeqEvent) => {
      try { callbacks.onChunk(e.event, e.seq); } catch { /* sink gone */ }
    },
    finish: (e: SeqEvent) => {
      try {
        if (e.event.type === 'result') {
          callbacks.onDone(e.event.text, e.event.attachments ?? [], e.seq);
        } else if (e.event.type === 'error') {
          callbacks.onError(e.error ?? new Error(e.event.message), e.seq);
        }
      } catch { /* sink gone */ }
    },
  };
}
