/**
 * Tests for the #337 unbounded-MEMORY.md fix:
 *   - deterministic compactor (archive MERGED/CLOSED log entries, keep recall)
 *   - budget-scaled proposal selection (converge over-budget files)
 *   - reviewer net-shrink budget signal
 *
 * No real secrets appear in any fixture (the live meguri file that motivated the
 * issue contains an API key; these fixtures are entirely synthetic).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  planCompaction,
  compactCompletedEntries,
  ARCHIVE_REL_PATH,
} from '../../src/agent/dreaming/compactor';
import { selectProposals, DreamingManager } from '../../src/agent/dreaming';
import { buildDreamPrompt } from '../../src/agent/dreaming/reviewer';
import type { DreamProposal } from '../../src/agent/dreaming/types';
import type { DreamHistoryDb } from '../../src/agent/dreaming/gather';
import type { ClaudeSpawnFn } from '../../src/agent/skill-learning/reviewer';

const NOW = 1_700_000_000_000; // fixed epoch → deterministic archive date

function mkWs(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const prop = (over: Partial<DreamProposal>): DreamProposal => ({
  op: 'remove',
  file: 'MEMORY.md',
  target: 'x',
  reason: 'r',
  score: 0.9,
  recallCount: 2,
  ...over,
});

// A small mixed MEMORY.md: two terminal entries (MERGED, CLOSED), two live ones
// (one open, one whose only "close" word is the false-friend "Closes #123").
const MIXED = `## Active PR

- [PR #100 — cool feature](memory/pr_100.md) — **MERGED 2026-08-01** (squash abc123). Closes #99. Long changelog tail with review score 9.4/10 and commit hashes that bloat the index forever.
- **PR #101** (repo) — OPEN, awaiting review. Closes #98. Still in flight, must not be archived.
- **Issue #77** — **CLOSED 2026-08-02**, superseded by #78. Full rationale preserved here across several sentences of detail.
- **Issue #78** — open follow-up to #77. Closes #77 conceptually but is itself active work.

## Preferences

- Likes concise answers.
`;

describe('dreaming/compactor: planCompaction (pure)', () => {
  it('C-1: archives MERGED and CLOSED blocks, keeps open ones (incl. "Closes #" false friend)', () => {
    const plan = planCompaction(MIXED, NOW);
    expect(plan.archivedCount).toBe(2); // the MERGED PR + the CLOSED issue
    // Open PR #101 and open Issue #78 (only "Closes" prose) survive in MEMORY.md.
    expect(plan.nextMemory).toContain('**PR #101**');
    expect(plan.nextMemory).toContain('**Issue #78**');
    // Terminal entries' verbose tails are gone from MEMORY.md.
    expect(plan.nextMemory).not.toContain('Long changelog tail');
    expect(plan.nextMemory).not.toContain('superseded by #78');
    // ...but preserved in the archive append (recall intact).
    expect(plan.archiveAppend).toContain('Long changelog tail');
    expect(plan.archiveAppend).toContain('superseded by #78');
    expect(plan.charsRemoved).toBeGreaterThan(0);
  });

  it('C-2: leaves a pointer that keeps identity + links to the archive file', () => {
    const plan = planCompaction(MIXED, NOW);
    // The MERGED entry had its own [label](link) — kept verbatim in the pointer.
    expect(plan.nextMemory).toContain('[PR #100 — cool feature](memory/pr_100.md)');
    expect(plan.nextMemory).toContain(ARCHIVE_REL_PATH);
    expect(plan.nextMemory).toMatch(/MERGED, archived 2023-11-14 → memory\/archive\/completed\.md/);
    // The Preferences section is untouched.
    expect(plan.nextMemory).toContain('Likes concise answers.');
  });

  it('C-3: idempotent — a pointer emitted by a prior run is never re-archived', () => {
    const once = planCompaction(MIXED, NOW);
    const twice = planCompaction(once.nextMemory, NOW);
    expect(twice.archivedCount).toBe(0);
    expect(twice.nextMemory).toBe(once.nextMemory);
  });

  it('C-4: a multi-line block (bullet + continuation lines) is archived whole', () => {
    const multi = `## Issues

- **Issue #5** — **CLOSED**, split into three:
  - #6 sub-issue one
  - #7 sub-issue two
  All three carry the original evidence.
- **Issue #9** — open, do not touch.
`;
    const plan = planCompaction(multi, NOW);
    expect(plan.archivedCount).toBe(1);
    expect(plan.archiveAppend).toContain('#6 sub-issue one');
    expect(plan.archiveAppend).toContain('All three carry the original evidence.');
    expect(plan.nextMemory).toContain('**Issue #9** — open, do not touch.');
    expect(plan.nextMemory).not.toContain('#6 sub-issue one');
  });

  it('C-5: no terminal entries → no-op plan', () => {
    const clean = `## Active PR\n\n- **PR #1** — OPEN.\n- **PR #2** — awaiting review.\n`;
    const plan = planCompaction(clean, NOW);
    expect(plan.archivedCount).toBe(0);
    expect(plan.nextMemory).toBe(clean);
    expect(plan.archiveAppend).toBe('');
  });
});

describe('dreaming/compactor: domain-agnostic markers (#337, not just dev)', () => {
  it('C-19: archives generic done markers — DONE / RESOLVED / CANCELLED / ✅ / [x] / ~~strike~~', () => {
    const mem = `## Tasks

- Book the venue — **DONE** 2026-08-01
- Ticket refund — RESOLVED by support
- Team offsite — CANCELLED, budget cut
- ✅ Renew the domain for the year
- [x] Submit the tax form
- ~~Old landing-page copy~~ replaced
- Buy milk and eggs for the week
- [ ] Draft the Q4 plan
`;
    const plan = planCompaction(mem, NOW);
    expect(plan.archivedCount).toBe(6); // the 6 done entries
    // The two live entries stay (a plain todo + an UNCHECKED box).
    expect(plan.nextMemory).toContain('- Buy milk and eggs for the week');
    expect(plan.nextMemory).toContain('- [ ] Draft the Q4 plan');
    // Archived bodies are recallable.
    expect(plan.archiveAppend).toContain('Book the venue');
    expect(plan.archiveAppend).toContain('Old landing-page copy');
  });

  it('C-20: lowercase status words are NOT matched (precision — prose is safe)', () => {
    const mem = `## Notes

- we are not done yet with the redesign
- the shop closed early yesterday
- meeting resolved nothing, reschedule
`;
    const plan = planCompaction(mem, NOW);
    expect(plan.archivedCount).toBe(0); // lowercase done/closed/resolved = prose, untouched
    expect(plan.nextMemory).toBe(mem);
  });

  it('C-21: h3+ entry headers are archived (founder-style ### ✅ … MERGED), section h2 is never touched', () => {
    const mem = `## Projects

### Free-Plan Docker Runtime (active, do not touch)
- point A
- point B

### ✅ #316 — explicit Stop status — PR #317 MERGED squash abc123

### ✅ #313 — start/stop REST API — issue #313 CLOSED
`;
    const plan = planCompaction(mem, NOW);
    expect(plan.archivedCount).toBe(2); // the two ### ✅ … entries
    // The h2 section header + the active project + its bullets remain.
    expect(plan.nextMemory).toContain('## Projects');
    expect(plan.nextMemory).toContain('### Free-Plan Docker Runtime (active, do not touch)');
    expect(plan.nextMemory).toContain('- point A');
    // Archived header entries become an h3 pointer (structure kept), full text in archive.
    expect(plan.nextMemory).toMatch(/### #316 — explicit Stop status .*archived .* → memory\/archive\/completed\.md/);
    expect(plan.nextMemory).not.toContain('PR #317 MERGED squash abc123');
    expect(plan.archiveAppend).toContain('PR #317 MERGED squash abc123');
  });

  it('C-22: idempotent across markers + headers (second pass archives nothing)', () => {
    const mem = `## X\n\n- ✅ a task\n- item — DONE\n\n### ✅ #9 — a thing CLOSED\n`;
    const once = planCompaction(mem, NOW);
    expect(once.archivedCount).toBe(3);
    const twice = planCompaction(once.nextMemory, NOW);
    expect(twice.archivedCount).toBe(0);
    expect(twice.nextMemory).toBe(once.nextMemory);
  });
});

describe('dreaming/compactor: compactCompletedEntries (I/O)', () => {
  it('C-6: writes searchable archive under memory/, shrinks MEMORY.md, keeps open items + backup', () => {
    const ws = mkWs({ 'MEMORY.md': MIXED });
    const before = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8').length;

    const res = compactCompletedEntries(ws, NOW);
    expect(res.archivedCount).toBe(2);
    expect(res.charsRemoved).toBeGreaterThan(0);

    const mem = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
    expect(mem.length).toBeLessThan(before);
    expect(mem).toContain('**PR #101**'); // open item stays
    expect(mem).toContain('**Issue #78**');

    // Archive file lives under memory/ → the knowledge indexer walks it → searchable.
    const archive = fs.readFileSync(path.join(ws, ARCHIVE_REL_PATH), 'utf8');
    expect(archive).toContain('Long changelog tail'); // MERGED content recallable
    expect(archive).toContain('superseded by #78'); // CLOSED content recallable
    expect(ARCHIVE_REL_PATH.startsWith('memory/')).toBe(true);

    // A rollback pre-image was written.
    const backups = fs.readdirSync(path.join(ws, '.dreaming', 'backups'));
    expect(backups.some((b) => b.includes('MEMORY.md') && b.endsWith('.bak'))).toBe(true);
  });

  it('C-7: second run is a no-op (nothing left to archive), archive not duplicated', () => {
    const ws = mkWs({ 'MEMORY.md': MIXED });
    compactCompletedEntries(ws, NOW);
    const archive1 = fs.readFileSync(path.join(ws, ARCHIVE_REL_PATH), 'utf8');
    const res2 = compactCompletedEntries(ws, NOW);
    expect(res2.archivedCount).toBe(0);
    const archive2 = fs.readFileSync(path.join(ws, ARCHIVE_REL_PATH), 'utf8');
    expect(archive2).toBe(archive1); // archive unchanged on the no-op second pass
  });

  it('C-8: ACCEPTANCE — a meguri-scale log (~80 KB, mostly MERGED) shrinks hard with zero loss of open items', () => {
    // Build a synthetic over-budget file: 60 MERGED entries + 6 open ones, each a
    // fat one-line changelog like the real bloat.
    const fat = (n: number, merged: boolean) =>
      `- **PR #${n}** (repo) — ${merged ? '**MERGED** (commit ' + n + 'ffff)' : 'OPEN, awaiting review'}. ` +
      'x'.repeat(1200);
    const merged = Array.from({ length: 60 }, (_, i) => fat(1000 + i, true));
    const open = Array.from({ length: 6 }, (_, i) => fat(2000 + i, false));
    const big = `## Active PR\n\n${[...merged, ...open].join('\n')}\n`;
    expect(big.length).toBeGreaterThan(75_000); // genuinely over the 8 KB budget

    const ws = mkWs({ 'MEMORY.md': big });
    const res = compactCompletedEntries(ws, NOW);
    expect(res.archivedCount).toBe(60);

    const mem = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
    // Massive shrink: 60 fat lines → 60 short pointers.
    expect(mem.length).toBeLessThan(big.length / 3);
    // Every OPEN item is still present verbatim — nothing active lost.
    for (let i = 0; i < 6; i++) expect(mem).toContain(`**PR #${2000 + i}**`);
    // All MERGED bodies are recallable in the archive.
    const archive = fs.readFileSync(path.join(ws, ARCHIVE_REL_PATH), 'utf8');
    for (let i = 0; i < 60; i++) expect(archive).toContain(`**PR #${1000 + i}**`);
  });

  it('C-9: never throws / no-op on a missing or empty MEMORY.md', () => {
    const ws = mkWs({});
    expect(compactCompletedEntries(ws, NOW)).toEqual({ archivedCount: 0, charsRemoved: 0, archivePath: null });
    const ws2 = mkWs({ 'MEMORY.md': '   \n' });
    expect(compactCompletedEntries(ws2, NOW).archivedCount).toBe(0);
  });
});

describe('dreaming: selectProposals (budget-scaled cap, #337)', () => {
  it('C-10: under budget → classic first-N cap (unchanged behavior)', () => {
    const removes = Array.from({ length: 15 }, (_, i) => prop({ target: `t${i}` }));
    expect(selectProposals(removes, 3, 1).length).toBe(3);
    expect(selectProposals(removes, 3, 0.5).length).toBe(3);
  });

  it('C-11: PROVEN-RED — over budget selects far MORE than maxChanges shrink ops (old .slice(0,3) would cap at 3)', () => {
    const removes = Array.from({ length: 15 }, (_, i) => prop({ target: `t${i}` }));
    // 5× over budget → shrinkCap = min(3*5, 30) = 15 → all 15 removes flow through.
    const sel = selectProposals(removes, 3, 5);
    expect(sel.length).toBe(15);
    expect(sel.every((p) => p.op === 'remove')).toBe(true);
  });

  it('C-12: over budget keeps the ADD cap tight while scaling removes', () => {
    const adds = Array.from({ length: 5 }, (_, i) => prop({ op: 'add', target: undefined, content: `a${i}` }));
    const removes = Array.from({ length: 10 }, (_, i) => prop({ target: `t${i}` }));
    const sel = selectProposals([...adds, ...removes], 3, 4); // shrinkCap = min(12,30)=12
    expect(sel.filter((p) => p.op === 'add').length).toBe(3); // add cap unchanged
    expect(sel.filter((p) => p.op === 'remove').length).toBe(10); // all removes scale in
  });

  it('C-13: a growing replace counts against the add cap, a shrinking replace scales as a shrink op', () => {
    const grow = prop({ op: 'replace', target: 'ab', content: 'abcdef' }); // longer → non-shrink
    const shrink = prop({ op: 'replace', target: 'abcdef', content: 'ab' }); // shorter → shrink
    const sel = selectProposals([grow, grow, grow, grow, shrink], 1, 5);
    expect(sel.filter((p) => (p.content ?? '').length > (p.target ?? '').length).length).toBe(1); // 1 grow (cap)
    expect(sel).toContain(shrink);
  });

  it('C-14: shrink ops are hard-capped at 30 even for an extreme overage', () => {
    const removes = Array.from({ length: 100 }, (_, i) => prop({ target: `t${i}` }));
    expect(selectProposals(removes, 3, 50).length).toBe(30);
  });
});

describe('dreaming/reviewer: net-shrink budget signal (#337)', () => {
  const base = { transcript: 'hi', currentMemory: 'm', currentUser: 'u' };

  it('C-15: over budget → prompt carries NET-SHRINK MODE + the overage figure', () => {
    const p = buildDreamPrompt({ ...base, memoryChars: 80_000, memoryBudget: 8_000 });
    expect(p).toContain('NET-SHRINK MODE');
    expect(p).toContain('10.0× over budget');
    expect(p).toContain('<budget_status>');
  });

  it('C-16: under budget (or no budget given) → no net-shrink directive', () => {
    expect(buildDreamPrompt({ ...base, memoryChars: 4_000, memoryBudget: 8_000 })).not.toContain('NET-SHRINK MODE');
    expect(buildDreamPrompt(base)).not.toContain('NET-SHRINK MODE');
  });
});

// A reviewer that proposes nothing — isolates compaction from the LLM path.
const emptyReviewer: ClaudeSpawnFn = async () => ({
  stdout: JSON.stringify({ result: JSON.stringify({ summary: 'nothing', proposals: [] }), usage: {} }),
});

function activeDb(nowMs: number): DreamHistoryDb {
  // One session, active well before `now` (past the quiet window), with a real
  // transcript line so the run is not skipped-empty.
  return {
    listSessions: () => [{ sessionId: 's1', lastActivity: nowMs - 24 * 60 * 60 * 1000 }],
    getSessionTranscript: () => [{ role: 'user', content: 'hello there', ts: nowMs - 24 * 60 * 60 * 1000 }],
  };
}

describe('dreaming: DreamingManager wires the compactor (#337)', () => {
  it('C-17: auto mode archives terminal entries even when the reviewer proposes nothing', async () => {
    const ws = mkWs({ 'MEMORY.md': MIXED });
    const before = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8').length;
    const mgr = new DreamingManager({
      db: activeDb(NOW),
      agentId: 'a',
      workspaceDir: ws,
      globalCfg: { mode: 'auto' },
      spawnFn: emptyReviewer,
    });
    const res = await mgr.dreamOnce(NOW);
    expect(res.compactedCount).toBe(2);
    const mem = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
    expect(mem.length).toBeLessThan(before);
    expect(mem).toContain('**PR #101**'); // open item preserved
    expect(fs.existsSync(path.join(ws, ARCHIVE_REL_PATH))).toBe(true);
  });

  it('C-18: propose mode never compacts (memory is not mutated)', async () => {
    const ws = mkWs({ 'MEMORY.md': MIXED });
    const before = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
    const mgr = new DreamingManager({
      db: activeDb(NOW),
      agentId: 'a',
      workspaceDir: ws,
      globalCfg: { mode: 'propose' },
      spawnFn: emptyReviewer,
    });
    const res = await mgr.dreamOnce(NOW);
    expect(res.compactedCount ?? 0).toBe(0);
    expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).toBe(before); // untouched
    expect(fs.existsSync(path.join(ws, ARCHIVE_REL_PATH))).toBe(false);
  });
});
