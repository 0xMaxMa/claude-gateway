import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SHARED_DEFAULTS,
  sharedNotesDir,
  sharedDbPath,
  indexSharedArchive,
  makeSharedPromoter,
  ArchiveDB,
  findSimilarSharedNotes,
  MAX_SHARED_NOTE_SIZE,
} from '../../src/agent/knowledge';
import type { ResolvedKnowledgeSharedCfg } from '../../src/agent/knowledge';

// A shared config rooted at a fresh temp dir so tests never touch the real vault.
function tmpSharedCfg(over: Partial<ResolvedKnowledgeSharedCfg> = {}): ResolvedKnowledgeSharedCfg {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shared-promote-'));
  return { ...SHARED_DEFAULTS, root, mode: 'auto', ...over };
}

function noteFiles(cfg: ResolvedKnowledgeSharedCfg): string[] {
  try {
    return fs.readdirSync(sharedNotesDir(cfg)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

function cleanup(cfg: ResolvedKnowledgeSharedCfg): void {
  ArchiveDB.evict(sharedDbPath(cfg));
  fs.rmSync(cfg.root, { recursive: true, force: true });
}

describe('makeSharedPromoter — gating', () => {
  test('shared KB disabled ⇒ undefined (no promoter)', () => {
    expect(makeSharedPromoter('agentA', { enabled: false }, undefined)).toBeUndefined();
  });

  test('mode "propose" ⇒ undefined (dry-run, no auto promotion)', () => {
    expect(makeSharedPromoter('agentA', { mode: 'propose' }, undefined)).toBeUndefined();
  });
});

describe('makeSharedPromoter — note identity + dedup (#386)', () => {
  test('a brand-new fact with no existing relative creates one note named after its reason', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({ reason: 'deploy-runbook', content: 'The prod cluster runs on kubernetes in region eu-west.' });
      expect(noteFiles(cfg)).toEqual(['deploy-runbook.md']);
    } finally {
      cleanup(cfg);
    }
  });

  test('the SAME reason recurring across two promotions updates the ONE note, never creates a second file', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({ reason: 'oncall-rotation', content: 'Escalate paging incidents to the platform team first.' });
      promote({ reason: 'oncall-rotation', content: 'Platform team is first-line oncall; SRE is the fallback.' });

      expect(noteFiles(cfg)).toEqual(['oncall-rotation.md']);
      const body = fs.readFileSync(path.join(sharedNotesDir(cfg), 'oncall-rotation.md'), 'utf8');
      expect(body).toContain('Escalate paging incidents');
      expect(body).toContain('SRE is the fallback');
    } finally {
      cleanup(cfg);
    }
  });

  test('re-promoting identical content under the same reason does not duplicate it in the note body', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({ reason: 'db-pool', content: 'Connection pool max size is 50.' });
      promote({ reason: 'db-pool', content: 'Connection pool max size is 50.' });

      const body = fs.readFileSync(path.join(sharedNotesDir(cfg), 'db-pool.md'), 'utf8');
      expect(body.match(/Connection pool max size is 50\./g)?.length).toBe(1);
    } finally {
      cleanup(cfg);
    }
  });

  test(
    'REGRESSION (#386): the same recurring fact, reworded under a DIFFERENT reason each night, ' +
      'merges into ONE shared note instead of piling up a near-duplicate per night',
    () => {
      const cfg = tmpSharedCfg();
      try {
        const promote = makeSharedPromoter('agentA', cfg, undefined)!;

        promote({
          reason: 'staging-db-timeout',
          content: 'The staging database connection pool times out after 30 seconds under load.',
        });
        // Simulate the reindex that happens between dream nights, so the near-dup
        // search below can see last night's promotion.
        indexSharedArchive(cfg, undefined);

        promote({
          reason: 'staging-timeout-followup',
          content: 'Staging database connection pool timeout occurs after roughly 30 seconds under heavy load.',
        });

        // Pre-#386 code named notes by content hash and never checked for a
        // near-duplicate, so this would have produced TWO files here.
        expect(noteFiles(cfg)).toEqual(['staging-db-timeout.md']);
        const body = fs.readFileSync(path.join(sharedNotesDir(cfg), 'staging-db-timeout.md'), 'utf8');
        expect(body).toContain('roughly 30 seconds');
      } finally {
        cleanup(cfg);
      }
    },
  );

  test('a near-duplicate under a different reason links OTHER related notes found alongside the merge target', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({ reason: 'redis-eviction-policy', content: 'Redis cache uses allkeys-lru eviction under memory pressure.' });
      promote({ reason: 'redis-memory-limits', content: 'Redis cache memory limit is 4gb before eviction kicks in.' });
      indexSharedArchive(cfg, undefined);

      // Reworded close to the FIRST note; the search should surface both existing
      // redis notes, merge into the closest, and link the other.
      promote({ reason: 'redis-cache-notes', content: 'Redis cache eviction runs allkeys-lru once memory pressure is hit.' });

      const files = noteFiles(cfg);
      expect(files.length).toBe(2); // merged into an existing note, no third file
      const merged = files.map((f) => fs.readFileSync(path.join(sharedNotesDir(cfg), f), 'utf8')).join('\n---\n');
      expect(merged).toMatch(/\[\[redis-memory-limits\]\]|\[\[redis-eviction-policy\]\]/);
    } finally {
      cleanup(cfg);
    }
  });

  test('empty content or reason is a silent no-op (never writes an empty/unnamed note)', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({ reason: '', content: 'has content but no reason' });
      promote({ reason: 'no-content' });
      expect(noteFiles(cfg)).toEqual([]);
    } finally {
      cleanup(cfg);
    }
  });

  test('a merge that would cross MAX_SHARED_NOTE_SIZE is skipped — the note is left as it was', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({ reason: 'growing-topic', content: 'x'.repeat(MAX_SHARED_NOTE_SIZE - 100) });
      const before = fs.readFileSync(path.join(sharedNotesDir(cfg), 'growing-topic.md'), 'utf8');

      // Same reason recurs with enough new content that the merged result would
      // exceed the cap — pre-fix this would have written past it unbounded.
      promote({ reason: 'growing-topic', content: 'y'.repeat(1000) });

      const after = fs.readFileSync(path.join(sharedNotesDir(cfg), 'growing-topic.md'), 'utf8');
      expect(after).toBe(before);
      expect(after.length).toBeLessThanOrEqual(MAX_SHARED_NOTE_SIZE);
    } finally {
      cleanup(cfg);
    }
  });
});

