/**
 * Dreaming applier (planning-64 K4) — the ONLY path that mutates durable memory.
 *
 * Applies a reviewer's proposed ops to MEMORY.md / USER.md in `auto` mode, with
 * the safety properties from openclaw dreaming-consolidation + the planning-63 P3
 * findings:
 *   - **Backup first**: a rollback pre-image is written before any mutation.
 *   - **Ordered apply + unambiguous anchors**: ops are applied in order against
 *     the CURRENT (already-mutated) content; a `replace`/`remove` whose anchor is
 *     gone OR occurs more than once is skipped, never misapplied to the wrong
 *     occurrence. Anchor splicing is index-based (not `String.replace`) so `$`
 *     sequences in the new content are inserted literally.
 *   - **Bounded loss (gross)**: the guard measures GROSS original content deleted,
 *     not net length, so an `add` cannot mask a destructive `remove`/`replace`.
 *     Replaces are gated at `maxPriorLossFraction`; when over budget, removes (the
 *     shrink lever) may prune deeply but never near-total. If the guard trips, only
 *     the `add`s are appended (append-only fallback) — a dream can never silently
 *     gut memory.
 *   - **Net-negative when over budget**: if the file is already over budget, an
 *     `add` (or a `replace` that grows the file) is skipped — a dream never
 *     enlarges an over-budget file (the core P3 fix).
 *   - **Concurrency-safe (CAS)**: the on-disk content is re-checked against the
 *     snapshot immediately before the atomic rename; if a live agent edited the
 *     file meanwhile, the dream aborts rather than clobber that write.
 *   - **Atomic write + validation**: the result is written temp-then-rename and
 *     never leaves a previously-non-empty file empty (else rollback).
 *
 * Writing the file is enough to be restart-safe: a MEMORY.md/USER.md change is
 * classified memory-only (planning-63 Part A) → no session is restarted.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DreamProposal, DreamFile } from './types';

const DEFAULT_MAX_PRIOR_LOSS_FRACTION = 0.25; // openclaw default (replaces, and removes under budget)
// When the file is ALREADY over budget, removals are the intended shrink lever, so
// allow deep pruning — but never a near-total wipe (a runaway reviewer that removes
// almost everything is still rejected).
const OVER_BUDGET_MAX_REMOVE_FRACTION = 0.9;
const MAX_BACKUPS = 20; // retained rollback pre-images per file (prevents disk creep)
const MEMORY_FILES: DreamFile[] = ['MEMORY.md', 'USER.md'];

export interface ApplyOptions {
  /** Soft budget for MEMORY.md; USER.md uses userBudgetChars. 0 ⇒ no budget gate. */
  memoryBudgetChars: number;
  userBudgetChars: number;
  maxPriorLossFraction?: number;
}

export interface ApplyFileResult {
  file: DreamFile;
  applied: number;
  skipped: number;
  mode: 'rewrite' | 'append-fallback' | 'none';
  backupPath: string | null;
  bytesBefore: number;
  bytesAfter: number;
  /** The proposals actually applied to this file (used for shared promotion). */
  appliedProposals: DreamProposal[];
}

export interface ApplyResult {
  files: ApplyFileResult[];
  totalApplied: number;
  /** All proposals actually applied across files — the ONLY ones safe to promote. */
  appliedProposals: DreamProposal[];
}

/** Backups dir for rollback pre-images. */
function backupsDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.dreaming', 'backups');
}

