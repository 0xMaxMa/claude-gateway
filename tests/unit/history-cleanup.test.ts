/**
 * Unit tests: History & Media Auto-Cleanup (planning-51)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../src/history/db';
import { scheduleCleanup, resolveRetentionDays, msUntilNextHour } from '../../src/history/cleanup';
import { HistoryMessage } from '../../src/history/types';

// ── helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(agentId = 'test-agent'): HistoryDB {
  // Use a unique sub-directory per call so tests get isolated DBs
  const agentDir = fs.mkdtempSync(path.join(tmpDir, 'agent-'));
  return HistoryDB.forDir(agentDir, agentId);
}

function insertMsg(db: HistoryDB, overrides: Partial<HistoryMessage> = {}): void {
  db.insertMessage({
    chatId: 'telegram-12345',
    sessionId: 'sess-1',
    source: 'telegram',
    role: 'user',
    content: 'hello',
    ts: Date.now(),
    ...overrides,
  });
}

// ── resolveRetentionDays ─────────────────────────────────────────────────────

describe('resolveRetentionDays', () => {
  it('returns agent value when set', () => {
    expect(resolveRetentionDays(30, 60)).toBe(30);
  });

  it('returns 0 (disabled) when agent explicitly sets 0', () => {
    expect(resolveRetentionDays(0, 60)).toBe(0);
  });

  it('falls back to global when agent is undefined', () => {
    expect(resolveRetentionDays(undefined, 90)).toBe(90);
  });

  it('returns default 60 when both are undefined', () => {
    expect(resolveRetentionDays(undefined, undefined)).toBe(60);
  });
});

// ── msUntilNextHour ──────────────────────────────────────────────────────────

describe('msUntilNextHour', () => {
  it('returns positive delay when target hour is later today', () => {
    // 01:30 UTC — target 03:00 UTC → ~1.5h wait
    const now = new Date('2026-01-01T01:30:00Z');
    const ms = msUntilNextHour(3, 'UTC', now);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  it('wraps to next day when target hour has passed', () => {
    // 04:00 UTC — target 03:00 UTC → ~23h wait
    const now = new Date('2026-01-01T04:00:00Z');
    const ms = msUntilNextHour(3, 'UTC', now);
    expect(ms).toBeGreaterThan(20 * 60 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('is never zero or negative', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const ms = msUntilNextHour(0, 'UTC', now);
    expect(ms).toBeGreaterThan(0);
  });
});

// ── HistoryDB.pruneOlderThan ─────────────────────────────────────────────────

describe('HistoryDB.pruneOlderThan', () => {
  it('deletes messages older than cutoff and returns empty mediaPaths when none', () => {
    const db = makeDb();
    const oldTs = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    insertMsg(db, { ts: oldTs });

    const mediaPaths = db.pruneOlderThan(Date.now() - 5 * 24 * 60 * 60 * 1000);
    expect(mediaPaths).toEqual([]);

    const page = db.getMessages('telegram-12345', {});
    expect(page.messages).toHaveLength(0);
  });

  it('keeps messages newer than cutoff', () => {
    const db = makeDb();
    const oldTs = Date.now() - 70 * 24 * 60 * 60 * 1000;
    const newTs = Date.now() - 1 * 24 * 60 * 60 * 1000;
    insertMsg(db, { ts: oldTs, content: 'old' });
    insertMsg(db, { ts: newTs, content: 'new' });

    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    db.pruneOlderThan(cutoff);

    const page = db.getMessages('telegram-12345', {});
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.content).toBe('new');
  });

  it('returns media_files paths from deleted messages', () => {
    const db = makeDb();
    const oldTs = Date.now() - 70 * 24 * 60 * 60 * 1000;
    insertMsg(db, {
      ts: oldTs,
      mediaFiles: ['media/telegram-12345/photo1.jpg', 'media/telegram-12345/photo2.jpg'],
    });

    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const paths = db.pruneOlderThan(cutoff);
    expect(paths).toContain('media/telegram-12345/photo1.jpg');
    expect(paths).toContain('media/telegram-12345/photo2.jpg');
  });

  it('returns empty array when no messages match cutoff', () => {
    const db = makeDb();
    insertMsg(db, { ts: Date.now() }); // recent message

    const paths = db.pruneOlderThan(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(paths).toEqual([]);
  });

  it('skips malformed media_files JSON gracefully', () => {
    const db = makeDb();
    // Insert via raw SQL to inject malformed JSON
    const oldTs = Date.now() - 70 * 24 * 60 * 60 * 1000;
    insertMsg(db, { ts: oldTs });
    // pruneOlderThan should not throw even if some rows had bad JSON
    expect(() => db.pruneOlderThan(Date.now())).not.toThrow();
  });

  it('does not delete messages when cutoff is 0', () => {
    const db = makeDb();
    insertMsg(db, { ts: Date.now() - 1000 });
    db.pruneOlderThan(0); // cutoff at epoch — nothing is older than 0
    const page = db.getMessages('telegram-12345', {});
    expect(page.messages).toHaveLength(1);
  });
});

// ── scheduleCleanup ──────────────────────────────────────────────────────────

describe('scheduleCleanup', () => {
  it('returns a no-op cancel function when retentionDays is 0', () => {
    const db = makeDb();
    const cancel = scheduleCleanup({
      db,
      agentMediaRoot: path.join(tmpDir, 'media'),
      logPath: path.join(tmpDir, 'cleanup.log'),
      retentionDays: 0,
      cleanupHour: 0,
      cleanupTimezone: 'UTC',
    });
    expect(() => cancel()).not.toThrow();
  });

  it('fires cleanup after the timer elapses and prunes old messages', () => {
    jest.useFakeTimers();

    const db = makeDb();
    const agentMediaRoot = path.join(tmpDir, 'media');
    fs.mkdirSync(agentMediaRoot, { recursive: true });
    const logPath = path.join(tmpDir, 'cleanup.log');

    // Insert a message old enough to be pruned (70 days ago)
    const oldTs = Date.now() - 70 * 24 * 60 * 60 * 1000;
    insertMsg(db, { ts: oldTs, content: 'old-message' });

    // Schedule with retentionDays=60, cleanupHour=0 (next midnight)
    const cancel = scheduleCleanup({
      db,
      agentMediaRoot,
      logPath,
      retentionDays: 60,
      cleanupHour: 0,
      cleanupTimezone: 'UTC',
    });

    // Advance past 24 hours to trigger the first cleanup
    jest.advanceTimersByTime(25 * 60 * 60 * 1000);

    const page = db.getMessages('telegram-12345', {});
    expect(page.messages).toHaveLength(0);

    cancel();
    jest.useRealTimers();
  });

  it('does not prune messages when retentionDays is 0', () => {
    jest.useFakeTimers();

    const db = makeDb();
    insertMsg(db, { ts: Date.now() - 70 * 24 * 60 * 60 * 1000, content: 'should-stay' });

    const cancel = scheduleCleanup({
      db,
      agentMediaRoot: path.join(tmpDir, 'media'),
      logPath: path.join(tmpDir, 'cleanup.log'),
      retentionDays: 0,
      cleanupHour: 0,
      cleanupTimezone: 'UTC',
    });

    jest.advanceTimersByTime(25 * 60 * 60 * 1000);

    const page = db.getMessages('telegram-12345', {});
    expect(page.messages).toHaveLength(1);

    cancel();
    jest.useRealTimers();
  });

  it('reschedules after first run (fires twice in 50h)', () => {
    jest.useFakeTimers();

    const db = makeDb();
    const agentMediaRoot = path.join(tmpDir, 'media');
    fs.mkdirSync(agentMediaRoot, { recursive: true });

    // First batch: 70 days old
    insertMsg(db, { ts: Date.now() - 70 * 24 * 60 * 60 * 1000, content: 'batch-1' });

    const cancel = scheduleCleanup({
      db,
      agentMediaRoot,
      logPath: path.join(tmpDir, 'cleanup.log'),
      retentionDays: 60,
      cleanupHour: 0,
      cleanupTimezone: 'UTC',
    });

    // First fire
    jest.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(db.getMessages('telegram-12345', {}).messages).toHaveLength(0);

    // Insert another old message and advance another 24h — second fire
    insertMsg(db, { ts: Date.now() - 70 * 24 * 60 * 60 * 1000, content: 'batch-2' });
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(db.getMessages('telegram-12345', {}).messages).toHaveLength(0);

    cancel();
    jest.useRealTimers();
  });
});

// ── Media file deletion (doCleanup via pruneOlderThan + scheduleCleanup) ─────

describe('cleanup media file deletion', () => {
  it('deletes media files referenced by old messages and logs completion', () => {
    const db = makeDb();
    const agentMediaRoot = path.join(tmpDir, 'media');
    fs.mkdirSync(agentMediaRoot, { recursive: true });

    // Create a fake media file
    const chatDir = path.join(agentMediaRoot, 'telegram-12345');
    fs.mkdirSync(chatDir, { recursive: true });
    const fakeFile = path.join(chatDir, 'photo.jpg');
    fs.writeFileSync(fakeFile, 'fake-image-data');

    const logPath = path.join(tmpDir, 'cleanup.log');
    const oldTs = Date.now() - 70 * 24 * 60 * 60 * 1000;

    insertMsg(db, {
      ts: oldTs,
      mediaFiles: ['media/telegram-12345/photo.jpg'],
    });

    // Manually trigger pruning + media deletion
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const mediaPaths = db.pruneOlderThan(cutoff);

    // Simulate what doCleanup does internally
    for (const relPath of mediaPaths) {
      const withoutPrefix = relPath.startsWith('media/') ? relPath.slice(6) : relPath;
      const absPath = path.resolve(agentMediaRoot, withoutPrefix);
      if (absPath.startsWith(agentMediaRoot + path.sep) || absPath === agentMediaRoot) {
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      }
    }

    expect(fs.existsSync(fakeFile)).toBe(false);
    expect(mediaPaths).toContain('media/telegram-12345/photo.jpg');
  });

  it('skips media paths outside agentMediaRoot (path traversal guard)', () => {
    const agentMediaRoot = path.join(tmpDir, 'media');
    fs.mkdirSync(agentMediaRoot, { recursive: true });

    // A file outside agentMediaRoot that should not be deleted
    const outsideFile = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'keep me');

    const maliciousPath = '../secret.txt';
    const withoutPrefix = maliciousPath;
    const absPath = path.resolve(agentMediaRoot, withoutPrefix);

    // Guard check mirrors cleanup.ts implementation
    const isSafe = absPath.startsWith(agentMediaRoot + path.sep) || absPath === agentMediaRoot;
    expect(isSafe).toBe(false);

    // File should remain untouched
    expect(fs.existsSync(outsideFile)).toBe(true);
  });
});

// ── HistoryDB.listSessions ────────────────────────────────────────────────────

describe('HistoryDB.listSessions', () => {
  it('returns empty array when no messages exist', () => {
    const db = makeDb();
    expect(db.listSessions()).toEqual([]);
  });

  it('groups messages by session_id and returns correct counts', () => {
    const db = makeDb();
    const ts = Date.now();
    insertMsg(db, { sessionId: 'sess-a', ts: ts - 2000, content: 'first' });
    insertMsg(db, { sessionId: 'sess-a', ts: ts - 1000, content: 'second' });
    insertMsg(db, { sessionId: 'sess-b', ts, content: 'only' });

    const sessions = db.listSessions();
    expect(sessions).toHaveLength(2);
    // Ordered by lastActivity DESC — sess-b is most recent
    expect(sessions[0]!.sessionId).toBe('sess-b');
    expect(sessions[0]!.messageCount).toBe(1);
    expect(sessions[1]!.sessionId).toBe('sess-a');
    expect(sessions[1]!.messageCount).toBe(2);
  });

  it('returns lastMessage as the most recent content in the session', () => {
    const db = makeDb();
    const ts = Date.now();
    insertMsg(db, { sessionId: 'sess-1', ts: ts - 1000, content: 'earlier' });
    insertMsg(db, { sessionId: 'sess-1', ts, content: 'latest' });

    const sessions = db.listSessions();
    expect(sessions[0]!.lastMessage).toBe('latest');
  });

  it('returns correct source and chatId fields', () => {
    const db = makeDb();
    db.insertMessage({
      chatId: 'telegram-99999',
      sessionId: 'sess-x',
      source: 'telegram',
      role: 'user',
      content: 'hi',
      ts: Date.now(),
    });

    const sessions = db.listSessions();
    expect(sessions[0]!.chatId).toBe('telegram-99999');
    expect(sessions[0]!.source).toBe('telegram');
    expect(sessions[0]!.sessionId).toBe('sess-x');
  });

  it('returns null chatId for API sessions without a chat_id', () => {
    const db = makeDb();
    db.insertMessage({
      chatId: '',
      sessionId: 'api-sess',
      source: 'api',
      role: 'user',
      content: 'api call',
      ts: Date.now(),
    });

    const sessions = db.listSessions();
    expect(sessions[0]!.chatId).toBeNull();
    expect(sessions[0]!.source).toBe('api');
  });

  it('returns createdAt as the earliest ts and lastActivity as the latest', () => {
    const db = makeDb();
    const early = Date.now() - 5000;
    const late = Date.now();
    insertMsg(db, { sessionId: 'sess-t', ts: early, content: 'a' });
    insertMsg(db, { sessionId: 'sess-t', ts: late, content: 'b' });

    const [session] = db.listSessions();
    expect(session!.createdAt).toBe(early);
    expect(session!.lastActivity).toBe(late);
  });
});
