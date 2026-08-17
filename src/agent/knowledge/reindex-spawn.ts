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

export function spawnArchiveReindex(
  workspaceDir: string,
  agentCfg?: KnowledgeArchiveConfig,
  globalCfg?: KnowledgeArchiveConfig,
): void {
  try {
    const cfg = resolveArchiveConfig(agentCfg, globalCfg);
    if (!cfg.enabled) return;
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
