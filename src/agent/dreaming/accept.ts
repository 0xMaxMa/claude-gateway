/**
 * Manual accept of dreaming proposals (dashboard action).
 *
 * In `propose` mode the nightly reviewer only records its proposals to
 * `<workspace>/.dreaming/promotions.jsonl` — nothing is written to memory. This
 * module lets a human accept one or more of those recorded proposals from the
 * dashboard and apply them through the SAME K4 safe applier the auto mode uses
 * (backup pre-image + ordered anchor re-resolution + bounded-loss + net-negative
 * + CAS + never-empty). Writing MEMORY.md/USER.md is memory-only ⇒ no session
 * restart.
 *
 * Idempotency: each applied proposal is recorded to `<workspace>/.dreaming/
 * accepted.jsonl` keyed by `"<ts>:<index>"`. A proposal already accepted is
 * skipped on a repeat request. A proposal the applier *skipped* (stale anchor,
 * net-negative, etc.) is NOT recorded, so it can be retried later.
 *
 * Pure of any clock — `now` is injected so it stays unit-testable.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DREAMING_DIR } from './audit';
import { applyDreamProposals, type ApplyFileResult } from './applier';
import type { DreamProposal, DreamOpKind, DreamFile } from './types';

const OP_KINDS = new Set<DreamOpKind>(['add', 'replace', 'remove']);
const DREAM_FILES = new Set<DreamFile>(['MEMORY.md', 'USER.md']);

export interface AcceptOptions {
  memoryBudgetChars: number;
  userBudgetChars: number;
  /** Promote each applied `add` to the shared vault (only when shared KB is auto). */
  sharedPromote?: (p: DreamProposal) => void;
}

export interface AcceptResult {
  /** Proposals matched from the run after the index filter (before dedup). */
  requested: number;
  /** Ops the applier actually wrote to memory. */
  applied: number;
  /** Matched but not written this call (stale anchor, net-negative, over-budget add). */
  skipped: number;
  /** Excluded because a prior accept already applied them. */
  alreadyAccepted: number;
  /** Per-file applier outcome (for surfacing backup paths / byte deltas). */
  files: ApplyFileResult[];
  /** Rollback pre-image paths written this call. */
  backups: string[];
}

/** One promotions.jsonl object → a valid DreamProposal, or null if unusable. */
function coerceProposal(o: Record<string, unknown>): DreamProposal | null {
  const op = String(o.op ?? '') as DreamOpKind;
  const file = String(o.file ?? '') as DreamFile;
  if (!OP_KINDS.has(op) || !DREAM_FILES.has(file)) return null;
  const content = typeof o.content === 'string' ? o.content : undefined;
  const target = typeof o.target === 'string' ? o.target : undefined;
  // add needs content; replace/remove need an anchor — drop the rest.
  if (op === 'add' && !content) return null;
  if ((op === 'replace' || op === 'remove') && !target) return null;
  return {
    op,
    file,
    target,
    content,
    reason: String(o.reason ?? ''),
    score: Number(o.score) || 0,
    recallCount: Number(o.recallCount) || 0,
  };
}

/**
 * Ordered proposals for a single run (matched by `ts`), each with its index —
 * the position among that run's proposals, matching the report/UI ordering.
 * Malformed or unusable lines are skipped but still consume an index slot so
 * indexes stay aligned with what the report renders.
 */
export function loadRunProposals(
  workspaceDir: string,
  ts: number,
): Array<{ index: number; proposal: DreamProposal }> {
  const file = path.join(workspaceDir, DREAMING_DIR, 'promotions.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Array<{ index: number; proposal: DreamProposal }> = [];
  let index = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (Number(o.ts) !== ts) continue;
    const proposal = coerceProposal(o);
    // Consume an index slot even for an unusable line so indexes match the
    // report's per-run ordering (which also lists every proposal line).
    const slot = index++;
    if (proposal) out.push({ index: slot, proposal });
  }
  return out;
}

/** Set of `"<ts>:<index>"` keys already accepted for this agent. */
export function readAcceptedKeys(workspaceDir: string): Set<string> {
  const file = path.join(workspaceDir, DREAMING_DIR, 'accepted.jsonl');
  const keys = new Set<string>();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return keys;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      const ts = Number(o.ts);
      const idx = Number(o.index);
      if (Number.isFinite(ts) && Number.isFinite(idx)) keys.add(`${ts}:${idx}`);
    } catch {
      /* skip malformed line */
    }
  }
  return keys;
}

/**
 * Accept (apply) the selected proposals of one dreaming run.
 *
 * @param indexes proposal indexes to accept within the run, or `null` for all.
 */
export function acceptDreamProposals(
  workspaceDir: string,
  ts: number,
  indexes: number[] | null,
  opts: AcceptOptions,
  now: number = Date.now(),
): AcceptResult {
  const all = loadRunProposals(workspaceDir, ts);
  const wanted =
    indexes === null ? all : all.filter((x) => indexes.includes(x.index));

  const acceptedKeys = readAcceptedKeys(workspaceDir);
  const already = wanted.filter((x) => acceptedKeys.has(`${ts}:${x.index}`));
  const fresh = wanted.filter((x) => !acceptedKeys.has(`${ts}:${x.index}`));

  if (fresh.length === 0) {
    return {
      requested: wanted.length,
      applied: 0,
      skipped: 0,
      alreadyAccepted: already.length,
      files: [],
      backups: [],
    };
  }

  const res = applyDreamProposals(
    workspaceDir,
    fresh.map((x) => x.proposal),
    { memoryBudgetChars: opts.memoryBudgetChars, userBudgetChars: opts.userBudgetChars },
    now,
  );

  // Identity match: applyDreamProposals returns the SAME proposal objects it
  // actually wrote, so a reference Set maps applied ops back to their indexes.
  const appliedSet = new Set(res.appliedProposals);
  const acceptedRecords: string[] = [];
  for (const x of fresh) {
    if (!appliedSet.has(x.proposal)) continue;
    acceptedRecords.push(
      JSON.stringify({
        ts,
        index: x.index,
        file: x.proposal.file,
        op: x.proposal.op,
        acceptedAt: now,
      }),
    );
    // Shared promotion mirrors the nightly auto path: only applied `add`s.
    if (opts.sharedPromote && x.proposal.op === 'add' && x.proposal.content) {
      try {
        opts.sharedPromote(x.proposal);
      } catch {
        /* best-effort — a promotion failure never fails the local accept */
      }
    }
  }

  if (acceptedRecords.length) {
    try {
      const dir = path.join(workspaceDir, DREAMING_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, 'accepted.jsonl'),
        acceptedRecords.join('\n') + '\n',
        'utf8',
      );
    } catch {
      /* best-effort audit — the memory write already committed */
    }
  }

  return {
    requested: wanted.length,
    applied: res.totalApplied,
    skipped: fresh.length - res.totalApplied,
    alreadyAccepted: already.length,
    files: res.files,
    backups: res.files.map((f) => f.backupPath).filter((b): b is string => !!b),
  };
}
