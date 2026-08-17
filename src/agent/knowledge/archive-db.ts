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
  };

  private constructor(dbPath: string, tokenizer: string) {
    this.dbPath = dbPath;
    this.tokenizer = tokenizer;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this._initSchema();
    this.stmts = {
      getSource: this.db.prepare('SELECT id, path, hash, mtime, size, source FROM kb_sources WHERE path = ?'),
      upsertSource: this.db.prepare(
        `INSERT INTO kb_sources (path, hash, mtime, size, source) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, size=excluded.size, source=excluded.source`,
      ),
      deleteSource: this.db.prepare('DELETE FROM kb_sources WHERE path = ?'),
      insertChunk: this.db.prepare(
        `INSERT INTO kb_chunks (id, path, start_line, end_line, text, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      insertRecall: this.db.prepare(
        `INSERT INTO kb_chunk_recall (chunk_id, importance, triggers, project_key) VALUES (?, ?, ?, ?)`,
      ),
      insertProvenance: this.db.prepare(
        `INSERT INTO kb_chunk_provenance (chunk_id, origin_class, session_kind, observed_at, supersedes_key)
         VALUES (?, ?, ?, ?, ?)`,
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
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_path ON kb_chunks(path);

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
    `);
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
   * row, insert the fresh chunks (+ recall + provenance). Runs in a transaction
   * so a failure never leaves a half-indexed file.
   */
  replaceSource(
    source: Omit<ArchiveSourceRow, 'id'>,
    chunks: ChunkWithMeta[],
  ): void {
    this.db.exec('BEGIN');
    try {
      // Drop old chunks for this path first (cascades recall + provenance + FTS).
      this._deleteChunksForPath(source.path);
      this.stmts.upsertSource.run(source.path, source.hash, source.mtime, source.size, source.source);
      for (const { chunk, recall, provenance } of chunks) {
        this.stmts.insertChunk.run(
          chunk.id,
          chunk.path,
          chunk.startLine,
          chunk.endLine,
          chunk.text,
          chunk.updatedAt,
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
   * Close the handle AND drop it from the singleton cache, so a later
   * `forPath(samePath)` opens a fresh handle instead of returning this closed one
   * (whose statements would throw). Mirrors `evict()`.
   */
  close(): void {
    this.db.close();
    cache.delete(this.dbPath);
  }
}
