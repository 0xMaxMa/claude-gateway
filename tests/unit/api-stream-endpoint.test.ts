/**
 * GET /api/v1/agents/:agentId/sessions/:sessionId/stream — the resume endpoint
 * added for #421.
 *
 * The runner-level behaviour (buffering, cursors, eviction) is covered by
 * tests/unit/turn-stream.test.ts and tests/unit/api-stream-reattach.test.ts.
 * What matters here is the HTTP contract: the wire frames a resuming client
 * gets, and the fact that a refused attach comes back as a clean JSON 410
 * rather than a half-open text/event-stream.
 */
import express from 'express';
import * as supertest from 'supertest';
import { EventEmitter } from 'events';
import { createApiRouter, openSseStream } from '../../src/api/router';
import { AgentConfig, ApiKey, StreamEvent } from '../../src/types';
import type { SeqEvent, TurnSink } from '../../src/agent/turn-stream';

type AttachResult =
  | { ok: true; requestId: string; detach: () => void }
  | { ok: false; reason: 'gone' | 'mismatch' | 'truncated' | 'ahead' };

class MockStreamRunner extends EventEmitter {
  get workspacePath(): string { return '/tmp/test-agent'; }

  /** What attachTurnStream should answer. Default: a turn exists. */
  attachResult: AttachResult | null = null;
  /** Replayed into the sink on a successful attach, then the terminal frame. */
  replay: SeqEvent[] = [];
  terminal: SeqEvent | null = null;
  detachCalled = false;
  captured: { sessionId: string; afterSeq?: number; requestId?: string } | null = null;
  /** What turnStreamInfo should answer — the identity and age the frames report. */
  turnInfo: { requestId: string; startedAt: number } | undefined = undefined;

  hasActiveApiSession(): boolean { return false; }

  turnStreamInfo(): { requestId: string; startedAt: number } | undefined { return this.turnInfo; }

  attachTurnStream(
    sessionId: string,
    sink: TurnSink,
    opts: { afterSeq?: number; requestId?: string } = {},
  ): AttachResult {
    this.captured = { sessionId, ...opts };
    if (this.attachResult && !this.attachResult.ok) return this.attachResult;

    // Mirror the real contract: replay synchronously, then (for these tests)
    // terminate so the response actually closes and supertest resolves.
    for (const e of this.replay) sink.write(e);
    if (this.terminal) sink.finish(this.terminal);
    return { ok: true, requestId: opts.requestId ?? 'req-1', detach: () => { this.detachCalled = true; } };
  }
}

const AGENT_ID = 'getpod';

const agentConfig: AgentConfig = {
  id: AGENT_ID,
  description: 'Test agent',
  workspace: '/tmp/test-agent',
  env: '',
  claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
};

const apiKeys: ApiKey[] = [
  { key: 'sk-read-only', agents: [AGENT_ID] },
  { key: 'sk-other', agents: ['someone-else'] },
];

function buildApp(runner: MockStreamRunner) {
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent/runner').AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return app;
}

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: ') && chunk.slice(6) !== '[DONE]')
    .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
}

const seq = (n: number, event: StreamEvent): SeqEvent => ({ seq: n, event });

const SESSION = 'sess-resume-1';
const url = (qs = '') => `/api/v1/agents/${AGENT_ID}/sessions/${SESSION}/stream${qs}`;

