/**
 * Resolve the effective knowledge-archive config for one agent.
 *
 * Precedence mirrors `resolveDreamingConfig`: a per-agent override wins over the
 * global gateway default, which wins over the built-in default. Numeric fields
 * are sanitized (non-finite / out-of-range JSON ⇒ default) so the indexer never
 * chunks with a NaN window.
 */

import * as os from 'os';
import * as path from 'path';
import type {
  KnowledgeArchiveConfig,
  ResolvedKnowledgeArchiveCfg,
  KnowledgeSharedConfig,
  ResolvedKnowledgeSharedCfg,
} from './types';

export const ARCHIVE_DEFAULTS: ResolvedKnowledgeArchiveCfg = {
  enabled: true,
  tokenizer: 'unicode61', // "trigram" evaluated for Thai/CJK before locking (planning-64 D5)
  chunkTokens: 400,
  chunkOverlap: 80,
};

/** FTS5 tokenizers we accept; anything else falls back to the default. */
const ALLOWED_TOKENIZERS = new Set(['unicode61', 'trigram', 'ascii', 'porter']);

function pick<T>(agent: T | undefined, global: T | undefined, fallback: T): T {
  if (agent !== undefined) return agent;
  if (global !== undefined) return global;
  return fallback;
}

function numOr(value: number, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

export function resolveArchiveConfig(
  agentCfg?: KnowledgeArchiveConfig,
  globalCfg?: KnowledgeArchiveConfig,
): ResolvedKnowledgeArchiveCfg {
  const d = ARCHIVE_DEFAULTS;
  const rawTokenizer = pick(agentCfg?.tokenizer, globalCfg?.tokenizer, d.tokenizer);
  const chunkTokens = numOr(
    pick(agentCfg?.chunkTokens, globalCfg?.chunkTokens, d.chunkTokens),
    d.chunkTokens,
    16, // a tokenizer window below this is not a meaningful chunk
    100_000,
  );
  // Overlap must be strictly less than the chunk window, else the chunker cannot
  // advance and would loop; clamp to [0, chunkTokens-1].
  const rawOverlap = numOr(
    pick(agentCfg?.chunkOverlap, globalCfg?.chunkOverlap, d.chunkOverlap),
    d.chunkOverlap,
    0,
    100_000,
  );
  return {
    enabled: pick(agentCfg?.enabled, globalCfg?.enabled, d.enabled),
    tokenizer: ALLOWED_TOKENIZERS.has(rawTokenizer) ? rawTokenizer : d.tokenizer,
    chunkTokens,
    chunkOverlap: Math.min(rawOverlap, chunkTokens - 1),
  };
}

// ── Shared KB (planning-64 K3) ───────────────────────────────────────────────

export const SHARED_DEFAULTS: ResolvedKnowledgeSharedCfg = {
  enabled: true,
  project: 'global',
  root: path.join(os.homedir(), '.claude-gateway', 'shared', 'kb'),
  mode: 'auto', // default: promote applied add-memories to the shared vault. Set 'propose' for dry-run (log only).
  graph: false, // K5 graph/dashboards are opt-in
};

/**
 * A project key safe to use as a single path segment (no traversal/separators).
 * NOTE: `.` is a literal inside the class, so `'.'` and `'..'` also match the
 * regex — they are rejected explicitly in `resolveSharedConfig` (a bare-dots key
 * would resolve `<root>/..` outside the intended root).
 */
const PROJECT_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Reserved path segments that must never be used as a project key. */
const RESERVED_PROJECT_KEYS = new Set(['.', '..']);

/** Expand a leading `~` to the home dir (mirrors config path handling elsewhere). */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveSharedConfig(
  agentCfg?: KnowledgeSharedConfig,
  globalCfg?: KnowledgeSharedConfig,
): ResolvedKnowledgeSharedCfg {
  const d = SHARED_DEFAULTS;
  const rawProject = pick(agentCfg?.project, globalCfg?.project, d.project);
  const project =
    typeof rawProject === 'string' && PROJECT_KEY_RE.test(rawProject) && !RESERVED_PROJECT_KEYS.has(rawProject)
      ? rawProject
      : d.project;
  const rawRoot = pick(agentCfg?.root, globalCfg?.root, d.root);
  const root = typeof rawRoot === 'string' && rawRoot.trim() ? expandHome(rawRoot.trim()) : d.root;
  const mode = pick(agentCfg?.mode, globalCfg?.mode, d.mode);
  return {
    enabled: pick(agentCfg?.enabled, globalCfg?.enabled, d.enabled),
    project,
    root,
    mode: mode === 'auto' ? 'auto' : 'propose', // anything but 'auto' ⇒ propose
    graph: pick(agentCfg?.graph, globalCfg?.graph, d.graph) === true,
  };
}

/** Directory for a project's shared vault: <root>/<project>. */
export function sharedVaultDir(cfg: ResolvedKnowledgeSharedCfg): string {
  return path.join(cfg.root, cfg.project);
}

/** The shared vault's SQLite index path. */
export function sharedDbPath(cfg: ResolvedKnowledgeSharedCfg): string {
  return path.join(sharedVaultDir(cfg), 'kb.sqlite');
}

/** The shared vault's notes dir (agents drop shared `*.md` here; indexed to kb.sqlite). */
export function sharedNotesDir(cfg: ResolvedKnowledgeSharedCfg): string {
  return path.join(sharedVaultDir(cfg), 'notes');
}
