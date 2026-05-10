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
