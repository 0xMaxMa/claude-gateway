/**
 * Shared-KB staleness GC (issue #392 part D) — unit + integration tests.
 * Mirrors `tests/unit/archive-staleness.test.ts`'s pattern for the personal
 * archive, adapted for the shared vault's whole-note identity model.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SHARED_DEFAULTS,
  sharedNotesDir,
  sharedDbPath,
  indexSharedArchive,
  ArchiveDB,
  writeSharedNote,
  readSharedNote,
  sharedNoteExists,
} from '../../src/agent/knowledge';
import type { ResolvedKnowledgeSharedCfg } from '../../src/agent/knowledge';
import { entryHash } from '../../src/agent/knowledge/lifecycle';
import { runSharedStalenessGc, retireSharedNote, STALE_NOTE_PREFIX } from '../../src/agent/knowledge/shared-staleness';
import { STALENESS_DEFAULTS } from '../../src/agent/dreaming/config';
import { DatabaseSync } from 'node:sqlite';

const DAY = 24 * 60 * 60 * 1000;

function tmpSharedCfg(over: Partial<ResolvedKnowledgeSharedCfg> = {}): ResolvedKnowledgeSharedCfg {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shared-staleness-'));
  return { ...SHARED_DEFAULTS, root, mode: 'auto', ...over };
}

function cleanup(cfg: ResolvedKnowledgeSharedCfg): void {
  ArchiveDB.evict(sharedDbPath(cfg));
  fs.rmSync(cfg.root, { recursive: true, force: true });
}

function db(cfg: ResolvedKnowledgeSharedCfg): ArchiveDB {
  return ArchiveDB.forPath(sharedDbPath(cfg));
}

describe('indexer populates kb_entry_lifecycle for shared notes (issue #392 part D)', () => {
  test('a shared note gets exactly one whole-file lifecycle row', () => {
    const cfg = tmpSharedCfg();
    try {
      writeSharedNote(cfg, 'deploy-runbook', 'The prod cluster runs on kubernetes in region eu-west.');
      indexSharedArchive(cfg);
      const rows = db(cfg).listLifecycle();
      expect(rows).toHaveLength(1);
      expect(rows[0].path).toBe('deploy-runbook.md');
      expect(rows[0].entryHash).toBe(entryHash('The prod cluster runs on kubernetes in region eu-west.'));
      expect(rows[0].invalidAt).toBeNull();
    } finally {
      cleanup(cfg);
    }
  });

  test('two shared notes get two independent lifecycle rows', () => {
    const cfg = tmpSharedCfg();
    try {
      writeSharedNote(cfg, 'note-a', 'Fact A.');
      writeSharedNote(cfg, 'note-b', 'Fact B.');
      indexSharedArchive(cfg);
      expect(db(cfg).listLifecycle()).toHaveLength(2);
    } finally {
      cleanup(cfg);
    }
  });
});

describe('runSharedStalenessGc (issue #392 part D)', () => {
  function setup(): { cfg: ResolvedKnowledgeSharedCfg; hOld: string; hNew: string; now: number } {
    const cfg = tmpSharedCfg();
    writeSharedNote(cfg, 'ancient-deploy-note', 'The old deploy pipeline used Jenkins.');
    // Make the note genuinely old before its first index, rather than advancing
    // only the GC clock — notes created during the test must remain current.
    const oldFile = path.join(sharedNotesDir(cfg), 'ancient-deploy-note.md');
    const now = Date.now();
    fs.utimesSync(oldFile, new Date(now - 100 * DAY), new Date(now - 100 * DAY));
    writeSharedNote(cfg, 'recent-fact', 'The current on-call channel is #incidents.');
    indexSharedArchive(cfg);
    const rows = db(cfg).listLifecycle();
    const oldRow = rows.find((r) => r.path === 'ancient-deploy-note.md')!;
    const newRow = rows.find((r) => r.path === 'recent-fact.md')!;
    // recent-fact retrieved yesterday → recall keeps it despite the same file age gate.
    db(cfg).logRetrieval(newRow.entryHash, now - 1 * DAY);
    return { cfg, hOld: oldRow.entryHash, hNew: newRow.entryHash, now };
  }

  test('an aged, low-retrieval note is moved to stale__<name>; content preserved and still searchable', () => {
    const { cfg, hOld, hNew, now } = setup();
    try {
      const res = runSharedStalenessGc(cfg, STALENESS_DEFAULTS, { now });
      expect(res.invalidated).toBe(1);

      expect(db(cfg).getLifecycle(hOld)!.invalidAt).not.toBeNull();
      expect(db(cfg).getLifecycle(hNew)!.invalidAt).toBeNull(); // retrieved → kept

      // Original note is gone; content lives on under the stale__ prefix.
      expect(sharedNoteExists(cfg, 'ancient-deploy-note')).toBe(false);
      expect(sharedNoteExists(cfg, `${STALE_NOTE_PREFIX}ancient-deploy-note`)).toBe(true);
      const staled = readSharedNote(cfg, `${STALE_NOTE_PREFIX}ancient-deploy-note`)!;
      expect(staled).toContain('Jenkins');

      // Still findable via search (never hard-deleted).
      expect(db(cfg).search('Jenkins').length).toBeGreaterThan(0);
      // Recent fact untouched.
      expect(sharedNoteExists(cfg, 'recent-fact')).toBe(true);
    } finally {
      cleanup(cfg);
    }
  });

  test('promote-back: a staled note retrieved afterward is restored to its original name', () => {
    const { cfg, hOld, now } = setup();
    try {
      runSharedStalenessGc(cfg, STALENESS_DEFAULTS, { now });
      expect(sharedNoteExists(cfg, 'ancient-deploy-note')).toBe(false);

      db(cfg).logRetrieval(hOld, now + 1 * DAY);
      const res = runSharedStalenessGc(cfg, STALENESS_DEFAULTS, { now: now + 2 * DAY });
      expect(res.promoted).toBe(1);

      expect(db(cfg).getLifecycle(hOld)!.invalidAt).toBeNull();
      expect(sharedNoteExists(cfg, 'ancient-deploy-note')).toBe(true);
      expect(sharedNoteExists(cfg, `${STALE_NOTE_PREFIX}ancient-deploy-note`)).toBe(false);
      expect(readSharedNote(cfg, 'ancient-deploy-note')).toContain('Jenkins');
    } finally {
      cleanup(cfg);
    }
  });

  test('promote-back never clobbers a new note created at the original name while staled', () => {
    const { cfg, hOld, now } = setup();
    try {
      runSharedStalenessGc(cfg, STALENESS_DEFAULTS, { now });
      // A brand new, unrelated note gets created at the freed-up original name.
      writeSharedNote(cfg, 'ancient-deploy-note', 'Fresh unrelated content.');

      db(cfg).logRetrieval(hOld, now + 1 * DAY);
      const res = runSharedStalenessGc(cfg, STALENESS_DEFAULTS, { now: now + 2 * DAY });
      expect(res.promoted).toBe(0); // refused — name is occupied

      expect(readSharedNote(cfg, 'ancient-deploy-note')).toBe('Fresh unrelated content.');
      expect(sharedNoteExists(cfg, `${STALE_NOTE_PREFIX}ancient-deploy-note`)).toBe(true); // still staled
    } finally {
      cleanup(cfg);
    }
  });

  test('disabled config is a no-op', () => {
    const { cfg, now } = setup();
    try {
      const res = runSharedStalenessGc(cfg, { ...STALENESS_DEFAULTS, enabled: false }, { now });
      expect(res).toMatchObject({ invalidated: 0, promoted: 0 });
      expect(sharedNoteExists(cfg, 'ancient-deploy-note')).toBe(true);
    } finally {
      cleanup(cfg);
    }
  });
});

describe('retireSharedNote (shared by the TTL GC and the reflection merge, issue #392 part C+D)', () => {
  test('moves a live note to stale__<name>, preserving content', () => {
    const cfg = tmpSharedCfg();
    try {
      writeSharedNote(cfg, 'dup-note', 'This is a duplicate fact.');
      const ok = retireSharedNote(cfg, 'dup-note', '<!-- merged into [[primary]] -->');
      expect(ok).toBe(true);
      expect(sharedNoteExists(cfg, 'dup-note')).toBe(false);
      expect(readSharedNote(cfg, `${STALE_NOTE_PREFIX}dup-note`)).toContain('This is a duplicate fact.');
    } finally {
      cleanup(cfg);
    }
  });

  test('returns false for a missing/empty note', () => {
    const cfg = tmpSharedCfg();
    try {
      expect(retireSharedNote(cfg, 'nope', '<!-- x -->')).toBe(false);
    } finally {
      cleanup(cfg);
    }
  });
});

// ── issue #398: lifecycle rows for sources the indexer hash-skips ───────────

/**
 * Drop every lifecycle row while leaving `kb_sources` current — the exact state
 * of any vault indexed before the lifecycle table existed, and the state the
 * hash guard used to make permanent (issue #398).
 */