/** Read the current on-disk content of a file, '' when absent/unreadable. */
function readOnDisk(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Write `content` to `file` atomically (temp in same dir + rename). */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-dream-${process.pid}-${process.hrtime.bigint().toString(36)}`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Don't leave a half-written temp behind on ENOSPC/EIO etc.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** Keep only the newest `keep` `<file>.<ts>.bak` pre-images; delete the rest. */
function pruneBackups(dir: string, file: DreamFile, keep: number): void {
  try {
    const prefix = `${file}.`;
    // The name embeds `.${now}.bak` with a fixed-width ms timestamp, so a
    // lexicographic sort is chronological (oldest first) for the foreseeable future.
    const entries = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.bak'))
      .sort();
    for (let i = 0; i < entries.length - keep; i++) {
      try {
        fs.rmSync(path.join(dir, entries[i]), { force: true });
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Write the rollback pre-image LAZILY — only once a mutation is actually about to
 * be committed (a no-op run leaves no backup) — then prune old pre-images.
 */
function writeBackup(workspaceDir: string, file: DreamFile, original: string, now: number): string {
  const dir = backupsDir(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = path.join(dir, `${file}.${now}.bak`);
  atomicWrite(backupPath, original);
  pruneBackups(dir, file, MAX_BACKUPS);
  return backupPath;
}

/** Result of applying one op: the new content plus how many ORIGINAL chars it deleted. */
interface OpApplied {
  next: string;
  deleted: number;
}

/**
 * Apply a single op to the current content, re-resolving its anchor against that
 * content. Returns the new content + deleted-char count, or null when the op could
 * not be applied (anchor gone OR ambiguous) so the caller can count it as skipped.
 */
function applyOp(content: string, p: DreamProposal): OpApplied | null {
  if (p.op === 'add') {
    const addition = (p.content ?? '').trim();
    if (!addition) return null;
    if (p.target) {
      // Insert after the anchor line if the anchor is present.
      const idx = content.indexOf(p.target);
      if (idx === -1) {
        // Anchor gone → append instead of failing (add is additive by nature).
        return { next: `${content.replace(/\s*$/, '')}\n\n${addition}\n`, deleted: 0 };
      }
      const insertAt = idx + p.target.length;
      return { next: `${content.slice(0, insertAt)}\n${addition}${content.slice(insertAt)}`, deleted: 0 };
    }
    return { next: `${content.replace(/\s*$/, '')}\n\n${addition}\n`, deleted: 0 };
  }
  if (p.op === 'replace' || p.op === 'remove') {
    const target = p.target ?? '';
    if (!target) return null;
    const first = content.indexOf(target);
    if (first === -1) return null; // anchor gone → skip
    // Ambiguous anchor: if the target occurs more than once we cannot know which
    // region the reviewer meant, so refuse rather than silently mutate the FIRST
    // occurrence (which may be the wrong one, or a copy just inserted by an `add`).
    if (content.indexOf(target, first + target.length) !== -1) return null;
    const replacement = p.op === 'replace' ? (p.content ?? '').trim() : '';
    // Splice by index — NOT String.replace — so `$`, `$&`, `` $` `` etc. in the
    // replacement are inserted literally, never interpreted as replacement patterns
    // ($-sequences are common in memory: `kill $$`, prices, shell snippets).
    const next = content.slice(0, first) + replacement + content.slice(first + target.length);
    return { next, deleted: target.length };
  }
  return null;
}

