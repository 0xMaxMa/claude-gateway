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
import { resolveArchiveConfig } from './config';
import type { IndexResult, KnowledgeArchiveConfig, ResolvedKnowledgeArchiveCfg } from './types';

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
  for (const e of entries) {
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
  const result: IndexResult = { ...empty };

  const files = collectSourceFiles(workspaceDir);
  const seenRel = new Set<string>();

  for (const abs of files) {
    let content: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // race: file vanished mid-walk — treat as not present
    }
    const rel = relPosix(workspaceDir, abs);
    seenRel.add(rel);
    result.filesSeen++;

    const hash = sha256(content);
    const existing = db.getSource(rel);
    if (existing && existing.hash === hash) {
      result.filesSkipped++; // hash-guarded: unchanged, no re-chunk
      continue;
    }

    const mtime = Math.floor(stat.mtimeMs);
    const origin = classifyOrigin(rel);
    const chunks = chunkMarkdown(content, cfg.chunkTokens, cfg.chunkOverlap);
    const rows: ChunkWithMeta[] = chunks.map((c) => ({
      chunk: {
        id: `${rel}#${c.startLine}-${c.endLine}`,
        path: rel,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        updatedAt: mtime,
      },
      recall: { importance: null, triggers: null, projectKey: null },
      provenance: {
        originClass: origin,
        sessionKind: 'unknown', // file-indexed content carries no session context in K0
        observedAt: mtime,
        supersedesKey: null,
      },
    }));

    db.replaceSource(
      { path: rel, hash, mtime, size: stat.size, source: 'memory' },
      rows,
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
    if (fs.existsSync(path.join(workspaceDir, rel))) continue; // present but unreadable this run — keep
    db.deleteSource(rel);
    result.filesRemoved++;
  }

  return result;
}
