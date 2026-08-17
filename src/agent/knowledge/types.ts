/**
 * Two-lane memory: per-agent searchable archive (planning-64 K0).
 *
 * Types for the archive substrate — a SQLite/FTS5 index over an agent's
 * `memory/*.md` notes (plus the evergreen `MEMORY.md`/`USER.md`). K0 is dormant
 * infrastructure: it builds and populates the index; later phases (K1 tools,
 * K2 core-shrink, K4 applier) read from it. Nothing here touches the injected
 * prompt or spawns tools.
 */

/** Trust class of an indexed chunk. Fail-closed: unclassified ⇒ `untrusted`. */
export type OriginClass = 'owner' | 'agent' | 'untrusted' | 'system';

/** Session context a chunk was observed in (reserved for later promotion gating). */
export type SessionKind = 'interactive' | 'cron' | 'heartbeat' | 'subagent' | 'unknown';

/** Raw config shape under `gateway.knowledge.archive` (untyped JSON before resolve). */
export interface KnowledgeArchiveConfig {
  enabled?: boolean;
  tokenizer?: string; // FTS5 tokenizer: "unicode61" (default) | "trigram" | ...
  chunkTokens?: number; // target chunk size in ~tokens, default 400
  chunkOverlap?: number; // overlap between chunks in ~tokens, default 80
}

/** Resolved, sanitized archive config (all fields present). */
export interface ResolvedKnowledgeArchiveCfg {
  enabled: boolean;
  tokenizer: string;
  chunkTokens: number;
  chunkOverlap: number;
}

/** Raw config shape under `gateway.knowledge.shared` (planning-64 K3/K5). */
export interface KnowledgeSharedConfig {
  enabled?: boolean;
  project?: string;
  root?: string;
  mode?: 'propose' | 'auto';
  graph?: boolean; // K5: compile the memory-wiki graph/dashboards over the vault
}

/** Resolved, sanitized shared-KB config (all fields present). */
export interface ResolvedKnowledgeSharedCfg {
  enabled: boolean;
  project: string;
  root: string;
  mode: 'propose' | 'auto';
  graph: boolean;
}

/** One indexed source file. */
export interface ArchiveSourceRow {
  id: number;
  path: string; // workspace-relative POSIX path, e.g. "memory/foo.md"
  hash: string; // SHA-256 hex of file contents (change detection)
  mtime: number;
  size: number;
  source: string; // corpus tag, "memory" for K0
}

/** One indexed chunk. */
export interface ArchiveChunkRow {
  id: string; // "<sourcePath>#<startLine>-<endLine>"
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  updatedAt: number;
}

/** Recall metadata for a chunk (importance/triggers/project scoping). */
export interface ArchiveRecallRow {
  importance: number | null; // 1..10, null = neutral
  triggers: string | null; // free-form concept tags
  projectKey: string | null;
}

/** Provenance/trust metadata for a chunk. */
export interface ArchiveProvenanceRow {
  originClass: OriginClass;
  sessionKind: SessionKind;
  observedAt: number;
  supersedesKey: string | null;
}

/** Result of an index pass over one agent's memory files. */
export interface IndexResult {
  filesSeen: number;
  filesIndexed: number; // changed/new files that were (re)chunked
  filesSkipped: number; // unchanged (hash-guarded)
  filesRemoved: number; // sources pruned because the file disappeared
  chunksWritten: number;
}
