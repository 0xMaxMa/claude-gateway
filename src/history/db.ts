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
  ActiveDaysOpts,
  SearchPage,
  SearchResult,
  SessionSummary,
} from './types';

/**
 * Ceiling for a single message-history page. Raised 200 -> 1000 so a client can
 * fetch a whole "target day -> now" span in one request (jump-to-date, #1798),
 * instead of several sequential load-more pages. Bounded (not unlimited) so a
 * pathological session cannot request an unbounded payload. Exported and reused
 * by the HTTP boundary clamp (api/router.ts) so the two ceilings can never drift.
 */
export const MAX_HISTORY_LIMIT = 1000;
const DEFAULT_LIMIT = 50;
const PREVIEW_LENGTH = 120;

// Singleton cache: one DB per (agentsBaseDir + agentId)
const cache = new Map<string, HistoryDB>();

// ---- Skill-learning persistence DTOs (planning-62) ----------------------------
// Kept local to the history layer so it owns its own storage shape; the
// skill-learning module maps to/from these rather than history importing upward.

export interface TurnMetricRow {
  sessionId: string;
  turnIdx: number;
  ts: number;
  toolCalls: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  recoveryFired: number;
  skillsLoaded: string | null; // JSON array of names
  intentHash: string | null;
  enabled: number;
}

export interface SkillStatRow {
  name: string;
  origin: string; // 'auto' | 'user'
  createdAt: number | null;
  createdFromSession: string | null;
  timesLoaded: number;
  lastUsedAt: number | null;
  pinned: number;
}

