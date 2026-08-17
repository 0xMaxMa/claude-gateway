/**
 * Memory metrics (planning-64 Measurement, absorbs planning-63 P4).
 *
 * Computes the 5 measures from data already on disk — memory files, the per-agent
 * and shared kb.sqlite indexes, and the dreaming audit (.dreaming/promotions.jsonl)
 * — plus the session-drop invariant. Read-only and cheap; opens a kb.sqlite only
 * when it already exists (never creates one as a side effect of reading metrics).
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

import type { AgentConfig, GatewayConfig } from '../types';
import { resolveMemoryBudget } from './workspace-loader';
import { archiveDbPath, resolveSharedConfig, sharedDbPath } from './knowledge';

export interface FileHygiene {
  chars: number;
  budget: number;
  utilization: number; // chars / budget (0 when budget disabled)
  overBudget: boolean;
}

export interface ArchiveStats {
  exists: boolean;
  sources: number;
  chunks: number;
}

export interface DreamingStats {
  runs: number; // audited proposal-bearing runs (lines are per-proposal; runs by distinct ts)
  proposals: number;
  applied: number;
  tokensSpent: number;
  lastRunISO: string | null;
}

export interface MemoryMetrics {
  agentId: string;
  /** #1 — memory-write-triggered session drops. Structurally 0 (Part A). */
  sessionDropIncidents: number;
  sessionDropNote: string;
  /** #2 — memory hygiene (budget utilization). */
  hygiene: { memory: FileHygiene; user: FileHygiene };
  /** archive coverage (the searchable backing for #3 adoption). */
  archive: ArchiveStats;
  shared: ArchiveStats & { enabled: boolean; project: string };
  /** #4 consolidation yield + #5 net-token (dreaming spend). */
  dreaming: DreamingStats;
}

function fileHygiene(filePath: string, budget: number): FileHygiene {
  // Count STRING LENGTH (code points as JS sees them), NOT byte size — this must
  // match the budget enforcement in workspace-loader (`content.length`). Byte size
  // over-counts multi-byte text (e.g. Thai = 3 bytes/char) and would report a file
  // as over budget while the live banner considers it fine.
  let chars = 0;
  try {
    chars = fs.readFileSync(filePath, 'utf8').length;
  } catch {
    chars = 0;
  }
  return {
    chars,
    budget,
    utilization: budget > 0 ? Number((chars / budget).toFixed(3)) : 0,
    overBudget: budget > 0 && chars > budget,
  };
}

/**
 * Count sources + chunks in a kb.sqlite WITHOUT creating it if absent and WITHOUT
 * a writable handle. This runs on the HTTP read path (event loop), so it opens a
 * short-lived READ-ONLY connection — no WAL/-shm sidecar creation, no schema DDL,
 * no cached handle (the #277 anti-pattern) — and closes it immediately. A failure
 * (locked/corrupt/read-only FS) degrades to `exists:false` and leaks nothing.
 */
function archiveStats(dbPath: string): ArchiveStats {
  if (!fs.existsSync(dbPath)) return { exists: false, sources: 0, chunks: 0 };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const s = db.prepare('SELECT count(*) AS n FROM kb_sources').get() as { n: number } | undefined;
    const c = db.prepare('SELECT count(*) AS n FROM kb_chunks').get() as { n: number } | undefined;
    return { exists: true, sources: Number(s?.n ?? 0), chunks: Number(c?.n ?? 0) };
  } catch {
    return { exists: false, sources: 0, chunks: 0 };
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
}

function dreamingStats(workspaceDir: string): DreamingStats {
  const jsonl = path.join(workspaceDir, '.dreaming', 'promotions.jsonl');
  const empty: DreamingStats = { runs: 0, proposals: 0, applied: 0, tokensSpent: 0, lastRunISO: null };
  let raw = '';
  try {
    raw = fs.readFileSync(jsonl, 'utf8');
  } catch {
    return empty;
  }
  const runs = new Set<number>();
  let proposals = 0;
  let lastTs = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { ts?: number };
      proposals++;
      if (typeof row.ts === 'number') {
        runs.add(row.ts);
        if (row.ts > lastTs) lastTs = row.ts;
      }
    } catch {
      /* skip malformed line */
    }
  }
  return {
    runs: runs.size,
    proposals,
    applied: 0, // per-op apply status is not recorded in the jsonl; run log carries counts
    tokensSpent: 0, // token spend lives in DREAMS.md summary, not the per-op jsonl
    lastRunISO: lastTs > 0 ? new Date(lastTs).toISOString() : null,
  };
}

export function computeMemoryMetrics(
  agentConfig: AgentConfig,
  gatewayConfig?: GatewayConfig,
): MemoryMetrics {
  const workspaceDir = agentConfig.workspace;
  const budget = resolveMemoryBudget({ ...gatewayConfig?.gateway?.memory, ...agentConfig.memory });
  const sharedCfg = resolveSharedConfig(agentConfig.knowledge?.shared, gatewayConfig?.gateway?.knowledge?.shared);

  return {
    agentId: agentConfig.id,
    sessionDropIncidents: 0,
    sessionDropNote:
      'Structurally 0: a memory-file write is classified memory-only and restarts no session (planning-63 Part A).',
    hygiene: {
      memory: fileHygiene(path.join(workspaceDir, 'MEMORY.md'), budget.memoryBudgetChars),
      user: fileHygiene(path.join(workspaceDir, 'USER.md'), budget.userBudgetChars),
    },
    archive: archiveStats(archiveDbPath(workspaceDir)),
    shared: {
      enabled: sharedCfg.enabled,
      project: sharedCfg.project,
      ...(sharedCfg.enabled ? archiveStats(sharedDbPath(sharedCfg)) : { exists: false, sources: 0, chunks: 0 }),
    },
    dreaming: dreamingStats(workspaceDir),
  };
}
