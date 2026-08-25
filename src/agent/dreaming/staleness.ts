/**
 * Archive staleness GC (planning-66) — the deterministic nightly pass that keeps
 * `memory_search` surfacing CURRENT truth.
 *
 * The Lane-2 archive accumulates stale / superseded entries. This pass, running
 * next to the compactor in `dreamOnce` (auto mode, before the LLM reviewer),
 * soft-invalidates them: superseded entries (deterministic same-`#id` detection),
 * aged-out entries (idle-since-last-retrieval past a TTL and rarely retrieved) are
 * MOVED to `memory/archive/stale.md` and stamped `invalid_at` — NEVER deleted, so
 * they stay `memory_search`-able (Zep bi-temporal: mark invalid, keep retrievable).
 * An entry that is retrieved AFTER it was invalidated is PROMOTED BACK to the
 * active archive (the recall feedback loop — proof we were wrong to age it out).
 *
 * This is a SEARCH-QUALITY fix, not a prompt-budget one: planning-65 already moved
 * task-log off the injected prompt. Everything here operates only on the
 * `memory/*.md` archive tier — never evergreen Lane-1 (MEMORY.md/USER.md), never
 * pinned files. Memory-only writes ⇒ no session restart (Part A). CAS + timestamped
 * backup guards every move (mirrors the compactor). The clock is injectable so the
 * TTL crossing is deterministic in tests.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ArchiveDB, type LifecycleRow } from '../knowledge/archive-db';
import { archiveDbPath, indexAgentArchive } from '../knowledge/indexer';
import {
  parseEntryBlocks,
  isArchiveTierPath,
  detectSupersessions,
  type EntryBlock,
} from '../knowledge/lifecycle';

/** Where soft-invalidated (staled) entries live — still indexed + searchable. */
export const STALE_REL_PATH = 'memory/archive/stale.md';
/** Where promoted-back (retrieved-after-invalidation) entries return to. */
export const RESTORED_REL_PATH = 'memory/archive/restored.md';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StalenessResult {
  invalidated: number; // entries moved to stale.md + stamped invalid_at
  promoted: number; // entries moved back out of stale.md (feedback)
  supersededMarked: number; // entries marked superseded_by this run
  foldedLogRows: number; // retrieval-log rows aggregated into lifecycle
  skippedMoves: number; // decided-but-not-moved (block not found / CAS lost)
}

const ZERO: StalenessResult = {
  invalidated: 0,
  promoted: 0,
  supersededMarked: 0,
  foldedLogRows: 0,
  skippedMoves: 0,
};

/**
 * PURE scoring/decision (planning-66). Given the lifecycle rows + resolved config +
 * a fixed clock, partition into entries to invalidate and entries to promote back.
 * No I/O — exhaustively unit-testable.
 *
 *  - Only LIVE (`invalid_at == null`) archive-tier, non-pinned, below-keepImportance
 *    entries are invalidation candidates. Within those: superseded OR
 *    (idle-past-TTL AND retrieved fewer than `minRetrievalKeep` times).
 *  - PROMOTE back any invalidated entry whose `last_retrieved` is newer than its
 *    `invalid_at` (it earned its keep after we aged it out).
 *
 * `isEligiblePath` (issue #392 part D) defaults to the personal-archive tier
 * check (`isArchiveTierPath`); the shared-vault GC passes `() => true` since
 * every shared note is lifecycle-eligible (there is no evergreen/pinned
 * distinction there).
 */
export function decideStaleness(
  rows: LifecycleRow[],
  cfg: { staleTtlDays: number; keepImportance: number; minRetrievalKeep: number },
  now: number,
  isEligiblePath: (path: string) => boolean = isArchiveTierPath,
): { invalidate: LifecycleRow[]; promote: LifecycleRow[] } {
  const ttlMs = cfg.staleTtlDays * DAY_MS;
  const invalidate: LifecycleRow[] = [];
  const promote: LifecycleRow[] = [];
  for (const r of rows) {
    if (r.invalidAt == null) {
      // Structurally exempt: evergreen/pinned never reach here (no lifecycle row),
      // but re-check the path defensively; importance is a non-decaying keep-axis.
      if (!isEligiblePath(r.path)) continue;
      if ((r.importance ?? 0) >= cfg.keepImportance) continue;
      const superseded = !!r.supersededBy;
      const idle = now - (r.lastRetrieved ?? r.firstSeen);
      const aged = idle > ttlMs && r.retrievalCount < cfg.minRetrievalKeep;
      if (superseded || aged) invalidate.push(r);
    } else if (r.lastRetrieved != null && r.lastRetrieved > r.invalidAt) {
      promote.push(r);
    }
  }
  return { invalidate, promote };
}