export interface ReviewRunRow {
  sessionId: string | null;
  ts: number;
  triggerReason: string | null;
  outcome: string | null;
  tokensSpent: number;
}

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
      `INSERT INTO messages (chat_id, session_id, source, role, content, sender_name, sender_id, platform_message_id, media_files, image_refs, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        image_refs          TEXT,
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

      -- Skill-learning telemetry (planning-62). Durable per-turn record — the
      -- prerequisite for BOTH gating and effectiveness measurement.
      CREATE TABLE IF NOT EXISTS turn_metrics (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT    NOT NULL,
        turn_idx       INTEGER NOT NULL,
        ts             INTEGER NOT NULL,
        tool_calls     INTEGER NOT NULL DEFAULT 0,
        duration_ms    INTEGER NOT NULL DEFAULT 0,
        tokens_in      INTEGER NOT NULL DEFAULT 0,
        tokens_out     INTEGER NOT NULL DEFAULT 0,
        recovery_fired INTEGER NOT NULL DEFAULT 0,
        skills_loaded  TEXT,                     -- JSON array of skill names
        intent_hash    TEXT,                     -- lightweight task-cluster key
        enabled        INTEGER NOT NULL DEFAULT 0 -- cohort tag at capture
      );
      CREATE INDEX IF NOT EXISTS idx_turn_metrics_ts      ON turn_metrics(ts);
      CREATE INDEX IF NOT EXISTS idx_turn_metrics_intent  ON turn_metrics(intent_hash);
      CREATE INDEX IF NOT EXISTS idx_turn_metrics_session ON turn_metrics(session_id, turn_idx);

      -- Per-skill provenance + usage. Only origin='auto' rows are ever pruned/edited.
      CREATE TABLE IF NOT EXISTS skill_stats (
        name                TEXT PRIMARY KEY,
        origin              TEXT NOT NULL,        -- 'auto' | 'user'
        created_at          INTEGER,
        created_from_session TEXT,
        times_loaded        INTEGER NOT NULL DEFAULT 0,
        last_used_at        INTEGER,
        pinned              INTEGER NOT NULL DEFAULT 0
      );

      -- Reviewer cost ledger: one row per reviewer spawn (daily budget + net-token measure).
      CREATE TABLE IF NOT EXISTS skill_review_runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT,
        ts             INTEGER NOT NULL,
        trigger_reason TEXT,
        outcome        TEXT,                      -- none | create | edit | error
        tokens_spent   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_skill_review_runs_ts ON skill_review_runs(ts);

    `);

    // image_refs (#74) postdates existing DBs: CREATE TABLE IF NOT EXISTS won't
    // touch them, so migrate with an explicit existence check. Only ALTER when the
    // column is genuinely absent — a blanket try/catch would also swallow real
    // failures (disk full, corruption) as if the column already existed.
    const messageCols = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!messageCols.some((c) => c.name === 'image_refs')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN image_refs TEXT');
    }
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
        msg.imageRefs?.length ? JSON.stringify(msg.imageRefs) : null,
        msg.ts,
      );
    } catch (err) {
      // Non-fatal — history is best-effort
      console.error(`[HistoryDB:${this.agentId}] insertMessage failed:`, err);
    }
  }

  // ---- Skill-learning telemetry (planning-62) --------------------------------
  // All best-effort: telemetry must never break a turn. Errors are logged, not thrown.

  /** Insert one durable per-turn metric row. */
  insertTurnMetric(row: TurnMetricRow): void {
    try {
      this.db
        .prepare(
          `INSERT INTO turn_metrics
             (session_id, turn_idx, ts, tool_calls, duration_ms, tokens_in, tokens_out, recovery_fired, skills_loaded, intent_hash, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.sessionId,
          row.turnIdx,
          row.ts,
          row.toolCalls,
          row.durationMs,
          row.tokensIn,
          row.tokensOut,
          row.recoveryFired,
          row.skillsLoaded,
          row.intentHash,
          row.enabled,
        );
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] insertTurnMetric failed:`, err);
    }
  }

  /** All turn_metrics rows for a session, ascending by turn. */
  getTurnMetricsForSession(sessionId: string): TurnMetricRow[] {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM turn_metrics WHERE session_id = ? ORDER BY turn_idx ASC`)
        .all(sessionId) as Array<Record<string, unknown>>;
      return rows.map(mapTurnMetricRow);
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] getTurnMetricsForSession failed:`, err);
      return [];
    }
  }

  /**
   * Most-recent messages for a session as {role, content}, oldest-first, capped.
   * Used to build the reviewer's transcript input (planning-62).
   */
  getSessionTranscript(sessionId: string, limit = 200): Array<{ role: string; content: string; ts: number }> {
    try {
      const rows = this.db
        .prepare(
          `SELECT role, content, ts FROM messages
           WHERE session_id = ? ORDER BY ts DESC LIMIT ?`,
        )
        .all(sessionId, limit) as Array<Record<string, unknown>>;
      return rows
        .map((r) => ({
          role: String(r['role'] ?? ''),
          content: String(r['content'] ?? ''),
          ts: Number(r['ts'] ?? 0),
        }))
        .reverse();
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] getSessionTranscript failed:`, err);
      return [];
    }
  }

  /** All turn_metrics rows since a timestamp (default: all), ascending by ts. */
  listTurnMetrics(sinceTs = 0): TurnMetricRow[] {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM turn_metrics WHERE ts >= ? ORDER BY ts ASC`)
        .all(sinceTs) as Array<Record<string, unknown>>;
      return rows.map(mapTurnMetricRow);
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] listTurnMetrics failed:`, err);
      return [];
    }
  }

  /** Record (or re-stamp provenance of) a created skill. Counters are preserved on conflict. */
  recordSkillCreated(row: Omit<SkillStatRow, 'timesLoaded' | 'lastUsedAt'> & { timesLoaded?: number }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO skill_stats (name, origin, created_at, created_from_session, times_loaded, last_used_at, pinned)
           VALUES (?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(name) DO UPDATE SET
             origin = excluded.origin,
             created_at = excluded.created_at,
             created_from_session = excluded.created_from_session,
             pinned = excluded.pinned`,
        )
        .run(row.name, row.origin, row.createdAt, row.createdFromSession, row.timesLoaded ?? 0, row.pinned);
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] recordSkillCreated failed:`, err);
    }
  }

  /**
   * Increment a skill's load counter. Upserts so loads are counted even if the
   * create was never recorded; a brand-new row defaults to origin 'user' (never
   * mis-tags an auto skill — its create row already set origin='auto').
   */
  bumpSkillLoaded(name: string, ts: number): void {
    try {
      this.db
        .prepare(
          `INSERT INTO skill_stats (name, origin, times_loaded, last_used_at, pinned)
           VALUES (?, 'user', 1, ?, 0)
           ON CONFLICT(name) DO UPDATE SET
             times_loaded = times_loaded + 1,
             last_used_at = excluded.last_used_at`,
        )
        .run(name, ts);
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] bumpSkillLoaded failed:`, err);
    }
  }

  setSkillPinned(name: string, pinned: boolean): void {
    try {
      this.db.prepare(`UPDATE skill_stats SET pinned = ? WHERE name = ?`).run(pinned ? 1 : 0, name);
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] setSkillPinned failed:`, err);
    }
  }

  deleteSkillStat(name: string): void {
    try {
      this.db.prepare(`DELETE FROM skill_stats WHERE name = ?`).run(name);
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] deleteSkillStat failed:`, err);
    }
  }

  getSkillStat(name: string): SkillStatRow | null {
    try {
      const row = this.db.prepare(`SELECT * FROM skill_stats WHERE name = ?`).get(name) as
        | Record<string, unknown>
        | undefined;
      return row ? mapSkillStatRow(row) : null;
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] getSkillStat failed:`, err);
      return null;
    }
  }

  listSkillStats(): SkillStatRow[] {
    try {
      const rows = this.db.prepare(`SELECT * FROM skill_stats`).all() as Array<Record<string, unknown>>;
      return rows.map(mapSkillStatRow);
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] listSkillStats failed:`, err);
      return [];
    }
  }

  /** Append a reviewer-run row to the cost ledger. */
  insertReviewRun(row: ReviewRunRow): void {
    try {
      this.db
        .prepare(
          `INSERT INTO skill_review_runs (session_id, ts, trigger_reason, outcome, tokens_spent)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.sessionId, row.ts, row.triggerReason, row.outcome, row.tokensSpent);
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] insertReviewRun failed:`, err);
    }
  }

  /** Count reviewer spawns at or after a timestamp (for the daily budget). */
  countReviewRunsSince(ts: number): number {
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM skill_review_runs WHERE ts >= ?`)
        .get(ts) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] countReviewRunsSince failed:`, err);
      return 0;
    }
  }

  listReviewRuns(sinceTs = 0): ReviewRunRow[] {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM skill_review_runs WHERE ts >= ? ORDER BY ts ASC`)
        .all(sinceTs) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        sessionId: (r['session_id'] as string) ?? null,
        ts: Number(r['ts'] ?? 0),
        triggerReason: (r['trigger_reason'] as string) ?? null,
        outcome: (r['outcome'] as string) ?? null,
        tokensSpent: Number(r['tokens_spent'] ?? 0),
      }));
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] listReviewRuns failed:`, err);
      return [];
    }
  }

  /** Retention prune for telemetry tables (runs even when learning is disabled). Returns rows removed. */
  pruneTelemetry(cutoffTs: number): number {
    let removed = 0;
    try {
      removed += (this.db.prepare(`DELETE FROM turn_metrics WHERE ts < ?`).run(cutoffTs).changes as number) ?? 0;
      removed +=
        (this.db.prepare(`DELETE FROM skill_review_runs WHERE ts < ?`).run(cutoffTs).changes as number) ?? 0;
    } catch (err) {
      console.error(`[HistoryDB:${this.agentId}] pruneTelemetry failed:`, err);
    }
    return removed;
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
    // Coerce limit to a non-negative integer before it reaches the SQLite bind (`limit + 1`),
    // mirroring the HTTP boundary's parseInt. Two failure modes to close:
    //   1. non-finite (NaN/±Infinity) or fractional would bind as a non-integer and throw a
    //      raw "datatype mismatch" -> non-finite falls back to DEFAULT_LIMIT, fractional truncates.
    //   2. a negative limit is NOT bounded by the Math.min ceiling (Math.min keeps the smaller,
    //      i.e. the negative), and SQLite reads a negative "LIMIT -n" as "no limit at all" — so a
    //      caller passing e.g. limit=-1000 would bypass MAX_HISTORY_LIMIT entirely. Treat any
    //      negative as invalid input and fall back to DEFAULT_LIMIT, same as non-finite.
    // Explicit 0 is preserved (a deliberate empty-page request, already bounded). #1798
    const rawLimit = opts.limit ?? DEFAULT_LIMIT;
    const coerced = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : DEFAULT_LIMIT;
    const intLimit = coerced < 0 ? DEFAULT_LIMIT : coerced;
    const limit = Math.min(intLimit, MAX_HISTORY_LIMIT);
    const conditions: string[] = ['chat_id = ?'];
    const params: (string | number)[] = [chatId];

    if (opts.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }
    // Composite (ts, id) cursor: when the caller pairs before/after with its id component,
    // match the boundary as a tuple so a page edge landing between equal-ts rows doesn't
    // skip the tied remainder. Without the id it falls back to the legacy ts-only filter,
    // keeping existing clients byte-for-byte compatible. before pages toward older rows
    // (uses <), after pages toward newer rows (uses >) — the id comparison follows the
    // same direction as its ts.
    if (opts.before !== undefined) {
      if (opts.beforeId !== undefined) {
        conditions.push('(ts < ? OR (ts = ? AND id < ?))');
        params.push(opts.before, opts.before, opts.beforeId);
      } else {
        conditions.push('ts < ?');
        params.push(opts.before);
      }
    }
    if (opts.after !== undefined) {
      if (opts.afterId !== undefined) {
        conditions.push('(ts > ? OR (ts = ? AND id > ?))');
        params.push(opts.after, opts.after, opts.afterId);
      } else {
        conditions.push('ts > ?');
        params.push(opts.after);
      }
    }

    // Fetch limit+1 to determine hasMore
    params.push(limit + 1);
    const order = opts.order === 'asc' ? 'ASC' : 'DESC'; // whitelist; never interpolate raw input
    // Tiebreak on id (AUTOINCREMENT, monotonic with insertion) so rows sharing a
    // ts have a deterministic, chronology-consistent order instead of relying on
    // SQLite's unspecified default. Paired with the composite (ts, id) cursor above,
    // a page boundary between equal-ts rows is expressible exactly, so no tied row is
    // skipped or repeated when the caller passes the cursor's id component back.
    const sql = `
      SELECT id, chat_id, session_id, source, role, content, sender_name, sender_id,
             platform_message_id, media_files, image_refs, ts
      FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY ts ${order}, id ${order}
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;

    const messages = slice.map((r) => this._rowToMessage(r));
    const boundary = hasMore && slice.length > 0 ? slice[slice.length - 1]! : null;
    const nextCursor = boundary ? (boundary['ts'] as number) : null;
    const nextCursorId = boundary ? (boundary['id'] as number) : null;

    return { messages, hasMore, nextCursor, nextCursorId };
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

  /**
   * Distinct local calendar days (YYYY-MM-DD) that have >= 1 message in [from, to).
   *
   * Rides the idx_messages_chat_ts index as a bounded range scan (chat_id + ts window),
   * so a one-month window emits at most ~31 rows without a full-history scan.
   *
   * Timezone: tzOffset is minutes EAST of UTC (local = UTC + offset), matching the issue's
   * SQL contract. Bangkok (UTC+7) => +420. The SQL adds (tzOffset * 60000) ms to ts before
   * bucketing, so days match the viewer's local calendar. Omitted tzOffset defaults to 0 (UTC).
   * (Clients computing this from JS should send -Date.prototype.getTimezoneOffset().)
   */
  getActiveDays(chatId: string, opts: ActiveDaysOpts): string[] {
    // Short-circuit empty/inverted windows before touching SQLite.
    if (!(opts.to > opts.from)) {
      return [];
    }

    const conditions: string[] = ['chat_id = ?', 'ts >= ?', 'ts < ?'];
    const params: (string | number)[] = [chatId, opts.from, opts.to];
    if (opts.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }

    // offsetMs is bound FIRST because it appears first in the SQL text; keep ? order and bind
    // order in lockstep. tzOffset is minutes east of UTC => local = UTC + offset => add offsetMs.
    const offsetMs = (opts.tzOffset ?? 0) * 60000;
    const sql = `
      SELECT DISTINCT date((ts + ?) / 1000, 'unixepoch') AS day
      FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY day ASC
    `;

    const rows = this.db.prepare(sql).all(offsetMs, ...params) as Array<{ day: string }>;
    return rows.map((r) => r.day);
  }

  listSessions(chatId?: string): SessionSummary[] {
    const where = chatId ? 'WHERE m.chat_id = ?' : '';
    const params = chatId ? [chatId] : [];
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
         ORDER BY ts DESC LIMIT 1) AS last_message,
        (SELECT role FROM messages m3
         WHERE m3.session_id = m.session_id
         ORDER BY ts DESC LIMIT 1) AS last_message_role
      FROM messages m
      ${where}
      GROUP BY session_id
      ORDER BY last_activity DESC
    `).all(...params) as Array<{
      chat_id: string;
      session_id: string;
      source: string;
      message_count: number;
      created_at: number;
      last_activity: number;
      last_message: string | null;
      last_message_role: string | null;
    }>;

    return rows.map((row) => ({
      chatId: row.chat_id || null,
      sessionId: row.session_id,
      source: row.source as HistorySource,
      messageCount: row.message_count,
      createdAt: row.created_at,
      lastActivity: row.last_activity,
      lastMessage: row.last_message ?? null,
      lastMessageRole: (row.last_message_role as MessageRole) ?? null,
      sessionName: null,
    }));
  }

  /**
   * Media-bearing messages of one session, oldest first — the deterministic
   * input for the session image catalog (#72). Rides idx_messages_session and
   * keeps the (ts, id) tiebreak used everywhere else so the ordering (and the
   * ordinals derived from it) never depends on SQLite's default row order.
   * Rows whose media_files JSON is malformed are skipped, like pruneOlderThan.
   */
  listSessionMedia(
    sessionId: string,
  ): Array<{ id: number; role: string; content: string; mediaFiles: string[]; ts: number }> {
    const rows = this.db.prepare(
      `SELECT id, role, content, media_files, ts FROM messages
       WHERE session_id = ? AND media_files IS NOT NULL
       ORDER BY ts ASC, id ASC`,
    ).all(sessionId) as Array<{ id: number; role: string; content: string | null; media_files: string; ts: number }>;

    const out: Array<{ id: number; role: string; content: string; mediaFiles: string[]; ts: number }> = [];
    for (const row of rows) {
      try {
        const mediaFiles = JSON.parse(row.media_files) as string[];
        if (!Array.isArray(mediaFiles)) continue; // not a JSON array — skip
        out.push({ id: row.id, role: row.role, content: row.content ?? '', mediaFiles, ts: row.ts });
      } catch {
        // malformed JSON — skip
      }
    }
    return out;
  }

  clearChat(chatId: string): void {
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  }

  clearSession(chatId: string, sessionId: string): string[] {
    const rows = this.db.prepare(
      `SELECT media_files FROM messages WHERE chat_id = ? AND session_id = ? AND media_files IS NOT NULL`,
    ).all(chatId, sessionId) as Array<{ media_files: string }>;
    const mediaPaths: string[] = [];
    for (const row of rows) {
      try { mediaPaths.push(...(JSON.parse(row.media_files) as string[])); } catch { /* skip */ }
    }
    this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND session_id = ?').run(chatId, sessionId);
    return mediaPaths;
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
    let imageRefs: string[] | undefined;
    if (r['image_refs'] && typeof r['image_refs'] === 'string') {
      try {
        imageRefs = JSON.parse(r['image_refs'] as string) as string[];
      } catch {
        imageRefs = undefined;
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
      ...(imageRefs?.length ? { imageRefs } : {}),
      ts: r['ts'] as number,
    };
  }
}

