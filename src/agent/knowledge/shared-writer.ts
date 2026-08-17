/**
 * Atomic writer for the shared KB notes dir (planning-64 K3).
 *
 * Multiple agents (each in its own gateway subprocess) may contribute to the same
 * shared vault. Two safety properties make that correct WITHOUT an in-process lock
 * (an in-process mutex wouldn't coordinate across separate processes anyway):
 *   1. Note files are written **write-temp + atomic rename**, so a concurrent
 *      reader/indexer never observes a partially-written note (same-file races
 *      resolve to last-write-wins, never corruption).
 *   2. The shared SQLite index is guarded by `PRAGMA busy_timeout` (archive-db),
 *      which serializes concurrent writers ACROSS processes.
 *
 * Note names are slugified to a single safe path segment — a caller can never
 * escape the notes dir.
 */

import * as fs from 'fs';
import * as path from 'path';
import { sharedNotesDir } from './config';
import type { ResolvedKnowledgeSharedCfg } from './types';

// Monotonic per-process counter so concurrent writes within one process still get
// distinct temp names (combined with pid for cross-process uniqueness).
let tmpCounter = 0;

/** Reduce an arbitrary name to one safe `*.md` path segment (no traversal). */
export function sharedNoteFilename(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
  return `${base || 'note'}.md`;
}

/**
 * Write a note into the shared vault's notes dir atomically. Returns the absolute
 * path written. Creates the notes dir if missing.
 */
export function writeSharedNote(cfg: ResolvedKnowledgeSharedCfg, name: string, content: string): string {
  const dir = sharedNotesDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, sharedNoteFilename(name));
  // Unique temp in the SAME dir so the rename is atomic (same filesystem).
  const tmp = path.join(dir, `.tmp-${process.pid}-${(tmpCounter += 1)}-${process.hrtime.bigint().toString(36)}.md`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target); // atomic replace
  return target;
}
