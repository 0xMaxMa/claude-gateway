/**
 * Episodic note writer (planning-65) — routes task-log OUT of the injected core
 * (MEMORY.md) into the searchable `memory/<topic>.md` archive tier.
 *
 * MEMORY.md is injected into every prompt (expensive); episodic records of "what
 * happened" belong in `memory/*.md`, which the knowledge indexer already walks
 * (`indexer.ts` → `walkMarkdown('memory')`) so the note stays retrievable via
 * `memory_search` — recall is preserved, the prompt stays small.
 *
 * Security: the transcript that drives the dreaming reviewer is untrusted
 * (prompt-injection surface), so the topic slug is validated against a strict
 * regex AND the resolved path is realpath-confined under `<ws>/<episodicDir>/`.
 * A topic that fails validation or escapes the directory is rejected — never
 * written. Append-only (a dated bullet); never rewrites existing content, so it
 * cannot destroy prior notes.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Lowercase-kebab slug, 1..64 chars. No slashes/dots ⇒ cannot escape the dir. */
export const EPISODIC_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LEN = 64;

/** Default episodic archive directory (relative to the agent workspace). */
export const DEFAULT_EPISODIC_DIR = 'memory';

export function isValidTopicSlug(topic: unknown): topic is string {
  return (
    typeof topic === 'string' &&
    topic.length >= 1 &&
    topic.length <= MAX_SLUG_LEN &&
    EPISODIC_SLUG_RE.test(topic)
  );
}

/**
 * Resolve `<ws>/<episodicDir>/<topic>.md`, confined under `<ws>/<episodicDir>`.
 * Returns null for an invalid slug or any path that would escape the base dir
 * (defense-in-depth on top of the slug regex).
 */
export function resolveEpisodicPath(
  workspaceDir: string,
  episodicDir: string,
  topic: string,
): string | null {
  if (!isValidTopicSlug(topic)) return null;
  const baseDir = path.resolve(workspaceDir, episodicDir);
  const target = path.resolve(baseDir, `${topic}.md`);
  const rel = path.relative(baseDir, target);
  // Must be a direct child file `<topic>.md` — no separators, no `..`, not absolute.
  if (rel !== `${topic}.md` || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

export interface EpisodicWriteResult {
  topic: string;
  /** Absolute path written, or '' when the write was rejected/failed. */
  path: string;
  ok: boolean;
  bytesAppended: number;
}

/**
 * Append a dated bullet to `memory/<topic>.md` (creating dir + file on first
 * write). One entry per line — internal newlines are collapsed so a note stays a
 * single searchable bullet. Never throws; a rejected/failed write returns
 * `ok:false` and touches nothing.
 */
export function appendEpisodicNote(
  workspaceDir: string,
  episodicDir: string,
  topic: string,
  content: string,
  now: number,
): EpisodicWriteResult {
  const fail: EpisodicWriteResult = { topic: String(topic ?? ''), path: '', ok: false, bytesAppended: 0 };
  const abs = resolveEpisodicPath(workspaceDir, episodicDir, topic);
  if (!abs) return fail;
  const text = (content ?? '').trim();
  if (!text) return fail;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const date = new Date(now).toISOString().slice(0, 10);
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const header = existing
      ? ''
      : `# ${topic}\n\nEpisodic task-log routed out of MEMORY.md (planning-65). Searchable via \`memory_search\`.\n\n`;
    const bullet = `- [${date}] ${text.replace(/\s*\n\s*/g, ' ')}`;
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    const payload = `${header}${sep}${bullet}\n`;
    fs.appendFileSync(abs, payload, 'utf8');
    return { topic, path: abs, ok: true, bytesAppended: payload.length };
  } catch {
    return fail;
  }
}
