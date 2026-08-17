#!/usr/bin/env node
/**
 * Standalone archive reindex entry (planning-64 K1).
 *
 * Run by the gateway as a DETACHED, unref'd subprocess so the synchronous
 * `node:sqlite` indexing never blocks the gateway event loop (#277 lesson). The
 * indexer is hash-guarded, so an unchanged workspace is a cheap no-op.
 *
 * Usage: node reindex-cli.js <workspaceDir> [<resolvedArchiveCfgJson>]
 * Best-effort: any failure exits 0 without disturbing the gateway.
 */

import { indexAgentArchive } from './indexer';
import type { KnowledgeArchiveConfig } from './types';

function main(): void {
  const workspaceDir = process.argv[2];
  if (!workspaceDir) return;

  let cfg: KnowledgeArchiveConfig | undefined;
  try {
    cfg = process.argv[3] ? (JSON.parse(process.argv[3]) as KnowledgeArchiveConfig) : undefined;
  } catch {
    cfg = undefined; // malformed arg → fall back to defaults
  }

  try {
    indexAgentArchive(workspaceDir, cfg);
  } catch {
    /* best-effort: never surface a reindex error to the caller */
  }
}

main();
process.exit(0);
