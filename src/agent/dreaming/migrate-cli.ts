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
import { migrateMemory } from './migrate';
import { isValidTopicSlug } from './episodic';
import type { DreamProposal } from './types';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const ROUTE_OUT_PROMPT = `You migrate an AI agent's MEMORY.md. MEMORY.md is injected into every prompt, so it must hold ONLY durable facts (user preferences, standing rules, identity, lessons). EPISODIC task-log — a record of what happened (completed/merged work, PR/issue status, dated progress notes) — must move to a searchable archive.

You are given the current MEMORY.md. Identify the blocks that are EPISODIC task-log and should move out. For each, return the EXACT block text to remove (verbatim, so it can be located) and the note to archive.

NEVER move blocks under a "## User", "## Feedback", or "## Preferences" section — those are durable and pinned.

Respond with STRICT JSON only (no prose/fences):
{"moves":[{"target":"<exact block text from MEMORY.md to remove>","topic":"<lowercase-kebab-slug>","content":"<text to archive>","reason":"<why episodic>"}]}
- topic MUST match ^[a-z0-9-]{1,64}$. moves: [] if nothing should move.`;

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

function parseEnvelope(stdout: string): string {
  try {
    const env = JSON.parse(stdout) as Record<string, unknown>;
    return typeof env['result'] === 'string' ? (env['result'] as string) : stdout;
  } catch {
    return stdout;
  }
}

/** Build the injected route-out classifier used by migrateMemory. */
function makeRouteOut(model: string): (memory: string) => Promise<DreamProposal[]> {
  const spawn = makeClaudeSpawn(model);
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
    routeOut: makeRouteOut(model),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`[migrate-cli] ${(err as Error).message}\n`);
    process.exit(1);
  });
