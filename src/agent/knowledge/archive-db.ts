/**
 * Per-agent knowledge archive — SQLite/FTS5 substrate (planning-64 K0).
 *
 * One `kb.sqlite` per agent, alongside `history.db`. Backed by `node:sqlite`
 * `DatabaseSync` (zero new dependency — the same substrate `src/history/db.ts`
 * uses, which already runs FTS5). Schema adapted from openclaw memory-core,
 * trimmed for v1 (FTS5-only; no vector table yet).
 *
 * IMPORTANT: `DatabaseSync` is synchronous. Every method here blocks. Callers
 * MUST run indexing/queries OFF the gateway event loop (the nightly dreaming
 * spawn or an out-of-process tool) — never on the HTTP read path (#277 lesson).
 * K0 ships this as dormant infrastructure; no gateway runtime path calls it yet.
 */

import * as path from 'path';
import * as fs from 'fs';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  ArchiveChunkRow,
  ArchiveProvenanceRow,
  ArchiveRecallRow,
  ArchiveSourceRow,
} from './types';

// Singleton cache: one DB handle per absolute file path.
const cache = new Map<string, ArchiveDB>();

/** A chunk plus its recall + provenance metadata, ready to persist. */
export interface ChunkWithMeta {
  chunk: ArchiveChunkRow;
  recall: ArchiveRecallRow;
  provenance: ArchiveProvenanceRow;
  /**
   * Stable, reindex-surviving identity of the archive ENTRY (markdown block) this
   * chunk belongs to (planning-66). `null` for content outside any entry block
   * (evergreen prose, section headers). Keyed to `kb_entry_lifecycle`.
   */
  entryHash?: string | null;
}

/** One archive-entry lifecycle row (planning-66), joined with its max importance. */
export interface LifecycleRow {
  entryHash: string;
  path: string;
  firstSeen: number;
  lastRetrieved: number | null;
  retrievalCount: number;
  supersededBy: string | null;
  invalidAt: number | null;
  /** MAX importance across the chunks carrying this entry_hash (null = none set). */
  importance: number | null;
}

export class ArchiveDB {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly tokenizer: string;
  private readonly stmts: {
    getSource: StatementSync;
    upsertSource: StatementSync;
    deleteSource: StatementSync;
    insertChunk: StatementSync;
    insertRecall: StatementSync;
    insertProvenance: StatementSync;
    upsertLifecycle: StatementSync;
  };

