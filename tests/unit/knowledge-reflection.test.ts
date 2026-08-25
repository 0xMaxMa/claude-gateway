import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SHARED_DEFAULTS,
  REFLECTION_DEFAULTS,
  ArchiveDB,
  SharedReflectionManager,
  connectedComponents,
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
