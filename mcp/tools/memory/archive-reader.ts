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

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number; // bm25 (lower = more relevant); surfaced for transparency
  snippet: string;
  originClass: string | null;
  importance: number | null;
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
 * Keyword search over the archive (FTS5 BM25). Returns [] when the index does
 * not exist yet or the query has no usable tokens. Read-only; never creates a DB.
 */
export function searchArchive(dbPath: string, query: string, maxResults: number): SearchHit[] {
  if (!fs.existsSync(dbPath)) return [];
  const match = toFtsMatch(query);
  if (!match) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT c.id AS id, c.path AS path, c.start_line AS startLine, c.end_line AS endLine,
                c.text AS text, bm25(kb_chunks_fts) AS score,
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
    }));
  } finally {
    db.close();
  }
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
