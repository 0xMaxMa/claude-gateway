/**
 * Archive staleness GC (planning-66) — opt-in end-to-end (`npm run test:e2e`).
 *
 * Real workspace + real indexer + real GC over a MULTI-FILE archive, with an
 * injected clock crossing the TTL. Asserts the full contract: stale/superseded
 * entries move to stale.md with a backup written, retrieved/important/pinned
 * entries stay, EVERY entry remains findable via the real FTS search (nothing
 * lost), no session is ever spawned (the GC is a pure library call — the Part A
 * "zero sessions stopped" invariant holds by construction), and a stale entry
 * retrieved afterward is promoted back. Runs under jest/node, so the real FTS
 * query goes through the node:sqlite `ArchiveDB.search` (the same index the Bun
 * `memory_search` reads).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { entryHash } from '../../src/agent/knowledge/lifecycle';
import { indexAgentArchive, archiveDbPath } from '../../src/agent/knowledge/indexer';
import { ArchiveDB } from '../../src/agent/knowledge/archive-db';
import { runStalenessGc, STALE_REL_PATH, RESTORED_REL_PATH } from '../../src/agent/dreaming/staleness';

const DAY = 24 * 60 * 60 * 1000;
const CFG = {
  enabled: true,
  staleTtlDays: 90,
  keepImportance: 7,
  minRetrievalKeep: 1,
  supersession: true,
  recordRetrievals: true,
};

describe('archive staleness GC — e2e', () => {
  let agentDir: string;
  let ws: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb66e2e-'));
    ws = path.join(agentDir, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    // A realistic multi-file archive tier + evergreen + pinned.
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# Core\n- durable preference: dark mode\n');
    fs.mkdirSync(path.join(ws, 'memory/archive'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'memory/pinned'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'memory/archive/prs.md'),
      ['# PR log', '', '- shipped auth flow referencing #200', '- supersedes #200 with the new oauth flow', ''].join('\n'),
    );
    fs.writeFileSync(
      path.join(ws, 'memory/topics.md'),
      ['- ancient migration note about mongoose', '- fresh incident note about pelican'].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(ws, 'memory/pinned/keep.md'), '- pinned runbook about albatross\n');
  });
  afterEach(() => {
    ArchiveDB.evict(archiveDbPath(ws));
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  test('stale/superseded move (with backup) + everything stays searchable + feedback promote-back', () => {
    indexAgentArchive(ws);
    const db = () => ArchiveDB.forPath(archiveDbPath(ws));
    const h = {
      superseded: entryHash('- shipped auth flow referencing #200'),
      newer: entryHash('- supersedes #200 with the new oauth flow'),
      aged: entryHash('- ancient migration note about mongoose'),
      fresh: entryHash('- fresh incident note about pelican'),
      pinned: entryHash('- pinned runbook about albatross'),
    };
    const firstSeen = db().getLifecycle(h.aged)!.firstSeen;
    const now = firstSeen + 120 * DAY;
    db().logRetrieval(h.fresh, now - 2 * DAY); // recently retrieved → keep
    db().logRetrieval(h.newer, now - 2 * DAY); // superseding entry stays active

    // No session infrastructure exists in this test — the GC spawns none by
    // construction (Part A: memory-only writes, zero sessions stopped).
    const res = runStalenessGc(ws, CFG, { now });
    expect(res.invalidated).toBe(2); // superseded + aged
    expect(res.supersededMarked).toBe(1);

    // Moved to stale.md.
    const stale = fs.readFileSync(path.join(ws, STALE_REL_PATH), 'utf8');
    expect(stale).toContain('mongoose');
    expect(stale).toContain('auth flow');
    // A rollback backup was written for each rewritten source file.
    const backups = fs.readdirSync(path.join(ws, '.dreaming', 'backups')).filter((f) => f.endsWith('.stale.bak'));
    expect(backups.length).toBeGreaterThan(0);

    // NOTHING LOST: every entry — moved or kept — is still findable via real FTS.
    for (const term of ['mongoose', 'auth', 'oauth', 'pelican', 'albatross']) {
      expect(db().search(term).length).toBeGreaterThan(0);
    }
    // Kept ones are still live; pinned never entered the lifecycle at all.
    expect(db().getLifecycle(h.fresh)!.invalidAt).toBeNull();
    expect(db().getLifecycle(h.newer)!.invalidAt).toBeNull();
    expect(db().getLifecycle(h.pinned)).toBeUndefined();

    // FEEDBACK: retrieve the aged entry after invalidation → promoted back next run.
    db().logRetrieval(h.aged, now + 1 * DAY);
    const res2 = runStalenessGc(ws, CFG, { now: now + 3 * DAY });
    expect(res2.promoted).toBe(1);
    expect(db().getLifecycle(h.aged)!.invalidAt).toBeNull();
    expect(fs.readFileSync(path.join(ws, RESTORED_REL_PATH), 'utf8')).toContain('mongoose');
    expect(fs.readFileSync(path.join(ws, STALE_REL_PATH), 'utf8')).not.toContain('mongoose');
    // Still searchable after the round trip.
    expect(db().search('mongoose').length).toBeGreaterThan(0);
  });
});