describe('findSimilarSharedNotes (Node-side near-dup search, node:sqlite)', () => {
  test('OR-match finds a note that shares only SOME terms with the seed (not an exact/full match)', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({ reason: 'postgres-tuning', content: 'Postgres shared_buffers is tuned to 25 percent of RAM on prod.' });
      indexSharedArchive(cfg, undefined);

      const hits = findSimilarSharedNotes(cfg, 'unrelated words postgres tuning memory', 3);
      expect(hits.some((h) => h.name === 'postgres-tuning')).toBe(true);
    } finally {
      cleanup(cfg);
    }
  });

  test('no shared index yet ⇒ [] (never throws)', () => {
    const cfg = tmpSharedCfg();
    try {
      expect(findSimilarSharedNotes(cfg, 'anything', 3)).toEqual([]);
    } finally {
      cleanup(cfg);
    }
  });
});

// ── issue #398: what may be promoted, and what may be merged unattended ─────

describe('makeSharedPromoter — index pointers are not shareable facts (issue #398)', () => {
  test('content that is only MEMORY.md index pointers is not promoted at all', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      // A descriptive (NOT instruction-shaped) reason, so this test isolates the
      // content filter rather than piggybacking on the name guard below.
      promote({
        reason: 'feedback memories about testing and rollback',
        content:
          '- [testing_state_data_bugs.md](testing_state_data_bugs.md) — data/state bugs need Docker E2E\n' +
          '- [rollback_completeness.md](rollback_completeness.md) — rollback must restore images too',
      });
      expect(noteFiles(cfg)).toEqual([]);
    } finally {
      cleanup(cfg);
    }
  });

  test('a real fact that merely CONTAINS a link still promotes', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({
        reason: 'runner-permission-blocker',
        content:
          'The shared CI runner cannot clean its workspace between jobs, so every run fails the recap step.\n' +
          '- [runbook.md](runbook.md) — manual cleanup steps',
      });
      expect(noteFiles(cfg)).toEqual(['runner-permission-blocker.md']);
    } finally {
      cleanup(cfg);
    }
  });
});

