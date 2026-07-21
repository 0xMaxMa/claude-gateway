import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB, MAX_HISTORY_LIMIT } from '../../src/history/db';
import { HistoryMessage } from '../../src/history/types';

let tmpDir: string;
let agentsBaseDir: string;
const AGENT_ID = 'test-agent';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-db-test-'));
  agentsBaseDir = tmpDir;
  // Clear singleton cache between tests by using unique dirs
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(): HistoryDB {
  // Each test gets its own unique agentsBaseDir so singleton cache doesn't interfere
  return HistoryDB.forAgent(agentsBaseDir, AGENT_ID);
}

function makeMsg(overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return {
    chatId: 'telegram-12345',
    sessionId: 'session-uuid-1',
    source: 'telegram',
    role: 'user',
    content: 'Hello world',
    senderName: 'testuser',
    ts: Date.now(),
    ...overrides,
  };
}

describe('HistoryDB.insertMessage', () => {
  it('inserts a message without error', () => {
    const db = makeDb();
    expect(() => db.insertMessage(makeMsg())).not.toThrow();
  });

  it('inserts message with media files', () => {
    const db = makeDb();
    const msg = makeMsg({ mediaFiles: ['media/telegram-12345/photo.jpg'] });
    db.insertMessage(msg);
    const page = db.getMessages('telegram-12345');
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.mediaFiles).toEqual(['media/telegram-12345/photo.jpg']);
  });

  it('inserts multiple messages', () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      db.insertMessage(makeMsg({ content: `Message ${i}`, ts: 1000 + i }));
    }
    const page = db.getMessages('telegram-12345');
    expect(page.messages).toHaveLength(5);
  });
});

describe('HistoryDB.getMessages', () => {
  it('returns empty page for unknown chat', () => {
    const db = makeDb();
    const page = db.getMessages('telegram-unknown');
    expect(page.messages).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('paginates with cursor (before)', () => {
    const db = makeDb();
    const base = 1000000;
    for (let i = 0; i < 10; i++) {
      db.insertMessage(makeMsg({ content: `msg-${i}`, ts: base + i }));
    }
    // Get first page (5 most recent)
    const page1 = db.getMessages('telegram-12345', { limit: 5 });
    expect(page1.messages).toHaveLength(5);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    // Get next page using cursor
    const page2 = db.getMessages('telegram-12345', { limit: 5, before: page1.nextCursor! });
    expect(page2.messages).toHaveLength(5);
    expect(page2.hasMore).toBe(false);
  });

  it('filters by sessionId', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ sessionId: 'session-a', content: 'a' }));
    db.insertMessage(makeMsg({ sessionId: 'session-b', content: 'b' }));
    const page = db.getMessages('telegram-12345', { sessionId: 'session-a' });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.content).toBe('a');
  });

  it('returns messages for specific chatId only', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ chatId: 'telegram-12345' }));
    db.insertMessage(makeMsg({ chatId: 'discord-99999' }));
    const page = db.getMessages('telegram-12345');
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.chatId).toBe('telegram-12345');
  });
});

