import * as path from 'path';
import * as fs from 'fs';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  ChatSummary,
  HistoryMessage,
  HistorySource,
  MessagePage,
  MessageRole,
  PaginationOpts,
  SearchOpts,
  SearchPage,
  SearchResult,
  SessionSummary,
} from './types';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const PREVIEW_LENGTH = 120;

// Singleton cache: one DB per (agentsBaseDir + agentId)
const cache = new Map<string, HistoryDB>();

export class HistoryDB {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly agentId: string;

  private constructor(dbPath: string, agentId: string) {
    this.agentId = agentId;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this._initSchema();
    this.insertStmt = this.db.prepare(
      `INSERT INTO messages (chat_id, session_id, source, role, content, sender_name, sender_id, platform_message_id, media_files, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  static forAgent(agentsBaseDir: string, agentId: string): HistoryDB {
    const key = `${agentsBaseDir}::${agentId}`;
    if (!cache.has(key)) {
      const dbPath = path.join(agentsBaseDir, agentId, 'history.db');
      cache.set(key, new HistoryDB(dbPath, agentId));
    }
    return cache.get(key)!;
  }

  // Used by AgentRunner: agentDir is workspace/.., so DB lives at agentDir/history.db
  // which equals agentsBaseDir/agentId/history.db without requiring workspace to be nested correctly.
  static forDir(agentDir: string, agentId: string): HistoryDB {
    const key = `dir::${agentDir}::${agentId}`;
    if (!cache.has(key)) {
      const dbPath = path.join(agentDir, 'history.db');
      cache.set(key, new HistoryDB(dbPath, agentId));
    }
    return cache.get(key)!;
  }

  static evict(agentsBaseDir: string, agentId: string): void {
    cache.delete(`${agentsBaseDir}::${agentId}`);
  }

  static evictDir(agentDir: string, agentId: string): void {
    cache.delete(`dir::${agentDir}::${agentId}`);
  }

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id             TEXT    NOT NULL,
        session_id          TEXT    NOT NULL,
        source              TEXT    NOT NULL,
        role                TEXT    NOT NULL,
        content             TEXT    NOT NULL,
        sender_name         TEXT,
        sender_id           TEXT,
        platform_message_id TEXT,
        media_files         TEXT,
        ts                  INTEGER NOT NULL,
        created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts    ON messages(chat_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_session    ON messages(session_id, ts ASC);
      CREATE INDEX IF NOT EXISTS idx_messages_source     ON messages(source, ts DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        sender_name,
        content='messages',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, sender_name)
        VALUES (new.id, new.content, new.sender_name);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
        VALUES ('delete', old.id, old.content, old.sender_name);
      END;

    `);
  }

  insertMessage(msg: HistoryMessage): void {
    try {
      this.insertStmt.run(
        msg.chatId,
        msg.sessionId,
        msg.source,
        msg.role,
        msg.content,
        msg.senderName ?? null,
        msg.senderId ?? null,
        msg.platformMessageId ?? null,
        msg.mediaFiles ? JSON.stringify(msg.mediaFiles) : null,
        msg.ts,
      );
    } catch (err) {
      // Non-fatal — history is best-effort
      console.error(`[HistoryDB:${this.agentId}] insertMessage failed:`, err);
    }
  }

  listChats(): ChatSummary[] {
    const rows = this.db.prepare(`
      SELECT
        m.chat_id,
        m.source,
        MAX(CASE WHEN m.role = 'user' THEN m.sender_name END) AS display_name,
        COUNT(*) AS message_count,
        MAX(m.ts) AS last_active,
        (
          SELECT SUBSTR(m2.content, 1, ${PREVIEW_LENGTH})
          FROM messages m2
          WHERE m2.chat_id = m.chat_id
          ORDER BY m2.ts DESC
          LIMIT 1
        ) AS last_preview
      FROM messages m
      GROUP BY m.chat_id
      ORDER BY last_active DESC
    `).all() as Array<{
      chat_id: string;
      source: string;
      display_name: string | null;
      message_count: number;
      last_active: number;
      last_preview: string | null;
    }>;

    return rows.map((row) => ({
      chatId: row.chat_id,
      source: row.source as HistorySource,
      displayName: row.display_name,
      messageCount: row.message_count,
      lastActive: row.last_active,
      lastMessagePreview: row.last_preview,
    }));
  }

