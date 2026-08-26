/**
 * Node-native near-duplicate search over the shared vault's `kb.sqlite`
 * (planning-64 K3 follow-up / issue #386).
 *
 * The shared vault is indexed with the SAME `ArchiveDB` schema the per-agent
 * archive uses (`indexSharedArchive` in `indexer.ts` calls
 * `ArchiveDB.forPath(sharedDbPath(cfg), ...)`), so `ArchiveDB.searchSimilar`
 * works against it unmodified. This exists because the MCP tools'
 * `findSimilarSharedNotes` (`mcp/tools/memory/archive-reader.ts`) runs under
 * Bun (`bun:sqlite`) and cannot be imported from here — the Node gateway
 * process (`node:sqlite`). Same on-disk file, two bindings; keep both in sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ArchiveDB } from './archive-db';
import { sharedDbPath } from './config';
import type { ResolvedKnowledgeSharedCfg } from './types';

export interface SimilarSharedNote {
  /** The note's freeform name (its filename under notes/, minus `.md`). */
  name: string;
  snippet: string;
}

/**
 * FTS term budget for a near-dup lookup. `searchSimilar` truncates the seed to
 * this many terms, so the budget has to be split deliberately between the note
 * name and its content (`buildSeedText`) — a long freeform name used to consume
 * all 12 terms and the promoted fact itself never reached the query (issue #398).
 */
export const SEED_TERM_BUDGET = 16;

/**
 * Find shared notes whose content overlaps `seedText`. Read-only; returns []
 * when the shared index doesn't exist yet or the seed has no usable tokens.
 */
export function findSimilarSharedNotes(
  cfg: ResolvedKnowledgeSharedCfg,
  seedText: string,
  maxResults = 3,
  maxTerms = SEED_TERM_BUDGET,
): SimilarSharedNote[] {
  const dbPath = sharedDbPath(cfg);
  if (!fs.existsSync(dbPath)) return [];
  const db = ArchiveDB.forPath(dbPath);
  const hits = db.searchSimilar(seedText, maxResults, maxTerms);
  return hits.map((h) => ({
    name: path.basename(h.path, '.md'),
    snippet: h.text.length > 500 ? `${h.text.slice(0, 500)}…` : h.text,
  }));
}

// ── Near-duplicate gate (issue #398) ────────────────────────────────────────
//
// FTS above is RECALL only: `searchSimilar` ORs the seed's tokens, so a single
// shared word is enough to return a hit. Auto-promotion used to treat any hit
// as a near-duplicate and merge into it unattended, which fused unrelated notes
// together (a live vault had 39 of 48 chunks matching a typical seed). Recall
// stays loose — a real near-dup rarely repeats every word — and the PRECISION
// bar below decides what may actually be merged.
//
// The bar is deterministic token containment rather than a BM25 cutoff: BM25 is
// corpus-relative, so a threshold tuned on one vault silently changes meaning as
// the vault grows. Containment ("how much of the seed does this note already
// say?") is stable, explainable, and testable offline.

/** Tokens carried by markdown/prose scaffolding rather than by the fact itself. */
const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','because','been','but','by','for','from','had','has','have','he','her','his',
  'how','i','if','in','into','is','it','its','me','my','need','needs','new','not','of','on','or','our','she','so',
  'that','the','their','them','then','there','these','they','this','to','up','use','used','user','was','we',
  'were','what','when','where','which','while','who','why','will','with','would','you','your',
  // markdown / memory-file scaffolding: present in almost every promoted line
  'md','memory','index','entry','note','notes','pointer','pointers','add','added','insert','section','file','files',
]);

/** Normalized, stopword-free, deduped content tokens of a text. */
export function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 3) continue; // 1-2 char fragments carry no topic signal
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * How much of `seed` the `candidate` already covers, in [0, 1]. Containment
 * (not Jaccard) on purpose: a short new fact merging into a long established
 * note is a legitimate near-duplicate, and Jaccard would punish it for the
 * candidate's length alone.
 *
 * Note the asymmetry in the inputs: `seed` is the truncated query text
 * (`buildSeedText`), while `candidate` should be a full note body. The score is
 * therefore "how much of the QUERY this note already says" — the candidate is
 * never penalised for saying more.
 */
export function containmentScore(seed: string, candidate: string): number {
  const a = significantTokens(seed);
  if (a.size === 0) return 0;
  const b = significantTokens(candidate);
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

/**
 * Minimum containment for an UNATTENDED merge. Deliberately strict: creating a
 * separate note when two really were duplicates is a tidy-up cost, while merging
 * two unrelated facts destroys both (the reader can no longer tell which note
 * the fact belongs to). Errors are pushed to the recoverable side.
 *
 * Read this against what the seed actually IS. Callers score against
 * `buildSeedText`'s output, which is capped at `SEED_TERM_BUDGET` significant
 * tokens (a minority from the name, the rest from the fact) — so the bar is "half
 * of the fact's first ~11 topic words are already in this note", not "half of the
 * whole fact". That is looser than the bare number reads, and deliberately so:
 * the cap is what keeps the FTS query itself affordable, and the same truncation
 * has to apply on both sides for the score to mean anything.
 */
export const MIN_MERGE_CONTAINMENT = 0.5;

/**
 * Minimum containment for emitting a `[[wikilink]]` to a note (issue #386 part
 * B's graph edges). Lower than the merge bar on purpose — the two operations
 * make different claims. A merge asserts "these are the same fact" and destroys
 * the distinction between them; a link only asserts "these are related" and is
 * additive, so the same evidence buys a link long before it buys a merge.
 */
export const MIN_RELATED_CONTAINMENT = 0.25;

/**
 * Candidates that clear `minContainment` against the seed, best first.
 *
 * `resolveText` decides WHAT the candidate is scored against. It defaults to the
 * FTS snippet, but callers that can read the note should pass its full body: a
 * snippet is one 500-char chunk, so an established note that a recurring topic
 * has merged into for months spreads the seed's tokens across several chunks and
 * scores far below its true containment — turning the bar into "much stricter
 * than 0.5" for exactly the notes that most need to match (issue #398 review).
 */
export function filterNearDuplicates(
  seedText: string,
  candidates: SimilarSharedNote[],
  minContainment = MIN_MERGE_CONTAINMENT,
  resolveText: (c: SimilarSharedNote) => string = (c) => c.snippet,
): SimilarSharedNote[] {
  return candidates
    .map((c) => ({ c, score: containmentScore(seedText, resolveText(c)) }))
    .filter((x) => x.score >= minContainment)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.c);
}

/**
 * Balanced FTS seed for a promotion lookup: the name gets a minority share of
 * `SEED_TERM_BUDGET` and the promoted fact gets the rest, so a long freeform
 * `reason` can no longer starve the content out of the query (issue #398).
 */
export function buildSeedText(name: string, content: string, budget = SEED_TERM_BUDGET): string {
  const nameBudget = Math.max(1, Math.floor(budget / 3));
  const nameTokens = [...significantTokens(name)].slice(0, nameBudget);
  const contentTokens = [...significantTokens(content)].filter((t) => !nameTokens.includes(t));
  return [...nameTokens, ...contentTokens].slice(0, budget).join(' ');
}