describe('HistoryDB.getMessages — order (asc/desc seek-forward)', () => {
  const CHAT = 'telegram-12345';
  const BASE = 1000000;

  function seed(db: HistoryDB, count = 10, overrides: Partial<HistoryMessage> = {}): void {
    for (let i = 0; i < count; i++) {
      db.insertMessage(makeMsg({ chatId: CHAT, content: `msg-${i}`, ts: BASE + i, ...overrides }));
    }
  }

  it('order="asc" returns oldest-first, strictly ascending', () => {
    const db = makeDb();
    seed(db, 10);
    const page = db.getMessages(CHAT, { order: 'asc' });
    expect(page.messages).toHaveLength(10);
    expect(page.messages[0]!.ts).toBe(BASE);
    for (let i = 1; i < page.messages.length; i++) {
      expect(page.messages[i]!.ts).toBeGreaterThan(page.messages[i - 1]!.ts);
    }
  });

  it('default order (omitted) is desc — newest-first, unchanged from today', () => {
    const db = makeDb();
    seed(db, 10);
    const page = db.getMessages(CHAT);
    expect(page.messages[0]!.ts).toBe(BASE + 9);
    for (let i = 1; i < page.messages.length; i++) {
      expect(page.messages[i]!.ts).toBeLessThan(page.messages[i - 1]!.ts);
    }
  });

  it('explicit order="desc" behaves identically to the default', () => {
    const db = makeDb();
    seed(db, 10);
    const implicit = db.getMessages(CHAT);
    const explicit = db.getMessages(CHAT, { order: 'desc' });
    expect(explicit.messages.map((m) => m.ts)).toEqual(implicit.messages.map((m) => m.ts));
  });

  it('asc + after bound excludes everything at or before the bound', () => {
    const db = makeDb();
    seed(db, 10); // ts BASE..BASE+9
    const page = db.getMessages(CHAT, { order: 'asc', after: BASE + 4 });
    expect(page.messages.map((m) => m.ts)).toEqual([BASE + 5, BASE + 6, BASE + 7, BASE + 8, BASE + 9]);
    expect(page.messages.every((m) => m.ts > BASE + 4)).toBe(true);
  });

  it('asc + hasMore is true and exactly `limit` rows are returned when more exist', () => {
    const db = makeDb();
    seed(db, 10);
    const page = db.getMessages(CHAT, { order: 'asc', limit: 3 });
    expect(page.messages).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((m) => m.ts)).toEqual([BASE, BASE + 1, BASE + 2]);
  });

  it('asc nextCursor continuation is contiguous — no gap, no overlap across pages', () => {
    const db = makeDb();
    seed(db, 10);
    const page1 = db.getMessages(CHAT, { order: 'asc', limit: 4 });
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(BASE + 3); // newest ts returned in this asc page

    const page2 = db.getMessages(CHAT, { order: 'asc', after: page1.nextCursor!, limit: 4 });
    const seen = [...page1.messages, ...page2.messages].map((m) => m.ts);
    expect(seen).toEqual([...new Set(seen)]); // no duplicates
    expect(page2.messages[0]!.ts).toBe(page1.messages[page1.messages.length - 1]!.ts + 1); // no gap
  });

  it('asc + before + after returns a bounded ascending window', () => {
    const db = makeDb();
    seed(db, 10); // ts BASE..BASE+9
    const page = db.getMessages(CHAT, { order: 'asc', after: BASE + 2, before: BASE + 7 });
    expect(page.messages.map((m) => m.ts)).toEqual([BASE + 3, BASE + 4, BASE + 5, BASE + 6]);
  });

  it('asc + after past the newest ts returns an empty page', () => {
    const db = makeDb();
    seed(db, 10);
    const page = db.getMessages(CHAT, { order: 'asc', after: BASE + 100 });
    expect(page.messages).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('asc on an unknown chat returns an empty page, not an error', () => {
    const db = makeDb();
    seed(db, 3);
    const page = db.getMessages('telegram-unknown', { order: 'asc' });
    expect(page.messages).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('asc composes with sessionId filtering', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ chatId: CHAT, sessionId: 'session-a', content: 'a1', ts: BASE }));
    db.insertMessage(makeMsg({ chatId: CHAT, sessionId: 'session-b', content: 'b1', ts: BASE + 1 }));
    db.insertMessage(makeMsg({ chatId: CHAT, sessionId: 'session-a', content: 'a2', ts: BASE + 2 }));
    const page = db.getMessages(CHAT, { order: 'asc', sessionId: 'session-a' });
    expect(page.messages.map((m) => m.content)).toEqual(['a1', 'a2']);
  });

  it('an arbitrary/garbage order value falls back to desc — never throws, never reaches SQL raw', () => {
    const db = makeDb();
    seed(db, 5);
    expect(() =>
      db.getMessages(CHAT, { order: 'sideways; DROP TABLE messages;--' as unknown as 'asc' | 'desc' })
    ).not.toThrow();
    const page = db.getMessages(CHAT, { order: 'sideways' as unknown as 'asc' | 'desc' });
    expect(page.messages[0]!.ts).toBe(BASE + 4); // newest-first, i.e. desc fallback
    // table must still exist / be intact after the "injection" attempt
    expect(db.getMessages(CHAT).messages).toHaveLength(5);
  });

  it('single-row result: asc and desc agree, hasMore false, nextCursor null', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ chatId: CHAT, ts: BASE }));
    const asc = db.getMessages(CHAT, { order: 'asc' });
    const desc = db.getMessages(CHAT, { order: 'desc' });
    expect(asc.messages).toHaveLength(1);
    expect(desc.messages).toHaveLength(1);
    expect(asc.hasMore).toBe(false);
    expect(asc.nextCursor).toBeNull();
  });

  it('rows sharing a ts get a deterministic id-tiebroken order (asc = insertion, desc = reverse)', () => {
    const db = makeDb();
    // three messages at the SAME ts, inserted in a known order
    db.insertMessage(makeMsg({ chatId: CHAT, content: 'first', ts: BASE }));
    db.insertMessage(makeMsg({ chatId: CHAT, content: 'second', ts: BASE }));
    db.insertMessage(makeMsg({ chatId: CHAT, content: 'third', ts: BASE }));
    expect(db.getMessages(CHAT, { order: 'asc' }).messages.map((m) => m.content))
      .toEqual(['first', 'second', 'third']);
    expect(db.getMessages(CHAT, { order: 'desc' }).messages.map((m) => m.content))
      .toEqual(['third', 'second', 'first']);
  });
});