function readOnDisk(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Atomic write (temp in same dir + rename), mirroring the compactor. */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-stale-${process.pid}-${process.hrtime.bigint().toString(36)}`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** Rollback pre-image of a source file before the GC rewrite. Best-effort. */
function writeBackup(workspaceDir: string, relPath: string, original: string, now: number): void {
  try {
    const dir = path.join(workspaceDir, '.dreaming', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const safe = relPath.replace(/[\\/]/g, '__');
    atomicWrite(path.join(dir, `${safe}.${now}.stale.bak`), original);
  } catch {
    /* best-effort — a failed backup must not block the (append-first) move */
  }
}

/** Recursively collect archive-tier `*.md` files under `memory/` (workspace-rel). */
function walkArchiveFiles(workspaceDir: string): string[] {
  const out: string[] = [];
  const root = path.join(workspaceDir, 'memory');
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const rel = path.relative(workspaceDir, full).split(path.sep).join('/');
        if (isArchiveTierPath(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Run the nightly staleness GC against one agent's archive. Never throws; on any
 * error the archive is left as-is. Deterministic given `opts.now`.
 */
export function runStalenessGc(
  workspaceDir: string,
  cfg: {
    enabled: boolean;
    staleTtlDays: number;
    keepImportance: number;
    minRetrievalKeep: number;
    supersession: boolean;
    recordRetrievals: boolean;
  },
  opts?: {
    now?: number;
    reindex?: (workspaceDir: string) => void;
    openDb?: (workspaceDir: string) => ArchiveDB;
  },
): StalenessResult {
  if (!cfg.enabled) return { ...ZERO };
  const now = opts?.now ?? Date.now();
  const reindex = opts?.reindex ?? ((ws: string) => void indexAgentArchive(ws));
  const openDb = opts?.openDb ?? ((ws: string) => ArchiveDB.forPath(archiveDbPath(ws)));
  const result: StalenessResult = { ...ZERO };

  try {
    // Ensure lifecycle rows exist for the current archive files (first_seen etc).
    reindex(workspaceDir);
    const db = openDb(workspaceDir);

    // 1) Fold the read-path retrieval log into per-entry recency (LRU + feedback).
    if (cfg.recordRetrievals) result.foldedLogRows = db.aggregateRetrievalLog();

    // 2) Deterministic supersession over ALL archive blocks (acts immediately).
    if (cfg.supersession) result.supersededMarked = markSupersessions(workspaceDir, db);

    // 3) Score + decide from the fresh lifecycle.
    const { invalidate, promote } = decideStaleness(db.listLifecycle(), cfg, now);
    const date = new Date(now).toISOString().slice(0, 10);

    // 4) Soft-invalidate: move to stale.md + stamp invalid_at.
    for (const r of invalidate) {
      const comment = `<!-- staled ${date} from ${r.path}${r.supersededBy ? ' (superseded)' : ' (aged out)'} -->`;
      if (moveBlockClocked(workspaceDir, r.path, STALE_REL_PATH, r.entryHash, comment, now)) {
        db.stampInvalid(r.entryHash, now);
        result.invalidated++;
      } else {
        result.skippedMoves++;
      }
    }

    // 5) Feedback: promote retrieved-after-invalidation entries back to the active tier.
    for (const r of promote) {
      const comment = `<!-- restored ${date} (retrieved after invalidation) from ${r.path} -->`;
      if (moveBlockClocked(workspaceDir, r.path, RESTORED_REL_PATH, r.entryHash, comment, now)) {
        db.stampInvalid(r.entryHash, null);
        result.promoted++;
      } else {
        result.skippedMoves++;
      }
    }

    // 6) Reflect the moves in the index (paths + FTS) so search sees the new homes.
    if (result.invalidated + result.promoted > 0) reindex(workspaceDir);
  } catch {
    /* best-effort — leave the archive untouched on any error */
  }
  return result;
}

/**
 * Deterministic supersession pass: read every archive block, resolve which entries
 * a replacement-verb+`#id` marks superseded, and record it on the (live) lifecycle
 * row + provenance. Returns how many entries were newly marked.
 */
function markSupersessions(workspaceDir: string, db: ArchiveDB): number {
  const blocks: EntryBlock[] = [];
  for (const rel of walkArchiveFiles(workspaceDir)) {
    blocks.push(...parseEntryBlocks(readOnDisk(path.join(workspaceDir, rel))));
  }
  // Snapshot lifecycle once (getLifecycle re-scans the table on each call).
  const byHash = new Map(db.listLifecycle().map((l) => [l.entryHash, l]));
  let n = 0;
  for (const { targetHash, bySpec } of detectSupersessions(blocks)) {
    const life = byHash.get(targetHash);
    if (!life || life.invalidAt != null || life.supersededBy) continue; // only newly-mark live entries
    db.setSuperseded(targetHash, bySpec);
    db.setSupersedesKeyForEntry(targetHash, `superseded_by:${bySpec.slice(0, 12)}`);
    n++;
  }
  return n;
}

/** moveBlock with the GC clock threaded into the backup filename. */
function moveBlockClocked(
  workspaceDir: string,
  fromRel: string,
  toRel: string,
  entryHash: string,
  comment: string,
  now: number,
): boolean {
  const fromAbs = path.join(workspaceDir, fromRel);
  const original = readOnDisk(fromAbs);
  if (!original.trim()) return false;
  const block = parseEntryBlocks(original).find((b) => b.entryHash === entryHash);
  if (!block) return false;

  const lines = original.split('\n');
  const nextSource = [...lines.slice(0, block.startLine - 1), ...lines.slice(block.endLine)].join('\n');
  if (readOnDisk(fromAbs) !== original) return false; // early CAS

  const toAbs = path.join(workspaceDir, toRel);
  const existingDest = readOnDisk(toAbs);
  const destHead = existingDest
    ? existingDest.replace(/\s*$/, '') + '\n\n'
    : `# ${toRel === STALE_REL_PATH ? 'Soft-invalidated (stale) archive entries' : 'Promoted-back archive entries'}\n\nManaged by the nightly staleness GC (planning-66). Still searchable via \`memory_search\`.\n\n`;
  atomicWrite(toAbs, `${destHead}${comment}\n${block.text}\n`);

  if (readOnDisk(fromAbs) !== original) return true; // late CAS: dest has it, leave source
  writeBackup(workspaceDir, fromRel, original, now);
  atomicWrite(fromAbs, nextSource);
  return true;
}
