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

import type { AgentConfig, GatewayConfig } from '../types';
import { resolveMemoryBudget } from './workspace-loader';
import {
  ArchiveDB,
  archiveDbPath,
  resolveSharedConfig,
  sharedDbPath,
} from './knowledge';

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
  let chars = 0;
  try {
    chars = fs.statSync(filePath).size;
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

/** Count sources + chunks in a kb.sqlite WITHOUT creating it if absent. */
function archiveStats(dbPath: string, tokenizer = 'unicode61'): ArchiveStats {
  if (!fs.existsSync(dbPath)) return { exists: false, sources: 0, chunks: 0 };
  try {
    const db = ArchiveDB.forPath(dbPath, tokenizer);
    return { exists: true, sources: db.listSourcePaths().length, chunks: db.chunkCount() };
  } catch {
    return { exists: false, sources: 0, chunks: 0 };
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
