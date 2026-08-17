/**
 * Fire-and-forget archive reindex trigger (planning-64 K1).
 *
 * The gateway calls this at agent-session spawn to keep the searchable archive
 * fresh. It launches reindex-cli.ts as a DETACHED, unref'd subprocess so the
 * synchronous `node:sqlite` indexing runs entirely OFF the gateway event loop
 * (#277 lesson). No-op when the archive is disabled; never throws.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveArchiveConfig } from './config';
import type { KnowledgeArchiveConfig } from './types';

/**
 * Per-workspace debounce so a burst of session spawns (interactive + subagent +
 * cron + heartbeat) doesn't launch a stampede of reindex subprocesses all racing
 * the same kb.sqlite. The indexer is hash-guarded, so skipping a redundant run
 * within the window loses nothing.
 */
export const REINDEX_DEBOUNCE_MS = 30_000;
const lastReindexAt = new Map<string, number>();

/**
 * Debounce gate (pure, exported for tests): returns true and records `now` when a
 * reindex for `workspaceDir` is due, or false when one ran within the window.
 * `now` is injected so tests are deterministic.
 */
export function shouldReindexNow(workspaceDir: string, now: number): boolean {
  const last = lastReindexAt.get(workspaceDir);
  if (last !== undefined && now - last < REINDEX_DEBOUNCE_MS) return false;
  lastReindexAt.set(workspaceDir, now);
  return true;
}

export function spawnArchiveReindex(
  workspaceDir: string,
  agentCfg?: KnowledgeArchiveConfig,
  globalCfg?: KnowledgeArchiveConfig,
): void {
  try {
    const cfg = resolveArchiveConfig(agentCfg, globalCfg);
    if (!cfg.enabled) return;
    if (!shouldReindexNow(workspaceDir, Date.now())) return;
    // The compiled CLI sits next to this file under dist/agent/knowledge/. Skip
    // silently when it isn't present (e.g. ts-jest/dev runs against source) so we
    // never attempt a doomed spawn.
    const cliPath = path.join(__dirname, 'reindex-cli.js');
    if (!fs.existsSync(cliPath)) return;
    const child = spawn(process.execPath, [cliPath, workspaceDir, JSON.stringify(cfg)], {
      detached: true,
      stdio: 'ignore',
    });
    // A spawn failure (e.g. missing CLI in an odd build) must never affect the session.
    child.on('error', () => {
      /* swallowed */
    });
    child.unref();
  } catch {
    /* best-effort: reindex is never on the critical path of spawning a session */
  }
}
