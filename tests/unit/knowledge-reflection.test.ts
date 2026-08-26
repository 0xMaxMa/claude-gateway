import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SHARED_DEFAULTS,
  REFLECTION_DEFAULTS,
  ArchiveDB,
  SharedReflectionManager,
  connectedComponents,
  msUntilNextDailyTime,
  nextReflectionDelay,
  isConsolidationDay,
  indexSharedArchive,
  sharedDbPath,
  sharedNoteExists,
  writeSharedNote,
} from '../../src/agent/knowledge';
import type { ResolvedKnowledgeSharedCfg, ResolvedKnowledgeReflectionCfg } from '../../src/agent/knowledge';
import type { GraphEdge, GraphNode } from '../../src/agent/knowledge/wiki';

function tmpCfg(): ResolvedKnowledgeSharedCfg {
  return { ...SHARED_DEFAULTS, root: fs.mkdtempSync(path.join(os.tmpdir(), 'kb-reflection-')), mode: 'auto' };
}

function cleanup(cfg: ResolvedKnowledgeSharedCfg): void {
  ArchiveDB.evict(sharedDbPath(cfg));
  fs.rmSync(cfg.root, { recursive: true, force: true });
}

const reflectionCfg: ResolvedKnowledgeReflectionCfg = {
  ...REFLECTION_DEFAULTS,
  enabled: true,
  maxClustersPerRun: 5,
};

describe('connectedComponents (issue #392 part C)', () => {
  test('groups linked notes and retains isolated nodes deterministically', () => {
    const nodes: GraphNode[] = [
      { id: 'a.md', title: 'a', type: null, degree: 0, confidence: null, updatedAt: null, stale: false, contradiction: false, excerpt: null },
      { id: 'b.md', title: 'b', type: null, degree: 0, confidence: null, updatedAt: null, stale: false, contradiction: false, excerpt: null },
      { id: 'c.md', title: 'c', type: null, degree: 0, confidence: null, updatedAt: null, stale: false, contradiction: false, excerpt: null },
    ];
    const edges: GraphEdge[] = [{ source: 'a.md', target: 'b.md' }];
    expect(connectedComponents(nodes, edges)).toEqual([['a.md', 'b.md'], ['c.md']]);
  });
});

describe('SharedReflectionManager (issue #392 part C)', () => {
  function manager(cfg: ResolvedKnowledgeSharedCfg, result: object = { action: 'none' }): SharedReflectionManager {
    return new SharedReflectionManager({
      sharedCfg: cfg,
      reflectionCfg,
      spawnFn: async () => ({ stdout: JSON.stringify({ result: JSON.stringify(result) }), timedOut: false }),
    });
  }

  test('skips unchanged vault with no reviewer call after persisting its revision watermark', async () => {
    const cfg = tmpCfg();
    try {
      writeSharedNote(cfg, 'a', 'Related [[b]].');
      writeSharedNote(cfg, 'b', 'Related [[a]].');
      let calls = 0;
      const m = new SharedReflectionManager({
        sharedCfg: cfg,
        reflectionCfg,
        spawnFn: async () => {
          calls++;
          return { stdout: JSON.stringify({ result: '{"action":"none"}' }), timedOut: false };
        },
      });
      expect((await m.reflectOnce()).outcome).toBe('ran');
      expect(calls).toBe(1);
      expect((await m.reflectOnce()).outcome).toBe('skipped-unchanged');
      expect(calls).toBe(1);
    } finally {
      cleanup(cfg);
    }
  });

  test('merges only an LLM-approved linked cluster and retires the folded note', async () => {
    const cfg = tmpCfg();
    try {
      writeSharedNote(cfg, 'canonical', 'Primary deploy policy. Related [[duplicate]].');
      writeSharedNote(cfg, 'duplicate', 'Primary deploy policy. Related [[canonical]].');
      const res = await manager(cfg, { action: 'merge', primary: 'canonical', reason: 'same fact' }).reflectOnce();
      expect(res.mergesApplied).toBe(1);
      expect(sharedNoteExists(cfg, 'canonical')).toBe(true);
      expect(sharedNoteExists(cfg, 'duplicate')).toBe(false);
      expect(sharedNoteExists(cfg, 'stale__duplicate')).toBe(true);
    } finally {
      cleanup(cfg);
    }
  });

  test('does not retire a source note when the capped canonical write fails', async () => {
    const cfg = tmpCfg();
    try {
      writeSharedNote(cfg, 'canonical', 'x'.repeat(102_380) + ' [[duplicate]]');
      writeSharedNote(cfg, 'duplicate', 'New material that cannot fit. [[canonical]]');
      const res = await manager(cfg, { action: 'merge', primary: 'canonical' }).reflectOnce();
      expect(res.mergesApplied).toBe(0);
      expect(sharedNoteExists(cfg, 'duplicate')).toBe(true);
      expect(sharedNoteExists(cfg, 'stale__duplicate')).toBe(false);
    } finally {
      cleanup(cfg);
    }
  });

  test('does not process unrelated singleton notes', async () => {
    const cfg = tmpCfg();
    try {
      writeSharedNote(cfg, 'a', 'Standalone A.');
      writeSharedNote(cfg, 'b', 'Standalone B.');
      const res = await manager(cfg).reflectOnce();
      expect(res.clustersConsidered).toBe(0);
      expect(res.clustersProcessed).toBe(0);
    } finally {
      cleanup(cfg);
    }
  });
});

