/**
 * Resolve the effective knowledge-archive config for one agent.
 *
 * Precedence mirrors `resolveDreamingConfig`: a per-agent override wins over the
 * global gateway default, which wins over the built-in default. Numeric fields
 * are sanitized (non-finite / out-of-range JSON ⇒ default) so the indexer never
 * chunks with a NaN window.
 */

import type { KnowledgeArchiveConfig, ResolvedKnowledgeArchiveCfg } from './types';

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
