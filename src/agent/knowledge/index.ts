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
  resolveReflectionConfig,
  REFLECTION_DEFAULTS,
} from './config';
export type {
  KnowledgeSharedConfig,
  ResolvedKnowledgeSharedCfg,
  KnowledgeReflectionConfig,
  ResolvedKnowledgeReflectionCfg,
} from './types';
export {
  writeSharedNote,
  sharedNoteFilename,
  sharedNoteExists,
  readSharedNote,
  deleteSharedNoteFile,
  MAX_SHARED_NOTE_SIZE,
} from './shared-writer';
export { makeSharedPromoter } from './shared-promote';
export { findSimilarSharedNotes } from './shared-dedup';
export type { SimilarSharedNote } from './shared-dedup';
export { runSharedStalenessGc, retireSharedNote, STALE_NOTE_PREFIX } from './shared-staleness';
export type { SharedStalenessResult } from './shared-staleness';
export {
  SharedReflectionManager,
  connectedComponents,
  msUntilNextDailyTime,
  isConsolidationDay,
} from './reflection';
export type { ReflectionResult, SharedReflectionManagerDeps } from './reflection';
export { wholeNoteEntryBlock } from './lifecycle';
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
