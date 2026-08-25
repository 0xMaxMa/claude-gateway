/**
 * Archive indexer (planning-64 K0).
 *
 * Walks an agent's memory files, chunks each, tags provenance, and writes them
 * into the per-agent `kb.sqlite`. Hash-guarded: an unchanged file is skipped;
 * a changed file is re-chunked and its stale chunks replaced; a file that
 * disappeared is pruned. Deterministic (timestamps come from file mtime, not the
 * wall clock) so a reindex of unchanged files is a true no-op.
 *
 * Synchronous by construction (node:sqlite + fs). Callers MUST invoke this OFF
 * the gateway event loop (nightly dreaming spawn / out-of-process). K0 does not
 * wire it into any gateway runtime path — it is dormant until K1.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ArchiveDB, ChunkWithMeta } from './archive-db';
import { chunkMarkdown } from './chunk';
import { classifyOrigin } from './provenance';
import { parseEntryBlocks, isArchiveTierPath, wholeNoteEntryBlock, type EntryBlock } from './lifecycle';
import {
  resolveArchiveConfig,
  resolveSharedConfig,
  sharedDbPath,
  sharedNotesDir,
  sharedVaultDir,
  ARCHIVE_DEFAULTS,
} from './config';
import { compileWiki } from './wiki';
import type {
  IndexResult,
  KnowledgeArchiveConfig,
  ResolvedKnowledgeArchiveCfg,
  KnowledgeSharedConfig,
  OriginClass,
} from './types';

/** Evergreen core files (indexed even though they live at the workspace root). */
const EVERGREEN_FILES = ['MEMORY.md', 'USER.md'];

/** Default location of an agent's archive DB (sibling to history.db). */
export function archiveDbPath(workspaceDir: string): string {
  // workspaceDir = agents/<id>/workspace ; the DB lives at agents/<id>/kb.sqlite
  return path.join(path.dirname(workspaceDir), 'kb.sqlite');
}

/** Recursively collect `*.md` files under a directory, as absolute paths. */
function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  // Sort for deterministic index order across runs/platforms.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    // Skip dotfiles — in particular a `.tmp-*` file left by a crashed shared-note
    // write must never be indexed as a real note.
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMarkdown(full));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