describe('HistoryDB.getMessages — composite (ts,id) cursor (boundary skip)', () => {
  const CHAT = 'telegram-12345';

  // A run where three messages share ts=200, flanked by a lower and a higher ts.
  // Inserted a..e into an empty db => AUTOINCREMENT ids 1..5 in that order.
  // desc row order: e,d,c,b,a ; asc row order: a,b,c,d,e.
  function seedTie(db: HistoryDB): void {
    db.insertMessage(makeMsg({ chatId: CHAT, content: 'a', ts: 100 }));
    db.insertMessage(makeMsg({ chatId: CHAT, content: 'b', ts: 200 }));
    db.insertMessage(makeMsg({ chatId: CHAT, content: 'c', ts: 200 }));
    db.insertMessage(makeMsg({ chatId: CHAT, content: 'd', ts: 200 }));
    db.insertMessage(makeMsg({ chatId: CHAT, content: 'e', ts: 300 }));
  }

  // U-HDB-TIE-01 — documents the legacy skip the id component closes: a ts-only
  // continuation drops the not-yet-shown rows that share the boundary ts.
  it('desc: ts-only cursor (no id) still skips messages sharing the boundary ts', () => {
    const db = makeDb();
    seedTie(db);
    const page1 = db.getMessages(CHAT, { limit: 2 }); // desc => e(300), d(200)
    expect(page1.messages.map((m) => m.content)).toEqual(['e', 'd']);
    expect(page1.nextCursor).toBe(200);

    // ts-only continuation: WHERE ts < 200 => only 'a'; 'b' and 'c' (ts=200) vanish.
    const page2 = db.getMessages(CHAT, { limit: 2, before: page1.nextCursor! });
    expect(page2.messages.map((m) => m.content)).toEqual(['a']);
  });

  // U-HDB-TIE-02 — composite cursor pages desc across the tie with no skip, no dup.
  it('desc: composite (ts,id) cursor returns every message exactly once across the tie', () => {
    const db = makeDb();
    seedTie(db);
    const collected: string[] = [];
    let before: number | undefined;
    let beforeId: number | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = db.getMessages(CHAT, { limit: 2, before, beforeId });
      collected.push(...page.messages.map((m) => m.content));
      if (!page.hasMore) break;
      before = page.nextCursor!;
      beforeId = page.nextCursorId!;
    }
    expect(collected).toEqual(['e', 'd', 'c', 'b', 'a']); // full desc, in order
    expect(new Set(collected).size).toBe(5); // no duplicates
  });

  // U-HDB-TIE-03 — mirror for asc via after/afterId.
  it('asc: composite (ts,id) cursor returns every message exactly once across the tie', () => {
    const db = makeDb();
    seedTie(db);
    const collected: string[] = [];
    let after: number | undefined;
    let afterId: number | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = db.getMessages(CHAT, { order: 'asc', limit: 2, after, afterId });
      collected.push(...page.messages.map((m) => m.content));
      if (!page.hasMore) break;
      after = page.nextCursor!;
      afterId = page.nextCursorId!;
    }
    expect(collected).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(new Set(collected).size).toBe(5);
  });

  // U-HDB-TIE-04 — nextCursorId travels with nextCursor and is null on the final page.
  it('exposes nextCursorId alongside nextCursor, both null when there is no next page', () => {
    const db = makeDb();
    seedTie(db);
    const page1 = db.getMessages(CHAT, { limit: 2 });
    expect(page1.hasMore).toBe(true);
    expect(typeof page1.nextCursorId).toBe('number');

    const last = db.getMessages(CHAT, { limit: 100 });
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeNull();
    expect(last.nextCursorId).toBeNull();
  });

  // U-HDB-TIE-05 — an id component without its ts partner is inert (no accidental filter).
  it('beforeId is ignored when before is absent', () => {
    const db = makeDb();
    seedTie(db);
    const page = db.getMessages(CHAT, { limit: 100, beforeId: 3 });
    expect(page.messages).toHaveLength(5);
  });
});

