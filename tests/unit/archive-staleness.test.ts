/**
 * Archive staleness GC (planning-66) — unit + integration tests.
 *
 * Pure primitives (entry hashing, block parsing, supersession, the scoring
 * decision) are tested in isolation; the DB lifecycle + the full GC pass run
 * against a real node:sqlite temp archive with an injected clock. The Bun read-
 * path recorder is exercised through its runtime-agnostic core with a node:sqlite
 * adapter (importing archive-reader.ts directly would pull in bun:sqlite).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

import {
  entryHash,
  normalizeEntryText,
  parseEntryBlocks,
  supersededIds,
  referencedIds,
  detectSupersessions,
  isArchiveTierPath,
} from '../../src/agent/knowledge/lifecycle';
import { indexAgentArchive, archiveDbPath } from '../../src/agent/knowledge/indexer';
import { ArchiveDB, type LifecycleRow } from '../../src/agent/knowledge/archive-db';
import {
  runStalenessGc,
  decideStaleness,
  STALE_REL_PATH,
  RESTORED_REL_PATH,
} from '../../src/agent/dreaming/staleness';
import { recordRetrievalHits } from '../../mcp/tools/memory/retrieval-recorder';
import { resolveDreamingConfig, resolveStalenessConfig, STALENESS_DEFAULTS } from '../../src/agent/dreaming/config';

const DAY = 24 * 60 * 60 * 1000;

function mkAgent(files: Record<string, string> = {}): { agentDir: string; workspaceDir: string } {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb66-'));
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
function db(workspaceDir: string): ArchiveDB {
  return ArchiveDB.forPath(archiveDbPath(workspaceDir));
}
function life(workspaceDir: string, h: string): LifecycleRow | undefined {
  return db(workspaceDir).getLifecycle(h);
}
function row(overrides: Partial<LifecycleRow>): LifecycleRow {
  return {
    entryHash: 'h',
    path: 'memory/archive/log.md',
    firstSeen: 0,
    lastRetrieved: null,
    retrievalCount: 0,
    supersededBy: null,
    invalidAt: null,
    importance: null,
    ...overrides,
  };
}
const CFG = {
  enabled: true,
  staleTtlDays: 90,
  keepImportance: 7,
  minRetrievalKeep: 1,
  supersession: true,
  recordRetrievals: true,
};

// ── Config resolution ──────────────────────────────────────────────────────
describe('staleness config resolution', () => {
  test('defaults are enabled with the documented values', () => {
    expect(resolveDreamingConfig().staleness).toEqual(STALENESS_DEFAULTS);
    expect(STALENESS_DEFAULTS).toMatchObject({ enabled: true, staleTtlDays: 90, keepImportance: 7 });
  });
  test('per-agent override wins over global; booleans honored', () => {
    const r = resolveStalenessConfig({ enabled: false, staleTtlDays: 30 }, { enabled: true });
    expect(r.enabled).toBe(false); // agent override
    expect(r.staleTtlDays).toBe(30);
    expect(r.recordRetrievals).toBe(true); // falls through to default
  });
  test('kill-switch: recordRetrievals:false', () => {
    expect(resolveStalenessConfig({ recordRetrievals: false }).recordRetrievals).toBe(false);
  });
  test('non-finite numerics fall back to defaults', () => {
    const r = resolveStalenessConfig({ staleTtlDays: NaN as unknown as number });
    expect(r.staleTtlDays).toBe(90);
  });
});

// ── Pure: hashing + normalization ──────────────────────────────────────────
describe('entryHash / normalizeEntryText', () => {
  test('stable across whitespace/reflow, changes on content change', () => {
    expect(entryHash('- a  b\n  c')).toBe(entryHash('- a b c'));
    expect(normalizeEntryText('- a  b\n  c')).toBe('- a b c');
    expect(entryHash('- fact one')).not.toBe(entryHash('- fact two'));
  });
});

// ── Pure: block parser ─────────────────────────────────────────────────────
describe('parseEntryBlocks', () => {
  test('parses top-level bullets + h3 headers with line ranges; ignores h1/h2/prose', () => {
    const md = [
      '# Section', // 1 h1 — not an entry
      'intro prose', // 2 prose — not an entry
      '- first bullet', // 3 block
      '  continued', // 4  (continuation of 3)
      '- second bullet', // 5 block
      '', // 6 blank
      '### An entry header', // 7 block
      'body line', // 8  (continuation of 7)
    ].join('\n');
    const blocks = parseEntryBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ startLine: 3, endLine: 4 });
    expect(blocks[1]).toMatchObject({ startLine: 5, endLine: 5 });
    expect(blocks[2]).toMatchObject({ startLine: 7, endLine: 8 });
  });
});

// ── Pure: supersession detection (precision) ───────────────────────────────
describe('supersession detection', () => {
  test('verb+#id matches; prose "Closes #12" / bare "#12" do not', () => {
    expect([...supersededIds('supersedes #316')]).toEqual([316]);
    expect([...supersededIds('replaces #7 and obsoletes #8')].sort()).toEqual([7, 8]);
    expect([...supersededIds('Closes #12')]).toEqual([]);
    expect([...supersededIds('see #12 for context')]).toEqual([]);
    expect([...referencedIds('fix #100 then #100 again')]).toEqual([100]);
  });

  test('detectSupersessions marks the referenced older entry, not the superseding one', () => {
    const blocks = parseEntryBlocks(
      ['- fix #100 login bug', '- supersedes #100 with a new login fix'].join('\n'),
    );
    const [older, newer] = blocks;
    const sup = detectSupersessions(blocks);
    expect(sup).toHaveLength(1);
    expect(sup[0].targetHash).toBe(older.entryHash);
    expect(sup[0].bySpec).toBe(newer.entryHash);
  });

  test('prose reference does not create a supersession', () => {
    const blocks = parseEntryBlocks(['- fix #100', '- Closes #100 (done)'].join('\n'));
    expect(detectSupersessions(blocks)).toEqual([]);
  });
});

// ── Pure: archive-tier gate ────────────────────────────────────────────────
describe('isArchiveTierPath', () => {
  test('memory/*.md yes; evergreen + pinned + shared no', () => {
    expect(isArchiveTierPath('memory/archive/log.md')).toBe(true);
    expect(isArchiveTierPath('memory/topic.md')).toBe(true);
    expect(isArchiveTierPath('MEMORY.md')).toBe(false);
    expect(isArchiveTierPath('USER.md')).toBe(false);
    expect(isArchiveTierPath('memory/pinned/keep.md')).toBe(false);
    expect(isArchiveTierPath('notes/shared.md')).toBe(false);
  });
});

// ── Pure: scoring decision ─────────────────────────────────────────────────
describe('decideStaleness', () => {
  const now = 1_000 * DAY;
  test('superseded → invalidate', () => {
    const { invalidate } = decideStaleness([row({ supersededBy: 'x', firstSeen: now })], CFG, now);
    expect(invalidate).toHaveLength(1);
  });
  test('idle past TTL & low recall → invalidate', () => {
    const { invalidate } = decideStaleness([row({ firstSeen: now - 100 * DAY })], CFG, now);
    expect(invalidate).toHaveLength(1);
  });
  test('idle past TTL but retrieved enough → keep', () => {
    const { invalidate } = decideStaleness(
      [row({ firstSeen: now - 100 * DAY, retrievalCount: 1 })],
      CFG,
      now,
    );
    expect(invalidate).toHaveLength(0);
  });
  test('LRU: fresh last_retrieved beats old first_seen → keep', () => {
    const { invalidate } = decideStaleness(
      [row({ firstSeen: now - 100 * DAY, lastRetrieved: now - 1 * DAY })],
      CFG,
      now,
    );
    expect(invalidate).toHaveLength(0);
  });
  test('importance >= keepImportance → keep even when old', () => {
    const { invalidate } = decideStaleness(
      [row({ firstSeen: now - 100 * DAY, importance: 8 })],
      CFG,
      now,
    );
    expect(invalidate).toHaveLength(0);
  });
  test('invalidated + retrieved after invalidation → promote', () => {
    const { promote } = decideStaleness(
      [row({ invalidAt: now - 5 * DAY, lastRetrieved: now - 1 * DAY })],
      CFG,
      now,
    );
    expect(promote).toHaveLength(1);
  });
  test('invalidated + NOT retrieved since → stays (no promote)', () => {
    const { promote } = decideStaleness(
      [row({ invalidAt: now - 1 * DAY, lastRetrieved: now - 5 * DAY })],
      CFG,
      now,
    );
    expect(promote).toHaveLength(0);
  });
});

// ── DB: lifecycle from the real indexer ────────────────────────────────────
describe('indexer → lifecycle', () => {
  test('archive-tier file gets a lifecycle row per block; evergreen does not', () => {
    const { workspaceDir } = mkAgent({
      'MEMORY.md': '# Core\n- durable fact alpha\n',
      'memory/archive/log.md': '- alpha entry uno\n- beta entry dos\n- gamma entry tres\n',
    });
    try {
      indexAgentArchive(workspaceDir);
      const lc = db(workspaceDir).listLifecycle();
      // 3 archive blocks get lifecycle rows; the evergreen MEMORY.md bullet does not.
      expect(lc).toHaveLength(3);
      expect(lc.every((l) => l.path === 'memory/archive/log.md')).toBe(true);
      expect(lc.every((l) => l.firstSeen > 0 && l.invalidAt === null)).toBe(true);
    } finally {
      cleanup(workspaceDir);
    }
  });

  test('first_seen is upsert-once: survives a re-index that changes the file', () => {
    const { workspaceDir } = mkAgent({ 'memory/archive/log.md': '- stable entry keeps age\n' });
    try {
      indexAgentArchive(workspaceDir);
      const h = entryHash('- stable entry keeps age');
      const firstSeen0 = life(workspaceDir, h)!.firstSeen;
      // Append an unrelated block (file hash changes → re-chunk) but keep the block.
      const p = path.join(workspaceDir, 'memory/archive/log.md');
      fs.writeFileSync(p, '- stable entry keeps age\n- a brand new sibling entry\n');
      const future = Date.now() + 5000;
      fs.utimesSync(p, future / 1000, future / 1000);
      indexAgentArchive(workspaceDir);
      expect(life(workspaceDir, h)!.firstSeen).toBe(firstSeen0); // unchanged
    } finally {
      cleanup(workspaceDir);
    }
  });
});

// ── DB: retrieval log aggregation ──────────────────────────────────────────
describe('aggregateRetrievalLog', () => {
  test('folds newest hit + count into lifecycle and clears the log', () => {
    const { workspaceDir } = mkAgent({ 'memory/archive/log.md': '- recall me alpha\n' });
    try {
      indexAgentArchive(workspaceDir);
      const h = entryHash('- recall me alpha');
      const d = db(workspaceDir);
      d.logRetrieval(h, 100);
      d.logRetrieval(h, 300);
      d.logRetrieval(h, 200);
      expect(d.aggregateRetrievalLog()).toBe(3);
      const l = d.getLifecycle(h)!;
      expect(l.lastRetrieved).toBe(300);
      expect(l.retrievalCount).toBe(3);
      expect(d.aggregateRetrievalLog()).toBe(0); // log cleared
    } finally {
      cleanup(workspaceDir);
    }
  });
});

// ── Read-path recorder (runtime-agnostic core, node adapter) ───────────────
describe('recordRetrievalHits (append-only, does not touch kb_chunks)', () => {
  test('dedups a batch and never mutates chunk rows', () => {
    const { workspaceDir } = mkAgent({ 'memory/archive/log.md': '- one\n- two\n' });
    try {
      indexAgentArchive(workspaceDir);
      const raw = new DatabaseSync(archiveDbPath(workspaceDir));
      const chunksBefore = (raw.prepare('SELECT COUNT(*) n FROM kb_chunks').get() as { n: number }).n;
      recordRetrievalHits(
        { run: (sql, params = []) => void raw.prepare(sql).run(...(params as never[])) },
        ['hA', 'hA', 'hB', null],
        555,
      );
      const logCount = (raw.prepare('SELECT COUNT(*) n FROM kb_retrieval_log').get() as { n: number }).n;
      const chunksAfter = (raw.prepare('SELECT COUNT(*) n FROM kb_chunks').get() as { n: number }).n;
      expect(logCount).toBe(2); // hA deduped, null skipped
      expect(chunksAfter).toBe(chunksBefore); // invariant: chunks untouched
      raw.close();
    } finally {
      cleanup(workspaceDir);
    }
  });
});

// ── Full GC pass: invalidate / keep / searchable / feedback ────────────────
describe('runStalenessGc (integration)', () => {
  const LOG = [
    '- alpha fix #100 login bug', // a: will be superseded → invalidate
    '- supersedes #100 with a fresh login rewrite', // e: superseding + retrieved → keep
    '- beta ancient deployment note about kudzu', // b: aged, never retrieved → invalidate
    '- gamma recent lookup about zebra', // c: retrieved recently → keep (LRU)
  ].join('\n');

  function setup() {
    const agent = mkAgent({
      'memory/archive/log.md': LOG + '\n',
      // Pinned: searchable but structurally exempt from the GC (no lifecycle row).
      'memory/pinned/keep.md': '- delta pinned rocket note never ages\n',
    });
    indexAgentArchive(agent.workspaceDir);
    const h = {
      a: entryHash('- alpha fix #100 login bug'),
      e: entryHash('- supersedes #100 with a fresh login rewrite'),
      b: entryHash('- beta ancient deployment note about kudzu'),
      c: entryHash('- gamma recent lookup about zebra'),
      pinned: entryHash('- delta pinned rocket note never ages'),
    };
    const firstSeen = life(agent.workspaceDir, h.b)!.firstSeen;
    const now = firstSeen + 100 * DAY;
    // c and e retrieved yesterday → recall keeps them despite age.
    db(agent.workspaceDir).logRetrieval(h.c, now - 1 * DAY);
    db(agent.workspaceDir).logRetrieval(h.e, now - 1 * DAY);
    return { ...agent, h, now };
  }

  test('invalidates superseded + aged, keeps retrieved + superseding + pinned; all still searchable', () => {
    const { workspaceDir, h, now } = setup();
    try {
      const res = runStalenessGc(workspaceDir, CFG, { now });
      expect(res.invalidated).toBe(2); // a (superseded) + b (aged)
      expect(res.supersededMarked).toBe(1);

      expect(life(workspaceDir, h.a)!.invalidAt).not.toBeNull();
      expect(life(workspaceDir, h.b)!.invalidAt).not.toBeNull();
      expect(life(workspaceDir, h.c)!.invalidAt).toBeNull(); // retrieved
      expect(life(workspaceDir, h.e)!.invalidAt).toBeNull(); // retrieved + superseding
      // Pinned is structurally excluded — it never even gets a lifecycle row.
      expect(life(workspaceDir, h.pinned)).toBeUndefined();

      // Physically moved into stale.md.
      const stale = fs.readFileSync(path.join(workspaceDir, STALE_REL_PATH), 'utf8');
      expect(stale).toContain('kudzu'); // b
      expect(stale).toContain('login bug'); // a
      // Kept entries remain in their source files.
      const log = fs.readFileSync(path.join(workspaceDir, 'memory/archive/log.md'), 'utf8');
      expect(log).toContain('zebra'); // c
      const pinned = fs.readFileSync(path.join(workspaceDir, 'memory/pinned/keep.md'), 'utf8');
      expect(pinned).toContain('rocket'); // pinned untouched

      // HARD REQUIREMENT (ยุบได้แต่ไม่ลืม): every entry still findable via search.
      const d = db(workspaceDir);
      for (const term of ['kudzu', 'zebra', 'rocket', 'login']) {
        expect(d.search(term).length).toBeGreaterThan(0);
      }
    } finally {
      cleanup(workspaceDir);
    }
  });

  test('feedback: an invalidated entry retrieved afterward is promoted back', () => {
    const { workspaceDir, h, now } = setup();
    try {
      runStalenessGc(workspaceDir, CFG, { now });
      expect(life(workspaceDir, h.b)!.invalidAt).not.toBeNull(); // b is stale

      // b gets retrieved AFTER invalidation; next GC promotes it back.
      db(workspaceDir).logRetrieval(h.b, now + 1 * DAY);
      const res = runStalenessGc(workspaceDir, CFG, { now: now + 2 * DAY });
      expect(res.promoted).toBe(1);

      expect(life(workspaceDir, h.b)!.invalidAt).toBeNull(); // live again
      const restored = fs.readFileSync(path.join(workspaceDir, RESTORED_REL_PATH), 'utf8');
      expect(restored).toContain('kudzu');
      const stale = fs.readFileSync(path.join(workspaceDir, STALE_REL_PATH), 'utf8');
      expect(stale).not.toContain('kudzu'); // moved out of stale.md
    } finally {
      cleanup(workspaceDir);
    }
  });

  test('disabled config is a no-op', () => {
    const { workspaceDir, now } = setup();
    try {
      const res = runStalenessGc(workspaceDir, { ...CFG, enabled: false }, { now });
      expect(res).toMatchObject({ invalidated: 0, promoted: 0 });
      expect(fs.existsSync(path.join(workspaceDir, STALE_REL_PATH))).toBe(false);
    } finally {
      cleanup(workspaceDir);
    }
  });
});
