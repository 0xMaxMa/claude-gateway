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

import { indexAgentArchive, indexSharedArchive } from './indexer';
import type { KnowledgeArchiveConfig, KnowledgeSharedConfig } from './types';

function parse<T>(arg: string | undefined): T | undefined {
  try {
    return arg ? (JSON.parse(arg) as T) : undefined;
  } catch {
    return undefined; // malformed arg → fall back to defaults
  }
}

function main(): void {
  const workspaceDir = process.argv[2];
  if (!workspaceDir) return;

  const archiveCfg = parse<KnowledgeArchiveConfig>(process.argv[3]);
  const sharedCfg = parse<KnowledgeSharedConfig>(process.argv[4]);

  // Each indexer is internally guarded by its own `enabled` flag, so a disabled
  // lane is a no-op. Failures are swallowed independently — the shared reindex
  // runs even if the per-agent one throws, and vice versa.
  try {
    indexAgentArchive(workspaceDir, archiveCfg);
  } catch {
    /* best-effort */
  }
  try {
    indexSharedArchive(sharedCfg);
  } catch {
    /* best-effort */
  }
}

main();
process.exit(0);
