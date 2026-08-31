/**
 * Unit coverage for the resumable turn buffer (#421).
 *
 * The mechanism the API surface is built on: an ordered, sequence-numbered
 * event buffer whose *sink* (the thing writing to a socket) can be detached and
 * re-attached, so a client that drops mid-turn can pick the turn back up
 * instead of losing everything after the disconnect.
 */
import {
  TurnStream,
  TurnStreamRegistry,
  TURN_BUFFER_MAX_EVENTS,
  callbackSink,
  errorEvent,
  resultEvent,
  turnStreamKey,
  type SeqEvent,
} from '../../src/agent/turn-stream';
import { StreamEvent } from '../../src/types';

function recordingSink(): { writes: SeqEvent[]; finished: SeqEvent | null; displacedCount: number; sink: { write(e: SeqEvent): void; finish(e: SeqEvent): void; displaced(): void } } {
  const rec = {
    writes: [] as SeqEvent[],
    finished: null as SeqEvent | null,
    displacedCount: 0,
    sink: {
      write(e: SeqEvent) { rec.writes.push(e); },
      finish(e: SeqEvent) { rec.finished = e; },
      displaced() { rec.displacedCount++; },
    },
  };
  return rec;
}

const delta = (text: string): StreamEvent => ({ type: 'text_delta', text });

