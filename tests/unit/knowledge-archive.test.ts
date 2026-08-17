import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { chunkMarkdown } from '../../src/agent/knowledge/chunk';
import { classifyOrigin } from '../../src/agent/knowledge/provenance';
import { resolveArchiveConfig, ARCHIVE_DEFAULTS } from '../../src/agent/knowledge/config';
import { indexAgentArchive, archiveDbPath } from '../../src/agent/knowledge/indexer';
import { ArchiveDB } from '../../src/agent/knowledge/archive-db';
import { shouldReindexNow, REINDEX_DEBOUNCE_MS } from '../../src/agent/knowledge/reindex-spawn';

// Build a temp agent dir with workspace/ + optional memory files.
// Returns { agentDir, workspaceDir } — the DB lands at agentDir/kb.sqlite.
function mkAgent(files: Record<string, string> = {}): { agentDir: string; workspaceDir: string } {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const workspaceDir = path.join(agentDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workspaceDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { agentDir, workspaceDir };
}

function cleanup(workspaceDir: string): void {
  ArchiveDB.evict(archiveDbPath(workspaceDir));
}

// ---------------------------------------------------------------------------
describe('chunkMarkdown', () => {
  test('empty / whitespace-only content yields no chunks', () => {
    expect(chunkMarkdown('', 400, 80)).toEqual([]);
    expect(chunkMarkdown('   \n  \n', 400, 80)).toEqual([]);
  });

  test('small content is a single line-aligned chunk', () => {
    const chunks = chunkMarkdown('line one\nline two\nline three', 400, 80);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
    expect(chunks[0].text).toContain('line one');
    expect(chunks[0].text).toContain('line three');
  });

  test('large content splits into multiple overlapping chunks (window advances)', () => {
    // 40 lines of ~20 chars; window ~3 lines with an overlap tail wide enough to
    // carry a whole line (overlapChars=32 > one line), so chunks genuinely overlap.
    const content = Array.from({ length: 40 }, (_, i) => `memory line number ${i}`).join('\n');
    const chunks = chunkMarkdown(content, 20, 8); // maxChars=80, overlapChars=32
    expect(chunks.length).toBeGreaterThan(3);
    // Monotonic, covering, and overlapping: some later chunk starts at/before a
    // prior chunk's end line (the carried overlap tail).
    let sawOverlap = false;
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeGreaterThan(0);
      expect(chunks[i].endLine).toBeGreaterThanOrEqual(chunks[i].startLine);
      if (chunks[i].startLine <= chunks[i - 1].endLine) sawOverlap = true;
    }
    expect(sawOverlap).toBe(true);
    // Full coverage: last chunk reaches the final line.
    expect(chunks[chunks.length - 1].endLine).toBe(40);
  });

  test('a single over-long line becomes its own chunk (no empty flush, no loop)', () => {
    const long = 'x'.repeat(5000);
    const chunks = chunkMarkdown(`short\n${long}\nafter`, 10, 2);
    expect(chunks.some((c) => c.text.includes(long))).toBe(true);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('classifyOrigin (fail-closed provenance)', () => {
  test('self-authored memory → agent', () => {
    expect(classifyOrigin('MEMORY.md')).toBe('agent');
    expect(classifyOrigin('USER.md')).toBe('agent');
    expect(classifyOrigin('memory/foo.md')).toBe('agent');
    expect(classifyOrigin('memory/imports/bar.md')).toBe('agent');
  });

  test('machine-generated dreaming outputs → system', () => {
    expect(classifyOrigin('DREAMS.md')).toBe('system');
    expect(classifyOrigin('memory/dreaming/2026-08-17.md')).toBe('system');
    expect(classifyOrigin('.dreaming/DREAMS.md')).toBe('system');
  });

  test('anything else → untrusted (fail-closed)', () => {
    expect(classifyOrigin('notes/random.md')).toBe('untrusted');
    expect(classifyOrigin('AGENTS.md')).toBe('untrusted');
    expect(classifyOrigin('somefile')).toBe('untrusted');
  });
});

// ---------------------------------------------------------------------------
describe('resolveArchiveConfig', () => {
  test('defaults when nothing set', () => {
    expect(resolveArchiveConfig()).toEqual(ARCHIVE_DEFAULTS);
  });

  test('precedence: agent > global > default', () => {
    const r = resolveArchiveConfig({ chunkTokens: 200 }, { chunkTokens: 300, tokenizer: 'trigram' });
    expect(r.chunkTokens).toBe(200); // agent wins
    expect(r.tokenizer).toBe('trigram'); // global wins over default
  });

  test('invalid tokenizer falls back to default', () => {
    expect(resolveArchiveConfig({ tokenizer: 'evil; DROP' }).tokenizer).toBe('unicode61');
  });

  test('non-finite / out-of-range numerics fall back to default', () => {
    const r = resolveArchiveConfig({ chunkTokens: NaN as unknown as number, chunkOverlap: -5 });
    expect(r.chunkTokens).toBe(ARCHIVE_DEFAULTS.chunkTokens);
    expect(r.chunkOverlap).toBe(ARCHIVE_DEFAULTS.chunkOverlap);
  });

  test('overlap is clamped strictly below the chunk window', () => {
    const r = resolveArchiveConfig({ chunkTokens: 50, chunkOverlap: 999 });
    expect(r.chunkOverlap).toBe(49);
  });

  test('enabled:false is respected', () => {
    expect(resolveArchiveConfig({ enabled: false }).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('reindex debounce', () => {
  test('shouldReindexNow: first call passes, a call within the window is skipped, later passes', () => {
    const ws = `/tmp/kb-debounce-${Math.floor(Math.abs(Math.sin(1) * 1e9))}`; // deterministic unique-ish key
    const t0 = 1_000_000;
    expect(shouldReindexNow(ws, t0)).toBe(true); // first → due
    expect(shouldReindexNow(ws, t0 + 1_000)).toBe(false); // within window → skip
    expect(shouldReindexNow(ws, t0 + REINDEX_DEBOUNCE_MS)).toBe(true); // window elapsed → due
    expect(shouldReindexNow(ws, t0 + REINDEX_DEBOUNCE_MS + 5)).toBe(false); // window restarts
  });

  test('shouldReindexNow: distinct workspaces debounce independently', () => {
    const t = 5_000_000;
    expect(shouldReindexNow('/tmp/kb-a', t)).toBe(true);
    expect(shouldReindexNow('/tmp/kb-b', t)).toBe(true); // different key → not blocked by /tmp/kb-a
    expect(shouldReindexNow('/tmp/kb-a', t + 10)).toBe(false);
  });
});

describe('indexAgentArchive (integration)', () => {
  test('AC1: indexes 100% of memory files + evergreen, searchable', () => {
    const { workspaceDir } = mkAgent({
      'MEMORY.md': '# Long-Term Memory\n\nThe deploy runs on kubernetes cluster prod.',
      'USER.md': '# User\n\nTimezone is Bangkok UTC+7.',
      'memory/apps.md': 'The apps router mounts under gateway-router at line 702.',
      'memory/getpod.md': 'Getpod ingress returns 401 before the gateway sees it.',
    });
    try {
      const res = indexAgentArchive(workspaceDir);
      expect(res.filesSeen).toBe(4);
      expect(res.filesIndexed).toBe(4);
      expect(res.filesSkipped).toBe(0);
      expect(res.chunksWritten).toBeGreaterThanOrEqual(4);

      const db = ArchiveDB.forPath(archiveDbPath(workspaceDir));
      expect(db.listSourcePaths().sort()).toEqual(
        ['MEMORY.md', 'USER.md', 'memory/apps.md', 'memory/getpod.md'].sort(),
      );
      // FTS retrieves the right note.
      const hits = db.search('ingress 401');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].path).toBe('memory/getpod.md');
    } finally {
      cleanup(workspaceDir);
    }
  });

  test('AC2: reindex is hash-guarded — unchanged skipped, revision stable', () => {
    const { workspaceDir } = mkAgent({
      'memory/a.md': 'alpha content one',
      'memory/b.md': 'bravo content two',
    });
    try {
      const first = indexAgentArchive(workspaceDir);
      expect(first.filesIndexed).toBe(2);
      const db = ArchiveDB.forPath(archiveDbPath(workspaceDir));
      const revAfterFirst = db.getRevision();

      // Second pass, nothing changed on disk.
      const second = indexAgentArchive(workspaceDir);
      expect(second.filesSeen).toBe(2);
      expect(second.filesIndexed).toBe(0);
      expect(second.filesSkipped).toBe(2);
      expect(db.getRevision()).toBe(revAfterFirst); // no mutation ⇒ no revision bump
    } finally {
      cleanup(workspaceDir);
    }
  });

  test('AC2: a changed file is re-chunked and stale chunks replaced', () => {
    const { workspaceDir } = mkAgent({ 'memory/a.md': 'the original secret is oldvalue' });
    try {
      indexAgentArchive(workspaceDir);
      const db = ArchiveDB.forPath(archiveDbPath(workspaceDir));
      expect(db.search('oldvalue').length).toBeGreaterThan(0);

      fs.writeFileSync(path.join(workspaceDir, 'memory/a.md'), 'the replacement secret is newvalue');
      const res = indexAgentArchive(workspaceDir);
      expect(res.filesIndexed).toBe(1);
      expect(res.filesSkipped).toBe(0);

      expect(db.search('newvalue').length).toBeGreaterThan(0);
      expect(db.search('oldvalue').length).toBe(0); // stale chunk gone
    } finally {
      cleanup(workspaceDir);
    }
  });

  test('AC3: provenance — dreaming outputs system, memory notes agent', () => {
    const { workspaceDir } = mkAgent({
      'memory/note.md': 'a normal self-authored note',
      'memory/dreaming/run.md': 'machine generated dream output',
    });
    try {
      indexAgentArchive(workspaceDir);
      const db = ArchiveDB.forPath(archiveDbPath(workspaceDir));
      const noteHit = db.search('self-authored')[0];
      const dreamHit = db.search('machine generated')[0];
      expect(db.getProvenance(noteHit.id)!.originClass).toBe('agent');
      expect(db.getProvenance(dreamHit.id)!.originClass).toBe('system');
      // Every provenance row carries a valid session_kind (fail-closed default).
      expect(db.getProvenance(noteHit.id)!.sessionKind).toBe('unknown');
    } finally {
      cleanup(workspaceDir);
    }
  });

  test('AC4: enabled:false is a complete no-op (no DB created)', () => {
    const { workspaceDir } = mkAgent({ 'memory/a.md': 'content' });
    try {
      const res = indexAgentArchive(workspaceDir, { archive: { enabled: false } }.archive);
      expect(res).toEqual({
        filesSeen: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        filesRemoved: 0,
        chunksWritten: 0,
      });
      expect(fs.existsSync(archiveDbPath(workspaceDir))).toBe(false); // no DB file
    } finally {
      cleanup(workspaceDir);
    }
  });

  test('M1: a present-but-unreadable file (transient error) is NOT pruned', () => {
    // chmod 000 is bypassed by root, so this can only be exercised as a non-root
    // user — skip under root rather than assert a false guarantee.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const { workspaceDir } = mkAgent({ 'memory/a.md': 'alpha', 'memory/b.md': 'bravo' });
    const bPath = path.join(workspaceDir, 'memory/b.md');
    try {
      indexAgentArchive(workspaceDir);
      const db = ArchiveDB.forPath(archiveDbPath(workspaceDir));
      expect(db.listSourcePaths()).toContain('memory/b.md');

      // Present on disk, but readFileSync now throws EACCES (transient-style error).
      fs.chmodSync(bPath, 0o000);
      let res;
      try {
        res = indexAgentArchive(workspaceDir);
      } finally {
        fs.chmodSync(bPath, 0o644); // restore so temp cleanup can proceed
      }

      expect(res.filesRemoved).toBe(0); // present-but-unreadable ⇒ NOT pruned
      expect(db.listSourcePaths()).toContain('memory/b.md'); // index retained
    } finally {
      cleanup(workspaceDir);
    }
  });

  test('prune: a removed file drops its source + chunks', () => {
    const { workspaceDir } = mkAgent({
      'memory/keep.md': 'keep this note',
      'memory/gone.md': 'this note disappears',
    });
    try {
      indexAgentArchive(workspaceDir);
      const db = ArchiveDB.forPath(archiveDbPath(workspaceDir));
      expect(db.search('disappears').length).toBeGreaterThan(0);

      fs.rmSync(path.join(workspaceDir, 'memory/gone.md'));
      const res = indexAgentArchive(workspaceDir);
      expect(res.filesRemoved).toBe(1);
      expect(db.listSourcePaths()).toEqual(['memory/keep.md']);
      expect(db.search('disappears').length).toBe(0);
    } finally {
      cleanup(workspaceDir);
    }
  });
});