// ---- Skill-learning row mappers (module scope) --------------------------------

function mapTurnMetricRow(r: Record<string, unknown>): TurnMetricRow {
  return {
    sessionId: r['session_id'] as string,
    turnIdx: Number(r['turn_idx'] ?? 0),
    ts: Number(r['ts'] ?? 0),
    toolCalls: Number(r['tool_calls'] ?? 0),
    durationMs: Number(r['duration_ms'] ?? 0),
    tokensIn: Number(r['tokens_in'] ?? 0),
    tokensOut: Number(r['tokens_out'] ?? 0),
    recoveryFired: Number(r['recovery_fired'] ?? 0),
    skillsLoaded: (r['skills_loaded'] as string | null) ?? null,
    intentHash: (r['intent_hash'] as string | null) ?? null,
    enabled: Number(r['enabled'] ?? 0),
  };
}

function mapSkillStatRow(r: Record<string, unknown>): SkillStatRow {
  return {
    name: r['name'] as string,
    origin: (r['origin'] as string) ?? 'user',
    createdAt: r['created_at'] != null ? Number(r['created_at']) : null,
    createdFromSession: (r['created_from_session'] as string | null) ?? null,
    timesLoaded: Number(r['times_loaded'] ?? 0),
    lastUsedAt: r['last_used_at'] != null ? Number(r['last_used_at']) : null,
    pinned: Number(r['pinned'] ?? 0),
  };
}