function dropLifecycleRows(cfg: ResolvedKnowledgeSharedCfg): void {
  ArchiveDB.evict(sharedDbPath(cfg));
  const handle = new DatabaseSync(sharedDbPath(cfg));
  try {
    handle.exec('DELETE FROM kb_entry_lifecycle');
  } finally {
    handle.close();
  }
}

describe('lifecycle backfill for unchanged sources (issue #398)', () => {
  test('a note indexed BEFORE lifecycle existed gets a row on the next index pass', () => {
    const cfg = tmpSharedCfg();
    try {
      writeSharedNote(cfg, 'legacy-note', 'Prod deploys need a one-time bootstrap before the first release.');
      indexSharedArchive(cfg);

      // Simulate the real-world state: the source row is present and current
      // (so the hash guard skips the file) but its lifecycle row was never
      // written, exactly as for every note that predates the feature.
      dropLifecycleRows(cfg);
      expect(db(cfg).listLifecycle()).toHaveLength(0);

      indexSharedArchive(cfg);

      const rows = db(cfg).listLifecycle();
      expect(rows).toHaveLength(1);
      expect(rows[0].path).toBe('legacy-note.md');
    } finally {
      cleanup(cfg);
    }
  });

  test('a backfilled row keeps the note\'s real age instead of resetting it to now', () => {
    const cfg = tmpSharedCfg();
    try {
      writeSharedNote(cfg, 'old-note', 'An operational lesson recorded a long time ago.');
      const notePath = path.join(sharedNotesDir(cfg), 'old-note.md');
      const oldMtime = Date.now() - 200 * DAY;
      fs.utimesSync(notePath, oldMtime / 1000, oldMtime / 1000);

      indexSharedArchive(cfg);
      dropLifecycleRows(cfg);
      indexSharedArchive(cfg);

      const [row] = db(cfg).listLifecycle();
      expect(row).toBeDefined();
      // Age preserved from mtime: seeding "now" would restart the TTL clock and
      // push any reclamation out by another full staleTtlDays.
      expect(Math.abs(row.firstSeen - oldMtime)).toBeLessThan(2000);
      expect(Date.now() - row.firstSeen).toBeGreaterThan(190 * DAY);
    } finally {
      cleanup(cfg);
    }
  });

  test('a backfilled note is visible to the GC and ages out normally', () => {
    const cfg = tmpSharedCfg();
    try {
      writeSharedNote(cfg, 'forgotten-note', 'A fact nobody has looked up in a very long time.');
      const notePath = path.join(sharedNotesDir(cfg), 'forgotten-note.md');
      const oldMtime = Date.now() - 200 * DAY;
      fs.utimesSync(notePath, oldMtime / 1000, oldMtime / 1000);

      indexSharedArchive(cfg);
      dropLifecycleRows(cfg); // pre-#398 state: indexed, but no lifecycle row

      const res = runSharedStalenessGc(cfg, { ...STALENESS_DEFAULTS, staleTtlDays: 90 });

      expect(res.invalidated).toBe(1);
      expect(sharedNoteExists(cfg, 'forgotten-note')).toBe(false);
      expect(sharedNoteExists(cfg, `${STALE_NOTE_PREFIX}forgotten-note`)).toBe(true);
    } finally {
      cleanup(cfg);
    }
  });
});