function applyToFile(
  workspaceDir: string,
  file: DreamFile,
  proposals: DreamProposal[],
  budgetChars: number,
  maxLossFraction: number,
  now: number,
): ApplyFileResult {
  const filePath = path.join(workspaceDir, file);
  const original = readOnDisk(filePath);
  const before = original.length;
  const overBudget = budgetChars > 0 && before > budgetChars;

  const base: ApplyFileResult = {
    file,
    applied: 0,
    skipped: 0,
    mode: 'none',
    backupPath: null,
    bytesBefore: before,
    bytesAfter: before,
    appliedProposals: [],
  };
  if (proposals.length === 0) return base;

  // Apply ops in order, re-resolving anchors against the mutated content. Track how
  // much ORIGINAL content is destroyed (GROSS) — measured against `original`, so an
  // `add` that refills length can't mask a big deletion, AND a chained edit that
  // targets content a PRIOR op introduced (e.g. AAA→BBB→CCC) is not double-counted
  // as original loss. A `remove` of original text loses its whole span; a `replace`
  // of original text loses only the net shrink (equal/longer replacements = intended
  // edit, ~0 loss).
  let content = original;
  let applied = 0;
  let skipped = 0;
  let deletedOriginal = 0;
  const appliedProposals: DreamProposal[] = [];
  for (const p of proposals) {
    // Net-negative gate: when over budget, an `add` that grows the file is skipped.
    if (overBudget && p.op === 'add') {
      skipped++;
      continue;
    }
    // Over budget, a `replace` whose new content is LONGER than its target grows the
    // file — that works against the shrink purpose, so skip it too.
    if (overBudget && p.op === 'replace') {
      const repl = (p.content ?? '').trim();
      if (repl.length > (p.target ?? '').length) {
        skipped++;
        continue;
      }
    }
    const r = applyOp(content, p);
    if (r === null) {
      skipped++;
      continue;
    }
    content = r.next;
    const t = p.target ?? '';
    if (p.op === 'remove') {
      if (t && original.includes(t)) deletedOriginal += t.length;
    } else if (p.op === 'replace') {
      const repl = (p.content ?? '').trim();
      if (t && original.includes(t)) deletedOriginal += Math.max(0, t.length - repl.length);
    }
    applied++;
    appliedProposals.push(p);
  }

  // Bounded-loss gate — GROSS original content destroyed, NOT net length. Under
  // budget it is capped at maxPriorLossFraction; when the file is already over
  // budget, deletions are the intended shrink lever, so the cap is raised (deep
  // pruning allowed) but never to a near-total wipe.
  const lossCap = overBudget ? OVER_BUDGET_MAX_REMOVE_FRACTION : maxLossFraction;
  const lossFraction = before > 0 ? deletedOriginal / before : 0;
  const rewriteRejected = applied > 0 && lossFraction > lossCap;
  // Validation: never turn a previously-non-empty file into an empty one.
  const wouldEmpty = before > 0 && content.trim().length === 0;

  if (rewriteRejected || wouldEmpty) {
    let appended = original;
    let appendCount = 0;
    const appendedProposals: DreamProposal[] = [];
    for (const p of proposals) {
      if (p.op !== 'add' || overBudget) continue; // append adds only; respect net-negative
      const r = applyOp(appended, { ...p, target: undefined }); // pure append
      if (r !== null) {
        appended = r.next;
        appendCount++;
        appendedProposals.push(p);
      }
    }
    if (appendCount > 0 && appended !== original) {
      // CAS: abort if a live agent edited the file since our snapshot (avoid
      // clobbering its write — our backup is the stale pre-image).
      if (readOnDisk(filePath) !== original) {
        return { ...base, applied: 0, skipped: proposals.length, mode: 'none', backupPath: null };
      }
      const backupPath = writeBackup(workspaceDir, file, original, now);
      atomicWrite(filePath, appended);
      return {
        ...base,
        applied: appendCount,
        skipped: proposals.length - appendCount,
        mode: 'append-fallback',
        backupPath,
        bytesAfter: appended.length,
        appliedProposals: appendedProposals,
      };
    }
    // Nothing safe to do → leave the file untouched (no backup written).
    return { ...base, applied: 0, skipped: proposals.length, mode: 'none', backupPath: null };
  }

  if (applied === 0 || content === original) {
    return { ...base, applied: 0, skipped, mode: 'none', backupPath: null };
  }

  // CAS: abort if the file changed underneath us since the snapshot.
  if (readOnDisk(filePath) !== original) {
    return { ...base, applied: 0, skipped: proposals.length, mode: 'none', backupPath: null };
  }
  const backupPath = writeBackup(workspaceDir, file, original, now);
  atomicWrite(filePath, content);
  return { ...base, applied, skipped, mode: 'rewrite', backupPath, bytesAfter: content.length, appliedProposals };
}

/**
 * Apply reviewer proposals to the agent's memory files (auto mode). Never throws;
 * on any per-file error that file is left untouched. Backups are kept under
 * `<workspace>/.dreaming/backups/`.
 */
export function applyDreamProposals(
  workspaceDir: string,
  proposals: DreamProposal[],
  opts: ApplyOptions,
  now: number = Date.now(),
): ApplyResult {
  const maxLoss = opts.maxPriorLossFraction ?? DEFAULT_MAX_PRIOR_LOSS_FRACTION;
  const files: ApplyFileResult[] = [];
  let totalApplied = 0;
  const appliedProposals: DreamProposal[] = [];
  for (const file of MEMORY_FILES) {
    const forFile = proposals.filter((p) => p.file === file);
    const budget = file === 'MEMORY.md' ? opts.memoryBudgetChars : opts.userBudgetChars;
    try {
      const res = applyToFile(workspaceDir, file, forFile, budget, maxLoss, now);
      files.push(res);
      totalApplied += res.applied;
      appliedProposals.push(...res.appliedProposals);
    } catch {
      files.push({
        file,
        applied: 0,
        skipped: forFile.length,
        mode: 'none',
        backupPath: null,
        bytesBefore: 0,
        bytesAfter: 0,
        appliedProposals: [],
      });
    }
  }
  return { files, totalApplied, appliedProposals };
}
