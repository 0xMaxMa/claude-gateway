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
