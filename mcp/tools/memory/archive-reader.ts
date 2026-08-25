/**
 * Read-only reader for the per-agent knowledge archive (planning-64 K1).
 *
 * The archive `kb.sqlite` is BUILT by src/ under Node via `node:sqlite`
 * (src/agent/knowledge). These MCP tools run under **Bun**, which has no
 * `node:sqlite`, so the read path here uses **`bun:sqlite`** instead. Same
 * on-disk SQLite/FTS5 file — verified that node:sqlite writes and bun:sqlite
 * reads it back via `bm25()`. This is a deliberate, read-only mirror of the
 * query half of `src/agent/knowledge/archive-db.ts`; keep the two in sync.
 */

import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { recordRetrievalHits } from './retrieval-recorder';

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number; // bm25 (lower = more relevant); surfaced for transparency
  snippet: string;
  originClass: string | null;
  importance: number | null;
  /** Stable archive-entry identity (planning-66); null outside any entry block. */
  entryHash: string | null;
}

/** Archive DB path for an agent: sibling of history.db at agents/<id>/kb.sqlite. */
export function archiveDbPath(workspaceDir: string): string {
  return path.join(path.dirname(workspaceDir), 'kb.sqlite');
}

/**
 * Shared, cross-agent vault DB path from the gateway-provided env
 * (`GATEWAY_SHARED_KB_DIR` = the resolved <root>/<project> dir), or null when
 * shared KB is disabled / not configured (planning-64 K3).
 */
export function sharedDbPathFromEnv(): string | null {
  const dir = process.env.GATEWAY_SHARED_KB_DIR;
  if (!dir || !dir.trim()) return null;
  return path.join(dir, 'kb.sqlite');
}

/**
 * Merge hit lists (per-agent + shared), keeping the best `limit`. bm25 scores are
 * corpus-relative — the value depends on each index's term/document statistics —
 * so scores from two independent FTS indexes are NOT on a comparable scale and a
 * global sort can spuriously rank one corpus over the other. Each list is already
 * sorted best-first within its own corpus, so interleave them round-robin for a
 * fair blend instead of a cross-corpus numeric sort.
 */
export function mergeHits<T extends SearchHit>(a: T[], b: T[], limit: number): T[] {
  const out: T[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < limit; i++) {
    if (i < a.length) out.push(a[i]);
    if (out.length < limit && i < b.length) out.push(b[i]);
  }
  return out;
}

