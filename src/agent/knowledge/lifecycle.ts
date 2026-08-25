/**
 * Archive entry lifecycle helpers (planning-66).
 *
 * The Lane-2 archive (`memory/*.md` → `kb.sqlite` → `memory_search`) accumulates
 * stale / superseded entries with no stable per-entry identity to decide staleness
 * from: the FTS chunk id is line-based (`${rel}#${start}-${end}`) and dies on every
 * re-chunk, and `updated_at`/`observed_at` are file mtime (re-stamped on any edit).
 *
 * This module gives every archive ENTRY a reindex-surviving identity — a content
 * hash of its normalized text (`entryHash`) — plus the two pure primitives the GC
 * needs: a markdown-block parser (an "entry" = a top-level bullet or an h3–h6 entry
 * header + its body, the same archivable unit the compactor moves) and deterministic
 * supersession detection (a replacement verb + `#N` marks the older `#N` entry
 * superseded). Everything here is pure — no I/O, no clock — so it is exhaustively
 * testable and safe to call from the indexer and the nightly GC alike.
 *
 * Identity is block-level (not chunk-level) on purpose: FTS chunks are token-window
 * slices with overlap (`chunk.ts`), so moving a chunk's raw lines would corrupt an
 * overlapping neighbour. Blocks are clean markdown units, so the GC moves whole
 * blocks. Each FTS chunk simply inherits the `entryHash` of the block it starts in,
 * which is what the read-path recall counter is keyed to.
 */

import * as crypto from 'crypto';

/** Pinned archive files are searchable but structurally exempt from GC. */
export const PINNED_PREFIX = 'memory/pinned/';

/**
 * True when a workspace-relative path is a GC-eligible PERSONAL archive-tier
 * entry source (planning-66). The archive tier is `memory/**.md`, EXCEPT:
 *   - evergreen Lane-1 (`MEMORY.md`/`USER.md` at the root) — never touched,
 *   - pinned files (`memory/pinned/**`) — searchable but never aged out.
 * Only these files get an `entry_hash` + lifecycle row; evergreen and pinned
 * files have no lifecycle, so the GC can never consider them. The SHARED vault
 * has its own, separate lifecycle (issue #392 part D, `wholeNoteEntryBlock` +
 * `shared-staleness.ts`) — every shared note is eligible, gated by this
 * function only for the PERSONAL `memory/**` tree.
 */
export function isArchiveTierPath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  if (p === 'MEMORY.md' || p === 'USER.md') return false;
  if (p.startsWith(PINNED_PREFIX)) return false;
  return p.startsWith('memory/') && p.endsWith('.md');
}

/** A parsed archive entry block with its 1-indexed inclusive line range. */
export interface EntryBlock {
  text: string; // full original block text (verbatim, for moving)
  startLine: number; // 1-indexed inclusive
  endLine: number; // 1-indexed inclusive
  entryHash: string; // sha256(normalized text)
}

/**
 * Normalize entry text for hashing: collapse every run of whitespace (including
 * newlines) to a single space and trim. A block re-chunked, re-indented, or
 * reflowed keeps the SAME hash — so its lifecycle (age, recall, invalidation)
 * survives cosmetic edits. A genuine content change yields a new hash, which is
 * correct: it is a new fact, so it starts a fresh age.
 */
export function normalizeEntryText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Stable content identity for an archive entry: sha256 of its normalized text. */
export function entryHash(s: string): string {
  return crypto.createHash('sha256').update(normalizeEntryText(s)).digest('hex');
}

const TOP_BULLET_RE = /^[-*] /;
const HEADER_RE = /^#{1,6} /;
/** h3–h6 can be a completed-entry header; h1/h2 are structural sections. */
const ENTRY_HEADER_RE = /^#{3,6} /;
const BLANK_RE = /^\s*$/;

/**
 * Parse an archive markdown file into its entry blocks. An entry is either:
 *   - a top-level bullet (`- `/`* ` at column 0) plus its contiguous non-blank,
 *     non-header, non-bullet continuation lines, or
 *   - an h3–h6 entry header plus its body up to the next header or blank line.
 * h1/h2 section titles, blank lines and free prose are NOT entries (they are
 * structure, never moved). Mirrors the compactor's block model so the GC and the
 * compactor agree on what a movable unit is. Line ranges are 1-indexed inclusive.
 */
