/**
 * Dreaming applier (planning-64 K4) — the ONLY path that mutates durable memory.
 *
 * Applies a reviewer's proposed ops to MEMORY.md / USER.md in `auto` mode, with
 * the safety properties from openclaw dreaming-consolidation + the planning-63 P3
 * findings:
 *   - **Backup first**: a rollback pre-image is written before any mutation.
 *   - **Ordered apply + anchor re-resolution**: ops are applied in order against
 *     the CURRENT (already-mutated) content, so a `replace`/`remove` anchor that a
 *     prior op moved is re-found (or the op is skipped, never misapplied).
 *   - **Bounded loss**: if the ops would delete more than `maxPriorLossFraction`
 *     of the file, the rewrite is rejected and only the `add`s are appended
 *     (append-only fallback) — a dream can never silently gut memory.
 *   - **Net-negative when over budget**: if the file is already over budget, an
 *     `add` that would grow it is skipped — a dream never enlarges an
 *     over-budget file (the core P3 fix).
 *   - **Atomic write + validation**: the result is written temp-then-rename and
 *     never leaves a previously-non-empty file empty (else rollback).
 *
 * Writing the file is enough to be restart-safe: a MEMORY.md/USER.md change is
 * classified memory-only (planning-63 Part A) → no session is restarted.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DreamProposal, DreamFile } from './types';

const DEFAULT_MAX_PRIOR_LOSS_FRACTION = 0.25; // openclaw default
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
}

export interface ApplyResult {
  files: ApplyFileResult[];
  totalApplied: number;
}

/** Backups dir for rollback pre-images. */
function backupsDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.dreaming', 'backups');
}

/** Write `content` to `file` atomically (temp in same dir + rename). */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-dream-${process.pid}-${process.hrtime.bigint().toString(36)}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Apply a single op to the current content, re-resolving its anchor against that
 * content. Returns the new content, or null when the op could not be applied
 * (anchor not found) so the caller can count it as skipped.
 */
function applyOp(content: string, p: DreamProposal): string | null {
  if (p.op === 'add') {
    const addition = (p.content ?? '').trim();
    if (!addition) return null;
    if (p.target) {
      // Insert after the anchor line if the anchor is present.
      const idx = content.indexOf(p.target);
      if (idx === -1) {
        // Anchor gone → append instead of failing (add is additive by nature).
        return `${content.replace(/\s*$/, '')}\n\n${addition}\n`;
      }
      const insertAt = idx + p.target.length;
      return `${content.slice(0, insertAt)}\n${addition}${content.slice(insertAt)}`;
    }
    return `${content.replace(/\s*$/, '')}\n\n${addition}\n`;
  }
  if (p.op === 'replace') {
    const target = p.target ?? '';
    if (!target || !content.includes(target)) return null; // anchor gone → skip
    return content.replace(target, (p.content ?? '').trim());
  }
  if (p.op === 'remove') {
    const target = p.target ?? '';
    if (!target || !content.includes(target)) return null;
    return content.replace(target, '');
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
  const original = (() => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  })();
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
  };
  if (proposals.length === 0) return base;

  // Backup pre-image BEFORE any mutation (rollback safety).
  const dir = backupsDir(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = path.join(dir, `${file}.${now}.bak`);
  atomicWrite(backupPath, original);

  // Apply ops in order, re-resolving anchors against the mutated content.
  let content = original;
  let applied = 0;
  let skipped = 0;
  for (const p of proposals) {
    // Net-negative gate: when over budget, an `add` that grows the file is skipped.
    if (overBudget && p.op === 'add') {
      skipped++;
      continue;
    }
    const next = applyOp(content, p);
    if (next === null) {
      skipped++;
      continue;
    }
    content = next;
    applied++;
  }

  // Bounded-loss gate: if the rewrite deleted too much, reject it and fall back to
  // append-only (apply just the `add`s, never the destructive replace/remove).
  const lossFraction = before > 0 ? Math.max(0, before - content.length) / before : 0;
  const rewriteRejected = applied > 0 && lossFraction > maxLossFraction;
  // Validation: never turn a previously-non-empty file into an empty one.
  const wouldEmpty = before > 0 && content.trim().length === 0;

  if (rewriteRejected || wouldEmpty) {
    let appended = original;
    let appendCount = 0;
    for (const p of proposals) {
      if (p.op !== 'add' || overBudget) continue; // append adds only; respect net-negative
      const next = applyOp(appended, { ...p, target: undefined }); // pure append
      if (next !== null) {
        appended = next;
        appendCount++;
      }
    }
    if (appendCount > 0 && appended !== original) {
      atomicWrite(filePath, appended);
      return { ...base, applied: appendCount, skipped: proposals.length - appendCount, mode: 'append-fallback', backupPath, bytesAfter: appended.length };
    }
    // Nothing safe to do → leave the file untouched.
    return { ...base, applied: 0, skipped: proposals.length, mode: 'none', backupPath };
  }

  if (applied === 0 || content === original) {
    return { ...base, applied: 0, skipped, mode: 'none', backupPath };
  }

  atomicWrite(filePath, content);
  return { ...base, applied, skipped, mode: 'rewrite', backupPath, bytesAfter: content.length };
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
  for (const file of MEMORY_FILES) {
    const forFile = proposals.filter((p) => p.file === file);
    const budget = file === 'MEMORY.md' ? opts.memoryBudgetChars : opts.userBudgetChars;
    try {
      const res = applyToFile(workspaceDir, file, forFile, budget, maxLoss, now);
      files.push(res);
      totalApplied += res.applied;
    } catch {
      files.push({
        file,
        applied: 0,
        skipped: forFile.length,
        mode: 'none',
        backupPath: null,
        bytesBefore: 0,
        bytesAfter: 0,
      });
    }
  }
  return { files, totalApplied };
}
