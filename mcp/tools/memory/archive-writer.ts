/**
 * Write-side glue for the shared KB (Bun/mcp side; planning-64 K3 follow-up).
 *
 * Unlike the read side (archive-reader.ts, which must reimplement its query
 * path because `bun:sqlite`/`node:sqlite` are different bindings over the
 * same file), the atomic-write logic itself (slugify + write-temp-then-rename)
 * has NO `node:sqlite` dependency — it's plain `fs`/`path`. So this file does
 * NOT duplicate it: it imports the real `writeSharedNote` / `sharedNoteFilename`
 * straight from the compiled `dist/agent/knowledge/shared-writer.js`, the same
 * pattern already used elsewhere in `mcp/` for logic it needs but cannot reach
 * in `src/` directly (see `mcp/tools/slack/module.ts`'s `SlackClient` import,
 * `mcp/tools/telegram/receiver-server.ts`'s `turn-trace`/`incident-store`
 * imports). Verified against mcp-no-src-imports.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { writeSharedNote, sharedNoteFilename } from '../../../dist/agent/knowledge/shared-writer.js';
import type { ResolvedKnowledgeSharedCfg } from '../../../dist/agent/knowledge/types.js';

export { sharedNoteFilename };

/**
 * Reconstruct the minimal resolved shared-KB config `writeSharedNote` needs
 * (only `root`/`project` are actually read, via `sharedNotesDir`), by
 * splitting `vaultDir` = `<root>/<project>` — the inverse of the Node-side
 * `sharedVaultDir()`. `mode`/`graph`/`enabled` are dead weight for this call
 * (writeSharedNote never reads them) but filled in for type shape.
 */
function cfgFromVaultDir(vaultDir: string): ResolvedKnowledgeSharedCfg {
  return {
    enabled: true,
    root: path.dirname(vaultDir),
    project: path.basename(vaultDir),
    mode: 'auto',
    graph: false,
  };
}

/**
 * Slug identity for an agent's on-demand shared note: `<agentId>-<reason>`,
 * stable across writes (NOT content-hashed) so a repeat call with the same
 * `reason` addresses the same file — required for update/delete semantics.
 * This deliberately diverges from the nightly promoter's content-hashed
 * naming (`shared-promote.ts`), which exists so that unrelated *automatic*
 * promotions never collide; the two schemes can never collide with each
 * other either, since a hashed name always has an extra `-<8hex>` segment
 * this slug does not.
 */
export function sharedNoteSlug(agentId: string, reason: string): string {
  return `${agentId}-${reason}`;
}

/** Whether a note already exists at this slug (post-`sharedNoteFilename` slugification). */
export function sharedNoteExists(vaultDir: string, slug: string): boolean {
  return fs.existsSync(path.join(vaultDir, 'notes', sharedNoteFilename(slug)));
}

/** Write a note into the shared vault atomically. Returns the absolute path written. */
export function writeSharedNoteAtomic(vaultDir: string, name: string, content: string): string {
  return writeSharedNote(cfgFromVaultDir(vaultDir), name, content);
}

/** Delete a note by slug. Returns false (no-op) if it did not exist. */
export function deleteSharedNote(vaultDir: string, slug: string): boolean {
  const target = path.join(vaultDir, 'notes', sharedNoteFilename(slug));
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target);
  return true;
}

/**
 * Fire-and-forget reindex trigger so a promoted note is searchable immediately,
 * instead of waiting for the next natural reindex (session spawn / nightly
 * dream). Spawns the SAME compiled CLI the Node-side `spawnArchiveReindex`
 * uses (`dist/agent/knowledge/reindex-cli.js`) as a SUBPROCESS (never
 * imported — reindex-cli.ts requires `node:sqlite`, which Bun does not have,
 * so it can only be run, not loaded, from this process).
 *
 * This code runs under Bun, whose own `process.execPath` points at the `bun`
 * binary — spawning the CLI with that fails silently (`node:sqlite` is not a
 * Bun built-in) since the child is detached with `stdio:'ignore'`. The gateway
 * forwards its own (real Node) `process.execPath` via `GATEWAY_NODE_EXEC_PATH`
 * (see src/session/process.ts) specifically so this spawn uses the right
 * runtime; fall back to a bare `node` on PATH if that env is somehow unset.
 *
 * The CLI's shared-archive half only needs `{enabled, root, project}` (see
 * `cfgFromVaultDir`); the personal-archive half is explicitly disabled
 * (`{enabled:false}`) since this trigger only concerns the shared vault.
 * Best-effort: swallows every failure so a promote call never fails because
 * reindexing couldn't be kicked off.
 */
export function triggerSharedReindex(vaultDir: string): void {
  try {
    const cliPath = path.join(__dirname, '..', '..', '..', 'dist', 'agent', 'knowledge', 'reindex-cli.js');
    if (!fs.existsSync(cliPath)) return;
    const nodeBin = process.env.GATEWAY_NODE_EXEC_PATH || 'node';
    const sharedCfg = cfgFromVaultDir(vaultDir);
    const child = spawn(
      nodeBin,
      [cliPath, vaultDir, JSON.stringify({ enabled: false }), JSON.stringify(sharedCfg)],
      { detached: true, stdio: 'ignore' },
    );
    child.on('error', () => {
      /* swallowed */
    });
    child.unref();
  } catch {
    /* best-effort: reindex is never on the critical path of a promote call */
  }
}
