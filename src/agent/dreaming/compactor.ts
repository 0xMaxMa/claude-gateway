/**
 * Deterministic memory compactor (issue #337, approach #3) — the non-LLM shrink
 * lever for append-only PR/issue logs in MEMORY.md.
 *
 * The problem: agents accumulate a `## Active PR` / `## Issues` style log where
 * every entry is a full changelog line (description, review score, commit hash).
 * Entries marked `MERGED` / `CLOSED` are terminal — the work is done — yet they
 * are never removed, so the file grows unbounded (meguri: ~78 KB vs an 8 KB
 * budget, ~50% of it these two log sections). The LLM reviewer can't see them
 * (it is anchored to the recent transcript), so nothing ever prunes them.
 *
 * The fix, deterministically and WITHOUT losing recall: move each terminal-state
 * entry's FULL text into a `memory/archive/*.md` file — which the knowledge
 * indexer already walks (`indexer.ts` → `walkMarkdown('memory')`), so the
 * archived record stays searchable via `memory_search` — and leave a compact
 * one-line pointer in MEMORY.md. The agent still "remembers" everything; it just
 * recalls the completed items on demand instead of carrying them in-prompt.
 *
 * Design constraints (this mutates real agent memory, so it is conservative):
 *   - Terminal markers are the UPPERCASE status words `MERGED` / `CLOSED` only.
 *     Prose like "Closes #1857" or "merged into develop" is NOT matched, so an
 *     open/active entry is never archived by accident.
 *   - Only top-level list bullets (`- ` / `* ` at column 0) plus their contiguous
 *     continuation lines form an archivable block. Headers and other structure
 *     are left untouched.
 *   - Idempotent: a pointer this pass emits (which links to the archive file) is
 *     never re-archived on the next run.
 *   - Nothing is ever dropped: an archived block is appended to the archive file
 *     BEFORE MEMORY.md is rewritten, and every removed block leaves a pointer.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Where archived completed-log entries are stored (indexed + searchable). */
export const ARCHIVE_REL_PATH = 'memory/archive/completed.md';

const STATUS_WORDS =
  'MERGED|CLOSED|DONE|COMPLETED|FINISHED|RESOLVED|CANCELLED|CANCELED|ARCHIVED|SUPERSEDED|OBSOLETE|DEPRECATED|EXPIRED|SHIPPED';
/**
 * A "done / terminal" marker, domain-agnostic (not just dev): an UPPERCASE status
 * word (case-sensitive, so prose like "Closes #12" or lowercase "closed early"
 * never matches), a checked task box `[x]`/`[X]`, a ✅ check mark, or a
 * ~~strikethrough~~. Covers any topic the agent marks done while keeping false
 * positives low.
 */
const TERMINAL_RE = new RegExp(`(?:\\b(?:${STATUS_WORDS})\\b|✅|\\[[xX]\\]|~~[^~]+~~)`);
/** Leading done-marker to strip from a pointer label (checkbox / check / strike open). */
const LEAD_MARKER_RE = /^(?:✅|\[[xX]\]|~~)\s*/;
const TOP_BULLET_RE = /^[-*] /;
const HEADER_RE = /^#{1,6} /;
/** h1/h2 are structural sections; h3–h6 can be a completed *entry* header. */
const SECTION_RE = /^#{1,2} /;
const ENTRY_HEADER_RE = /^#{3,6} /;
const BLANK_RE = /^\s*$/;

/** A parsed block: a lead line (bullet or h3+ header) plus its continuation lines. */
interface Block {
  lines: string[];
  /** The nearest preceding `## ` section title (for archive provenance). */
  section: string;
  /** How the pointer is re-emitted: keep a bullet, or keep the header prefix. */
  lead: 'bullet' | 'header';
  /** For header blocks, the `### ` prefix to preserve on the pointer. */
  headerPrefix: string;
}

/** Result of the pure planning step — no I/O. */
export interface CompactionPlan {
  /** New MEMORY.md content (terminal blocks replaced by pointers). */
  nextMemory: string;
  /** Text to append to the archive file ('' when nothing is archived). */
  archiveAppend: string;
  /** How many blocks were archived. */
  archivedCount: number;
  /** Net chars removed from MEMORY.md (before − after). */
  charsRemoved: number;
}

/** Applied result — includes the archive path actually written. */
export interface CompactionResult {
  archivedCount: number;
  charsRemoved: number;
  archivePath: string | null;
}

