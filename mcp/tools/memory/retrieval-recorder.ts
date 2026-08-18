/**
 * Runtime-agnostic append-only retrieval recorder (planning-66).
 *
 * The read path (`archive-reader.ts`) runs under Bun (`bun:sqlite`); the tests and
 * the src/ aggregator run under Node (`node:sqlite`). Both need to write the SAME
 * append-only `kb_retrieval_log` table, so the actual SQL lives here behind a tiny
 * `SqlRunner` seam that each runtime adapts to its own driver. This file imports
 * NO sqlite driver, so it is safe to import from a Node/jest test (importing
 * `archive-reader.ts` directly is not — it top-level-imports `bun:sqlite`).
 *
 * The recall counter is deliberately APPEND-ONLY and fire-and-forget: the Bun read
 * path must never read-modify-write chunk rows (that would break the "mcp reads
 * only / src writes" invariant and risk locking the hot search path). It only ever
 * INSERTs into a dedicated log table; the Node side aggregates that log into
 * `kb_entry_lifecycle.last_retrieved`/`retrieval_count` at GC time.
 */

/** Minimal write surface both `bun:sqlite` and `node:sqlite` can satisfy. */
export interface SqlRunner {
  run(sql: string, params?: unknown[]): void;
}

/** DDL for the append-only retrieval log. Idempotent; safe to call every write. */
export const RETRIEVAL_LOG_DDL =
  'CREATE TABLE IF NOT EXISTS kb_retrieval_log (' +
  'rowid_id INTEGER PRIMARY KEY AUTOINCREMENT, entry_hash TEXT NOT NULL, retrieved_at INTEGER NOT NULL)';

/** Ensure the log table exists (the Bun side may run before any Node index pass). */
export function ensureRetrievalLog(db: SqlRunner): void {
  db.run(RETRIEVAL_LOG_DDL);
}

/**
 * Append one retrieval event, keyed by the STABLE `entry_hash` (never the line-
 * based chunk id). Best-effort: a null/empty hash is ignored (a chunk outside any
 * entry block carries no lifecycle identity). Callers wrap this in try/catch and
 * never block their response on it.
 */
export function appendRetrieval(db: SqlRunner, entryHash: string | null | undefined, retrievedAt: number): void {
  if (!entryHash) return;
  ensureRetrievalLog(db);
  db.run('INSERT INTO kb_retrieval_log (entry_hash, retrieved_at) VALUES (?, ?)', [entryHash, retrievedAt]);
}

/**
 * Record a batch of retrieval hits (the entry_hashes of one search's results),
 * de-duplicated so a single search that returns two chunks of the same entry
 * counts once. Fire-and-forget; never throws out (errors are swallowed so a
 * telemetry write can never fail a search response).
 */
export function recordRetrievalHits(
  db: SqlRunner,
  entryHashes: Array<string | null | undefined>,
  retrievedAt: number,
): void {
  try {
    const seen = new Set<string>();
    for (const h of entryHashes) {
      if (!h || seen.has(h)) continue;
      seen.add(h);
      appendRetrieval(db, h, retrievedAt);
    }
  } catch {
    /* best-effort telemetry — never affect the search response */
  }
}
