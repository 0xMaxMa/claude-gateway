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
  resultEvent,
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

  it('a superseded turn finishing late terminates ITSELF, never the turn that replaced it', async () => {
    // Two producers can hold the same session id — an API turn and a channel
    // turn are separate namespaces that share this map. A late finisher must
    // not deliver its result to the newer turn's client, nor schedule that
    // turn's release out from under it.
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
});
