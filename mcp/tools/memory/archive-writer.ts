/**
 * Write-side mirror for the shared KB (Bun/mcp side; planning-64 K3 follow-up).
 *
 * `mcp/` must never import from `src/` (enforced by mcp-no-src-imports.test.ts —
 * src/ is not in the published package). The atomic-write half of the shared
 * vault lives Node-side at `src/agent/knowledge/shared-writer.ts` and is used
 * only by the nightly dreaming promoter. This file is a deliberate mirror of
 * that logic (same slugify rule, same temp+rename scheme) so an agent-initiated
 * `memory_promote` call — issued from the Bun MCP process — can write into the
 * exact same vault the nightly path writes to, without crossing the packaging
 * boundary. Keep the two writers in sync (mirrors the existing
 * archive-reader.ts / archive-db.ts read-side split).
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

let tmpCounter = 0;

/** Reduce an arbitrary name to one safe `*.md` path segment (no traversal). */
export function sharedNoteFilename(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
  return `${base || 'note'}.md`;
}

/**
 * Content-hashed note name — the exact scheme `makeSharedPromoter` (Node side)
 * uses, so an on-demand write and a nightly promotion of the same content map
 * to the same file (idempotent; the two paths dedupe against each other).
 */
export function sharedNoteName(agentId: string, reason: string, content: string): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  return `${agentId}-${reason}-${hash}`;
}

/**
 * Write a note into `<vaultDir>/notes` atomically (write-temp + rename), same
 * as `writeSharedNote`. Returns the absolute path written.
 */
export function writeSharedNoteAtomic(vaultDir: string, name: string, content: string): string {
  const dir = path.join(vaultDir, 'notes');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, sharedNoteFilename(name));
  const tmp = path.join(dir, `.tmp-${process.pid}-${(tmpCounter += 1)}-${process.hrtime.bigint().toString(36)}.part`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target); // atomic replace
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return target;
}

/**
 * Fire-and-forget reindex trigger so a promoted note is searchable immediately,
 * instead of waiting for the next natural reindex (session spawn / nightly
 * dream). Spawns the SAME compiled CLI the Node-side `spawnArchiveReindex`
 * uses (`dist/agent/knowledge/reindex-cli.js`, shipped alongside `mcp/` per
 * package.json `files`) — never imported, only spawned as a subprocess, so this
 * does not trip the mcp-no-src-imports guard.
 *
 * This code runs under Bun, whose own `process.execPath` points at the `bun`
 * binary — spawning the CLI with that fails silently (`node:sqlite` is not a
 * Bun built-in) since the child is detached with `stdio:'ignore'`. The gateway
 * forwards its own (real Node) `process.execPath` via `GATEWAY_NODE_EXEC_PATH`
 * (see src/session/process.ts) specifically so this spawn uses the right
 * runtime; fall back to a bare `node` on PATH if that env is somehow unset.
 *
 * The CLI's shared-archive half only needs `{enabled, root, project}`; `root`
 * and `project` are recovered by splitting `vaultDir` (= `<root>/<project>`,
 * the inverse of the Node-side `sharedVaultDir()`). The personal-archive half
 * is explicitly disabled (`{enabled:false}`) since this trigger only concerns
 * the shared vault. Best-effort: swallows every failure so a promote call
 * never fails because reindexing couldn't be kicked off.
 */
export function triggerSharedReindex(vaultDir: string): void {
  try {
    const cliPath = path.join(__dirname, '..', '..', '..', 'dist', 'agent', 'knowledge', 'reindex-cli.js');
    if (!fs.existsSync(cliPath)) return;
    const nodeBin = process.env.GATEWAY_NODE_EXEC_PATH || 'node';
    const sharedCfg = { enabled: true, root: path.dirname(vaultDir), project: path.basename(vaultDir) };
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
