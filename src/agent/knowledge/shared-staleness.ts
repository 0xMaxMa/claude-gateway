/**
 * Shared-KB staleness GC (issue #392 part D) — the shared-vault twin of
 * `dreaming/staleness.ts`'s nightly per-agent GC, extending the SAME
 * `kb_entry_lifecycle` soft-invalidate model to the shared KB, which had none
 * at all (the shared vault's `kb_entry_lifecycle` table existed but was never
 * populated — `indexer.ts` only computed entry blocks for `source: 'memory'`).
 *
 * The unit of identity here is the WHOLE NOTE (`wholeNoteEntryBlock`), not a
 * bullet, so "moving a block" means moving the whole note. A stale note's
 * content is written byte-identical (so its entry_hash — and thus the
 * promote-back feedback loop — survives the move) to a `stale__<name>`
 * sibling note, then the original file is deleted; a note retrieved AFTER
 * being staled is moved back to its original name. This mirrors the personal
 * archive's "decluttering by physical relocation" without merging multiple
 * notes' content together (which would break entry-hash stability).
 *
 * Explicit `supersedes #N`-by-reference detection stays personal-only (issue
 * #392 scope note): shared notes have no visible numeric id, and round 1's
 * write-time merge/near-dup already provides de-facto content supersession.
 * Only TTL/retrieval-based soft-invalidation applies here.
 */

import { ArchiveDB, type LifecycleRow } from './archive-db';
import { decideStaleness } from '../dreaming/staleness';
import { indexSharedArchive } from './indexer';
import { wholeNoteEntryBlock } from './lifecycle';
import { readSharedNote, writeSharedNote, deleteSharedNoteFile, sharedNoteExists } from './shared-writer';
import { sharedDbPath } from './config';
import type { ResolvedKnowledgeSharedCfg } from './types';
import type { ResolvedStalenessCfg } from '../dreaming/types';

/** Prefix a staled note's file is moved under (issue #392 part D). */
export const STALE_NOTE_PREFIX = 'stale__';

export interface SharedStalenessResult {
  invalidated: number;
  promoted: number;
  skippedMoves: number;
  foldedLogRows: number;
}

const ZERO: SharedStalenessResult = { invalidated: 0, promoted: 0, skippedMoves: 0, foldedLogRows: 0 };

/** The note "name" (pre-slug) a lifecycle row's stored path corresponds to. */
function nameFromPath(relPath: string): string {
  return relPath.replace(/\.md$/i, '');
}

/**
 * Retire a live note: write its content byte-identical (after `comment`, which
 * `wholeNoteEntryBlock` skips when hashing) to `stale__<name>`, then delete the
 * original. Exported so both the TTL-based GC below and the reflection pass
 * (issue #392 part C, merging a note into a cluster's canonical note) share one
 * "move a note out of the active set" primitive. Returns false if the note is
 * missing/empty.
 */
export function retireSharedNote(cfg: ResolvedKnowledgeSharedCfg, name: string, comment: string): boolean {
  const content = readSharedNote(cfg, name);
  if (!content || !content.trim()) return false;
  const block = wholeNoteEntryBlock(content)[0];
  if (!block) return false;
  const staleName = `${STALE_NOTE_PREFIX}${name}`;
  writeSharedNote(cfg, staleName, `${comment}\n${block.text}`);
  if (deleteSharedNoteFile(cfg, name)) return true;
  // A failed delete must not leave a new stale duplicate behind or let callers
  // stamp this active note invalid. Best-effort rollback preserves the invariant
  // that a successful retirement has exactly one physical representation.
  deleteSharedNoteFile(cfg, staleName);
  return false;
}

/**
 * Move a live note to `stale__<name>`, preserving its content byte-identical
 * (after a leading `<!-- staled ... -->` marker line, which `wholeNoteEntryBlock`
 * skips when hashing) so the entry_hash — and therefore the promote-back
 * feedback loop — survives the move. Returns false (skip, don't stamp invalid)
 * if the note is missing/empty or the content no longer matches the block that
 * was scored (moved/edited concurrently).
 */
