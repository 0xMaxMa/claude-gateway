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
export { indexAgentArchive, indexSharedArchive, archiveDbPath } from './indexer';
export { spawnArchiveReindex } from './reindex-spawn';
export {
  resolveArchiveConfig,
  ARCHIVE_DEFAULTS,
  resolveSharedConfig,
  SHARED_DEFAULTS,
  sharedVaultDir,
  sharedDbPath,
  sharedNotesDir,
} from './config';
export type { KnowledgeSharedConfig, ResolvedKnowledgeSharedCfg } from './types';
export { writeSharedNote, sharedNoteFilename } from './shared-writer';
export {
  compileWiki,
  parseWikiPage,
  extractLinks,
  buildBacklinks,
  buildDashboards,
  readVaultPages,
  graphFromPages,
  buildGraphModel,
} from './wiki';
export type {
  WikiPage,
  WikiClaim,
  Dashboards,
  WikiCompileResult,
  GraphNode,
  GraphEdge,
  GraphModel,
} from './wiki';
export { demoGraphModel, demoGraphModelSized, DEMO_MAX_SIZE } from './graph-demo';
export { chunkMarkdown } from './chunk';
export type { Chunk } from './chunk';
export { classifyOrigin } from './provenance';
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