describe('makeSharedPromoter — unattended merges need a real similarity bar (issue #398)', () => {
  test('a fact sharing only generic words with an existing note gets its OWN note, not a merge', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({
        reason: 'ci-runner-permission-blocker',
        content:
          'The self-hosted CI runner cannot remove its workspace folder between jobs, so the recap job fails ' +
          'with a permission error on every pull request and needs manual intervention on the machine.',
      });
      indexSharedArchive(cfg);

      // Unrelated topic. The FTS recall query still returns the note above
      // (both mention "new"/"needs"/"jobs"-ish scaffolding), but containment is
      // far below the bar, so merging them would fuse two unrelated facts.
      promote({
        reason: 'docker-e2e-required-for-state-bugs',
        content:
          'State and data bugs must be validated with a Docker end-to-end run comparing the old and new ' +
          'builds; counting passing unit tests proves nothing about persisted state.',
      });

      expect(noteFiles(cfg)).toEqual([
        'ci-runner-permission-blocker.md',
        'docker-e2e-required-for-state-bugs.md',
      ]);
      const first = fs.readFileSync(
        path.join(sharedNotesDir(cfg), 'ci-runner-permission-blocker.md'),
        'utf8',
      );
      expect(first).not.toContain('Docker end-to-end');
      expect(first).not.toContain('Related:');
    } finally {
      cleanup(cfg);
    }
  });

  test('a genuine restatement of the same fact still merges into the existing note', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({
        reason: 'incus-rolling-upgrade-blocked',
        content:
          'An incus rolling upgrade reports blocked while the cluster sits in a midstate; this is expected ' +
          'and resolves once every member has been upgraded.',
      });
      indexSharedArchive(cfg);

      promote({
        reason: 'incus-upgrade-midstate-expected',
        content:
          'Incus rolling upgrade blocked in midstate is expected: the cluster stays blocked until every ' +
          'member has been upgraded.',
      });

      expect(noteFiles(cfg)).toEqual(['incus-rolling-upgrade-blocked.md']);
    } finally {
      cleanup(cfg);
    }
  });

  test('a long reason no longer starves the promoted content out of the similarity seed', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({
        reason: 'postgres-bootstrap-required',
        content:
          'The production database needs a one-time bootstrap before the first deploy; the develop ' +
          'environment silently skipped it and the migration then failed.',
      });
      indexSharedArchive(cfg);

      // 12+ leading tokens of pure justification prose: under the old
      // first-12-tokens seed the content below never reached the query at all.
      promote({
        reason:
          'durable operational lesson observed repeatedly across several separate deployment sessions this month',
        content:
          'Production database bootstrap is a one-time step required before the first deploy; develop ' +
          'silently skipped the bootstrap and its migration failed.',
      });

      expect(noteFiles(cfg)).toEqual(['postgres-bootstrap-required.md']);
    } finally {
      cleanup(cfg);
    }
  });
});

describe('makeSharedPromoter — note identity (issue #398)', () => {
  test('a durable topic slug is preferred over the free-form reason as the note name', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({
        topic: 'prod-deploy-needs-bootstrap',
        reason: 'insert after the cron section, before the memory notes',
        content: 'Production needs a one-time bootstrap before its first deploy.',
      });
      expect(noteFiles(cfg)).toEqual(['prod-deploy-needs-bootstrap.md']);
    } finally {
      cleanup(cfg);
    }
  });

  test('an instruction-shaped reason with no topic is skipped instead of becoming a note name', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({
        reason: 'insert after cron config, before the pty_shell memory section',
        content: 'Some prose that would otherwise have been stored under that name.',
      });
      expect(noteFiles(cfg)).toEqual([]);
    } finally {
      cleanup(cfg);
    }
  });

  test('a descriptive reason that merely starts with a verb is NOT mistaken for an instruction', () => {
    const cfg = tmpSharedCfg();
    try {
      const promote = makeSharedPromoter('agentA', cfg, undefined)!;
      promote({
        reason: 'add-on billing is charged per seat',
        content: 'Add-on billing is charged per seat, not per organization.',
      });
      expect(noteFiles(cfg)).toEqual(['add-on-billing-is-charged-per-seat.md']);
    } finally {
      cleanup(cfg);
    }
  });
});