describe('HistoryDB.listChats', () => {
  it('returns empty array when no messages', () => {
    const db = makeDb();
    expect(db.listChats()).toHaveLength(0);
  });

  it('returns one entry per distinct chatId', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ chatId: 'telegram-111' }));
    db.insertMessage(makeMsg({ chatId: 'discord-222' }));
    db.insertMessage(makeMsg({ chatId: 'telegram-111', content: 'second' }));
    const chats = db.listChats();
    expect(chats).toHaveLength(2);
    const chatIds = chats.map((c) => c.chatId).sort();
    expect(chatIds).toEqual(['discord-222', 'telegram-111']);
  });

  it('returns messageCount and lastMessagePreview', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ chatId: 'telegram-111', content: 'first', ts: 1000 }));
    db.insertMessage(makeMsg({ chatId: 'telegram-111', role: 'assistant', content: 'reply', ts: 2000 }));
    const chats = db.listChats();
    const chat = chats.find((c) => c.chatId === 'telegram-111');
    expect(chat).toBeDefined();
    expect(chat!.messageCount).toBe(2);
    expect(chat!.lastMessagePreview).toBe('reply');
  });
});

describe('HistoryDB.clearChat', () => {
  it('removes all messages for a chatId', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ chatId: 'telegram-12345', content: 'a' }));
    db.insertMessage(makeMsg({ chatId: 'telegram-12345', content: 'b' }));
    db.insertMessage(makeMsg({ chatId: 'discord-999', content: 'c' }));

    db.clearChat('telegram-12345');

    const page = db.getMessages('telegram-12345');
    expect(page.messages).toHaveLength(0);
    // Other chat unaffected
    const discordPage = db.getMessages('discord-999');
    expect(discordPage.messages).toHaveLength(1);
  });
});

