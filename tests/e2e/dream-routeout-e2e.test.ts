/**
 * planning-67 e2e — the embedded route-out stage + archive-safe net-shrink, end to
 * end through the REAL nightly `dreamOnce`, the REAL archive indexer + FTS search,
 * and the REAL restart classifier. Opt-in (tests/e2e/ is ignored by `npm test`; run
 * via `npm run test:e2e`).
 *
 * No live model: the route-out classifier and the dream reviewer are scripted stubs.
 * The clock is injected. Everything else is the real code path.
 *
 * Proves the AC:
 *   1. an over-budget MEMORY.md self-drains UNDER budget during one auto dreamOnce
 *      (no manual `dreaming:migrate`), pinned sections preserved;
 *   2. a net-shrink `remove` relocates its block to a searchable archive (no forget);
 *   3. every moved / pruned entry is still found by the real archive search;
 *   4. the whole cycle triggers no session restart.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DreamingManager } from '../../src/agent/dreaming';
import type { DreamHistoryDb } from '../../src/agent/dreaming/gather';
import type { DreamProposal } from '../../src/agent/dreaming/types';
import { indexAgentArchive, archiveDbPath } from '../../src/agent/knowledge/indexer';
import { ArchiveDB } from '../../src/agent/knowledge/archive-db';
import { resolveArchiveConfig } from '../../src/agent/knowledge/config';
import { classifyWorkspaceRestart } from '../../src/agent/workspace-loader';

const NOW = 1_734_500_000_000;
const HOUR = 60 * 60 * 1000;
const BUDGET = 8_000;

const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

function mkWs(memory: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeout-e2e-'));
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), memory);
  return dir;
}

const OPEN_EPISODIC =
  '### Checkout investigation log\n' +
  ('Investigating an intermittent cache bug in the checkout flow; traced the retry path, ' +
    'captured timings, still open and ongoing across many sessions. ').repeat(90);
const STALE_BLOCK =
  '- Old scratch note about the deprecated cron path that nobody references anymore';

/** Over-budget MEMORY.md: pinned + durable + 20 terminal task-logs + 1 huge open episodic + 1 stale. */
function seedMemory(): string {
  const terminal = Array.from(
    { length: 20 },
    (_, i) =>
      `- PR #${100 + i} implemented feature ${i}: reworked the request pipeline, added validation at the boundary, ` +
      `wrote unit + integration coverage, reviewed with score ${i % 5}/5, commit hash abc${i}def${i}, ` +
      `deployed to staging then production on day ${i}, verified metrics green — MERGED`,
  ).join('\n');
  return [
    '# Long-term Memory',
    '',
    '## User',
    '- Timezone: UTC+7',
    '',
    '## Facts',
    '- The production database is Postgres 15',
    '',
    '## Active PR log',
    terminal,
    STALE_BLOCK,
    '',
    '## Working notes',
    OPEN_EPISODIC,
    '',
  ].join('\n');
}

// A scripted dream reviewer that proposes ONE net-shrink remove of the stale block.
function scriptedReviewer(): DreamHistoryDb {
  return {
    listSessions: () => [{ sessionId: 's1', lastActivity: NOW - 2 * HOUR }],
    getSessionTranscript: () => [{ role: 'user', content: 'a busy session '.repeat(50), ts: NOW - 2 * HOUR }],
  };
}

describe('planning-67 — embedded route-out + archive-safe remove (e2e)', () => {
  it('self-drains an over-budget MEMORY.md via dreamOnce, preserves recall, drops no session', async () => {
    const ws = mkWs(seedMemory());
    const memPath = path.join(ws, 'MEMORY.md');
    expect(read(memPath).length).toBeGreaterThan(BUDGET); // genuinely over budget

    // Route-out classifier: move the open episodic block; wrongly propose a pinned
    // block too (must be refused by migrateMemory's pinned-exclude).
    const routeOutFn = (): DreamProposal[] => [
      { op: 'add', tier: 'episodic', topic: 'checkout', content: 'Investigating intermittent cache bug in checkout flow',
        target: OPEN_EPISODIC, reason: 'ongoing task-log', score: 1, recallCount: 0 },
      { op: 'add', tier: 'episodic', topic: 'prefs', content: 'tz', target: '- Timezone: UTC+7', reason: 'x', score: 1, recallCount: 0 },
    ];
    // Dream reviewer proposes a net-shrink remove of the stale block (Part 2).
    const spawnFn = async () => ({
      stdout: JSON.stringify({
        result: JSON.stringify({
          summary: 's',
          proposals: [{ op: 'remove', file: 'MEMORY.md', target: STALE_BLOCK, reason: 'stale', score: 1, recallCount: 1 }],
        }),
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });

    const mgr = new DreamingManager({
      db: scriptedReviewer(),
      agentId: 'a',
      workspaceDir: ws,
      globalCfg: { mode: 'auto', quietMinutes: 30 },
      memoryBudgetChars: BUDGET,
      writeRouting: true,
      routeOutFn,
      spawnFn,
    });

    await mgr.dreamOnce(NOW);

    const after = read(memPath);
    // 1) Back under budget — automatically, no manual migrate.
    expect(after.length).toBeLessThan(BUDGET);
    // 2) Moved / pruned out; pinned + durable preserved.
    expect(after).not.toContain(OPEN_EPISODIC);
    expect(after).not.toContain(STALE_BLOCK);
    expect(after).toContain('- Timezone: UTC+7'); // pinned refused by route-out
    expect(after).toContain('The production database is Postgres 15'); // durable stays
    // episodic + pruned archives written
    expect(read(path.join(ws, 'memory/checkout.md'))).toContain('cache bug');
    expect(read(path.join(ws, 'memory/archive/pruned.md'))).toContain('deprecated cron path');

    // 3) Recall preserved through the REAL indexer + FTS search.
    indexAgentArchive(ws, resolveArchiveConfig({ enabled: true }, undefined));
    const db = ArchiveDB.forPath(archiveDbPath(ws));
    try {
      expect(db.search('checkout cache bug', 10).some((r) => r.text.includes('cache bug'))).toBe(true);
      expect(db.search('deprecated cron path', 10).some((r) => r.text.includes('cron path'))).toBe(true);
      expect(db.search('feature 7 MERGED', 10).length).toBeGreaterThan(0);
    } finally {
      ArchiveDB.evict(archiveDbPath(ws));
    }

    // 4) A memory-only cycle restarts NOTHING (planning-63 Part A).
    expect(classifyWorkspaceRestart(['MEMORY.md'])).toBe('none');
  });
});