describe('TurnStream', () => {
  it('numbers events from 1 and writes them to the attached sink', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    const a = recordingSink();
    turn.attach(a.sink, 0);

    turn.emit(delta('one'));
    turn.emit(delta('two'));

    expect(a.writes.map((e) => e.seq)).toEqual([1, 2]);
    expect(a.writes.map((e) => e.event)).toEqual([delta('one'), delta('two')]);
    expect(turn.lastSeq).toBe(2);
  });

  it('keeps recording after the sink detaches, and a re-attach replays exactly the missed tail', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    const a = recordingSink();
    turn.attach(a.sink, 0);

    turn.emit(delta('seen'));
    turn.detach(a.sink); // the client went away mid-turn

    turn.emit(delta('missed-1'));
    turn.emit(delta('missed-2'));
    expect(a.writes).toHaveLength(1); // the dead connection got nothing more

    const b = recordingSink();
    turn.attach(b.sink, 1); // cursor = the last seq the first connection saw

    expect(b.writes.map((e) => e.seq)).toEqual([2, 3]);
    expect(b.writes.map((e) => e.event)).toEqual([delta('missed-1'), delta('missed-2')]);
  });

  it('has no gap and no duplicate at the seam — replay ends exactly where live events begin', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    turn.emit(delta('a'));
    turn.emit(delta('b'));

    const b = recordingSink();
    turn.attach(b.sink, 0); // no cursor → replay from the very first event
    turn.emit(delta('c'));  // live, straight after the replay

    expect(b.writes.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(b.writes.map((e) => (e.event as { text: string }).text)).toEqual(['a', 'b', 'c']);
  });

  it('replays from the first event when attached with no cursor', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    turn.emit(delta('a'));
    turn.emit(delta('b'));
    turn.complete(resultEvent('ab', []));

    const b = recordingSink();
    turn.attach(b.sink, 0);

    expect(b.writes.map((e) => e.seq)).toEqual([1, 2]);
    expect(b.finished).toMatchObject({ seq: 3, event: { type: 'result', text: 'ab' } });
  });

  it('delivers the terminal frame — with attachments — to a connection that attached after completion', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    turn.emit(delta('drawing'));
    turn.complete(resultEvent('done', [{ type: 'image', url: '/media/x.png', relPath: 'x.png' }]));

    const b = recordingSink();
    turn.attach(b.sink, 1);

    expect(b.writes).toHaveLength(0);
    expect(b.finished?.event).toEqual({
      type: 'result',
      text: 'done',
      attachments: [{ type: 'image', url: '/media/x.png', relPath: 'x.png' }],
    });
  });

  it('a stale detach from a superseded connection cannot silence the sink that replaced it', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    const a = recordingSink();
    const b = recordingSink();
    turn.attach(a.sink, 0);
    turn.attach(b.sink, 0);

    turn.detach(a.sink); // the old response's 'close' finally fires
    turn.emit(delta('live'));

    expect(b.writes.map((e) => e.seq)).toEqual([1]);
  });

  it('tells a displaced connection it has been taken over, so its socket does not hang', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    const a = recordingSink();
    const b = recordingSink();
    turn.attach(a.sink, 0);

    turn.attach(b.sink, 0); // a second connection resumes the same turn

    expect(a.displacedCount).toBe(1);
    expect(b.displacedCount).toBe(0);
    // The displaced sink is genuinely out of the loop, not merely notified.
    turn.emit(delta('live'));
    expect(a.writes).toHaveLength(0);
    expect(b.writes).toHaveLength(1);
  });

  it('re-attaching the SAME sink is not a displacement', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    const a = recordingSink();
    turn.attach(a.sink, 0);
    turn.attach(a.sink, 0);
    expect(a.displacedCount).toBe(0);
  });

  it('nothing may follow the terminal frame, and complete() is idempotent', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    const a = recordingSink();
    turn.attach(a.sink, 0);

    turn.complete(resultEvent('final', []));
    turn.emit(delta('too late'));
    turn.complete({ type: 'error', message: 'also too late' });

    expect(a.writes).toHaveLength(0);
    expect(a.finished?.event).toEqual({ type: 'result', text: 'final' });
    expect(turn.isComplete).toBe(true);
  });

  it('carries the original Error on a terminal error frame so callers keep its code', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    const onError = jest.fn();
    turn.attach(callbackSink({ onChunk: jest.fn(), onDone: jest.fn(), onError }), 0);

    const err = Object.assign(new Error('boom'), { code: 'PROCESS_EXITED' });
    turn.complete({ type: 'error', message: err.message }, err);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(err);
  });

  it('errorEvent puts the Error\'s code on the frame, and omits the field when there is none', () => {
    expect(errorEvent(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })))
      .toEqual({ type: 'error', message: 'timed out', code: 'TIMEOUT' });
    expect(errorEvent(new Error('plain'))).toEqual({ type: 'error', message: 'plain' });
    // A non-string `code` (libuv errno objects use numbers) is not a protocol code.
    expect(errorEvent(Object.assign(new Error('numeric'), { code: 7 })))
      .toEqual({ type: 'error', message: 'numeric' });
  });

  it('a REPLAYED error frame still hands its code to the sink — the live Error is long gone', () => {
    // The turn completed while nobody was attached; the reconnecting client
    // gets the frame from the buffer, not the throw. Rebuilding a bare Error
    // there would silently downgrade 'the turn was hard-capped' to 'something
    // failed', which is the string-matching the code field exists to end.
    const turn = new TurnStream('sess-1', 'req-1');
    turn.complete({ type: 'error', message: 'Agent response timed out.', code: 'TIMEOUT' });

    const onError = jest.fn();
    turn.attach(callbackSink({ onChunk: jest.fn(), onDone: jest.fn(), onError }), 0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ message: 'Agent response timed out.', code: 'TIMEOUT' });
  });

  it('is bounded: a turn with heavy output evicts its oldest events instead of growing forever', () => {
    const turn = new TurnStream('sess-1', 'req-1');
    for (let i = 0; i < TURN_BUFFER_MAX_EVENTS * 2; i++) turn.emit(delta(`e${i}`));

    expect(turn.isTruncated).toBe(true);

    // The tail is still replayable...
    const tail = recordingSink();
    expect(turn.attach(tail.sink, turn.lastSeq - 10)).toBeNull();
    expect(tail.writes).toHaveLength(10);

    // ...but a cursor inside the evicted region is refused rather than served
    // with a silent hole, so the client can fall back to history.
    const stale = recordingSink();
    expect(turn.attach(stale.sink, 0)).toBe('truncated');
    expect(stale.writes).toHaveLength(0);
  });

  it('refuses a cursor past the turn\'s last event instead of serving the answer with no deltas', () => {
    // Seq restarts at 1 every turn, so a cursor held over from an earlier turn
    // is not merely useless — it is *ahead*. Without an upper bound the attach
    // succeeds, the `e.seq > afterSeq` replay loop matches nothing, and the
    // client is still handed the terminal frame: the final answer with every
    // delta silently missing.
    const turn = new TurnStream('sess-1', 'req-2');
    turn.emit(delta('one'));
    turn.emit(delta('two'));
    expect(turn.lastSeq).toBe(2);

    const stale = recordingSink();
    expect(turn.attach(stale.sink, 50)).toBe('ahead');
    expect(stale.writes).toHaveLength(0);

    // Nothing was installed, so the turn keeps running for whoever is really
    // attached rather than streaming on into a rejected sink.
    turn.emit(delta('three'));
    expect(stale.writes).toHaveLength(0);
    turn.complete(resultEvent('one two three', []));
    expect(stale.finished).toBeNull();
  });

  it('accepts a cursor sitting exactly at the head — caught up is not ahead', () => {
    const turn = new TurnStream('sess-1', 'req-3');
    turn.emit(delta('one'));

    const caughtUp = recordingSink();
    expect(turn.attach(caughtUp.sink, turn.lastSeq)).toBeNull();
    expect(caughtUp.writes).toHaveLength(0); // nothing missed, nothing replayed

    turn.emit(delta('two'));
    expect(caughtUp.writes.map((e) => e.event)).toEqual([delta('two')]); // and it is live
  });

  it('accepts after_seq=0 on a turn that has produced nothing yet', () => {
    // lastSeq is 0 before the first emit; a fresh client must not be told its
    // cursor is ahead of a turn that simply has not started producing.
    const turn = new TurnStream('sess-1', 'req-4');
    const fresh = recordingSink();

    expect(turn.attach(fresh.sink, 0)).toBeNull();

    turn.emit(delta('first'));
    expect(fresh.writes.map((e) => e.seq)).toEqual([1]);
  });

  it('measures a tool_use event once, not again when it is evicted', () => {
    // approxSize() advertises itself as too cheap to cache, then serialises the
    // tool input — so charging it a second time on eviction stringified every
    // tool call twice, the big Write/Edit payloads included. The size is now
    // carried on the buffered entry.
    const turn = new TurnStream('api:sess-1', 'req-5');
    const input = { file_path: '/tmp/x.ts', content: 'y'.repeat(4096) };
    const spy = jest.spyOn(JSON, 'stringify');
    try {
      turn.emit({ type: 'tool_use', name: 'Write', id: 'tool-1', input });
      // Push it past the cap so the entry is evicted, which is where the second
      // measurement used to happen.
      for (let i = 0; i <= TURN_BUFFER_MAX_EVENTS; i++) turn.emit(delta('.'));

      const onThisInput = spy.mock.calls.filter((c) => c[0] === input);
      expect(onThisInput).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('TurnStreamRegistry', () => {
  it('keeps a completed turn replayable for the grace window, then releases it', async () => {
    const registry = new TurnStreamRegistry(30);
    const turn = registry.start('sess-1', 'req-1');
    turn.emit(delta('hi'));
    registry.complete(turn, resultEvent('hi', []));

    expect(registry.get('sess-1')).toBe(turn);
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.get('sess-1')).toBeUndefined();
  });

  it('a new turn never inherits the previous turn\'s buffer', () => {
    const registry = new TurnStreamRegistry(60_000);
    const first = registry.start('sess-1', 'req-1');
    first.emit(delta('old turn'));
    registry.complete(first, resultEvent('old turn', []));

    const second = registry.start('sess-1', 'req-2');
    expect(second).not.toBe(first);
    expect(second.lastSeq).toBe(0);
    expect(second.isComplete).toBe(false);

    const sink = recordingSink();
    second.attach(sink.sink, 0);
    expect(sink.writes).toHaveLength(0);
    expect(sink.finished).toBeNull();
    registry.clear();
  });

  it('starting a new turn ends the previous turn\'s grace window immediately', async () => {
    // The grace window promises a completed turn stays replayable for 2 minutes,
    // but a session holds at most one turn — so nothing of turn N survives once
    // turn N+1 starts, and a client that names turn N gets TURN_MISMATCH rather
    // than a replay. Documented in API.md; pinned here so the doc can't quietly
    // drift from the behaviour.
    const registry = new TurnStreamRegistry(30);
    const first = registry.start('sess-1', 'req-1');
    first.emit(delta('answer to turn 1'));
    registry.complete(first, resultEvent('answer to turn 1', []));

    // Within the grace window the completed turn is still resumable…
    expect(registry.get('sess-1')).toBe(first);

    // …until a second turn starts on the same session, well inside that window.
    const second = registry.start('sess-1', 'req-2');
    expect(registry.get('sess-1')).toBe(second);

    // And `start()` must have CANCELLED the completed turn's release timer, not
    // just overwritten the map entry: that timer is keyed by session id, so if
    // it survived it would fire mid-flight and evict `second` — a live turn —
    // leaving its client resuming into TURN_GONE at the old turn's deadline.
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.get('sess-1')).toBe(second);
    registry.clear();
  });

  it('a superseded turn finishing late terminates ITSELF, never the turn that replaced it', async () => {
    // Turn N and turn N+1 on one session share a key, so the record for N is
    // replaced the moment N+1 starts. A late finisher must not deliver its
    // result to the newer turn's client, nor schedule that turn's release out
    // from under it.
    const registry = new TurnStreamRegistry(30);
    const stale = registry.start('sess-1', 'req-1');
    const current = registry.start('sess-1', 'req-2');

    const watcher = recordingSink();
    current.attach(watcher.sink, 0);

    registry.complete(stale, resultEvent('stale result', []));

    expect(stale.isComplete).toBe(true);
    expect(current.isComplete).toBe(false);
    expect(watcher.finished).toBeNull();
    expect(registry.get('sess-1')).toBe(current);

    // …and the stale completion must not have scheduled a release for `current`.
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.get('sess-1')).toBe(current);
    registry.clear();
  });

  it('clear() drops every record and its pending grace timer', async () => {
    const registry = new TurnStreamRegistry(30);
    const turn = registry.start('sess-1', 'req-1');
    registry.complete(turn, resultEvent('x', []));
    registry.clear();

    expect(registry.get('sess-1')).toBeUndefined();
    // The release timer must not resurrect or throw after clear().
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.get('sess-1')).toBeUndefined();
  });

  it('namespaced keys keep an API turn and a channel turn on one session id apart', () => {
    // One registry serves both producers. Keyed by the bare session id, the
    // second producer to start would release the first one's record — the
    // collision two comments in the source used to contradict each other about.
    const registry = new TurnStreamRegistry(60_000);
    const api = registry.start(turnStreamKey('api', 'sess-1'), 'req-api');
    api.emit(delta('from the api turn'));
    const watcher = recordingSink();
    api.attach(watcher.sink, api.lastSeq);

    const channel = registry.start(turnStreamKey('telegram', 'sess-1'), 'req-telegram');

    expect(registry.get(turnStreamKey('api', 'sess-1'))).toBe(api);
    expect(registry.get(turnStreamKey('telegram', 'sess-1'))).toBe(channel);

    // …and terminating the channel turn leaves the API turn's client waiting on
    // its own turn, not handed someone else's terminal frame.
    registry.complete(channel, resultEvent('channel answer', []));
    expect(api.isComplete).toBe(false);
    expect(watcher.finished).toBeNull();
    registry.clear();
  });
});
