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

/**
 * A retained event, carrying the size it contributed to the turn's byte budget.
 * Measured once on the way in: approxSize() stringifies tool input, so charging
 * it again on eviction meant every tool call was serialised twice, in a helper
 * whose whole premise is that it is too cheap to bother caching.
 */
interface BufferedEvent extends SeqEvent {
  bytes: number;
}

/** Whatever is currently writing a turn's events out (an SSE response, a test spy). */
export interface TurnSink {
  /** A non-terminal event. */
  write(e: SeqEvent): void;
  /** The terminal `result` / `error` frame. The sink should close after this. */
  finish(e: SeqEvent): void;
  /**
   * Another connection took over this turn. Optional: sinks that own a socket
   * should close it, otherwise the displaced connection hangs open with no
   * terminal frame ever coming — it is no longer the one being written to.
   */
  displaced?(): void;
}

export type AttachFailure = 'truncated' | 'ahead';

/**
 * One in-flight (or recently completed) turn: its ordered event buffer, its
 * terminal frame once known, and the sink currently draining it.
 */
export class TurnStream {
  readonly startedAt = Date.now();
  completedAt: number | null = null;

  private readonly events: BufferedEvent[] = [];
  private nextSeq = 1;
  /** seq of the oldest event ever evicted — anything at or below this is unreplayable. */
  private evictedThroughSeq = 0;
  private bytes = 0;
  private terminalEvent: SeqEvent | null = null;
  private sink: TurnSink | null = null;

  constructor(
    /** The registry key this turn is filed under — see turnStreamKey(). */
    readonly key: string,
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
    const e: BufferedEvent = { seq: this.nextSeq++, event, bytes: approxSize(event) };
    this.events.push(e);
    this.bytes += e.bytes;
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
   *
   * Returns `'ahead'` when `afterSeq` runs past the last event this turn has
   * produced. Seq numbering restarts at 1 for every turn, so a client that
   * reloads and replays a cursor held over from an earlier turn would otherwise
   * attach successfully, match no event, and still be handed the terminal frame
   * — the final answer with every delta silently missing. Rejecting is the only
   * way the client learns its cursor belongs to a turn that is gone.
   */
  attach(sink: TurnSink, afterSeq: number): AttachFailure | null {
    if (afterSeq > this.lastSeq) return 'ahead';
    if (afterSeq < this.evictedThroughSeq) return 'truncated';

    // Retire whoever held the slot before the replay, so the displaced socket
    // closes instead of waiting forever for a terminal frame it will not get.
    const previous = this.sink;
    if (previous && previous !== sink) {
      this.sink = null;
      try { previous.displaced?.(); } catch { /* already gone */ }
    }

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
      this.bytes -= dropped.bytes;
      this.evictedThroughSeq = dropped.seq;
    }
  }
}

/**
 * Registry key for a turn. Every producer namespaces its session ids, because
 * one registry serves them all: the API path files under `api`, a channel turn
 * under its channel name. Without the prefix the two id spaces shared one
 * keyspace and a collision would let one producer's turn evict or terminate the
 * other's — a claim the old comments here asserted could not happen while
 * complete()'s guard below existed precisely because it could.
 *
 * The chat id is deliberately NOT part of the key: an API session id is minted
 * by the gateway inside a single `api-{chatId}` index and cannot be presented
 * for another chat (see apiSessionExists), so the namespace prefix already makes
 * every key unique.
 */
export function turnStreamKey(namespace: string, sessionId: string): string {
  return `${namespace}:${sessionId}`;
}

/**
 * Per-session registry of turn streams, with the completed-turn grace window.
 *
 * Keyed by turnStreamKey(); each record carries its request id, so a client that
 * re-attaches can assert it is resuming the turn it thinks it is.
 */
export class TurnStreamRegistry {
  private readonly turns = new Map<string, TurnStream>();
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly graceMs: number = TURN_REPLAY_GRACE_MS) {}

  /**
   * Begin a new turn, replacing (and un-scheduling) any previous record for the
   * key so a fresh turn never inherits the last one's buffer — the same reason
   * `pendingApiAttachments` is cleared at the top of every turn.
   *
   * This also ends the previous turn's replay grace window early: a session
   * holds at most one turn, so a client resuming turn N after turn N+1 has
   * started gets TURN_GONE rather than a replay. Documented in API.md under
   * "Resuming an interrupted stream"; history is the fallback.
   */
  start(key: string, requestId: string): TurnStream {
    this.release(key);
    const turn = new TurnStream(key, requestId);
    this.turns.set(key, turn);
    return turn;
  }

  get(key: string): TurnStream | undefined {
    return this.turns.get(key);
  }

  /**
   * Record the terminal frame and keep the turn replayable for the grace window.
   *
   * Takes the TurnStream itself, not a key: a turn superseded by the next one on
   * the same session finishes late often enough, and it must terminate its OWN
   * record, never the one that replaced it.
   */
  complete(turn: TurnStream, event: StreamEvent, error?: Error): void {
    turn.complete(event, error);
    // Only the current record earns a grace timer; a superseded one is already
    // unreachable and would otherwise schedule a release for its successor.
    if (this.turns.get(turn.key) !== turn) return;
    const timer = setTimeout(() => this.release(turn.key), this.graceMs);
    timer.unref?.();
    this.releaseTimers.set(turn.key, timer);
  }

  /** Drop the record and its grace timer. */
  release(key: string): void {
    const timer = this.releaseTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.releaseTimers.delete(key);
    }
    this.turns.delete(key);
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

/** Terminal frame for a turn that failed, carrying the Error's `code` when it has one. */
export function errorEvent(err: Error): StreamEvent {
  const code = errorCode(err);
  return code ? { type: 'error', message: err.message, code } : { type: 'error', message: err.message };
}

/** The `code` property producers attach to their Errors, when it is a string. */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Best-effort message for a terminal frame that is not a `result`. */
function terminalMessage(event: StreamEvent): string {
  return 'message' in event ? event.message : `Turn ended (${event.type})`;
}

/**
 * Rebuild an Error for a terminal frame whose original Error is not available —
 * a replayed `error` frame reaches a sink as data, not as the live throw. The
 * frame's `code` is copied back onto it so a resumed client learns the same
 * thing the original connection did.
 */
function terminalError(event: StreamEvent): Error {
  const err = new Error(terminalMessage(event));
  if (event.type === 'error' && event.code) Object.assign(err, { code: event.code });
  return err;
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
  /** Another connection resumed this turn; this one is no longer being written to. */
  onDisplaced?: () => void;
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
        } else {
          // `error` — and anything else that ever ends up terminal. A sink that
          // is handed a terminal frame it does not recognise must still be told
          // the turn is over, or an SSE response stays open forever.
          callbacks.onError(e.error ?? terminalError(e.event), e.seq);
        }
      } catch { /* sink gone */ }
    },
    displaced: () => {
      try { callbacks.onDisplaced?.(); } catch { /* sink gone */ }
    },
  };
}
