/**
 * One-shot memory migration (planning-65) — drain an over-budget MEMORY.md that
 * accumulated task-log before write-routing existed.
 *
 * Two deterministic passes, both non-destructive (content is relocated, never
 * deleted — everything stays searchable via `memory_search`):
 *
 *   Pass 1 — terminal sweep: reuse the shipped compactor (#337) to move
 *   MERGED/CLOSED/✅-marked blocks to `memory/archive/completed.md`.
 *
 *   Pass 2 — episodic route-out: an injected classifier (`routeOut`, in
 *   production a print-only reviewer) proposes which REMAINING MEMORY.md blocks
 *   are episodic task-log. Each surviving proposal moves the block's text to
 *   `memory/<topic>.md` and removes the block from MEMORY.md. Pinned sections
 *   (`## User`, `## Feedback`, `## Preferences`) are hard-excluded — never moved.
 *
 * `mode:"propose"` writes a `.dreaming/migration-plan.md` review file and mutates
 * MEMORY.md not at all (beyond Pass 1's deterministic sweep, which is always safe
 * and idempotent). `mode:"apply"` performs the moves (archive-first, then one
 * backed-up atomic rewrite of MEMORY.md).
 */

import * as fs from 'fs';
import * as path from 'path';

import { compactCompletedEntries } from './compactor';
import { appendEpisodicNote, DEFAULT_EPISODIC_DIR, isValidTopicSlug } from './episodic';
import { DREAMING_DIR } from './audit';
import type { ClaudeSpawnFn } from '../skill-learning/reviewer';
import type { DreamProposal } from './types';

/** h2 sections whose entries are durable and must NEVER be routed to episodic. */
const PINNED_SECTION_RE = /^##\s+(user|feedback|preference|preferences|profile)\b/i;
const SECTION_RE = /^#{1,2}\s/;

export type MigrateMode = 'propose' | 'apply';

export interface MigrateOptions {
  mode: MigrateMode;
  /**
   * Classifier that, given the (post-sweep) MEMORY.md, returns episodic-move
   * proposals: `{op:'add', tier:'episodic', topic, content, target}` where
   * `target` is the exact MEMORY.md block text to remove. Injected so it is
   * fully testable without a live model; production wraps the dream reviewer.
   */
  routeOut?: (memory: string) => Promise<DreamProposal[]> | DreamProposal[];
  /** Episodic archive dir (relative to workspace). Default "memory". */
  episodicArchiveDir?: string;
  /**
   * planning-67: skip Pass 1 (terminal sweep). The nightly dream already runs
   * the compactor before this call, so re-running it would be a redundant no-op;
   * the embedded route-out stage sets this to go straight to Pass 2.
   */
  skipTerminalSweep?: boolean;
  now?: number;
}

export interface MigrateResult {
  /** Terminal-state blocks archived by the compactor sweep (Pass 1). */
  terminalArchived: number;
  /** Episodic blocks moved to memory/<topic>.md (Pass 2, apply mode only). */
  episodicMoved: number;
  /** Episodic-move proposals that survived validation (propose + apply). */
  episodicPlanned: number;
  /** Path to the written migration-plan.md (propose mode). */
  planPath?: string;
  memoryCharsBefore: number;
  memoryCharsAfter: number;
}