  private constructor(dbPath: string, tokenizer: string) {
    this.dbPath = dbPath;
    this.tokenizer = tokenizer;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    // All sessions of an agent reindex the SAME kb.sqlite; concurrent reindex
    // subprocesses would otherwise hit SQLITE_BUSY immediately. Wait instead of
    // failing so a losing writer completes rather than silently no-opping.
    this.db.exec('PRAGMA busy_timeout=5000');
    this._initSchema();
    this.stmts = {
      getSource: this.db.prepare('SELECT id, path, hash, mtime, size, source FROM kb_sources WHERE path = ?'),
      upsertSource: this.db.prepare(
        `INSERT INTO kb_sources (path, hash, mtime, size, source) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, size=excluded.size, source=excluded.source`,
      ),
      deleteSource: this.db.prepare('DELETE FROM kb_sources WHERE path = ?'),
      insertChunk: this.db.prepare(
        `INSERT INTO kb_chunks (id, path, start_line, end_line, text, updated_at, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertRecall: this.db.prepare(
        `INSERT INTO kb_chunk_recall (chunk_id, importance, triggers, project_key) VALUES (?, ?, ?, ?)`,
      ),
      insertProvenance: this.db.prepare(
        `INSERT INTO kb_chunk_provenance (chunk_id, origin_class, session_kind, observed_at, supersedes_key)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      // Age survives reindex: first_seen is written ONCE (never reset); a later
      // reindex of the same entry only refreshes its current path (planning-66).
      upsertLifecycle: this.db.prepare(
        `INSERT INTO kb_entry_lifecycle (entry_hash, path, first_seen) VALUES (?, ?, ?)
         ON CONFLICT(entry_hash) DO UPDATE SET path = excluded.path`,
      ),
    };
  }

  static forPath(dbPath: string, tokenizer = 'unicode61'): ArchiveDB {
    const abs = path.resolve(dbPath);
    if (!cache.has(abs)) cache.set(abs, new ArchiveDB(abs, tokenizer));
    return cache.get(abs)!;
  }

  static evict(dbPath: string): void {
    const inst = cache.get(path.resolve(dbPath));
    if (inst) inst.close(); // closes the handle + removes it from the cache
  }

  private _initSchema(): void {
    // FTS5 tokenizer is a trusted, enum-validated value (resolveArchiveConfig),
    // never raw user input — safe to interpolate into the CREATE. NOTE (K0
    // limitation): the FTS vtable is created with IF NOT EXISTS, so an existing
    // kb.sqlite keeps its ORIGINAL tokenizer — changing `tokenizer` in config does
    // not retokenize a built index. A later phase (planning-64) will persist the
    // config signature in kb_index_state and force a rebuild when it changes.
    const tok = this.tokenizer.replace(/[^a-z0-9]/g, '') || 'unicode61';
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_sources (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        path   TEXT    NOT NULL UNIQUE,
        hash   TEXT    NOT NULL,
        mtime  REAL    NOT NULL,
        size   INTEGER NOT NULL,
        source TEXT    NOT NULL DEFAULT 'memory'
      );

      CREATE TABLE IF NOT EXISTS kb_chunks (
        rowid_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        id         TEXT    NOT NULL UNIQUE,
        path       TEXT    NOT NULL,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        text       TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        entry_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_path ON kb_chunks(path);
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_entry_hash ON kb_chunks(entry_hash);

      CREATE TABLE IF NOT EXISTS kb_chunk_recall (
        chunk_id    TEXT PRIMARY KEY,
        importance  INTEGER CHECK (importance IS NULL OR importance BETWEEN 1 AND 10),
        triggers    TEXT,
        project_key TEXT,
        FOREIGN KEY (chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kb_chunk_provenance (
        chunk_id       TEXT PRIMARY KEY,
        origin_class   TEXT NOT NULL CHECK (origin_class IN ('owner','agent','untrusted','system')),
        session_kind   TEXT NOT NULL CHECK (session_kind IN ('interactive','cron','heartbeat','subagent','unknown')),
        observed_at    INTEGER NOT NULL,
        supersedes_key TEXT,
        FOREIGN KEY (chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
      );

      -- Per-ENTRY lifecycle (planning-66). Deliberately NOT a FK-cascade child of
      -- kb_chunks: reindex does delete-then-insert of chunks, which would wipe any
      -- cascade child — so age/recall/invalidation must live in a standalone table
      -- keyed by the stable entry_hash (sha256 of normalized block text), which
      -- survives re-chunking. NULL invalid_at = live; a stamp = soft-invalidated
      -- (Zep bi-temporal: still indexed + searchable, never hard-deleted).
      CREATE TABLE IF NOT EXISTS kb_entry_lifecycle (
        entry_hash      TEXT PRIMARY KEY,
        path            TEXT NOT NULL,
        first_seen      INTEGER NOT NULL,
        last_retrieved  INTEGER,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        superseded_by   TEXT,
        invalid_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_kb_lifecycle_invalid ON kb_entry_lifecycle(invalid_at);
      CREATE INDEX IF NOT EXISTS idx_kb_lifecycle_superseded ON kb_entry_lifecycle(superseded_by);

      -- Append-only retrieval log (planning-66). The Bun read path appends a row
      -- per memory_search hit (fire-and-forget); the Node side folds it into
      -- kb_entry_lifecycle.last_retrieved/retrieval_count at GC time, then clears
      -- the folded rows. Keyed by the stable entry_hash, never the line-based id.
      CREATE TABLE IF NOT EXISTS kb_retrieval_log (
        rowid_id     INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_hash   TEXT    NOT NULL,
        retrieved_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
        text,
        content='kb_chunks',
        content_rowid='rowid_id',
        tokenize='${tok}'
      );

      -- INVARIANT: kb_chunks rows are IMMUTABLE — only ever INSERTed or DELETEd
      -- (replaceSource does delete-then-insert, never UPDATE). Hence there is no
      -- AFTER UPDATE trigger and the revision counter bumps on INSERT only. Any
      -- future code that UPDATEs kb_chunks.text MUST add an _au FTS trigger + a
      -- revision bump, or the FTS index will silently desync.
      CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
        INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.rowid_id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
        INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES ('delete', old.rowid_id, old.text);
      END;

      -- Single revision counter, bumped on any source/chunk mutation. An
      -- optimistic-concurrency hook for later phases (shadow reindex publish).
      CREATE TABLE IF NOT EXISTS kb_index_state (
        id       INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO kb_index_state (id, revision) VALUES (1, 0);

      CREATE TRIGGER IF NOT EXISTS kb_sources_rev AFTER INSERT ON kb_sources BEGIN
        UPDATE kb_index_state SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS kb_sources_rev_u AFTER UPDATE ON kb_sources BEGIN
        UPDATE kb_index_state SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS kb_sources_rev_d AFTER DELETE ON kb_sources BEGIN
        UPDATE kb_index_state SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS kb_chunks_rev AFTER INSERT ON kb_chunks BEGIN
        UPDATE kb_index_state SET revision = revision + 1 WHERE id = 1;
      END;

      -- Watermark for the weekly shared-KB reflection pass (issue #392 part C):
      -- the kb_index_state.revision this DB was at the last time reflection ran,
      -- so an unchanged KB is skipped entirely (zero LLM/compute cost). Single row,
      -- same shape as kb_index_state. Harmless/unused for a per-agent archive DB.
      CREATE TABLE IF NOT EXISTS kb_reflection_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        last_revision INTEGER NOT NULL DEFAULT 0,
        last_run_at   INTEGER
      );
      INSERT OR IGNORE INTO kb_reflection_state (id, last_revision, last_run_at) VALUES (1, 0, NULL);
    `);

    // Idempotent column migration (planning-66): a kb.sqlite built before the
    // entry_hash column exists keeps its rows via CREATE TABLE IF NOT EXISTS, but
    // the new column is absent. Add it in place (nullable, no default) so the
    // insert/read statements below don't fail on an upgraded DB. The lifecycle +
    // retrieval-log tables above are new, so IF NOT EXISTS creates them cleanly.
    const cols = this.db.prepare(`PRAGMA table_info(kb_chunks)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'entry_hash')) {
      this.db.exec(`ALTER TABLE kb_chunks ADD COLUMN entry_hash TEXT`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_entry_hash ON kb_chunks(entry_hash)`);
    }
  }

  /** Look up an indexed source by its workspace-relative path. */
  getSource(relPath: string): ArchiveSourceRow | undefined {
    const row = this.stmts.getSource.get(relPath) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as number,
      path: row.path as string,
      hash: row.hash as string,
      mtime: row.mtime as number,
      size: row.size as number,
      source: row.source as string,
    };
  }

  /**
   * Replace a file's index atomically: delete its old chunks, upsert the source
   * row, insert the fresh chunks (+ recall + provenance), then upsert the entry
   * lifecycle rows for ALL of the file's blocks. Runs in a transaction so a
   * failure never leaves a half-indexed file.
   *
   * `entryBlocks` (planning-66) is the FULL set of archive-entry blocks in the file
   * — one lifecycle row each — NOT derived from chunks: a single FTS chunk can span
   * several blocks, so per-chunk upsert would miss the inner ones. Empty for
   * non-archive-tier files (evergreen/pinned/shared get no lifecycle).
   */
  replaceSource(
    source: Omit<ArchiveSourceRow, 'id'>,
    chunks: ChunkWithMeta[],
    entryBlocks: Array<{ entryHash: string; firstSeen: number }> = [],
  ): void {
    this.db.exec('BEGIN');
    try {
      // Drop old chunks for this path first (cascades recall + provenance + FTS).
      this._deleteChunksForPath(source.path);
      this.stmts.upsertSource.run(source.path, source.hash, source.mtime, source.size, source.source);
      for (const { chunk, recall, provenance, entryHash } of chunks) {
        this.stmts.insertChunk.run(
          chunk.id,
          chunk.path,
          chunk.startLine,
          chunk.endLine,
          chunk.text,
          chunk.updatedAt,
          entryHash ?? null,
        );
        this.stmts.insertRecall.run(chunk.id, recall.importance, recall.triggers, recall.projectKey);
        this.stmts.insertProvenance.run(
          chunk.id,
          provenance.originClass,
          provenance.sessionKind,
          provenance.observedAt,
          provenance.supersedesKey,
        );
      }
      // Entry lifecycle (planning-66): upsert-once first_seen per BLOCK keyed by the
      // stable entry_hash; a re-index only refreshes the current path. Age therefore
      // survives edits and re-chunking (kb_chunks is delete-then-insert, but this
      // standalone table is not a cascade child, so its first_seen is preserved).
      for (const b of entryBlocks) {
        this.stmts.upsertLifecycle.run(b.entryHash, source.path, b.firstSeen);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      // A failing COMMIT may have already rolled the txn back, so this ROLLBACK
      // can itself throw "no transaction is active" — swallow it so the ORIGINAL
      // error is the one that propagates.
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* txn already unwound */
      }
      throw err;
    }
  }

  /** Remove a source and all its chunks (file disappeared). */
  deleteSource(relPath: string): void {
    this.db.exec('BEGIN');
    try {
      this._deleteChunksForPath(relPath);
      this.stmts.deleteSource.run(relPath);
      this.db.exec('COMMIT');
    } catch (err) {
      // A failing COMMIT may have already rolled the txn back, so this ROLLBACK
      // can itself throw "no transaction is active" — swallow it so the ORIGINAL
      // error is the one that propagates.
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* txn already unwound */
      }
      throw err;
    }
  }

  private _deleteChunksForPath(relPath: string): void {
    // Explicit DELETE so the FTS delete-trigger + FK cascades both fire.
    this.db.prepare('DELETE FROM kb_chunks WHERE path = ?').run(relPath);
  }

  /** All indexed source paths. */
  listSourcePaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM kb_sources ORDER BY path').all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /** Current index revision (bumped on every mutation). */
  getRevision(): number {
    const row = this.db.prepare('SELECT revision FROM kb_index_state WHERE id = 1').get() as
      | { revision: number }
      | undefined;
    return row ? row.revision : 0;
  }

  /** The weekly reflection pass's watermark (issue #392 part C). */
  getReflectionState(): { lastRevision: number; lastRunAt: number | null } {
    const row = this.db.prepare('SELECT last_revision, last_run_at FROM kb_reflection_state WHERE id = 1').get() as
      | { last_revision: number; last_run_at: number | null }
      | undefined;
    return { lastRevision: row?.last_revision ?? 0, lastRunAt: row?.last_run_at ?? null };
  }

  /** Persist the reflection pass's watermark after a run. */
  setReflectionState(lastRevision: number, lastRunAt: number): void {
    this.db
      .prepare('UPDATE kb_reflection_state SET last_revision = ?, last_run_at = ? WHERE id = 1')
      .run(lastRevision, lastRunAt);
  }

  /** Source paths whose mtime is strictly newer than `sinceMtime` (issue #392 part C). */
  changedSourcePaths(sinceMtime: number): string[] {
    const rows = this.db
      .prepare('SELECT path FROM kb_sources WHERE mtime > ? ORDER BY path')
      .all(sinceMtime) as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /** Total chunk count (test/introspection helper). */
  chunkCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM kb_chunks').get() as { n: number };
    return row.n;
  }

  /** Provenance row for a chunk (test/introspection helper). */
  getProvenance(chunkId: string): ArchiveProvenanceRow | undefined {
    const row = this.db
      .prepare('SELECT origin_class, session_kind, observed_at, supersedes_key FROM kb_chunk_provenance WHERE chunk_id = ?')
      .get(chunkId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      originClass: row.origin_class as ArchiveProvenanceRow['originClass'],
      sessionKind: row.session_kind as ArchiveProvenanceRow['sessionKind'],
      observedAt: row.observed_at as number,
      supersedesKey: (row.supersedes_key as string | null) ?? null,
    };
  }

  // ── Entry lifecycle / staleness GC (planning-66) ──────────────────────────

  /** Append a retrieval event (Node-side seed for tests + aggregation symmetry). */
  logRetrieval(entryHash: string, retrievedAt: number): void {
    this.db
      .prepare('INSERT INTO kb_retrieval_log (entry_hash, retrieved_at) VALUES (?, ?)')
      .run(entryHash, retrievedAt);
  }

  /**
   * Fold the append-only retrieval log into per-entry lifecycle: bump each entry's
   * `last_retrieved` to the newest hit and add the hit count, then delete the
   * folded rows (bounded by the max rowid read, so a concurrent append after this
   * read survives to the next GC). Returns how many log rows were folded. A hit for
   * an entry_hash no longer in lifecycle (its text changed → new hash) updates 0
   * rows and is harmlessly dropped.
   */
  aggregateRetrievalLog(): number {
    const rows = this.db
      .prepare('SELECT rowid_id, entry_hash, retrieved_at FROM kb_retrieval_log ORDER BY rowid_id')
      .all() as Array<{ rowid_id: number; entry_hash: string; retrieved_at: number }>;
    if (rows.length === 0) return 0;
    const agg = new Map<string, { max: number; count: number }>();
    let maxRowId = 0;
    for (const r of rows) {
      maxRowId = Math.max(maxRowId, r.rowid_id);
      const cur = agg.get(r.entry_hash);
      if (cur) {
        cur.max = Math.max(cur.max, r.retrieved_at);
        cur.count += 1;
      } else {
        agg.set(r.entry_hash, { max: r.retrieved_at, count: 1 });
      }
    }
    const upd = this.db.prepare(
      `UPDATE kb_entry_lifecycle
       SET last_retrieved = MAX(COALESCE(last_retrieved, 0), ?), retrieval_count = retrieval_count + ?
       WHERE entry_hash = ?`,
    );
    this.db.exec('BEGIN');
    try {
      for (const [hash, { max, count }] of agg) upd.run(max, count, hash);
      this.db.prepare('DELETE FROM kb_retrieval_log WHERE rowid_id <= ?').run(maxRowId);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* txn already unwound */
      }
      throw err;
    }
    return rows.length;
  }

  /** All lifecycle rows, joined with the MAX importance across their chunks. */
  listLifecycle(): LifecycleRow[] {
    const rows = this.db
      .prepare(
        `SELECT l.entry_hash, l.path, l.first_seen, l.last_retrieved, l.retrieval_count,
                l.superseded_by, l.invalid_at,
                (SELECT MAX(r.importance) FROM kb_chunks c JOIN kb_chunk_recall r ON r.chunk_id = c.id
                 WHERE c.entry_hash = l.entry_hash) AS importance
         FROM kb_entry_lifecycle l`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      entryHash: r.entry_hash as string,
      path: r.path as string,
      firstSeen: r.first_seen as number,
      lastRetrieved: (r.last_retrieved as number | null) ?? null,
      retrievalCount: (r.retrieval_count as number) ?? 0,
      supersededBy: (r.superseded_by as string | null) ?? null,
      invalidAt: (r.invalid_at as number | null) ?? null,
      importance: (r.importance as number | null) ?? null,
    }));
  }

  /** Read one lifecycle row (test/introspection helper). */
  getLifecycle(entryHash: string): LifecycleRow | undefined {
    return this.listLifecycle().find((l) => l.entryHash === entryHash);
  }

  /** Mark `entryHash` superseded by `bySpec` (or clear when null). */
  setSuperseded(entryHash: string, bySpec: string | null): void {
    this.db
      .prepare('UPDATE kb_entry_lifecycle SET superseded_by = ? WHERE entry_hash = ?')
      .run(bySpec, entryHash);
  }

  /**
   * Populate the (previously inert) provenance `supersedes_key` for every chunk of
   * a superseded entry — so the search-side provenance reflects supersession too,
   * not just the lifecycle table. Best-effort mirror of {@link setSuperseded}.
   */
  setSupersedesKeyForEntry(entryHash: string, key: string): void {
    this.db
      .prepare(
        `UPDATE kb_chunk_provenance SET supersedes_key = ?
         WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE entry_hash = ?)`,
      )
      .run(key, entryHash);
  }

  /** Stamp (soft-invalidate) or clear an entry's invalidation. */
  stampInvalid(entryHash: string, invalidAt: number | null): void {
    this.db
      .prepare('UPDATE kb_entry_lifecycle SET invalid_at = ? WHERE entry_hash = ?')
      .run(invalidAt, entryHash);
  }


  /**
   * Keyword search over chunk text (FTS5 BM25). K0 helper for tests/introspection;
   * the ranked, agent-facing `memory_search` tool is K1. Returns best matches
   * first. Query tokens are quoted so punctuation can't inject FTS syntax.
   */
  search(query: string, limit = 10): ArchiveChunkRow[] {
    const match = query
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' ');
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.updated_at
         FROM kb_chunks_fts f JOIN kb_chunks c ON c.rowid_id = f.rowid
         WHERE kb_chunks_fts MATCH ? ORDER BY bm25(kb_chunks_fts) LIMIT ?`,
      )
      .all(match, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      path: r.path as string,
      startLine: r.start_line as number,
      endLine: r.end_line as number,
      text: r.text as string,
      updatedAt: r.updated_at as number,
    }));
  }

  /**
   * OR-based FTS5 near-duplicate search: "is anything like this already here?"
   * Node-side (`node:sqlite`) twin of `findSimilarSharedNotes`'s query shape in
   * `mcp/tools/memory/archive-reader.ts` (Bun/`bun:sqlite`, same on-disk file) —
   * keep the two matching. Unlike `search()` above (implicit AND — every token
   * must match), terms are OR'd and capped at 12: a near-duplicate rarely repeats
   * every single word of the seed text, so an AND match would almost never hit.
   */
  searchSimilar(seedText: string, limit = 3): ArchiveChunkRow[] {
    const match = seedText
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
      .slice(0, 12)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.updated_at
         FROM kb_chunks_fts f JOIN kb_chunks c ON c.rowid_id = f.rowid
         WHERE kb_chunks_fts MATCH ? ORDER BY bm25(kb_chunks_fts) LIMIT ?`,
      )
      .all(match, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      path: r.path as string,
      startLine: r.start_line as number,
      endLine: r.end_line as number,
      text: r.text as string,
      updatedAt: r.updated_at as number,
    }));
  }

  /**
   * Close the handle AND drop it from the singleton cache, so a later
   * `forPath(samePath)` opens a fresh handle instead of returning this closed one
   * (whose statements would throw). Mirrors `evict()`.
   */
  close(): void {
    this.db.close();
    cache.delete(this.dbPath);
  }
}
