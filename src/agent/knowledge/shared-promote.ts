import { writeSharedNote, sharedNoteExists, readSharedNote, MAX_SHARED_NOTE_SIZE } from './shared-writer';
import {
  findSimilarSharedNotes,
  filterNearDuplicates,
  buildSeedText,
  MIN_RELATED_CONTAINMENT,
} from './shared-dedup';
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
export function mergeIntoNote(existing: string, addition: string, relatedNames: string[] = []): string {
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
export function writeCapped(cfg: Parameters<typeof writeSharedNote>[0], name: string, content: string): boolean {
  if (content.length > MAX_SHARED_NOTE_SIZE) return false;
  writeSharedNote(cfg, name, content);
  return true;
}

// ── What may be promoted, and under what name (issue #398) ─────────────────

/** A `MEMORY.md` index bullet: `- [label](target.md) — hook`. */
const INDEX_POINTER_LINE_RE = /^\s*[-*]\s*\[[^\]]*\]\([^)]*\)\s*(?:[-–—:].*)?$/;

/**
 * True when the content is nothing but `MEMORY.md` index pointers.
 *
 * The memory-tiering convention writes a fact to its own file AND a one-line
 * pointer into the `MEMORY.md` index. Both land as durable `add`s, so both used
 * to be promoted — and the pointer's links resolve only inside the promoting
 * agent's own workspace, making it dead weight in a shared vault (issue #398:
 * 30 of 40 live notes were pointer-only, with all 32 link targets dangling).
 *
 * The trailing hook text is deliberately NOT rescued into a note of its own: an
 * index hook is written to be read next to the file it points at, so promoting
 * it alone would put a decontextualized fragment in front of every other agent.
 * A dream that proposes the fact itself as prose still promotes normally — only
 * navigation scaffolding is dropped.
 */
export function isIndexPointerOnly(content: string): boolean {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((l) => INDEX_POINTER_LINE_RE.test(l));
}

/** Leading verbs that make a `reason` an edit instruction rather than a topic. */
const INSTRUCTION_VERB_RE =
  /^(insert|append|prepend|add|put|place|move|update|replace|remove|delete|keep|group)\b/i;
/** Anchors an edit instruction points AT — a position or a file, not a subject. */
const EDIT_ANCHOR_RE = /\b(before|after|above|below|between|index|section|\.md)\b/i;

/**
 * True when a note name reads as an instruction for editing a file rather than
 * as the name of a fact ("insert after cron config, before the pty_shell
 * section"). `reason` is prompted as free-form justification (`reviewer.ts`) but
 * issue #386 repurposed it as the shared note's identity, so such strings became
 * note names that no future occurrence of the same fact can ever match.
 *
 * Two signals are required — an imperative edit verb AND a positional/file
 * anchor — because either alone is common in legitimate names ("Add-on billing
 * is per seat", "the section header is user-visible").
 */
export function isInstructionShapedName(name: string): boolean {
  return INSTRUCTION_VERB_RE.test(name.trim()) && EDIT_ANCHOR_RE.test(name);
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
): ((p: { reason: string; content?: string; topic?: string }) => void) | undefined {
  const sharedCfg = resolveSharedConfig(agentCfg, globalCfg);
  if (!sharedCfg.enabled || sharedCfg.mode !== 'auto') return undefined;
  return (p: { reason: string; content?: string; topic?: string }) => {
    const content = (p.content ?? '').trim();
    // A durable proposal may carry an explicit `topic` slug (mirroring the
    // episodic contract) — a far more stable note identity than a free-form
    // reason, which the reviewer prompt never asked to be a name.
    const name = (p.topic ?? '').trim() || p.reason.trim();
    if (!content || !name) return;

    // An index pointer is a per-agent navigation aid, not a shareable fact.
    if (isIndexPointerOnly(content)) return;
    // A name that reads as an edit instruction would create a note no future
    // occurrence of the same fact can ever match. Skipping beats writing junk.
    if (!p.topic && isInstructionShapedName(name)) return;

    try {
      // Same name recurred: this IS the same fact — update it, never duplicate.
      if (sharedNoteExists(sharedCfg, name)) {
        const existing = readSharedNote(sharedCfg, name) ?? '';
        writeCapped(sharedCfg, name, mergeIntoNote(existing, content));
        return;
      }

      // New name, but the content may already live in another note. FTS is
      // recall only; `filterNearDuplicates` is the precision bar that decides
      // whether an UNATTENDED merge is justified. Below the bar the fact gets
      // its own note — two notes are recoverable, two unrelated facts fused
      // into one are not (issue #398).
      const seed = buildSeedText(name, content);
      const candidates = findSimilarSharedNotes(sharedCfg, seed, 3);
      const mergeable = filterNearDuplicates(seed, candidates);
      if (mergeable.length > 0) {
        const primary = mergeable[0];
        // Wikilinks use the LOWER bar: a link is an additive "these are related"
        // claim, unlike a merge, so it is worth making on weaker evidence.
        const related = filterNearDuplicates(seed, candidates, MIN_RELATED_CONTAINMENT).filter(
          (c) => c.name !== primary.name,
        );
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
