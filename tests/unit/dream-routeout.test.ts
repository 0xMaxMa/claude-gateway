import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DreamingManager } from '../../src/agent/dreaming';
import type { DreamHistoryDb } from '../../src/agent/dreaming/gather';
import { applyDreamProposals } from '../../src/agent/dreaming/applier';
import type { DreamProposal } from '../../src/agent/dreaming/types';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

// Route-out is transcript-independent, so an empty db is enough to exercise the
// stage (it runs before the empty-transcript early return).
function emptyDb(): DreamHistoryDb {
  return { listSessions: () => [], getSessionTranscript: () => [] };
}

function mkWs(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeout-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const read = (ws: string, rel: string): string => {
  try {
    return fs.readFileSync(path.join(ws, rel), 'utf8');
  } catch {
    return '';
  }
};

// A large, plainly-EPISODIC block with NO terminal marker (so the compactor
// leaves it — we are testing route-out, not the terminal sweep).
const EPISODIC_BLOCK =
  '### Working notes on the widget pipeline\n' +
  'On day one we wired the ingest path and traced the retry loop end to end. '.repeat(6);

const seedMemory = (extra = ''): string =>
  `# Long-term Memory\n\n${EPISODIC_BLOCK}\n\n${extra}`;

describe('planning-67 — embedded route-out stage (dreamOnce)', () => {
  it('RO-1: over-budget + all gates on → routes the episodic block to memory/<topic>.md and cuts it', async () => {
    const ws = mkWs({ 'MEMORY.md': seedMemory() });
    const routeOutFn = jest.fn(
      async (): Promise<DreamProposal[]> => [
        {
          op: 'add',
          tier: 'episodic',
          topic: 'widget-pipeline',
          content: 'Widget pipeline ingest + retry loop notes.',
          target: EPISODIC_BLOCK,
          reason: 'episodic task-log',
          score: 1,
          recallCount: 0,
        },
      ],
    );
    const mgr = new DreamingManager({
      db: emptyDb(),
      agentId: 'a',
      workspaceDir: ws,
      globalCfg: { mode: 'auto' },
      memoryBudgetChars: 100, // seed is far over budget
      writeRouting: true,
      routeOutFn,
      spawnFn: async () => ({ stdout: '' }),
    });

    await mgr.dreamOnce(NOW);

    expect(routeOutFn).toHaveBeenCalledTimes(1);
    // Block moved out of MEMORY.md …
    expect(read(ws, 'MEMORY.md')).not.toContain(EPISODIC_BLOCK);
    // … and into the searchable episodic archive.
    expect(read(ws, 'memory/widget-pipeline.md')).toContain('Widget pipeline ingest');
  });

  it('RO-2: writeRouting off → stage skipped (classifier never called, MEMORY.md untouched)', async () => {
    const ws = mkWs({ 'MEMORY.md': seedMemory() });
    const routeOutFn = jest.fn(async (): Promise<DreamProposal[]> => []);
    const mgr = new DreamingManager({
      db: emptyDb(),
      agentId: 'a',
      workspaceDir: ws,
      globalCfg: { mode: 'auto' },
      memoryBudgetChars: 100,
      writeRouting: false, // ← gate off
      routeOutFn,
      spawnFn: async () => ({ stdout: '' }),
    });

    await mgr.dreamOnce(NOW);

    expect(routeOutFn).not.toHaveBeenCalled();
    expect(read(ws, 'MEMORY.md')).toContain(EPISODIC_BLOCK);
  });

  it('RO-3: autoRouteOut:false → stage skipped (kill-switch)', async () => {
    const ws = mkWs({ 'MEMORY.md': seedMemory() });
    const routeOutFn = jest.fn(async (): Promise<DreamProposal[]> => []);
    const mgr = new DreamingManager({
      db: emptyDb(),
      agentId: 'a',
      workspaceDir: ws,
      globalCfg: { mode: 'auto', autoRouteOut: false }, // ← kill-switch
      memoryBudgetChars: 100,
      writeRouting: true,
      routeOutFn,
      spawnFn: async () => ({ stdout: '' }),
    });

    await mgr.dreamOnce(NOW);

    expect(routeOutFn).not.toHaveBeenCalled();
    expect(read(ws, 'MEMORY.md')).toContain(EPISODIC_BLOCK);
  });

  it('RO-4: under budget → stage skipped / idempotent (no classifier call)', async () => {
    const ws = mkWs({ 'MEMORY.md': '# Small\n\nJust a durable fact.\n' });
    const routeOutFn = jest.fn(async (): Promise<DreamProposal[]> => []);
    const mgr = new DreamingManager({
      db: emptyDb(),
      agentId: 'a',
      workspaceDir: ws,
      globalCfg: { mode: 'auto' },
      memoryBudgetChars: 8000, // file is well under
      writeRouting: true,
      routeOutFn,
      spawnFn: async () => ({ stdout: '' }),
    });

    await mgr.dreamOnce(NOW);

    expect(routeOutFn).not.toHaveBeenCalled();
  });

  it('RO-5: propose mode → stage skipped (auto-only)', async () => {
    const ws = mkWs({ 'MEMORY.md': seedMemory() });
    const routeOutFn = jest.fn(async (): Promise<DreamProposal[]> => []);
    const mgr = new DreamingManager({
      db: emptyDb(),
      agentId: 'a',
      workspaceDir: ws,
      globalCfg: { mode: 'propose' }, // ← dry-run
      memoryBudgetChars: 100,
      writeRouting: true,
      routeOutFn,
      spawnFn: async () => ({ stdout: '' }),
    });

    await mgr.dreamOnce(NOW);

    expect(routeOutFn).not.toHaveBeenCalled();
    expect(read(ws, 'MEMORY.md')).toContain(EPISODIC_BLOCK);
  });
});

describe('planning-67 — archive-safe net-shrink remove (applier)', () => {
  const REMOVABLE = '### Stale open note\nThis open task-log entry is no longer needed. '.repeat(4);
  // Durable filler so REMOVABLE is a small fraction of the file — the bounded-loss
  // gate (max 0.9 over budget) then permits the remove instead of rejecting it.
  const DURABLE = '## Durable\n' + 'The user prefers concise answers in conversation. '.repeat(20);

  it('PR-1: routing on → a remove relocates the block to memory/archive/pruned.md BEFORE cutting it', () => {
    const ws = mkWs({ 'MEMORY.md': `# Memory\n\n${REMOVABLE}\n\n${DURABLE}\n` });
    const proposals: DreamProposal[] = [
      { op: 'remove', target: REMOVABLE, reason: 'stale', score: 1, recallCount: 0, file: 'MEMORY.md' },
    ];

    applyDreamProposals(
      ws,
      proposals,
      { memoryBudgetChars: 50, userBudgetChars: 3000, archivePrunedRemovals: true },
      NOW,
    );

    expect(read(ws, 'MEMORY.md')).not.toContain(REMOVABLE);
    // recall preserved — the removed text lives in the searchable pruned archive.
    expect(read(ws, 'memory/archive/pruned.md')).toContain('Stale open note');
  });

  it('PR-2: a remove targeting a pinned section is skipped (never pruned out of the core)', () => {
    const pinned = 'I prefer concise answers.';
    const ws = mkWs({ 'MEMORY.md': `# Memory\n\n## User\n${pinned}\n\n## Notes\nfiller\n` });
    const proposals: DreamProposal[] = [
      { op: 'remove', target: pinned, reason: 'x', score: 1, recallCount: 0, file: 'MEMORY.md' },
    ];

    applyDreamProposals(
      ws,
      proposals,
      { memoryBudgetChars: 10, userBudgetChars: 3000, archivePrunedRemovals: true },
      NOW,
    );

    // pinned block stays in MEMORY.md and is NOT relocated.
    expect(read(ws, 'MEMORY.md')).toContain(pinned);
    expect(read(ws, 'memory/archive/pruned.md')).not.toContain(pinned);
  });

  it('PR-3 (proven-red): flag OFF → remove deletes WITHOUT archiving (reproduces the forget)', () => {
    const ws = mkWs({ 'MEMORY.md': `# Memory\n\n${REMOVABLE}\n\n${DURABLE}\n` });
    const proposals: DreamProposal[] = [
      { op: 'remove', target: REMOVABLE, reason: 'stale', score: 1, recallCount: 0, file: 'MEMORY.md' },
    ];

    applyDreamProposals(
      ws,
      proposals,
      { memoryBudgetChars: 50, userBudgetChars: 3000 /* archivePrunedRemovals omitted */ },
      NOW,
    );

    // With the guard off, the old behavior stands: block gone AND not archived → forgotten.
    expect(read(ws, 'MEMORY.md')).not.toContain(REMOVABLE);
    expect(read(ws, 'memory/archive/pruned.md')).toBe('');
  });
});
