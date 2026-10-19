import {
  writeSharedNote,
  sharedNoteExists,
  readSharedNote,
  deleteSharedNoteFile,
  MAX_SHARED_NOTE_SIZE,
} from './shared-writer';
import {
  findSimilarSharedNotes,
  filterNearDuplicates,
  buildSeedText,
  significantTokens,
  MIN_RELATED_CONTAINMENT,
} from './shared-dedup';
import { STALE_NOTE_PREFIX } from './shared-staleness';
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
  // Only link what is not linked yet: a recurring fact that merges into the same
  // note night after night would otherwise stack a duplicate `Related:` line on
  // every pass (issue #398 review).
  const missing = relatedNames.filter((n) => !existing.includes(`[[${n}]]`));
  const links = missing.length ? `\n\nRelated: ${missing.map((n) => `[[${n}]]`).join(' ')}` : '';
  if (!existing.trim()) return `${trimmedAddition}${links}`;
  // Already recorded verbatim: there is nothing to append — but the note must
  // still gain edges it is missing, or a fact that recurs under a name it
  // already occupies stays a disconnected node forever (issue #398 review).
  if (existing.includes(trimmedAddition)) return links ? `${existing.trim()}${links}` : existing;
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
export function writeCapped(
  cfg: Parameters<typeof writeSharedNote>[0],
  name: string,
  content: string,
  relatedNames: string[] = [],
): boolean {
  const body = relatedNames.length ? mergeIntoNote('', content, relatedNames) : content;
  if (body.length > MAX_SHARED_NOTE_SIZE) return false;
  writeSharedNote(cfg, name, body);
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

/**
 * A note name derived from the fact itself — the fallback when the proposal has
 * no `topic`.
 *
 * The free-form `reason` is never a fallback name: it is prompted as a
 * justification, and issue #386 found reviewers writing editing instructions
 * there ("insert after cron config, before the pty_shell section") that no later
 * occurrence of the same fact can match. Naming from the content keeps the fact;
 * only content with nothing nameable in it is given up on.
 */
export function deriveNameFromContent(content: string): string | undefined {
  const firstSentence = content
    .replace(/^[\s>*-]+/, '')
    .replace(/`+/g, '')
    .split(/(?<=[.!?])\s|\n/)[0]
    ?.trim();
  if (!firstSentence) return undefined;
  const name = firstSentence.slice(0, 80).trim();
  // Needs real topic words, not just scaffolding, to be a usable identity.
  return significantTokens(name).size >= 3 ? name : undefined;
}

/**
 * Build the per-agent→shared promotion function used after the dreaming applier
 * writes an `add` to local memory (K3↔K4). Returns `undefined` when the shared
 * KB is disabled or in `propose` (dry-run) mode — callers then skip promotion.
 *
 * Note identity is the proposal's `topic` slug — the reviewer names what the
 * fact IS (issue #398), in the SAME freeform namespace `memory_shared_create`/
 * `_update` use, not a content hash. A content-hashed name (the pre-#386 scheme)
 * meant the same recurring fact, reworded slightly by the reviewer each night,
 * hashed differently and was written as a brand-new note every time — this is
 * what created the near-duplicate pileup #386 reports. A stable name means the
 * same recurring fact maps to the same note across nights, landing as an
 * update. A name that doesn't collide is also checked against the shared
 * vault's near-dup search before creating, and merged into the closest match
 * instead of creating a disconnected duplicate when one is found.
 *
 * Concurrency note: the name-collision check, read, and write below are not one
 * atomic operation, so two agents dreaming at the same moment and promoting
 * under the exact same name can race — `shared-writer.ts` already documents
 * that same-file races resolve to last-write-wins, never corruption, and other
 * read-modify-write callers (e.g. `memory_shared_update`) have this same
 * property. Naming by topic instead of a content hash makes same-name
 * collisions between different agents more likely than the pre-#386 scheme, but
 * it's the same accepted tradeoff, not a new class of risk.
 */
export function makeSharedPromoter(
  // No longer used for NAMING — issue #386 moved note identity off the agent id,
  // and issue #398 moved it to the proposal's `topic` slug (falling back to the
  // fact itself), so a recurring fact maps to the same
  // shared note whichever agent dreamed it. Still carried because every declined
  // promotion is logged with the agent that proposed it.
  agentId: string,
  agentCfg: KnowledgeSharedConfig | undefined,
  globalCfg: KnowledgeSharedConfig | undefined,
  // Promotion can decline for several reasons and used to do so in total silence,
  // which made "why did the shared vault stop growing?" undiagnosable from the
  // outside (issue #398 review). Optional so existing call sites keep working.
  logger?: { info: (msg: string, data?: Record<string, unknown>) => void },
): ((p: { reason: string; content?: string; topic?: string }) => void) | undefined {
  const sharedCfg = resolveSharedConfig(agentCfg, globalCfg);
  if (!sharedCfg.enabled || sharedCfg.mode !== 'auto') return undefined;
  const skip = (why: string, data: Record<string, unknown> = {}): void => {
    logger?.info('shared promotion skipped', { agentId, why, ...data });
  };
  return (p: { reason: string; content?: string; topic?: string }) => {
    const content = (p.content ?? '').trim();
    if (!content) return;

    // An index pointer is a per-agent navigation aid, not a shareable fact: its
    // links resolve only inside the promoting agent's own workspace.
    if (isIndexPointerOnly(content)) {
      skip('index-pointer-only', { reason: p.reason });
      return;
    }

    // Identity: the reviewer-declared `topic` slug (mirroring the episodic
    // contract), else the fact itself. The free-form `reason` is never a name,
    // so an editing instruction written there cannot become one (issue #629).
    const name = (p.topic ?? '').trim() || deriveNameFromContent(content);
    if (!name) {
      skip('no-usable-name', { reason: p.reason });
      return;
    }

    try {
      // A `stale__` twin of THIS name means the GC retired this fact and it has
      // now recurred — the recurrence itself is the promote-back signal. Resolved
      // BEFORE the update/create split because both paths put a live file back at
      // `name`, and once that file exists the GC's own restore refuses forever
      // (`moveNoteFromStale` bails on `sharedNoteExists`). A twin left behind is
      // not inert: retired notes stay indexed and searchable by design (#392), so
      // the same fact would answer every query twice, permanently (issue #398
      // review — the create path handled this, the update path did not).
      const staleTwin = `${STALE_NOTE_PREFIX}${name}`;
      const retired = sharedNoteExists(sharedCfg, staleTwin)
        ? (readSharedNote(sharedCfg, staleTwin) ?? '').replace(/^<!--[\s\S]*?-->\s*/, '').trim()
        : '';
      // Only drop the twin once its content is safely in the live note: a write
      // refused by the size cap must leave the retired copy where it is.
      const dropTwinIfWritten = (written: boolean): void => {
        if (written && retired) deleteSharedNoteFile(sharedCfg, staleTwin);
      };

      // Same name recurred: this IS the same fact — update it, never duplicate.
      if (sharedNoteExists(sharedCfg, name)) {
        const existing = readSharedNote(sharedCfg, name) ?? '';
        const withRetired = retired ? mergeIntoNote(existing, retired) : existing;
        const written = writeCapped(sharedCfg, name, mergeIntoNote(withRetired, content));
        if (!written) skip('note-size-cap', { reason: p.reason, note: name });
        dropTwinIfWritten(written);
        return;
      }

      // New name, but the content may already live in another note. FTS is
      // recall only; `filterNearDuplicates` is the precision bar that decides
      // whether an UNATTENDED merge is justified. Below the bar the fact gets
      // its own note — two notes are recoverable, two unrelated facts fused
      // into one are not (issue #398).
      //
      // Retired (`stale__*`) notes are excluded as targets: they are indexed
      // like any other file, and merging a fresh fact into one would write it
      // straight into the set the GC has already moved out of the active vault.
      const seed = buildSeedText(name, content);
      const candidates = findSimilarSharedNotes(sharedCfg, seed, 3).filter(
        (c) => !c.name.startsWith(STALE_NOTE_PREFIX),
      );
      // Score against each candidate's FULL body, not the matched chunk: a long
      // note that a recurring topic has merged into spreads the seed across
      // chunks and would score far below its real containment.
      const bodyOf = (c: { name: string }): string => readSharedNote(sharedCfg, c.name) ?? '';
      const mergeable = filterNearDuplicates(seed, candidates, undefined, bodyOf);
      // Wikilinks clear a LOWER bar than merges: a link is an additive "these
      // are related" claim, while a merge asserts they are the same fact and
      // destroys the distinction. Computed for BOTH outcomes — a new note that
      // has related neighbours must still carry its edges, or the graph gains a
      // disconnected node exactly in the 0.25–0.5 band (issue #398 review).
      const linkable = filterNearDuplicates(seed, candidates, MIN_RELATED_CONTAINMENT, bodyOf);

      if (mergeable.length > 0) {
        const primary = mergeable[0];
        const related = linkable.filter((c) => c.name !== primary.name);
        const existing = readSharedNote(sharedCfg, primary.name) ?? '';
        if (
          !writeCapped(
            sharedCfg,
            primary.name,
            mergeIntoNote(existing, content, related.map((r) => r.name)),
          )
        ) {
          skip('note-size-cap', { reason: p.reason, note: primary.name });
        }
        return;
      }

      // Creating fresh. Folding a retired twin back in here also stops two files
      // from sharing one `entry_hash`, whose single lifecycle row's `path` would
      // otherwise flip between them on every index pass.
      const body = retired ? mergeIntoNote(retired, content) : content;
      const written = writeCapped(sharedCfg, name, body, linkable.map((r) => r.name));
      if (!written) skip('note-size-cap', { reason: p.reason, note: name });
      dropTwinIfWritten(written);
    } catch (err) {
      // Best-effort — a promotion failure never affects the local dream. It must
      // not be invisible either: a vault that silently stops growing was the
      // undiagnosable failure issue #398 set out to close.
      skip('write-failed', { reason: p.reason, error: (err as Error)?.message });
    }
  };
}
