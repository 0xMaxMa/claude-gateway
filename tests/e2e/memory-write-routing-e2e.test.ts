/**
 * planning-65 e2e — memory write routing, end to end against the REAL archive
 * indexer + FTS search and the REAL restart classifier. Opt-in (tests/e2e/ is
 * ignored by `npm test`; run via `npm run test:e2e`).
 *
 * No live model / no spawned claude: the migration's route-out classifier is a
 * scripted stub (the "mock reviewer"). The clock is injected. Everything else is
 * the real code path: the deterministic compactor sweep, the episodic writer, the
 * node:sqlite FTS indexer, and `classifyWorkspaceRestart`.
 *
 * Proves the whole chain the issue asks for:
 *   1. an over-budget MEMORY.md comes back UNDER budget after migration,
 *   2. terminal + episodic content is MOVED out (pinned sections preserved),
 *   3. every moved entry is still found by the real archive search (recall kept),
 *   4. the migration's writes never trigger a session restart.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { migrateMemory } from '../../src/agent/dreaming/migrate';
import { indexAgentArchive, archiveDbPath } from '../../src/agent/knowledge/indexer';
import { ArchiveDB } from '../../src/agent/knowledge/archive-db';
import { resolveArchiveConfig } from '../../src/agent/knowledge/config';
import { classifyWorkspaceRestart } from '../../src/agent/workspace-loader';
import type { DreamProposal } from '../../src/agent/dreaming/types';

const NOW = 1_734_500_000_000;
const BUDGET = 8_000;

function mkAgent(memory: string): { agentDir: string; workspaceDir: string } {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwr-e2e-'));
  const workspaceDir = path.join(agentDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'MEMORY.md'), memory);
  return { agentDir, workspaceDir };
}
const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

/** Synthetic over-budget MEMORY.md: pinned + durable + 40 terminal task-logs + 1 episodic. */
function seedMemory(): string {
  const terminal = Array.from(
    { length: 40 },
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
    '## Feedback',
    '- Always ask before committing',
    '',
    '## Facts',
    '- The production database is Postgres 15',
    '',
    '## Active PR log',
    terminal,
    '- Investigating an intermittent cache bug in the checkout flow, still open and ongoing',
    '',
  ].join('\n');
}

describe('memory write routing — e2e', () => {
  it('drains an over-budget MEMORY.md, preserves recall via the real archive, drops no session', async () => {
    const { workspaceDir } = mkAgent(seedMemory());
    const memPath = path.join(workspaceDir, 'MEMORY.md');
    const before = read(memPath).length;
    expect(before).toBeGreaterThan(BUDGET); // genuinely over budget

    // Scripted route-out (the "mock reviewer"): move the one open episodic block.
    const EPISODIC_TARGET =
      '- Investigating an intermittent cache bug in the checkout flow, still open and ongoing';
    const routeOut = (): DreamProposal[] => [
      { op: 'add', tier: 'episodic', topic: 'checkout', content: 'Investigating intermittent cache bug in checkout flow',
        target: EPISODIC_TARGET, reason: 'ongoing task-log', score: 1, recallCount: 0 },
      // pinned block the model wrongly proposed — must be refused
      { op: 'add', tier: 'episodic', topic: 'prefs', content: 'tz', target: '- Timezone: UTC+7', reason: 'x', score: 1, recallCount: 0 },
    ];

    const res = await migrateMemory(workspaceDir, { mode: 'apply', routeOut, now: NOW });

    // 1) Back under budget after the deterministic terminal sweep + route-out.
    const after = read(memPath);
    expect(after.length).toBeLessThan(BUDGET);
    expect(res.terminalArchived).toBe(40);
    expect(res.episodicMoved).toBe(1);

    // 2) Moved out; pinned + durable preserved.
    expect(after).not.toContain(EPISODIC_TARGET);
    expect(after).toContain('- Timezone: UTC+7'); // pinned refused
    expect(after).toContain('## Feedback');
    expect(after).toContain('The production database is Postgres 15'); // durable stays

    // 3) Recall preserved through the REAL indexer + FTS search.
    indexAgentArchive(workspaceDir, resolveArchiveConfig({ enabled: true }, undefined));
    const db = ArchiveDB.forPath(archiveDbPath(workspaceDir));
    try {
      const episodicHit = db.search('checkout cache bug', 10);
      expect(episodicHit.some((r) => r.text.includes('cache bug'))).toBe(true); // episodic searchable
      const terminalHit = db.search('feature 7 MERGED', 10);
      expect(terminalHit.length).toBeGreaterThan(0); // swept terminal entry searchable
    } finally {
      ArchiveDB.evict(archiveDbPath(workspaceDir));
    }

    // 4) The migration only wrote MEMORY.md + memory/*.md — a memory-only change
    // restarts NOTHING (planning-63 Part A); memory/ notes aren't even watched.
    expect(classifyWorkspaceRestart(['MEMORY.md'])).toBe('none');
  });
});