describe('HistoryDB.searchMessages', () => {
  it('returns empty result for empty query', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ content: 'hello world' }));
    const result = db.searchMessages('telegram-12345', '');
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('finds messages matching query', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ content: 'hello world testing', ts: 1000 }));
    db.insertMessage(makeMsg({ content: 'unrelated content here', ts: 2000 }));
    const result = db.searchMessages('telegram-12345', 'hello');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.content).toContain('hello');
  });

  it('returns no results for nonexistent term', () => {
    const db = makeDb();
    db.insertMessage(makeMsg({ content: 'hello world' }));
    const result = db.searchMessages('telegram-12345', 'xyznonexistent');
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('limits results', () => {
    const db = makeDb();
    for (let i = 0; i < 10; i++) {
      db.insertMessage(makeMsg({ content: `searchterm message ${i}`, ts: 1000 + i }));
    }
    const result = db.searchMessages('telegram-12345', 'searchterm', { limit: 3 });
    expect(result.results).toHaveLength(3);
    expect(result.total).toBe(10);
    expect(result.hasMore).toBe(true);
  });
});

describe('HistoryDB.getMessages — MAX_HISTORY_LIMIT ceiling (#1798)', () => {
  const CHAT = 'telegram-12345';

  function seed(db: HistoryDB, n: number): void {
    for (let i = 0; i < n; i++) {
      db.insertMessage(makeMsg({ chatId: CHAT, content: `msg-${i}`, ts: 1_000 + i }));
    }
  }

  it('exports MAX_HISTORY_LIMIT as 1000', () => {
    expect(MAX_HISTORY_LIMIT).toBe(1000);
  });

  it('returns more than 200 rows in a single call when limit exceeds the old cap', () => {
    // AC-2: a large single-call span. 300 > the previous 200 ceiling.
    const db = makeDb();
    seed(db, 300);
    const page = db.getMessages(CHAT, { limit: 1000 });
    expect(page.messages.length).toBe(300);
    expect(page.messages.length).toBeGreaterThan(200);
    expect(page.hasMore).toBe(false);
  });

  it('leaves the default page size unchanged at 50 when no limit is passed', () => {
    // AC-3: clients that do not request a large limit are unaffected.
    const db = makeDb();
    seed(db, 300);
    const page = db.getMessages(CHAT);
    expect(page.messages).toHaveLength(50);
    expect(page.hasMore).toBe(true);
  });

  it('clamps a request above the ceiling to MAX_HISTORY_LIMIT and reports hasMore', () => {
    // 1001 rows, client asks for far more than the ceiling: return exactly 1000 + hasMore.
    const db = makeDb();
    seed(db, MAX_HISTORY_LIMIT + 1);
    const page = db.getMessages(CHAT, { limit: 5000 });
    expect(page.messages).toHaveLength(MAX_HISTORY_LIMIT);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it('returns exactly the ceiling with hasMore false when total equals MAX_HISTORY_LIMIT', () => {
    // hasMore boundary: limit+1 fetch sees no extra row, so hasMore is false.
    const db = makeDb();
    seed(db, MAX_HISTORY_LIMIT);
    const page = db.getMessages(CHAT, { limit: MAX_HISTORY_LIMIT });
    expect(page.messages).toHaveLength(MAX_HISTORY_LIMIT);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe('HistoryDB.getMessages — limit input validation: good & bad cases (#1798)', () => {
  const CHAT = 'telegram-12345';

  function seed(db: HistoryDB, n: number): void {
    for (let i = 0; i < n; i++) {
      db.insertMessage(makeMsg({ chatId: CHAT, content: `msg-${i}`, ts: 1_000 + i }));
    }
  }

  // ── good: interior values across the range ────────────────────────────
  it('good: a mid-range limit (500) between DEFAULT and MAX_HISTORY_LIMIT returns exactly that many', () => {
    const db = makeDb();
    seed(db, 700);
    const page = db.getMessages(CHAT, { limit: 500 });
    expect(page.messages).toHaveLength(500);
    expect(page.hasMore).toBe(true);
  });

  it('good: a below-default limit (10) is honored as-is, not bumped to DEFAULT_LIMIT', () => {
    const db = makeDb();
    seed(db, 100);
    const page = db.getMessages(CHAT, { limit: 10 });
    expect(page.messages).toHaveLength(10);
    expect(page.hasMore).toBe(true);
  });

  it('good: an unknown chatId with an explicit large limit returns an empty page, not an error', () => {
    const db = makeDb();
    seed(db, 5); // seeded under a different chat below
    const page = db.getMessages('no-such-chat', { limit: MAX_HISTORY_LIMIT });
    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  // ── bad: values a well-behaved caller should never send, but the layer must survive ──
  it('bad: limit=0 returns an empty page rather than falling back to DEFAULT_LIMIT', () => {
    // Documents current behavior: 0 is a valid (if useless) explicit limit, distinct from
    // "no limit passed". A caller that means "give me the default" must omit the field.
    const db = makeDb();
    seed(db, 10);
    const page = db.getMessages(CHAT, { limit: 0 });
    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(true);
  });

  it('bad: a negative limit must never bypass MAX_HISTORY_LIMIT and return the whole table', () => {
    // SQLite treats "LIMIT -1" as "no limit at all" — a negative value handed straight
    // through Math.min(opts.limit, MAX_LIMIT) (Math.min keeps the negative number, since
    // it's still the smaller of the two) reaches the SQL layer unclamped. Seed well past
    // the ceiling so an unbounded leak is unambiguous versus a correctly-clamped result.
    const db = makeDb();
    seed(db, MAX_HISTORY_LIMIT + 50);
    const page = db.getMessages(CHAT, { limit: -1 });
    expect(page.messages.length).toBeLessThanOrEqual(MAX_HISTORY_LIMIT);
  });

  it('bad: a large negative limit must not return more rows than exist, unbounded', () => {
    // limit=-1000 makes the internal `limit + 1` fetch bound itself negative (-999), which
    // is where SQLite's "negative LIMIT means no limit at all" semantics would actually
    // engage (limit=-1 above collapses to a LIMIT of 0 and never reaches this path).
    // Seed well past the ceiling so a genuine unbounded leak is unambiguous.
    const db = makeDb();
    seed(db, MAX_HISTORY_LIMIT + 200);
    const page = db.getMessages(CHAT, { limit: -1000 });
    expect(page.messages.length).toBeLessThanOrEqual(MAX_HISTORY_LIMIT);
  });

  it('bad: NaN limit must not crash the query and must not exceed MAX_HISTORY_LIMIT', () => {
    const db = makeDb();
    seed(db, 300);
    expect(() => db.getMessages(CHAT, { limit: NaN })).not.toThrow();
    const page = db.getMessages(CHAT, { limit: NaN });
    expect(page.messages.length).toBeLessThanOrEqual(MAX_HISTORY_LIMIT);
  });

  it('bad: a fractional limit does not crash and stays within bounds', () => {
    const db = makeDb();
    seed(db, 100);
    expect(() => db.getMessages(CHAT, { limit: 50.7 })).not.toThrow();
    const page = db.getMessages(CHAT, { limit: 50.7 });
    expect(page.messages.length).toBeLessThanOrEqual(100);
  });

  it('bad: Number.MAX_SAFE_INTEGER as limit is clamped to MAX_HISTORY_LIMIT, not passed through raw', () => {
    const db = makeDb();
    seed(db, 300);
    const page = db.getMessages(CHAT, { limit: Number.MAX_SAFE_INTEGER });
    expect(page.messages).toHaveLength(300);
    expect(page.messages.length).toBeLessThanOrEqual(MAX_HISTORY_LIMIT);
  });

  it('bad: Infinity as limit does not crash and stays within bounds', () => {
    const db = makeDb();
    seed(db, 300);
    expect(() => db.getMessages(CHAT, { limit: Infinity })).not.toThrow();
    const page = db.getMessages(CHAT, { limit: Infinity });
    expect(page.messages.length).toBeLessThanOrEqual(MAX_HISTORY_LIMIT);
  });
});
