/**
 * Two-lane memory: per-agent knowledge archive (planning-64 K0).
 *
 * Public surface of the archive substrate. K0 ships this as dormant
 * infrastructure — the index is built and queryable, but no gateway runtime path
 * calls it yet. Later phases consume it: K1 (`memory_search`/`memory_get` tools),
 * K2 (core shrink), K4 (dreaming applier), K3 (shared KB).
 */

export { ArchiveDB } from './archive-db';
export type { ChunkWithMeta } from './archive-db';
export { indexAgentArchive, archiveDbPath } from './indexer';
export { spawnArchiveReindex } from './reindex-spawn';
export { chunkMarkdown } from './chunk';
export type { Chunk } from './chunk';
export { classifyOrigin } from './provenance';
export { resolveArchiveConfig, ARCHIVE_DEFAULTS } from './config';
export type {
  KnowledgeArchiveConfig,
  ResolvedKnowledgeArchiveCfg,
  OriginClass,
  SessionKind,
  ArchiveSourceRow,
  ArchiveChunkRow,
  ArchiveRecallRow,
  ArchiveProvenanceRow,
  IndexResult,
} from './types';
