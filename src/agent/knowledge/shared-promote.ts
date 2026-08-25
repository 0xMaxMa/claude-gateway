import { writeSharedNote, sharedNoteExists, readSharedNote } from './shared-writer';
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
        writeSharedNote(sharedCfg, name, mergeIntoNote(existing, content));
        return;
      }

      // New reason, but content overlaps an existing note: fold into the closest
      // match (rather than creating a near-duplicate under a different name), and
      // link any OTHER related notes the search turned up.
      const similar = findSimilarSharedNotes(sharedCfg, `${name} ${content}`, 3);
      if (similar.length > 0) {
        const [primary, ...related] = similar;
        const existing = readSharedNote(sharedCfg, primary.name) ?? '';
        writeSharedNote(
          sharedCfg,
          primary.name,
          mergeIntoNote(existing, content, related.map((r) => r.name)),
        );
        return;
      }

      writeSharedNote(sharedCfg, name, content);
    } catch {
      /* best-effort — a promotion failure never affects the local dream */
    }
  };
}