function readOnDisk(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-migrate-${process.pid}-${process.hrtime.bigint().toString(36)}`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

/** Char range [start,end) of each pinned section in `memory` (heading → next h1/h2). */
export function pinnedRanges(memory: string): Array<[number, number]> {
  const lines = memory.split('\n');
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let openStart = -1;
  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for the split '\n'
    if (SECTION_RE.test(line)) {
      // Close a currently-open pinned section at this heading.
      if (openStart >= 0) {
        ranges.push([openStart, offset]);
        openStart = -1;
      }
      if (PINNED_SECTION_RE.test(line)) openStart = offset;
    }
    offset += lineLen;
  }
  if (openStart >= 0) ranges.push([openStart, memory.length]);
  return ranges;
}

function inPinned(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => index >= s && index < e);
}

/** True iff the block at `original.indexOf(target)` sits inside a pinned section. */
export function isTargetPinned(memory: string, target: string): boolean {
  if (!target) return false;
  const at = memory.indexOf(target);
  if (at === -1) return false;
  return inPinned(at, pinnedRanges(memory));
}

interface PlannedMove {
  proposal: DreamProposal;
  index: number; // start offset of the target block in MEMORY.md
}

/**
 * Validate route-out proposals against the current MEMORY.md: keep only episodic
 * `add`s with a topic + content whose `target` block occurs EXACTLY once and is
 * NOT inside a pinned section.
 */
function planMoves(memory: string, proposals: DreamProposal[]): PlannedMove[] {
  const ranges = pinnedRanges(memory);
  const out: PlannedMove[] = [];
  for (const p of proposals) {
    if (p.tier !== 'episodic' || p.op !== 'add' || !p.topic || !p.content) continue;
    const target = p.target ?? '';
    if (!target) continue;
    const first = memory.indexOf(target);
    if (first === -1) continue; // block not found → skip
    if (memory.indexOf(target, first + target.length) !== -1) continue; // ambiguous → skip
    if (inPinned(first, ranges)) continue; // pinned section → never move
    out.push({ proposal: p, index: first });
  }
  return out;
}

/** Remove each planned block from `memory` in one pass (splice by index, desc). */
function removeBlocks(memory: string, planned: PlannedMove[]): string {
  let next = memory;
  const sorted = [...planned].sort((a, b) => b.index - a.index);
  for (const { proposal, index } of sorted) {
    const target = proposal.target ?? '';
    // Re-resolve against the ORIGINAL memory offset; splice literally.
    next = next.slice(0, index) + next.slice(index + target.length);
  }
  // Collapse the blank-line gaps left by removed blocks.
  return next.replace(/\n{3,}/g, '\n\n');
}

/**
 * Run the migration. Never throws on a per-pass error — returns what it managed
 * to do. In `apply` mode the episodic notes are written BEFORE MEMORY.md is
 * rewritten (archive-first), and MEMORY.md is backed up before the atomic write.
 */
export async function migrateMemory(
  workspaceDir: string,
  opts: MigrateOptions,
): Promise<MigrateResult> {
  const now = opts.now ?? Date.now();
  const episodicDir = opts.episodicArchiveDir || DEFAULT_EPISODIC_DIR;
  const memPath = path.join(workspaceDir, 'MEMORY.md');
  const before = readOnDisk(memPath).length;

  // Pass 1 — deterministic terminal sweep (always safe, idempotent). Skipped by
  // the nightly dream, which already ran the compactor this tick (planning-67).
  let terminalArchived = 0;
  if (!opts.skipTerminalSweep) {
    try {
      terminalArchived = compactCompletedEntries(workspaceDir, now).archivedCount;
    } catch {
      terminalArchived = 0;
    }
  }

  // Pass 2 — episodic route-out (gated on an injected classifier).
  const memory = readOnDisk(memPath);
  let planned: PlannedMove[] = [];
  if (opts.routeOut && memory.trim()) {
    let proposals: DreamProposal[] = [];
    try {
      proposals = (await opts.routeOut(memory)) ?? [];
    } catch {
      proposals = [];
    }
    planned = planMoves(memory, proposals);
  }

  if (opts.mode === 'propose') {
    // Write a human-review plan; mutate MEMORY.md not at all in Pass 2.
    let planPath: string | undefined;
    try {
      const dir = path.join(workspaceDir, DREAMING_DIR);
      fs.mkdirSync(dir, { recursive: true });
      planPath = path.join(dir, 'migration-plan.md');
      const lines = [
        '# Memory migration plan (planning-65)',
        '',
        `Terminal sweep archived: ${terminalArchived} block(s) → memory/archive/completed.md`,
        `Episodic route-out proposed: ${planned.length} block(s)`,
        '',
        '## Proposed episodic moves (MEMORY.md → memory/<topic>.md)',
        '',
        ...planned.map(
          (m) =>
            `- → \`memory/${m.proposal.topic}.md\` — ${m.proposal.reason || '(episodic task-log)'}\n` +
            `  \`\`\`\n  ${(m.proposal.target ?? '').replace(/\n/g, '\n  ')}\n  \`\`\``,
        ),
        '',
        '_Run with --apply to perform these moves (pinned sections excluded, content stays searchable)._',
      ];
      atomicWrite(planPath, lines.join('\n') + '\n');
    } catch {
      planPath = undefined;
    }
    return {
      terminalArchived,
      episodicMoved: 0,
      episodicPlanned: planned.length,
      planPath,
      memoryCharsBefore: before,
      memoryCharsAfter: readOnDisk(memPath).length,
    };
  }

  // apply mode — archive first, then one backed-up rewrite of MEMORY.md.
  let episodicMoved = 0;
  if (planned.length > 0) {
    const moved: PlannedMove[] = [];
    for (const m of planned) {
      const res = appendEpisodicNote(workspaceDir, episodicDir, m.proposal.topic!, m.proposal.content!, now);
      if (res.ok) moved.push(m);
    }
    if (moved.length > 0) {
      // CAS: only rewrite if MEMORY.md is unchanged since we read it.
      if (readOnDisk(memPath) === memory) {
        const next = removeBlocks(memory, moved);
        try {
          const dir = path.join(workspaceDir, DREAMING_DIR, 'backups');
          fs.mkdirSync(dir, { recursive: true });
          atomicWrite(path.join(dir, `MEMORY.md.${now}.migrate.bak`), memory);
        } catch {
          /* best-effort backup */
        }
        atomicWrite(memPath, next);
        episodicMoved = moved.length;
      }
    }
  }

  return {
    terminalArchived,
    episodicMoved,
    episodicPlanned: planned.length,
    memoryCharsBefore: before,
    memoryCharsAfter: readOnDisk(memPath).length,
  };
}