/** The set of memory files to index for an agent (absolute paths). */
function collectSourceFiles(workspaceDir: string): string[] {
  const files: string[] = [];
  for (const name of EVERGREEN_FILES) {
    const p = path.join(workspaceDir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push(p);
  }
  files.push(...walkMarkdown(path.join(workspaceDir, 'memory')));
  return files;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Workspace-relative POSIX path (for storage + provenance classification). */
function relPosix(workspaceDir: string, absFile: string): string {
  return path.relative(workspaceDir, absFile).split(path.sep).join('/');
}

/** The entry_hash of the block a chunk starts in, or null if it starts outside any. */
function blockHashForLine(blocks: EntryBlock[], line: number): string | null {
  for (const b of blocks) {
    if (line >= b.startLine && line <= b.endLine) return b.entryHash;
  }
  return null;
}

/**
 * Index one agent's archive. Returns per-run counts. A no-op (returns zeroed
 * counts) when the archive is disabled.
 *
 * @param workspaceDir the agent's workspace dir (agents/<id>/workspace)
 * @param agentCfg     per-agent `gateway.knowledge.archive` override
 * @param globalCfg    global `gateway.knowledge.archive`
 */
export function indexAgentArchive(
  workspaceDir: string,
  agentCfg?: KnowledgeArchiveConfig,
  globalCfg?: KnowledgeArchiveConfig,
): IndexResult {
  const cfg: ResolvedKnowledgeArchiveCfg = resolveArchiveConfig(agentCfg, globalCfg);
  const empty: IndexResult = {
    filesSeen: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesRemoved: 0,
    chunksWritten: 0,
  };
  if (!cfg.enabled) return empty;

  const db = ArchiveDB.forPath(archiveDbPath(workspaceDir), cfg.tokenizer);
  return reindexInto(db, {
    baseDir: workspaceDir,
    files: collectSourceFiles(workspaceDir),
    chunkTokens: cfg.chunkTokens,
    chunkOverlap: cfg.chunkOverlap,
    originFn: classifyOrigin,
    source: 'memory',
    projectKey: null,
  });
}

interface ReindexOpts {
  baseDir: string; // base for workspace-relative paths + the prune existence check
  files: string[]; // absolute file paths to index
  chunkTokens: number;
  chunkOverlap: number;
  originFn: (rel: string) => OriginClass; // provenance for a file
  source: string; // corpus tag: 'memory' | 'shared'
  projectKey: string | null; // recall project scoping
}

/**
 * Shared indexing core (used by both the per-agent and shared archives):
 * hash-guarded chunk+provenance write of each file, then prune only files that
 * genuinely disappeared. Deterministic (mtime-based) so unchanged input is a
 * true no-op.
 */
function reindexInto(db: ArchiveDB, opts: ReindexOpts): IndexResult {
  const result: IndexResult = {
    filesSeen: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesRemoved: 0,
    chunksWritten: 0,
  };
  const seenRel = new Set<string>();

  for (const abs of opts.files) {
    let content: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // race: file vanished mid-walk — treat as not present
    }
    const rel = relPosix(opts.baseDir, abs);
    seenRel.add(rel);
    result.filesSeen++;

    const hash = sha256(content);
    const existing = db.getSource(rel);
    if (existing && existing.hash === hash) {
      result.filesSkipped++; // hash-guarded: unchanged, no re-chunk
      continue;
    }

    const mtime = Math.floor(stat.mtimeMs);
    const origin = opts.originFn(rel);
    const chunks = chunkMarkdown(content, opts.chunkTokens, opts.chunkOverlap);
    // Entry-lifecycle identity (planning-66 / issue #392). Personal archive-tier
    // files get one entry per bullet/header block (evergreen Lane-1 and pinned
    // files are exempt, so the GC can never consider them). Shared-vault notes
    // (issue #392 part D) get ONE whole-file block each — a shared note's unit of
    // identity is the whole file, matching every other shared-KB operation. Each
    // FTS chunk inherits the entry_hash of the block it starts in; blocks are the
    // clean, movable unit the GC operates on (chunks are overlapping token windows
    // and must never be moved).
    const blocks =
      opts.source === 'memory' && isArchiveTierPath(rel)
        ? parseEntryBlocks(content)
        : opts.source === 'shared'
          ? wholeNoteEntryBlock(content)
          : [];
    const rows: ChunkWithMeta[] = chunks.map((c) => ({
      chunk: {
        id: `${rel}#${c.startLine}-${c.endLine}`,
        path: rel,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        updatedAt: mtime,
      },
      recall: { importance: null, triggers: null, projectKey: opts.projectKey },
      provenance: {
        originClass: origin,
        sessionKind: 'unknown', // file-indexed content carries no session context
        observedAt: mtime,
        supersedesKey: null,
      },
      entryHash: blocks.length ? blockHashForLine(blocks, c.startLine) : null,
    }));

    db.replaceSource(
      { path: rel, hash, mtime, size: stat.size, source: opts.source },
      rows,
      blocks.map((b) => ({ entryHash: b.entryHash, firstSeen: mtime })),
    );
    result.filesIndexed++;
    result.chunksWritten += rows.length;
  }

  // Prune sources whose file genuinely disappeared. A file that still exists but
  // whose stat/read threw a TRANSIENT error this run (EMFILE/EACCES/EINTR) is not
  // in `seenRel` either — but it must NOT be pruned, or a live note silently loses
  // its index between runs. Confirm real absence on disk before deleting.
  for (const rel of db.listSourcePaths()) {
    if (seenRel.has(rel)) continue;
    if (fs.existsSync(path.join(opts.baseDir, rel))) continue; // present but unreadable this run — keep
    db.deleteSource(rel);
    result.filesRemoved++;
  }

  return result;
}

/**
 * Index the SHARED, cross-agent vault (planning-64 K3): every `*.md` under the
 * project's `notes/` dir is chunked into the shared `kb.sqlite`. Shared notes are
 * authored by the owner's own agents (same trust domain) → provenance `agent`.
 * No-op when shared KB is disabled. Runs OFF the gateway event loop, same as the
 * per-agent indexer.
 */
export function indexSharedArchive(
  agentCfg?: KnowledgeSharedConfig,
  globalCfg?: KnowledgeSharedConfig,
): IndexResult {
  const empty: IndexResult = {
    filesSeen: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesRemoved: 0,
    chunksWritten: 0,
  };
  const cfg = resolveSharedConfig(agentCfg, globalCfg);
  if (!cfg.enabled) return empty;

  const notesDir = sharedNotesDir(cfg);
  const db = ArchiveDB.forPath(sharedDbPath(cfg), ARCHIVE_DEFAULTS.tokenizer);
  const result = reindexInto(db, {
    baseDir: notesDir,
    files: walkMarkdown(notesDir),
    chunkTokens: ARCHIVE_DEFAULTS.chunkTokens,
    chunkOverlap: ARCHIVE_DEFAULTS.chunkOverlap,
    originFn: () => 'agent',
    source: 'shared',
    projectKey: cfg.project,
  });

  // K5 (opt-in): compile the memory-wiki graph + dashboards over the whole vault.
  // Best-effort — a compile failure never affects indexing. mtime-free determinism
  // is not required here (reports are regenerated each run), so wall-clock `now` is
  // used for the staleness dashboard.
  if (cfg.graph) {
    try {
      compileWiki(sharedVaultDir(cfg), Date.now());
    } catch {
      /* best-effort */
    }
  }
  return result;
}