export function parseEntryBlocks(content: string): EntryBlock[] {
  const lines = content.split('\n');
  const blocks: EntryBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ENTRY_HEADER_RE.test(line)) {
      const blockLines = [line];
      let j = i + 1;
      while (j < lines.length && !BLANK_RE.test(lines[j]) && !HEADER_RE.test(lines[j])) {
        blockLines.push(lines[j]);
        j++;
      }
      const text = blockLines.join('\n');
      blocks.push({ text, startLine: i + 1, endLine: j, entryHash: entryHash(text) });
      i = j - 1;
      continue;
    }
    if (TOP_BULLET_RE.test(line)) {
      const blockLines = [line];
      let j = i + 1;
      while (
        j < lines.length &&
        !BLANK_RE.test(lines[j]) &&
        !HEADER_RE.test(lines[j]) &&
        !TOP_BULLET_RE.test(lines[j])
      ) {
        blockLines.push(lines[j]);
        j++;
      }
      const text = blockLines.join('\n');
      blocks.push({ text, startLine: i + 1, endLine: j, entryHash: entryHash(text) });
      i = j - 1;
      continue;
    }
    // h1/h2 section titles, blanks, prose → not an entry.
  }
  return blocks;
}

/**
 * A replacement marker: an explicit supersession verb immediately followed by an
 * issue/PR reference `#N`. Case-INSENSITIVE on the verb but the `#N` is required,
 * so prose like "Closes #12", "merged into develop", or a bare "#12" never
 * matches — only "supersedes #316" / "replaces #12" / "obsoletes #7". Mirrors the
 * compactor's precision-over-recall stance: a false supersession only soft-
 * invalidates (still searchable), never deletes, but we keep it tight anyway.
 */
export const SUPERSEDE_RE = /\b(?:supersed(?:e|es|ed)|replaces?|obsoletes?)\s+#(\d+)/gi;

/** All distinct `#N` numbers a block references (its candidate identities/targets). */
export function referencedIds(text: string): Set<number> {
  const ids = new Set<number>();
  for (const m of text.matchAll(/#(\d+)\b/g)) ids.add(Number(m[1]));
  return ids;
}

/** The `#N` numbers a block declares it supersedes (verb + `#N`). */
export function supersededIds(text: string): Set<number> {
  const ids = new Set<number>();
  for (const m of text.matchAll(SUPERSEDE_RE)) ids.add(Number(m[1]));
  return ids;
}

/** One resolved supersession: `targetHash` is superseded by `bySpec`. */
export interface Supersession {
  targetHash: string;
  bySpec: string; // the superseding entry's hash
}

/**
 * Whole-file entry-block for the shared KB (issue #392, part D). Unlike the
 * personal archive (one entry per bullet/header), a shared note's unit of
 * identity is the WHOLE FILE — shared notes are freeform prose, not bulleted
 * lists, and every other shared-KB operation (create/get/update/delete,
 * near-dup search, wikilink graph) already treats one note = one fact/topic.
 * Leading blank lines and a leading HTML comment (e.g. a `<!-- staled ... -->`
 * marker written by the staleness GC when a note is moved) are skipped so the
 * hashed text is stable across a move — mirrors `parseEntryBlocks` treating a
 * leading comment as non-block prose. Returns `[]` for empty/comment-only
 * content (nothing to give an identity to).
 */
export function wholeNoteEntryBlock(content: string): EntryBlock[] {
  const lines = content.split('\n');
  let start = 0;
  while (start < lines.length && (BLANK_RE.test(lines[start]) || /^<!--.*-->\s*$/.test(lines[start]))) {
    start++;
  }
  if (start >= lines.length) return [];
  const text = lines.slice(start).join('\n');
  if (!text.trim()) return [];
  return [{ text, startLine: start + 1, endLine: lines.length, entryHash: entryHash(text) }];
}

/**
 * Deterministically resolve which entries are superseded, over a set of blocks
 * (the whole archive tier). For every block B that declares "supersedes #N", any
 * OTHER block A that references `#N` is marked superseded-by-B. Precision guards:
 *   - the trigger requires the verb+`#N` form (referencing `#N` alone is not a
 *     trigger — only a target),
 *   - a block never supersedes itself,
 *   - a block that itself supersedes something is not eligible to be a target of
 *     the same `#N` (the newer, superseding entry stays live).
 * Returns one entry per superseded target hash (last writer wins on conflict).
 */
export function detectSupersessions(blocks: EntryBlock[]): Supersession[] {
  const out = new Map<string, string>();
  for (const b of blocks) {
    const supersedes = supersededIds(b.text);
    if (supersedes.size === 0) continue;
    for (const a of blocks) {
      if (a.entryHash === b.entryHash) continue; // never supersede self
      if (supersededIds(a.text).size > 0) continue; // the newer superseding entry stays live
      const aIds = referencedIds(a.text);
      for (const n of supersedes) {
        if (aIds.has(n)) {
          out.set(a.entryHash, b.entryHash);
          break;
        }
      }
    }
  }
  return Array.from(out, ([targetHash, bySpec]) => ({ targetHash, bySpec }));
}