/** True when this bullet line marks a terminal (done) entry we should archive. */
function isTerminalHead(head: string): boolean {
  // Never re-archive a pointer we already emitted (it links to the archive file).
  if (head.includes(ARCHIVE_REL_PATH)) return false;
  return TERMINAL_RE.test(head);
}

/**
 * Extract a compact identity label for the pointer line, from a lead line whose
 * bullet/header prefix has already been stripped (`body`). Preference order:
 *   1. An existing markdown link `[text](url)` — kept verbatim so the entry's own
 *      per-record memory/*.md link (if any) survives.
 *   2. The identity text BEFORE the terminal marker, so status/detail stays in the
 *      archive and only the name lands in the pointer.
 *   3. The first ~70 chars, markdown stripped.
 */
function extractLabel(body: string): string {
  const trimmed = body.replace(LEAD_MARKER_RE, '').trim();
  const link = trimmed.match(/\[[^\]]+\]\([^)]+\)/);
  if (link) return link[0];
  // Everything from the terminal marker onward is detail bound for the archive.
  const cut = trimmed.search(TERMINAL_RE);
  let ident = (cut > 0 ? trimmed.slice(0, cut) : trimmed).trim();
  ident = ident
    .replace(/[\s—–\-:,(~]+$/, '') // trailing separators / open strike left by the cut
    .replace(/[*_`~]/g, '') // markdown emphasis / strike marks
    .replace(/\s+/g, ' ')
    .trim();
  if (!ident) ident = trimmed.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  return ident.length > 70 ? ident.slice(0, 70).replace(/\s+\S*$/, '') + '…' : ident;
}

/** Which terminal marker matched (for the pointer suffix); non-word markers ⇒ DONE. */
function statusOf(head: string): string {
  const m = head.match(TERMINAL_RE);
  if (!m) return 'DONE';
  return /^[A-Z]+$/.test(m[0]) ? m[0] : 'DONE';
}

/**
 * Parse MEMORY.md into an ordered list of items. Each item is either a raw line
 * (h1/h2 section headers, blanks, prose) or a Block:
 *   - a top-level bullet (`- `/`* `) plus its contiguous non-blank continuation lines, or
 *   - an h3–h6 entry header (`### …`) plus its body up to the next header/blank.
 * h1/h2 headers are structural section titles — never archivable entries.
 */
type Item = { kind: 'raw'; line: string } | { kind: 'block'; block: Block };

function parseItems(memory: string): Item[] {
  const lines = memory.split('\n');
  const items: Item[] = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // h1/h2 = structural section title (updates provenance, never a block).
    if (SECTION_RE.test(line)) {
      section = line.replace(/^#{1,6}\s+/, '').trim();
      items.push({ kind: 'raw', line });
      continue;
    }
    // h3–h6 = a completed-entry header candidate; absorb its body until the next
    // header (any level) or a blank line.
    if (ENTRY_HEADER_RE.test(line)) {
      const blockLines = [line];
      let j = i + 1;
      while (j < lines.length && !BLANK_RE.test(lines[j]) && !HEADER_RE.test(lines[j])) {
        blockLines.push(lines[j]);
        j++;
      }
      const headerPrefix = (line.match(/^#{3,6}\s+/) ?? ['### '])[0];
      items.push({ kind: 'block', block: { lines: blockLines, section, lead: 'header', headerPrefix } });
      i = j - 1;
      continue;
    }
    if (TOP_BULLET_RE.test(line)) {
      const blockLines = [line];
      // Absorb continuation lines: non-blank lines that are neither a header nor
      // the next top-level bullet.
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
      items.push({ kind: 'block', block: { lines: blockLines, section, lead: 'bullet', headerPrefix: '' } });
      i = j - 1;
      continue;
    }
    items.push({ kind: 'raw', line });
  }
  return items;
}

/**
 * Plan a compaction over `memory`. Pure (no I/O) so it is exhaustively testable.
 * Terminal-state blocks (bullets or h3+ entry headers) are replaced with a
 * one-line pointer; their full original text is collected into `archiveAppend`.
 */
export function planCompaction(memory: string, now: number): CompactionPlan {
  const items = parseItems(memory);
  const date = new Date(now).toISOString().slice(0, 10);
  const outLines: string[] = [];
  const archiveChunks: string[] = [];
  let archivedCount = 0;

  for (const item of items) {
    if (item.kind === 'raw') {
      outLines.push(item.line);
      continue;
    }
    const block = item.block;
    const head = block.lines[0];
    if (!isTerminalHead(head)) {
      outLines.push(...block.lines);
      continue;
    }
    // Archive the full original block; leave a compact pointer behind. The pointer
    // keeps the block's lead form (a bullet, or the same `### ` header level).
    const original = block.lines.join('\n');
    const prefix = block.lead === 'header' ? block.headerPrefix : '- ';
    const body = head.replace(block.lead === 'header' ? ENTRY_HEADER_RE : TOP_BULLET_RE, '').trim();
    const label = extractLabel(body);
    const status = statusOf(head);
    outLines.push(`${prefix}${label} — ${status}, archived ${date} → ${ARCHIVE_REL_PATH}`);
    archiveChunks.push(
      `<!-- archived ${date} from MEMORY.md · ## ${block.section} -->\n${original.trim()}\n`,
    );
    archivedCount++;
  }

  if (archivedCount === 0) {
    return { nextMemory: memory, archiveAppend: '', archivedCount: 0, charsRemoved: 0 };
  }
  const nextMemory = outLines.join('\n');
  return {
    nextMemory,
    archiveAppend: archiveChunks.join('\n'),
    archivedCount,
    charsRemoved: Math.max(0, memory.length - nextMemory.length),
  };
}

/** Write `content` to `filePath` atomically (temp in same dir + rename). */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-compact-${process.pid}-${process.hrtime.bigint().toString(36)}`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

function readOnDisk(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Write a rollback pre-image of MEMORY.md before the compaction rewrite. */
function writeBackup(workspaceDir: string, original: string, now: number): void {
  try {
    const dir = path.join(workspaceDir, '.dreaming', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, `MEMORY.md.${now}.compact.bak`), original);
  } catch {
    /* best-effort — a failed backup must not block the (archive-first) compaction */
  }
}

/**
 * Run the deterministic compaction against an agent's MEMORY.md. Never throws;
 * on any error the memory file is left untouched.
 *
 * Ordering is crash-safe: the archive file is appended FIRST, then MEMORY.md is
 * rewritten. A crash between the two leaves the entries in BOTH files (a harmless
 * duplicate), never lost. A CAS re-read guards against clobbering a concurrent
 * agent edit.
 */
export function compactCompletedEntries(
  workspaceDir: string,
  now: number = Date.now(),
): CompactionResult {
  const none: CompactionResult = { archivedCount: 0, charsRemoved: 0, archivePath: null };
  try {
    const memPath = path.join(workspaceDir, 'MEMORY.md');
    const original = readOnDisk(memPath);
    if (!original.trim()) return none;

    const plan = planCompaction(original, now);
    if (plan.archivedCount === 0) return none;

    // Early CAS: if a live agent edited MEMORY.md since we read it, abort BEFORE
    // touching the archive — otherwise we would append entries that then can't be
    // removed from MEMORY.md (the late CAS below would block the rewrite), and the
    // next run would archive them again. Concurrent edits are rare (dreams run in a
    // quiet window) but this keeps the common case duplicate-free.
    const memPathNow = readOnDisk(memPath);
    if (memPathNow !== original) return none;

    // 1) Archive first (append to the searchable archive file). If a crash happens
    // between this and the rewrite below, entries live in BOTH files (a harmless
    // duplicate), never lost.
    const archivePath = path.join(workspaceDir, ARCHIVE_REL_PATH);
    const existingArchive = readOnDisk(archivePath);
    const header = existingArchive
      ? existingArchive.replace(/\s*$/, '') + '\n\n'
      : '# Archived completed log entries\n\nMoved out of MEMORY.md by nightly compaction (#337). Still searchable via `memory_search`.\n\n';
    atomicWrite(archivePath, header + plan.archiveAppend);

    // 2) Late CAS: re-check immediately before the rewrite (guards the tiny window
    // between the early check and here).
    if (readOnDisk(memPath) !== original) return { ...none, archivePath };
    writeBackup(workspaceDir, original, now);
    atomicWrite(memPath, plan.nextMemory);

    return { archivedCount: plan.archivedCount, charsRemoved: plan.charsRemoved, archivePath };
  } catch {
    return none;
  }
}