// ── Route-out classifier (shared by the migrate CLI and the nightly dream) ──────

const ROUTE_OUT_PROMPT = `You migrate an AI agent's MEMORY.md. MEMORY.md is injected into every prompt, so it must hold ONLY durable facts (user preferences, standing rules, identity, lessons). EPISODIC task-log — a record of what happened (completed/merged work, PR/issue status, dated progress notes) — must move to a searchable archive.

You are given the current MEMORY.md. Identify the blocks that are EPISODIC task-log and should move out. For each, return the EXACT block text to remove (verbatim, so it can be located) and the note to archive.

NEVER move blocks under a "## User", "## Feedback", or "## Preferences" section — those are durable and pinned.

Respond with STRICT JSON only (no prose/fences):
{"moves":[{"target":"<exact block text from MEMORY.md to remove>","topic":"<lowercase-kebab-slug>","content":"<text to archive>","reason":"<why episodic>"}]}
- topic MUST match ^[a-z0-9-]{1,64}$. moves: [] if nothing should move.`;

/** Extract the first balanced top-level JSON object from free text (fence-safe). */
function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Unwrap a `claude -p --output-format json` envelope, else return stdout as-is. */
function parseEnvelope(stdout: string): string {
  try {
    const env = JSON.parse(stdout) as Record<string, unknown>;
    return typeof env['result'] === 'string' ? (env['result'] as string) : stdout;
  } catch {
    return stdout;
  }
}

/**
 * Build the injected route-out classifier that `migrateMemory` consumes, backed by
 * a print-only claude spawn (no tools, untrusted input — same safety model as the
 * dreaming reviewer). Injectable `spawn` keeps it fully testable without a model.
 */
export function makeRouteOut(spawn: ClaudeSpawnFn): (memory: string) => Promise<DreamProposal[]> {
  return async (memory: string): Promise<DreamProposal[]> => {
    const prompt = `${ROUTE_OUT_PROMPT}\n\n<current_memory>\n${memory}\n</current_memory>\n\nOutput the JSON now:`;
    let stdout = '';
    try {
      const r = await spawn([], prompt);
      if (r.timedOut) return [];
      stdout = r.stdout;
    } catch {
      return [];
    }
    const jsonStr = extractJson(parseEnvelope(stdout));
    if (!jsonStr) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return [];
    }
    const moves = (parsed as Record<string, unknown>)?.['moves'];
    if (!Array.isArray(moves)) return [];
    const out: DreamProposal[] = [];
    for (const m of moves) {
      if (!m || typeof m !== 'object') continue;
      const o = m as Record<string, unknown>;
      const target = typeof o['target'] === 'string' ? o['target'] : '';
      const content = typeof o['content'] === 'string' ? o['content'] : '';
      const topic = o['topic'];
      if (!target || !content || !isValidTopicSlug(topic)) continue;
      out.push({
        op: 'add',
        tier: 'episodic',
        topic,
        content,
        target,
        reason: typeof o['reason'] === 'string' ? o['reason'] : '',
        score: 1,
        recallCount: 0,
      });
    }
    return out;
  };
}