// ── issue #398: daily staleness GC, weekly LLM consolidation ────────────────

describe('reflection cadence split (issue #398)', () => {
  test('msUntilNextDailyTime lands on the next occurrence today, not next week', () => {
    // 2026-08-25T09:00:00Z is a Tuesday; the 04:00 UTC slot has passed.
    const now = new Date('2026-08-25T09:00:00Z');
    const delay = msUntilNextDailyTime(4, 0, 'UTC', now);
    expect(delay).toBe(19 * 60 * 60 * 1000); // 09:00 → 04:00 tomorrow
    expect(delay).toBeLessThan(24 * 60 * 60 * 1000);
  });

  test('msUntilNextDailyTime waits for later today when the slot has not passed', () => {
    const now = new Date('2026-08-25T01:30:00Z');
    expect(msUntilNextDailyTime(4, 0, 'UTC', now)).toBe(2.5 * 60 * 60 * 1000);
  });

  test('isConsolidationDay is true only on the configured weekday', () => {
    expect(isConsolidationDay(0, 'UTC', new Date('2026-08-30T04:00:00Z'))).toBe(true); // Sunday
    expect(isConsolidationDay(0, 'UTC', new Date('2026-08-25T04:00:00Z'))).toBe(false); // Tuesday
  });

  test('a GC-only run never calls the reviewer and leaves the consolidation watermark alone', async () => {
    const cfg = tmpCfg();
    try {
      writeSharedNote(cfg, 'a', 'Primary deploy policy. Related [[b]].');
      writeSharedNote(cfg, 'b', 'Primary deploy policy. Related [[a]].');
      let calls = 0;
      const m = new SharedReflectionManager({
        sharedCfg: cfg,
        reflectionCfg,
        spawnFn: async () => {
          calls++;
          return { stdout: JSON.stringify({ result: '{"action":"none"}' }), timedOut: false };
        },
      });

      const daily = await m.reflectOnce(Date.now(), { consolidate: false });
      expect(daily.outcome).toBe('ran');
      expect(daily.clustersConsidered).toBe(0);
      expect(calls).toBe(0); // no model spend on a GC-only day

      // The weekly run still sees the cluster: a GC-only pass must not advance
      // the watermark past work it never consolidated.
      const weekly = await m.reflectOnce();
      expect(weekly.outcome).toBe('ran');
      expect(weekly.clustersConsidered).toBe(1);
      expect(calls).toBe(1);
    } finally {
      cleanup(cfg);
    }
  });
});

describe('consolidation day is decided from the slot, not the fire (#398 review)', () => {
  test('a fire nudged past local midnight still consolidates on the intended slot', () => {
    // The slot targeted here is Sunday 04:00 UTC. Deciding from a fire instant
    // that slipped to Monday 00:00 would skip consolidation for a whole week.
    const slot = new Date('2026-08-30T04:00:00Z');
    const slippedFire = new Date('2026-08-31T00:00:05Z');
    expect(isConsolidationDay(0, 'UTC', slot)).toBe(true);
    expect(isConsolidationDay(0, 'UTC', slippedFire)).toBe(false);
  });

  test('a fire a hair early re-arms on tomorrow, not on the slot it just served', () => {
    // The delay the scheduler actually uses, not a floor applied next to it: a
    // floor only postponed the duplicate run of the SAME slot (#398 review).
    const hairEarly = new Date('2026-08-25T03:59:59.999Z');
    expect(msUntilNextDailyTime(4, 0, 'UTC', hairEarly)).toBeLessThan(60_000); // raw is near-zero
    const delay = nextReflectionDelay(4, 0, 'UTC', hairEarly);
    const nextFire = new Date(hairEarly.getTime() + delay);
    // Must land on TOMORROW's 04:00 slot — never a second visit to today's.
    expect(nextFire.toISOString()).toBe('2026-08-26T04:00:00.000Z');
    expect(delay).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  test('a normal re-arm is left exactly as computed', () => {
    // The roll-forward must fire ONLY for the just-served slot, or every daily
    // run would drift a day and the GC would stop running nightly.
    const now = new Date('2026-08-25T01:30:00Z');
    expect(nextReflectionDelay(4, 0, 'UTC', now)).toBe(msUntilNextDailyTime(4, 0, 'UTC', now));
    expect(nextReflectionDelay(4, 0, 'UTC', now)).toBe(2.5 * 60 * 60 * 1000);
  });
});