function moveNoteToStale(cfg: ResolvedKnowledgeSharedCfg, r: LifecycleRow, comment: string): boolean {
  const name = nameFromPath(r.path);
  const content = readSharedNote(cfg, name);
  if (!content) return false;
  const block = wholeNoteEntryBlock(content)[0];
  if (!block || block.entryHash !== r.entryHash) return false; // content changed since scoring
  return retireSharedNote(cfg, name, comment);
}

/** Move a staled note back to its original name (issue #392 promote-back). */
function moveNoteFromStale(cfg: ResolvedKnowledgeSharedCfg, r: LifecycleRow, comment: string): boolean {
  const staleName = nameFromPath(r.path); // r.path is the stale__<name> source path
  const content = readSharedNote(cfg, staleName);
  if (!content) return false;
  const block = wholeNoteEntryBlock(content)[0];
  if (!block || block.entryHash !== r.entryHash) return false;
  const originalName = staleName.startsWith(STALE_NOTE_PREFIX) ? staleName.slice(STALE_NOTE_PREFIX.length) : staleName;
  // Don't clobber a brand-new note that was created at the original name while
  // this one sat staled — leave it staled rather than lose the newer note.
  if (sharedNoteExists(cfg, originalName)) return false;
  writeSharedNote(cfg, originalName, `${comment}\n${block.text}`);
  deleteSharedNoteFile(cfg, staleName);
  return true;
}

/**
 * Run the shared-KB staleness GC. Never throws; on any error the vault is left
 * as-is. Deterministic given `opts.now`. Mirrors `runStalenessGc`'s shape.
 */
export function runSharedStalenessGc(
  cfg: ResolvedKnowledgeSharedCfg,
  staleCfg: ResolvedStalenessCfg,
  opts?: {
    now?: number;
    reindex?: (cfg: ResolvedKnowledgeSharedCfg) => void;
    openDb?: (cfg: ResolvedKnowledgeSharedCfg) => ArchiveDB;
  },
): SharedStalenessResult {
  if (!staleCfg.enabled) return { ...ZERO };
  const now = opts?.now ?? Date.now();
  const reindex = opts?.reindex ?? ((c: ResolvedKnowledgeSharedCfg) => void indexSharedArchive(c));
  const openDb = opts?.openDb ?? ((c: ResolvedKnowledgeSharedCfg) => ArchiveDB.forPath(sharedDbPath(c)));
  const result: SharedStalenessResult = { ...ZERO };

  try {
    // Ensure lifecycle rows exist for the current notes (first_seen etc).
    reindex(cfg);
    const db = openDb(cfg);

    if (staleCfg.recordRetrievals) result.foldedLogRows = db.aggregateRetrievalLog();

    // Every shared note is lifecycle-eligible (no evergreen/pinned distinction).
    const { invalidate, promote } = decideStaleness(db.listLifecycle(), staleCfg, now, () => true);
    const date = new Date(now).toISOString().slice(0, 10);

    for (const r of invalidate) {
      const comment = `<!-- staled ${date} (aged out, ${r.retrievalCount} retrievals) -->`;
      if (moveNoteToStale(cfg, r, comment)) {
        db.stampInvalid(r.entryHash, now);
        result.invalidated++;
      } else {
        result.skippedMoves++;
      }
    }

    for (const r of promote) {
      const comment = `<!-- restored ${date} (retrieved after invalidation) -->`;
      if (moveNoteFromStale(cfg, r, comment)) {
        db.stampInvalid(r.entryHash, null);
        result.promoted++;
      } else {
        result.skippedMoves++;
      }
    }

    if (result.invalidated + result.promoted > 0) reindex(cfg);
  } catch {
    /* best-effort — leave the vault untouched on any error */
  }
  return result;
}