/** Build an FTS5 MATCH string: quote each token so punctuation can't inject syntax. */
function toFtsMatch(query: string): string {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * Same tokenizing/quoting as `toFtsMatch`, but joined with OR and capped to
 * `maxTerms`. Used for "is anything like this already here?" lookups
 * (`findSimilarSharedNotes`), where an implicit-AND match across a whole
 * note's worth of terms would almost never hit — a near-duplicate rarely
 * repeats every single word of the seed text.
 */
function toFtsMatchOr(query: string, maxTerms = 12): string {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, maxTerms)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/**
 * Keyword search over the archive (FTS5 BM25). Returns [] when the index does
 * not exist yet or the query has no usable tokens. Read-only; never creates a DB.
 *
 * When `recordRetrievals` is set (planning-66), each returned entry's stable
 * `entry_hash` is appended to `kb_retrieval_log` through a SEPARATE, dedicated
 * writable handle AFTER the results are built — append-only and fire-and-forget,
 * so the read path never read-modify-writes chunk rows and never blocks/locks the
 * search response. The Node side folds this log into per-entry recency at GC time.
 */
/** True when kb_chunks carries the planning-66 `entry_hash` column. */
function hasEntryHashColumn(db: Database): boolean {
  const cols = db.query(`PRAGMA table_info(kb_chunks)`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === 'entry_hash');
}

/**
 * Idempotent, best-effort heal for a pre-#346 archive DB. The `entry_hash`
 * column is only added by the writer (`ArchiveDb` constructor migration); a
 * `kb.sqlite` that has not been reindexed since #346 still lacks it, so the
 * read-only search query below crashes with `no such column: entry_hash`. Add
 * the column in place via a short writable handle (mirroring the recall-logging
 * handle further down). A read-only filesystem simply skips — the column-aware
 * query then falls back to a NULL `entryHash` so search still returns hits.
 */
function ensureEntryHashColumn(dbPath: string): void {
  try {
    const w = new Database(dbPath);
    try {
      w.exec('PRAGMA busy_timeout=2000');
      if (!hasEntryHashColumn(w)) {
        w.exec(`ALTER TABLE kb_chunks ADD COLUMN entry_hash TEXT`);
        w.exec(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_entry_hash ON kb_chunks(entry_hash)`);
      }
    } finally {
      w.close();
    }
  } catch {
    /* read-only / locked DB — the column-aware query below degrades gracefully */
  }
}

/**
 * Core FTS5 query, shared by `searchArchive` (implicit-AND keyword search)
 * and `findSimilarSharedNotes` (OR-based near-duplicate lookup) — only the
 * MATCH expression differs between the two callers.
 */
function runFtsMatchQuery(dbPath: string, match: string, maxResults: number): SearchHit[] {
  // Heal pre-#346 DBs in place so the query never crashes on a missing column.
  ensureEntryHashColumn(dbPath);

  const db = new Database(dbPath, { readonly: true });
  // If the heal above could not run (read-only FS), select a NULL entry_hash
  // rather than referencing a column that does not exist.
  const entryHashSelect = hasEntryHashColumn(db) ? 'c.entry_hash' : 'NULL';
  try {
    const rows = db
      .query(
        `SELECT c.id AS id, c.path AS path, c.start_line AS startLine, c.end_line AS endLine,
                c.text AS text, ${entryHashSelect} AS entryHash, bm25(kb_chunks_fts) AS score,
                p.origin_class AS originClass, r.importance AS importance
         FROM kb_chunks_fts f
         JOIN kb_chunks c ON c.rowid_id = f.rowid
         LEFT JOIN kb_chunk_provenance p ON p.chunk_id = c.id
         LEFT JOIN kb_chunk_recall r ON r.chunk_id = c.id
         WHERE kb_chunks_fts MATCH ?
         ORDER BY bm25(kb_chunks_fts)
         LIMIT ?`,
      )
      .all(match, maxResults) as Array<{
      path: string;
      startLine: number;
      endLine: number;
      text: string;
      entryHash: string | null;
      score: number;
      originClass: string | null;
      importance: number | null;
    }>;
    return rows.map((r) => ({
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      score: r.score,
      snippet: r.text.length > 500 ? `${r.text.slice(0, 500)}…` : r.text,
      originClass: r.originClass,
      importance: r.importance,
      entryHash: r.entryHash,
    }));
  } finally {
    db.close();
  }
}

export function searchArchive(
  dbPath: string,
  query: string,
  maxResults: number,
  opts?: { recordRetrievals?: boolean; now?: number },
): SearchHit[] {
  if (!fs.existsSync(dbPath)) return [];
  const match = toFtsMatch(query);
  if (!match) return [];
  const hits = runFtsMatchQuery(dbPath, match, maxResults);

  // Recall counter (planning-66): fire-and-forget, append-only, best-effort. A
  // dedicated writable handle (WAL + busy_timeout so it never fails a concurrent
  // reindex) logs the retrieved entries AFTER the read handle is closed. Any error
  // is swallowed inside recordRetrievalHits — telemetry never fails a search.
  if (opts?.recordRetrievals && hits.length > 0) {
    try {
      const w = new Database(dbPath);
      try {
        w.exec('PRAGMA busy_timeout=2000');
        recordRetrievalHits(
          { run: (sql, params = []) => void w.query(sql).run(...(params as never[])) },
          hits.map((h) => h.entryHash),
          opts.now ?? Date.now(),
        );
      } finally {
        w.close();
      }
    } catch {
      /* best-effort telemetry — never affect the search response */
    }
  }
  return hits;
}

export function recordSharedPathRetrieval(dbPath: string, sourcePath: string, now = Date.now()): void {
  if (!fs.existsSync(dbPath)) return;
  try {
    const db = new Database(dbPath);
    try {
      db.exec('PRAGMA busy_timeout=2000');
      const rows = db
        .query('SELECT DISTINCT entry_hash FROM kb_chunks WHERE path = ? AND entry_hash IS NOT NULL')
        .all(sourcePath) as Array<{ entry_hash: string | null }>;
      recordRetrievalHits(
        { run: (sql, params = []) => void db.query(sql).run(...(params as never[])) },
        rows.map((r) => r.entry_hash),
        now,
      );
    } finally {
      db.close();
    }
  } catch {
    /* best-effort telemetry — never affect a direct read response */
  }
}

/**
 * Find shared notes whose content overlaps `seedText` (typically a new
 * note's name plus the opening of its content) — the basis of
 * `memory_shared_create`'s "does something like this already exist?" nudge.
 * Read-only, same missing-DB/empty-query behavior as `searchArchive`.
 */
export function findSimilarSharedNotes(dbPath: string, seedText: string, maxResults = 3): SearchHit[] {
  if (!fs.existsSync(dbPath)) return [];
  const match = toFtsMatchOr(seedText);
  if (!match) return [];
  return runFtsMatchQuery(dbPath, match, maxResults);
}

/** A memory-scoped path: MEMORY.md, USER.md, or memory/**.md — no traversal. */
export function isMemoryScopedPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  if (p.includes('..') || path.isAbsolute(p)) return false;
  if (p === 'MEMORY.md' || p === 'USER.md') return true;
  return p.startsWith('memory/') && p.endsWith('.md');
}

export interface Excerpt {
  path: string;
  from: number;
  to: number;
  text: string;
  totalLines: number;
  truncated: boolean;
}

/**
 * Bounded exact excerpt of a memory file by line range (1-indexed). Reads the
 * file directly (it is the source of truth). Returns null for an out-of-scope
 * path or a missing file.
 */
export function getExcerpt(
  workspaceDir: string,
  relPath: string,
  from = 1,
  lines = 200,
): Excerpt | null {
  // Validate and read the SAME normalized path so the check can't diverge from
  // what is actually opened.
  const rel = relPath.replace(/\\/g, '/');
  if (!isMemoryScopedPath(rel)) return null;
  const abs = path.join(workspaceDir, rel);
  if (!fs.existsSync(abs)) return null;
  // Containment against symlink escape: a memory/x.md symlink pointing outside
  // the workspace passes the string check but must not be readable through the
  // tool. Resolve real paths and require the target stays under the workspace.
  try {
    const realBase = fs.realpathSync(workspaceDir);
    const realTarget = fs.realpathSync(abs);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) return null;
  } catch {
    return null; // realpath failed (broken symlink, race) → refuse
  }

  const all = fs.readFileSync(abs, 'utf8').split('\n');
  const total = all.length;
  const start = Math.max(1, Math.floor(from));
  const count = Math.max(1, Math.floor(lines));
  const end = Math.min(total, start + count - 1);
  const slice = start > total ? [] : all.slice(start - 1, end);
  return {
    path: relPath,
    from: start,
    to: start > total ? start : end,
    text: slice.join('\n'),
    totalLines: total,
    truncated: end < total,
  };
}
