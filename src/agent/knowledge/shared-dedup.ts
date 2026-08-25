/**
 * Node-native near-duplicate search over the shared vault's `kb.sqlite`
 * (planning-64 K3 follow-up / issue #386).
 *
 * The shared vault is indexed with the SAME `ArchiveDB` schema the per-agent
 * archive uses (`indexSharedArchive` in `indexer.ts` calls
 * `ArchiveDB.forPath(sharedDbPath(cfg), ...)`), so `ArchiveDB.searchSimilar`
 * works against it unmodified. This exists because the MCP tools'
 * `findSimilarSharedNotes` (`mcp/tools/memory/archive-reader.ts`) runs under
 * Bun (`bun:sqlite`) and cannot be imported from here — the Node gateway
 * process (`node:sqlite`). Same on-disk file, two bindings; keep both in sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ArchiveDB } from './archive-db';
import { sharedDbPath } from './config';
import type { ResolvedKnowledgeSharedCfg } from './types';

export interface SimilarSharedNote {
  /** The note's freeform name (its filename under notes/, minus `.md`). */
  name: string;
  snippet: string;
}

/**
 * Find shared notes whose content overlaps `seedText`. Read-only; returns []
 * when the shared index doesn't exist yet or the seed has no usable tokens.
 */
export function findSimilarSharedNotes(
  cfg: ResolvedKnowledgeSharedCfg,
  seedText: string,
  maxResults = 3,
): SimilarSharedNote[] {
  const dbPath = sharedDbPath(cfg);
  if (!fs.existsSync(dbPath)) return [];
  const db = ArchiveDB.forPath(dbPath);
  const hits = db.searchSimilar(seedText, maxResults);
  return hits.map((h) => ({
    name: path.basename(h.path, '.md'),
    snippet: h.text.length > 500 ? `${h.text.slice(0, 500)}…` : h.text,
  }));
}
