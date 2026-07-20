import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../src/history/db';
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
