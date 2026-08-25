import { writeSharedNote, sharedNoteExists, readSharedNote, MAX_SHARED_NOTE_SIZE } from './shared-writer';
import { findSimilarSharedNotes } from './shared-dedup';
import { resolveSharedConfig } from './config';
import type { KnowledgeSharedConfig } from './types';

/**
 * Merge a newly-promoted fact into a note's existing content, rather than
 * blindly overwriting it. Deterministic append (no extra LLM call — dreaming
 * already spent its budget proposing the fact); a no-op if the addition is
 * already present verbatim. `relatedNames` (issue #386 part B) adds
 * `[[wikilink]]`s to OTHER near-duplicate notes found alongside the merge
 * target, so the existing (previously unpopulated) `/knowledge/graph`
 * dashboard gets real edges — `wiki.ts` already resolves `[[links]]` into
 * graph edges, no parser change needed.
 */
function mergeIntoNote(existing: string, addition: string, relatedNames: string[] = []): string {
  const trimmedAddition = addition.trim();
  const links = relatedNames.length ? `\n\nRelated: ${relatedNames.map((n) => `[[${n}]]`).join(' ')}` : '';
  if (!existing.trim()) return `${trimmedAddition}${links}`;
  if (existing.includes(trimmedAddition)) return existing; // already recorded, nothing to add
  return `${existing.trim()}\n\n${trimmedAddition}${links}`;
}

/**
 * Write only if the result stays within the same size cap the manual
 * `memory_shared_create`/`_update` tools enforce. Unlike those tools, dreaming
 * has no one to show a "content too large" error to — a note a recurring topic
 * keeps merging into over months has no natural stopping point otherwise, so
 * once a merge would cross the cap the note is left as-is (best-effort: a
 * skipped promotion never fails the local dream, same as any other error here).
 */
function writeCapped(cfg: Parameters<typeof writeSharedNote>[0], name: string, content: string): void {
  if (content.length > MAX_SHARED_NOTE_SIZE) return;
  writeSharedNote(cfg, name, content);
}

/**
 * Build the per-agent→shared promotion function used after the dreaming applier
 * writes an `add` to local memory (K3↔K4). Returns `undefined` when the shared
 * KB is disabled or in `propose` (dry-run) mode — callers then skip promotion.
 *
 * Note identity is the proposal's `reason` (issue #386) — the SAME freeform
 * namespace `memory_shared_create`/`_update` use, not a content hash. A
 * content-hashed name (the pre-#386 scheme) meant the same recurring fact,
 * reworded slightly by the reviewer each night, hashed differently and was
 * written as a brand-new note every time — this is what created the
 * near-duplicate pileup #386 reports. Naming by `reason` instead means the
 * same recurring fact maps to the same note name across nights, landing as an
 * update. A `reason` that doesn't collide by name is also checked against the
 * shared vault's near-dup search before creating, and merged into the closest
 * match instead of creating a disconnected duplicate when one is found.
 *
 * Concurrency note: the name-collision check, read, and write below are not one
 * atomic operation, so two agents dreaming at the same moment and promoting
 * under the exact same `reason` can race — `shared-writer.ts` already documents
 * that same-file races resolve to last-write-wins, never corruption, and other
 * read-modify-write callers (e.g. `memory_shared_update`) have this same
 * property. Naming by `reason` instead of a content hash makes same-name
 * collisions between different agents more likely than the pre-#386 scheme, but
 * it's the same accepted tradeoff, not a new class of risk.
 */
export function makeSharedPromoter(
  // Kept for call-site compatibility (src/index.ts, gateway-router.ts) though no
  // longer used for naming — issue #386 moved note identity to `reason` so a
  // recurring fact maps to the same shared note regardless of which agent dreamed it.
  _agentId: string,
  agentCfg: KnowledgeSharedConfig | undefined,
  globalCfg: KnowledgeSharedConfig | undefined,
): ((p: { reason: string; content?: string }) => void) | undefined {
  const sharedCfg = resolveSharedConfig(agentCfg, globalCfg);
  if (!sharedCfg.enabled || sharedCfg.mode !== 'auto') return undefined;
  return (p: { reason: string; content?: string }) => {
    const content = (p.content ?? '').trim();
    const name = p.reason.trim();
    if (!content || !name) return;

    try {
      // Same reason recurred: this IS the same fact — update it, never duplicate.
      if (sharedNoteExists(sharedCfg, name)) {
        const existing = readSharedNote(sharedCfg, name) ?? '';
        writeCapped(sharedCfg, name, mergeIntoNote(existing, content));
        return;
      }

      // New reason, but content overlaps an existing note: fold into the closest
      // match (rather than creating a near-duplicate under a different name), and
      // link any OTHER related notes the search turned up.
      const similar = findSimilarSharedNotes(sharedCfg, `${name} ${content}`, 3);
      if (similar.length > 0) {
        const [primary, ...related] = similar;
        const existing = readSharedNote(sharedCfg, primary.name) ?? '';
        writeCapped(
          sharedCfg,
          primary.name,
          mergeIntoNote(existing, content, related.map((r) => r.name)),
        );
        return;
      }

      writeCapped(sharedCfg, name, content);
    } catch {
      /* best-effort — a promotion failure never affects the local dream */
    }
  };
}
