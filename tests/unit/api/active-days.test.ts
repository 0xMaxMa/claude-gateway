import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../../src/history/db';
import { HistoryMessage } from '../../../src/history/types';

let tmpDir: string;
const AGENT_ID = 'test-agent';
const CHAT = 'telegram-12345';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-days-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(): HistoryDB {
  // Each test gets its own unique dir so the singleton cache does not interfere.
  return HistoryDB.forAgent(tmpDir, AGENT_ID);
}

function insertAt(db: HistoryDB, ts: number, overrides: Partial<HistoryMessage> = {}): void {
  const msg: HistoryMessage = {
    chatId: CHAT,
    sessionId: 'session-uuid-1',
    source: 'telegram',
    role: 'user',
    content: 'msg',
    senderName: 'testuser',
    ts,
    ...overrides,
  };
  db.insertMessage(msg);
}

// Fixed UTC timestamps — deterministic buckets, never Date.now().
const JUL = 6; // month is 0-indexed in Date.UTC (6 = July)
// tz_offset is minutes EAST of UTC (local = UTC + offset), matching the issue contract.
const TZ_BANGKOK = 420; // UTC+7
const TZ_NEPAL = 345; // UTC+5:45

describe('HistoryDB.getActiveDays', () => {
  // U-AD-01 — distinct days, deduped and ascending
  it('returns distinct local days, deduped and sorted ascending', () => {
    const db = makeDb();
    insertAt(db, Date.UTC(2026, JUL, 2, 10, 0, 0));
    insertAt(db, Date.UTC(2026, JUL, 2, 15, 0, 0)); // duplicate day
    insertAt(db, Date.UTC(2026, JUL, 3, 9, 0, 0));
    insertAt(db, Date.UTC(2026, JUL, 5, 20, 0, 0));

    const days = db.getActiveDays(CHAT, {
      from: Date.UTC(2026, JUL, 1),
      to: Date.UTC(2026, JUL, 6),
      tzOffset: 0,
    });

    expect(days).toEqual(['2026-07-02', '2026-07-03', '2026-07-05']);
  });

  // U-AD-02 — empty range and inverted window both return []
  it('returns [] for a window with no messages', () => {
    const db = makeDb();
    insertAt(db, Date.UTC(2026, JUL, 2, 10, 0, 0));

    const days = db.getActiveDays(CHAT, {
      from: Date.UTC(2026, JUL, 10),
      to: Date.UTC(2026, JUL, 20),
      tzOffset: 0,
    });

    expect(days).toEqual([]);
  });

  it('short-circuits to [] when to <= from (inverted/empty window)', () => {
    const db = makeDb();
    insertAt(db, Date.UTC(2026, JUL, 2, 10, 0, 0));

    const inverted = db.getActiveDays(CHAT, {
      from: Date.UTC(2026, JUL, 5),
      to: Date.UTC(2026, JUL, 1),
    });
    const equal = db.getActiveDays(CHAT, {
      from: Date.UTC(2026, JUL, 2),
      to: Date.UTC(2026, JUL, 2),
    });

    expect(inverted).toEqual([]);
    expect(equal).toEqual([]);
  });

  // U-AD-03 — the critical timezone day-boundary test (a flipped sign fails this)
  it('buckets a near-midnight message into the viewer local day (tz sign)', () => {
    const db = makeDb();
    // 2026-07-02T23:30:00Z — still Jul 2 in UTC, but Jul 3 in Bangkok (UTC+7).
    const ts = Date.UTC(2026, JUL, 2, 23, 30, 0);
    insertAt(db, ts);

    const window = { from: Date.UTC(2026, JUL, 2), to: Date.UTC(2026, JUL, 4) };

    const bangkok = db.getActiveDays(CHAT, { ...window, tzOffset: TZ_BANGKOK });
    const utc = db.getActiveDays(CHAT, { ...window, tzOffset: 0 });

    expect(bangkok).toEqual(['2026-07-03']); // UTC+7 pushes 23:30 into the next local day
    expect(utc).toEqual(['2026-07-02']); // UTC bucketing keeps it on Jul 2
  });

  it('defaults to UTC bucketing when tzOffset is omitted', () => {
    const db = makeDb();
    insertAt(db, Date.UTC(2026, JUL, 2, 23, 30, 0));

    const days = db.getActiveDays(CHAT, {
      from: Date.UTC(2026, JUL, 2),
      to: Date.UTC(2026, JUL, 4),
    });

    expect(days).toEqual(['2026-07-02']);
  });

  // U-AD-03b — a western offset must bucket the other way (guards the sign direction)
  it('buckets a just-after-midnight UTC message into the previous local day for a western offset', () => {
    const db = makeDb();
    // 2026-07-03T02:00:00Z — Jul 3 in UTC, but still Jul 2 in New York (UTC-4).
    insertAt(db, Date.UTC(2026, JUL, 3, 2, 0, 0));

    const window = { from: Date.UTC(2026, JUL, 2), to: Date.UTC(2026, JUL, 4) };
    const newYork = db.getActiveDays(CHAT, { ...window, tzOffset: -240 }); // UTC-4

    expect(newYork).toEqual(['2026-07-02']);
  });

  // U-AD-04 — session_id filter (also exercises the full bind order)
  it('filters by session_id', () => {
    const db = makeDb();
    insertAt(db, Date.UTC(2026, JUL, 2, 10, 0, 0), { sessionId: 'sess-A' });
    insertAt(db, Date.UTC(2026, JUL, 3, 10, 0, 0), { sessionId: 'sess-B' });

    const window = { from: Date.UTC(2026, JUL, 1), to: Date.UTC(2026, JUL, 6), tzOffset: 0 };

    const onlyA = db.getActiveDays(CHAT, { ...window, sessionId: 'sess-A' });
    const both = db.getActiveDays(CHAT, window);

    expect(onlyA).toEqual(['2026-07-02']);
    expect(both).toEqual(['2026-07-02', '2026-07-03']);
  });

  // U-AD-05 — half-hour / 45-min zone
  it('buckets correctly for a 45-minute offset zone (Nepal UTC+5:45)', () => {
    const db = makeDb();
    // 2026-07-02T18:20:00Z + 5:45 = 2026-07-03T00:05 local => Jul 3 in Nepal.
    insertAt(db, Date.UTC(2026, JUL, 2, 18, 20, 0));

    const window = { from: Date.UTC(2026, JUL, 2), to: Date.UTC(2026, JUL, 4) };

    const nepal = db.getActiveDays(CHAT, { ...window, tzOffset: TZ_NEPAL });
    const utc = db.getActiveDays(CHAT, { ...window, tzOffset: 0 });

    expect(nepal).toEqual(['2026-07-03']);
    expect(utc).toEqual(['2026-07-02']);
  });
});
