import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../../src/session-store';
import { Message } from '../../src/types';

function makeMsg(role: 'user' | 'assistant', content: string): Message {
  return { role, content, ts: Date.now() };
}

describe('session-store', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-'));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // U-SS-01: DM session key
  // -------------------------------------------------------------------------
  it('U-SS-01: generates correct DM session key', () => {
    const key = store.resolveKey('alfred', '991177022');
    expect(key).toBe('agent:alfred:telegram:991177022');
  });

  // -------------------------------------------------------------------------
  // U-SS-02: Group session key
  // -------------------------------------------------------------------------
  it('U-SS-02: generates correct group session key', () => {
    const key = store.resolveKey('baerbel', '-1001234567890');
    expect(key).toBe('agent:baerbel:telegram:-1001234567890');
  });

  // -------------------------------------------------------------------------
  // U-SS-03: Different agents, same chat ID → different keys
  // -------------------------------------------------------------------------
  it('U-SS-03: different agents with same chatId produce different keys', () => {
    const keyA = store.resolveKey('alfred', '123');
    const keyB = store.resolveKey('baerbel', '123');
    expect(keyA).not.toBe(keyB);
  });

  // -------------------------------------------------------------------------
  // U-SS-04: Session file path resolution
  // -------------------------------------------------------------------------
  it('U-SS-04: session file is stored under <agentsBaseDir>/<agentId>/sessions/<chatId>.jsonl', async () => {
    await store.appendMessage('alfred', '991177022', makeMsg('user', 'hello'));
    const expectedPath = path.join(tmpDir, 'alfred', 'sessions', '991177022.jsonl');
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // U-SS-05: New session created (no file → empty array)
  // -------------------------------------------------------------------------
  it('U-SS-05: returns empty array for a new (non-existent) session', async () => {
    const messages = await store.loadSession('alfred', 'newchat');
    expect(messages).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // U-SS-06: Existing session loaded
  // -------------------------------------------------------------------------
  it('U-SS-06: loads an existing session with messages', async () => {
    const msgs = [
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi there'),
      makeMsg('user', 'how are you?'),
      makeMsg('assistant', 'fine'),
      makeMsg('user', 'bye'),
    ];
    for (const msg of msgs) {
      await store.appendMessage('alfred', 'chat1', msg);
    }

    const loaded = await store.loadSession('alfred', 'chat1');
    expect(loaded).toHaveLength(5);
    expect(loaded[0].content).toBe('hello');
    expect(loaded[4].content).toBe('bye');
  });

  // -------------------------------------------------------------------------
  // U-SS-07: Session append (not overwrite)
  // -------------------------------------------------------------------------
  it('U-SS-07: appending a message does not overwrite existing messages', async () => {
    await store.appendMessage('alfred', 'chat1', makeMsg('user', 'first'));
    await store.appendMessage('alfred', 'chat1', makeMsg('assistant', 'second'));

    const loaded = await store.loadSession('alfred', 'chat1');
    expect(loaded).toHaveLength(2);
    expect(loaded[0].content).toBe('first');
    expect(loaded[1].content).toBe('second');
  });

  // -------------------------------------------------------------------------
  // U-SS-08: Concurrent writes — both messages persisted (no data loss)
  // -------------------------------------------------------------------------
  it('U-SS-08: concurrent writes are serialized — both messages persisted', async () => {
    const writes = [
      store.appendMessage('alfred', 'chat1', makeMsg('user', 'msg-1')),
      store.appendMessage('alfred', 'chat1', makeMsg('user', 'msg-2')),
    ];
    await Promise.all(writes);

    const loaded = await store.loadSession('alfred', 'chat1');
    expect(loaded).toHaveLength(2);
    const contents = loaded.map((m) => m.content).sort();
    expect(contents).toEqual(['msg-1', 'msg-2']);
  });

  // -------------------------------------------------------------------------
  // U-SS-09: Corrupted session file → reset to empty
  // -------------------------------------------------------------------------
  it('U-SS-09: resets session when .jsonl contains a corrupted line', async () => {
    const sessionDir = path.join(tmpDir, 'alfred', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, 'corrupt.jsonl');
    // Write two lines: one valid, one corrupted
    fs.writeFileSync(sessionFile, '{"role":"user","content":"good","ts":1}\nBAD JSON LINE\n');

    const loaded = await store.loadSession('alfred', 'corrupt');
    expect(loaded).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // resetSession
  // -------------------------------------------------------------------------
  it('resetSession empties the session file', async () => {
    await store.appendMessage('alfred', 'chat1', makeMsg('user', 'hello'));
    await store.resetSession('alfred', 'chat1');

    const loaded = await store.loadSession('alfred', 'chat1');
    expect(loaded).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // pruneOldSessions
  // -------------------------------------------------------------------------
  it('pruneOldSessions deletes files older than maxAgeDays', async () => {
    const sessionDir = path.join(tmpDir, 'alfred', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Create a file and backdate its mtime to 10 days ago
    const oldFile = path.join(sessionDir, 'old-chat.jsonl');
    fs.writeFileSync(oldFile, '{"role":"user","content":"old","ts":1}\n');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    // Create a fresh file
    const newFile = path.join(sessionDir, 'new-chat.jsonl');
    fs.writeFileSync(newFile, '{"role":"user","content":"new","ts":2}\n');

    const deleted = await store.pruneOldSessions('alfred', 7);
    expect(deleted).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  it('pruneOldSessions returns 0 when sessions dir does not exist', async () => {
    const deleted = await store.pruneOldSessions('nonexistent-agent', 7);
    expect(deleted).toBe(0);
  });

  // Cross-agent isolation
  it('cross-agent isolation: different agents have separate session files', async () => {
    await store.appendMessage('alfred', '123', makeMsg('user', 'alfred message'));
    await store.appendMessage('baerbel', '123', makeMsg('user', 'baerbel message'));

    const alfredMsgs = await store.loadSession('alfred', '123');
    const baerbelMsgs = await store.loadSession('baerbel', '123');

    expect(alfredMsgs[0].content).toBe('alfred message');
    expect(baerbelMsgs[0].content).toBe('baerbel message');
  });

  // ─── Multi-session Telegram support ──────────────────────────────────────────

  // -------------------------------------------------------------------------
  // U1: listSessions returns all 3 sessions with correct activeSessionId
  // -------------------------------------------------------------------------
  it('U1: listSessions returns all 3 sessions with correct activeSessionId', async () => {
    // Initialise the index (creates Session 1)
    const index0 = await store.getOrCreateIndex('test-agent', '123456');
    // Create two more sessions
    await store.createTelegramSession('test-agent', '123456', 'Session 2');
    await store.createTelegramSession('test-agent', '123456', 'Session 3');

    const index = await store.listSessions('test-agent', '123456');
    expect(index.sessions).toHaveLength(3);
    expect(index.sessions.map(s => s.name)).toEqual(['Session 1', 'Session 2', 'Session 3']);
    // activeSessionId must be the first one created
    expect(index.activeSessionId).toBe(index0.activeSessionId);
  });

  // -------------------------------------------------------------------------
  // U2: setActiveSession switches active, verified by getActiveSessionId
  // -------------------------------------------------------------------------
  it('U2: setActiveSession switches active session', async () => {
    await store.getOrCreateIndex('test-agent', '123456');
    const s2 = await store.createTelegramSession('test-agent', '123456', 'Session 2');

    await store.setActiveSession('test-agent', '123456', s2.id);

    const activeId = await store.getActiveSessionId('test-agent', '123456');
    expect(activeId).toBe(s2.id);
  });

  // -------------------------------------------------------------------------
  // U3: deleteSession removes file and index entry; cannot delete last session
  // -------------------------------------------------------------------------
  it('U3: deleteTelegramSession removes file and index entry', async () => {
    const index = await store.getOrCreateIndex('test-agent', '123456');
    const s1Id = index.activeSessionId;
    const s2 = await store.createTelegramSession('test-agent', '123456', 'Session 2');

    await store.deleteTelegramSession('test-agent', '123456', s2.id);

    const updated = await store.listSessions('test-agent', '123456');
    expect(updated.sessions).toHaveLength(1);
    expect(updated.sessions[0].id).toBe(s1Id);

    // Session file should be gone
    const sessionDir = path.join(tmpDir, 'test-agent', 'sessions', 'telegram-123456');
    const sessionFile = path.join(sessionDir, `${s2.id}.json`);
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it('U3b: deleteTelegramSession throws when only one session remains', async () => {
    await store.getOrCreateIndex('test-agent', '123456');
    const index = await store.listSessions('test-agent', '123456');
    const onlyId = index.sessions[0].id;

    await expect(
      store.deleteTelegramSession('test-agent', '123456', onlyId),
    ).rejects.toThrow('Cannot delete the last session');
  });

  // -------------------------------------------------------------------------
  // U4: Migration — existing flat {chatId}.jsonl auto-migrates to new layout
  // -------------------------------------------------------------------------
  it('U4: existing flat .jsonl file auto-migrates to new multi-session layout', async () => {
    // Write an old-style flat JSONL file
    const sessionsDir = path.join(tmpDir, 'test-agent', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const oldFile = path.join(sessionsDir, 'migrate-chat.jsonl');
    const msg1 = makeMsg('user', 'old message 1');
    const msg2 = makeMsg('assistant', 'old reply');
    fs.writeFileSync(oldFile, JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n');

    // getOrCreateIndex should detect the old file and migrate it
    const index = await store.getOrCreateIndex('test-agent', 'migrate-chat');

    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0].name).toBe('Session 1');
    expect(index.sessions[0].messageCount).toBe(2);

    // Old JSONL file should be gone
    expect(fs.existsSync(oldFile)).toBe(false);

    // New session file should contain the migrated messages
    const messages = await store.loadTelegramSession('test-agent', 'migrate-chat', index.activeSessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('old message 1');
    expect(messages[1].content).toBe('old reply');
  });

  // -------------------------------------------------------------------------
  // U5: clearTelegramSessionHistory resets messages to [] but keeps SessionMeta
  // -------------------------------------------------------------------------
  it('U5: clearTelegramSessionHistory resets messages to [] but preserves SessionMeta', async () => {
    const index = await store.getOrCreateIndex('test-agent', '123456');
    const sessionId = index.activeSessionId;

    // Append some messages
    await store.appendTelegramMessage('test-agent', '123456', sessionId, makeMsg('user', 'hello'));
    await store.appendTelegramMessage('test-agent', '123456', sessionId, makeMsg('assistant', 'hi'));

    // Verify messages exist
    const before = await store.loadTelegramSession('test-agent', '123456', sessionId);
    expect(before).toHaveLength(2);

    // Clear history
    await store.clearTelegramSessionHistory('test-agent', '123456', sessionId);

    // Messages should be empty
    const after = await store.loadTelegramSession('test-agent', '123456', sessionId);
    expect(after).toEqual([]);

    // Meta should still exist with messageCount reset
    const updatedIndex = await store.listSessions('test-agent', '123456');
    const meta = updatedIndex.sessions.find(s => s.id === sessionId);
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('Session 1');
    expect(meta!.messageCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // U6: createTelegramSession auto-names "Session 1", "Session 2", etc.
  // -------------------------------------------------------------------------
  it('U6: createTelegramSession auto-names sessions sequentially', async () => {
    // First getOrCreateIndex creates "Session 1"
    const index0 = await store.getOrCreateIndex('test-agent', '123456');
    expect(index0.sessions[0].name).toBe('Session 1');

    // Explicitly creating further sessions
    const s2 = await store.createTelegramSession('test-agent', '123456');
    expect(s2.name).toBe('Session 2');

    const s3 = await store.createTelegramSession('test-agent', '123456');
    expect(s3.name).toBe('Session 3');
  });

  it('U6b: createTelegramSession uses provided name when given', async () => {
    await store.getOrCreateIndex('test-agent', '123456');
    const s = await store.createTelegramSession('test-agent', '123456', 'My Custom Session');
    expect(s.name).toBe('My Custom Session');
  });

  // -------------------------------------------------------------------------
  // U7: appendTelegramMessage and loadTelegramSession round-trip
  // -------------------------------------------------------------------------
  it('U7: appendTelegramMessage and loadTelegramSession round-trip correctly', async () => {
    const index = await store.getOrCreateIndex('test-agent', '123456');
    const sessionId = index.activeSessionId;

    const msg1 = makeMsg('user', 'ping');
    const msg2 = makeMsg('assistant', 'pong');
    const msg3 = makeMsg('user', 'again');

    await store.appendTelegramMessage('test-agent', '123456', sessionId, msg1);
    await store.appendTelegramMessage('test-agent', '123456', sessionId, msg2);
    await store.appendTelegramMessage('test-agent', '123456', sessionId, msg3);

    const loaded = await store.loadTelegramSession('test-agent', '123456', sessionId);
    expect(loaded).toHaveLength(3);
    expect(loaded[0].content).toBe('ping');
    expect(loaded[1].content).toBe('pong');
    expect(loaded[2].content).toBe('again');
    expect(loaded[0].role).toBe('user');
    expect(loaded[1].role).toBe('assistant');

    // messageCount in index should be updated
    const updatedIndex = await store.listSessions('test-agent', '123456');
    const meta = updatedIndex.sessions.find(s => s.id === sessionId);
    expect(meta!.messageCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // U8: updateSessionMeta updates fields without affecting other fields
  // -------------------------------------------------------------------------
  it('U8: updateSessionMeta updates specified fields without affecting other fields', async () => {
    const index = await store.getOrCreateIndex('test-agent', '123456');
    const sessionId = index.activeSessionId;
    const originalCreatedAt = index.sessions[0].createdAt;

    // Update name and totalTokensUsed
    await store.updateSessionMeta('test-agent', '123456', sessionId, {
      name: 'Renamed Session',
      totalTokensUsed: 5000,
    });

    const updated = await store.listSessions('test-agent', '123456');
    const meta = updated.sessions.find(s => s.id === sessionId);
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('Renamed Session');
    expect(meta!.totalTokensUsed).toBe(5000);

    // Other fields should be unchanged
    expect(meta!.id).toBe(sessionId);
    expect(meta!.createdAt).toBe(originalCreatedAt);
    expect(meta!.messageCount).toBe(0);
  });
});
