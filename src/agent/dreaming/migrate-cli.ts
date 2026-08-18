#!/usr/bin/env node
/**
 * One-shot memory migration entry (planning-65).
 *
 * Drains an over-budget MEMORY.md: a deterministic terminal sweep (#337
 * compactor) + an LLM route-out pass that moves episodic task-log blocks to
 * `memory/<topic>.md`. Pinned sections are excluded and nothing is deleted
 * (content is relocated, still searchable via `memory_search`).
 *
 * Usage: node migrate-cli.js <workspaceDir> [--apply] [<reviewModel>]
 *   (default is a dry-run that writes .dreaming/migration-plan.md)
 *
 * The route-out classifier is a print-only `claude -p` (no tools, untrusted
 * input) — same safety model as the dreaming reviewer.
 */

import { makeClaudeSpawn } from '../skill-learning/reviewer';
import { migrateMemory, makeRouteOut } from './migrate';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

async function main(): Promise<void> {
  const workspaceDir = process.argv[2];
  if (!workspaceDir) {
    process.stderr.write('usage: migrate-cli <workspaceDir> [--apply] [<reviewModel>]\n');
    process.exit(2);
    return;
  }
  const apply = process.argv.includes('--apply');
  const model = process.argv.find((a, i) => i >= 3 && a !== '--apply') ?? DEFAULT_MODEL;

  const result = await migrateMemory(workspaceDir, {
    mode: apply ? 'apply' : 'propose',
    routeOut: makeRouteOut(makeClaudeSpawn(model)),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`[migrate-cli] ${(err as Error).message}\n`);
    process.exit(1);
  });