describe('GET /api/v1/agents/:agentId/sessions/:sessionId/stream (#421)', () => {
  let runner: MockStreamRunner;

  beforeEach(() => { runner = new MockStreamRunner(); });

  it('replays the buffered tail as SSE and terminates with result + [DONE]', async () => {
    runner.replay = [
      seq(2, { type: 'text_delta', text: 'after ' }),
      seq(3, { type: 'thinking', text: 'hmm' }),
    ];
    runner.terminal = seq(4, { type: 'result', text: 'before after' });

    const res = await supertest.default(buildApp(runner))
      .get(url('?after_seq=1&request_id=req-1'))
      .set('X-Api-Key', 'sk-read-only');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text.endsWith('data: [DONE]\n\n')).toBe(true);

    const events = parseSse(res.text);
    expect(events).toEqual([
      { type: 'text_delta', text: 'after ', seq: 2 },
      { type: 'thinking', text: 'hmm', seq: 3 },
      expect.objectContaining({ type: 'result', text: 'before after', seq: 4, session_id: SESSION }),
    ]);
    // Every frame carries the cursor the client needs to resume again.
    expect(events.every((e) => typeof e['seq'] === 'number')).toBe(true);
  });

  it('passes the cursor and request_id through to the runner; omitting after_seq replays from the start', async () => {
    runner.terminal = seq(1, { type: 'result', text: 'ok' });

    await supertest.default(buildApp(runner))
      .get(url('?after_seq=7&request_id=req-abc'))
      .set('X-Api-Key', 'sk-read-only');
    expect(runner.captured).toMatchObject({ sessionId: SESSION, afterSeq: 7, requestId: 'req-abc' });

    await supertest.default(buildApp(runner)).get(url()).set('X-Api-Key', 'sk-read-only');
    expect(runner.captured).toMatchObject({ afterSeq: 0, requestId: undefined });
  });

  it('echoes the client\'s request_id, and reports the turn\'s own when the client had none', async () => {
    runner.terminal = seq(1, { type: 'result', text: 'ok' });

    const named = parseSse(
      (await supertest.default(buildApp(runner))
        .get(url('?request_id=req-abc'))
        .set('X-Api-Key', 'sk-read-only')).text,
    )[0]!;
    expect(named['request_id']).toBe('req-abc');

    // A client that reloaded has no token, and the endpoint refuses any
    // `after_seq > 0` without one — so a resume that omitted it must LEARN the
    // turn's request_id here, or it can never resume from a cursor again.
    runner.turnInfo = { requestId: 'req-live', startedAt: Date.now() };
    const anonymous = parseSse(
      (await supertest.default(buildApp(runner)).get(url()).set('X-Api-Key', 'sk-read-only')).text,
    )[0]!;
    expect(anonymous['request_id']).toBe('req-live');
    expect(anonymous['session_id']).toBe(SESSION);

    // With no turn record to name, the field is absent — better than the session
    // id masquerading as a request id.
    runner.turnInfo = undefined;
    const unknown = parseSse(
      (await supertest.default(buildApp(runner)).get(url()).set('X-Api-Key', 'sk-read-only')).text,
    )[0]!;
    expect(unknown).not.toHaveProperty('request_id');
  });

  it('forwards a result\'s attachments so a resumed turn does not lose its images', async () => {
    runner.terminal = seq(2, {
      type: 'result',
      text: 'here you go',
      attachments: [{ type: 'image', url: '/media/x.png', relPath: 'x.png' }],
    });

    const res = await supertest.default(buildApp(runner)).get(url()).set('X-Api-Key', 'sk-read-only');
    expect(parseSse(res.text)[0]).toMatchObject({
      type: 'result',
      attachments: [{ type: 'image', url: '/media/x.png', relPath: 'x.png' }],
    });
  });

  it('streams a soft timeout as a non-terminal `timeout` frame — the stream stays open past it', async () => {
    runner.replay = [
      seq(1, { type: 'timeout', message: 'Agent response timeout', resumable: true }),
      seq(2, { type: 'text_delta', text: 'still working' }),
    ];
    runner.terminal = seq(3, { type: 'result', text: 'still working' });

    const events = parseSse(
      (await supertest.default(buildApp(runner)).get(url()).set('X-Api-Key', 'sk-read-only')).text,
    );
    expect(events[0]).toEqual({ type: 'timeout', message: 'Agent response timeout', resumable: true, seq: 1 });
    expect(events[events.length - 1]).toMatchObject({ type: 'result' });
  });

  it('puts the error `code` on the wire so a client can tell the hard cap from a crash', async () => {
    // Both timeouts used to reach the client as bare messages differing only by
    // a tense and a full stop ('Agent response timeout' vs 'Agent response
    // timed out.'), so distinguishing 'the turn is still alive, resume it' from
    // 'the turn was interrupted, stop waiting' meant string-matching.
    runner.terminal = {
      seq: 5,
      event: { type: 'error', message: 'Agent response timed out.', code: 'TIMEOUT' },
      error: Object.assign(new Error('Agent response timed out.'), { code: 'TIMEOUT' }),
    };

    const events = parseSse(
      (await supertest.default(buildApp(runner)).get(url()).set('X-Api-Key', 'sk-read-only')).text,
    );
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      message: 'Agent response timed out.',
      code: 'TIMEOUT',
      seq: 5,
    });
  });

  it('omits `code` entirely for an error that has none, rather than sending a null', async () => {
    runner.terminal = { seq: 2, event: { type: 'error', message: 'boom' }, error: new Error('boom') };

    const events = parseSse(
      (await supertest.default(buildApp(runner)).get(url()).set('X-Api-Key', 'sk-read-only')).text,
    );
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: 'error', message: 'boom' });
    expect(last).not.toHaveProperty('code');
  });

  // ── Refused attaches: JSON 410, never a half-open event-stream ────────────
  it.each([
    ['gone', 'TURN_GONE'],
    ['mismatch', 'TURN_MISMATCH'],
  ] as const)('answers 410 %s with a %s code and no SSE headers', async (reason, code) => {
    runner.attachResult = { ok: false, reason };

    const res = await supertest.default(buildApp(runner))
      .get(url('?after_seq=1&request_id=req-1'))
      .set('X-Api-Key', 'sk-read-only');

    expect(res.status).toBe(410);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toMatchObject({ code });
    expect(res.body.hint).toContain('history');
  });

  it.each([
    ['truncated', 'TURN_TRUNCATED'],
    ['ahead', 'CURSOR_AHEAD'],
  ] as const)('answers 410 %s (%s) with a recover-here hint, not the history fallback', async (reason, code) => {
    // Both mean the turn is live and only the *cursor* is unusable — one points
    // into evicted events, the other past the last one. Dropping `after_seq`
    // recovers either, so pointing the client at history would send it away from
    // a stream it can still join (and, mid-turn, at a history with no row yet).
    runner.attachResult = { ok: false, reason };

    const res = await supertest.default(buildApp(runner))
      .get(url('?after_seq=50&request_id=req-1'))
      .set('X-Api-Key', 'sk-read-only');

    expect(res.status).toBe(410);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toMatchObject({ code });
    expect(res.body.hint).toContain('after_seq');
    expect(res.body.hint).not.toContain('history');
  });

  // ── Guards ────────────────────────────────────────────────────────────────

  it('rejects a bad after_seq before touching the runner', async () => {
    for (const bad of ['-1', 'abc', '1.5']) {
      const res = await supertest.default(buildApp(runner))
        .get(url(`?after_seq=${bad}&request_id=req-1`))
        .set('X-Api-Key', 'sk-read-only');
      expect(res.status).toBe(400);
    }
    expect(runner.captured).toBeNull();
  });

  it('rejects a non-zero after_seq that does not name its turn, before touching the runner', async () => {
    // Seq numbers restart at 1 every turn, so a bare cursor cannot say WHICH
    // turn's seq 12 the client saw. If the session has moved on, that cursor
    // lands inside the newer turn — attach() sees a perfectly ordinary
    // mid-stream resume and replays a turn the client never watched, with
    // everything before seq 12 missing. Only request_id separates the two.
    // (A terminal frame is armed so that a regression here fails on the status
    // rather than hanging on a stream that never closes.)
    runner.terminal = seq(13, { type: 'result', text: 'someone else\'s turn' });
    const res = await supertest.default(buildApp(runner))
      .get(url('?after_seq=12'))
      .set('X-Api-Key', 'sk-read-only');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('request_id');
    expect(res.body.hint).toContain('after_seq');
    expect(runner.captured).toBeNull();

    // after_seq=0 (and omitting it) still needs nothing: replaying whichever
    // turn is current from its first event is unambiguous either way.
    runner.terminal = seq(1, { type: 'result', text: 'ok' });
    expect(
      (await supertest.default(buildApp(runner)).get(url('?after_seq=0')).set('X-Api-Key', 'sk-read-only')).status,
    ).toBe(200);
  });

  it('reports duration_ms for the turn, not for the reconnect', async () => {
    // A client that resumes 5 seconds before a long turn ends must not be told
    // the turn took 5 seconds. The replayed frame stands in for the one the
    // original connection would have received, so it is timed from the turn's
    // own start.
    runner.turnInfo = { requestId: 'req-1', startedAt: Date.now() - 30_000 };
    runner.terminal = seq(4, { type: 'result', text: 'done' });

    const res = await supertest.default(buildApp(runner))
      .get(url('?after_seq=3&request_id=req-1'))
      .set('X-Api-Key', 'sk-read-only');

    const result = parseSse(res.text).find((e) => e['type'] === 'result')!;
    expect(result['duration_ms'] as number).toBeGreaterThanOrEqual(30_000);
  });

  // ── Keepalive ─────────────────────────────────────────────────────────────
  // The keepalive is time-based and fires on a response nobody is reading, which
  // no end-to-end HTTP test can hold still, so these drive openSseStream directly
  // against a stub response whose lifecycle flags they control.
  function resStub() {
    const writes: string[] = [];
    const listeners = new Map<string, () => void>();
    const res = {
      writableEnded: false,
      destroyed: false,
      writeHead: jest.fn(),
      flushHeaders: jest.fn(),
      socket: { setNoDelay: jest.fn() },
      write: (c: string) => { writes.push(c); return true; },
      on: jest.fn(),
    };
    res.on.mockImplementation((ev: string, fn: () => void) => { listeners.set(ev, fn); return res; });
    return { res, writes, listeners, response: res as unknown as import('express').Response };
  }

  it('keeps an idle stream alive with SSE comment frames, and stops them when it closes', () => {
    // A turn can be silent for minutes (a long Bash call), which a reverse proxy
    // reads as a dead connection. The keepalive is a comment frame: every SSE
    // parser drops it, so it must not appear as an event or consume a seq.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { writes, listeners, response } = resStub();
      openSseStream(response);

      jest.advanceTimersByTime(46_000);
      expect(writes).toEqual([': keepalive\n\n', ': keepalive\n\n', ': keepalive\n\n']);
      // Comment frames only — nothing a client would parse as an event.
      expect(parseSse(writes.join(''))).toEqual([]);

      // Once the response closes the timer must go, or every dropped connection
      // leaks an interval that writes to a dead socket forever.
      listeners.get('close')!();
      jest.advanceTimersByTime(60_000);
      expect(writes).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never writes into the window between res.end() and \'finish\' — that write kills the process', () => {
    // http does NOT throw write-after-end synchronously: it emits 'error' on the
    // response a tick later, so the try/catch around the write cannot see it and
    // index.ts's uncaughtException handler turns it into exit(1). The window is
    // as wide as the reader is slow — the body has to drain before 'finish' —
    // so one stalled SSE client could take the gateway down. Checked, not caught.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { res, writes, listeners, response } = resStub();
      openSseStream(response);
      jest.advanceTimersByTime(16_000);
      expect(writes).toHaveLength(1);

      res.writableEnded = true; // end() called, 'finish'/'close' not fired yet
      jest.advanceTimersByTime(60_000);
      expect(writes).toHaveLength(1);

      // Belt and braces for the same class of failure: an 'error' listener means
      // an asynchronous write error on this response — from here or from a frame
      // written by createSseCallbacks — is a dead client, never an uncaught throw.
      expect(listeners.has('error')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens nothing when the client is already gone', () => {
    // Every caller reaches openSseStream after an await (a session lookup,
    // reading GREETING.md). If the client aborted during it, 'close' has already
    // fired, so a listener registered now never runs and the interval would
    // outlive the request writing to a destroyed socket.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { res, writes, listeners, response } = resStub();
      res.destroyed = true;
      openSseStream(response);

      expect(res.writeHead).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
      jest.advanceTimersByTime(60_000);
      expect(writes).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('enforces auth, agent access and session-id validity', async () => {
    const app = buildApp(runner);
    runner.terminal = seq(1, { type: 'result', text: 'ok' });

    expect((await supertest.default(app).get(url())).status).toBe(401);
    expect((await supertest.default(app).get(url()).set('X-Api-Key', 'sk-other')).status).toBe(403);
    expect(
      (await supertest.default(app)
        .get(`/api/v1/agents/${AGENT_ID}/sessions/bad%20id/stream`)
        .set('X-Api-Key', 'sk-read-only')).status,
    ).toBe(400);
    expect(
      (await supertest.default(app)
        .get(`/api/v1/agents/nope/sessions/${SESSION}/stream`)
        .set('X-Api-Key', 'sk-read-only')).status,
    ).toBe(403);
  });
});