  getMessages(chatId: string, opts: PaginationOpts = {}): MessagePage {
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const conditions: string[] = ['chat_id = ?'];
    const params: (string | number)[] = [chatId];

    if (opts.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }
    if (opts.before !== undefined) {
      conditions.push('ts < ?');
      params.push(opts.before);
    }
    if (opts.after !== undefined) {
      conditions.push('ts > ?');
      params.push(opts.after);
    }

    // Fetch limit+1 to determine hasMore
    params.push(limit + 1);
    const sql = `
      SELECT id, chat_id, session_id, source, role, content, sender_name, sender_id,
             platform_message_id, media_files, ts
      FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY ts DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;

    const messages = slice.map((r) => this._rowToMessage(r));
    const nextCursor = hasMore && slice.length > 0
      ? (slice[slice.length - 1]!['ts'] as number)
      : null;

    return { messages, hasMore, nextCursor };
  }

  searchMessages(chatId: string, query: string, opts: SearchOpts = {}): SearchPage {
    const limit = Math.min(opts.limit ?? 20, 100);
    const offset = opts.offset ?? 0;

    if (!query.trim()) {
      return { results: [], total: 0, hasMore: false };
    }

    const sanitizedQuery = query.replace(/['"*\-]/g, ' ').trim();
    if (!sanitizedQuery) {
      return { results: [], total: 0, hasMore: false };
    }

    try {
      const countStmt = this.db.prepare(`
        SELECT COUNT(*) as cnt
        FROM messages_fts
        JOIN messages ON messages.id = messages_fts.rowid
        WHERE messages.chat_id = ? AND messages_fts MATCH ?
      `);
      const countRow = countStmt.get(chatId, sanitizedQuery) as { cnt: number };
      const total = countRow?.cnt ?? 0;

      const stmt = this.db.prepare(`
        SELECT
          messages.id, messages.chat_id, messages.session_id, messages.source,
          messages.role, messages.content, messages.sender_name, messages.sender_id,
          messages.platform_message_id, messages.media_files, messages.ts,
          snippet(messages_fts, 0, '<b>', '</b>', '...', 32) AS snippet
        FROM messages_fts
        JOIN messages ON messages.id = messages_fts.rowid
        WHERE messages.chat_id = ? AND messages_fts MATCH ?
        ORDER BY messages.ts DESC
        LIMIT ? OFFSET ?
      `);

      const rows = stmt.all(chatId, sanitizedQuery, limit, offset) as Array<Record<string, unknown>>;
      const results: SearchResult[] = rows.map((r) => ({
        ...this._rowToMessage(r),
        snippet: (r['snippet'] as string | null) ?? '',
      }));

      return { results, total, hasMore: offset + results.length < total };
    } catch {
      return { results: [], total: 0, hasMore: false };
    }
  }

  listSessions(): SessionSummary[] {
    const rows = this.db.prepare(`
      SELECT
        chat_id,
        session_id,
        source,
        COUNT(*) AS message_count,
        MIN(ts)   AS created_at,
        MAX(ts)   AS last_activity,
        (SELECT content FROM messages m2
         WHERE m2.session_id = m.session_id
         ORDER BY ts DESC LIMIT 1) AS last_message
      FROM messages m
      GROUP BY session_id
      ORDER BY last_activity DESC
    `).all() as Array<{
      chat_id: string;
      session_id: string;
      source: string;
      message_count: number;
      created_at: number;
      last_activity: number;
      last_message: string | null;
    }>;

    return rows.map((row) => ({
      chatId: row.chat_id || null,
      sessionId: row.session_id,
      source: row.source as HistorySource,
      messageCount: row.message_count,
      createdAt: row.created_at,
      lastActivity: row.last_activity,
      lastMessage: row.last_message ?? null,
      sessionName: null,
    }));
  }

  clearChat(chatId: string): void {
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  }

  /**
   * Delete all messages older than cutoffMs (Unix ms timestamp).
   * Returns relative media_files paths from deleted rows for disk cleanup.
   * FTS5 index stays consistent via the AFTER DELETE trigger.
   */
  pruneOlderThan(cutoffMs: number): string[] {
    const rows = this.db.prepare(
      `SELECT media_files FROM messages WHERE ts < ? AND media_files IS NOT NULL`,
    ).all(cutoffMs) as Array<{ media_files: string }>;

    const mediaPaths: string[] = [];
    for (const row of rows) {
      try {
        const paths = JSON.parse(row.media_files) as string[];
        mediaPaths.push(...paths);
      } catch {
        // malformed JSON — skip
      }
    }

    this.db.prepare(`DELETE FROM messages WHERE ts < ?`).run(cutoffMs);

    return mediaPaths;
  }

  private _rowToMessage(r: Record<string, unknown>): HistoryMessage {
    let mediaFiles: string[] | undefined;
    if (r['media_files'] && typeof r['media_files'] === 'string') {
      try {
        mediaFiles = JSON.parse(r['media_files'] as string) as string[];
      } catch {
        mediaFiles = undefined;
      }
    }
    return {
      id: r['id'] as number,
      chatId: r['chat_id'] as string,
      sessionId: r['session_id'] as string,
      source: r['source'] as HistorySource,
      role: r['role'] as MessageRole,
      content: r['content'] as string,
      senderName: (r['sender_name'] as string | null) ?? undefined,
      senderId: (r['sender_id'] as string | null) ?? undefined,
      platformMessageId: (r['platform_message_id'] as string | null) ?? undefined,
      mediaFiles,
      ts: r['ts'] as number,
    };
  }
}
