/**
 * planning-65 — memory write routing (MEMORY.md = durable facts; task-log →
 * memory/<topic>.md). Unit + integration coverage for the episodic writer,
 * tier-aware reviewer coercion, the applier's episodic pass, the MEMORY_RULE
 * tier contract, and the one-shot migration.
 *
 * Mock seams (no live model, no binary): the reviewer is exercised via its pure
 * `coerceReview`/`buildDreamPrompt`; the applier/migration take temp workspaces;
 * the migration's route-out classifier is injected as a stub. Clocks are passed
 * explicitly. Fixtures are synthetic — no real secrets.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isValidTopicSlug,
  resolveEpisodicPath,
  appendEpisodicNote,
} from '../../src/agent/dreaming/episodic';
import { buildDreamPrompt, coerceReview } from '../../src/agent/dreaming/reviewer';
import { applyDreamProposals } from '../../src/agent/dreaming/applier';
import { migrateMemory } from '../../src/agent/dreaming/migrate';
import { loadWorkspace, resolveMemoryBudget } from '../../src/agent/workspace-loader';
import type { DreamProposal } from '../../src/agent/dreaming/types';

const NOW = 1_734_500_000_000; // fixed clock → deterministic dated bullets

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mwr-'));
}
function read(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// ── episodic.ts — slug validation + traversal guard + append ─────────────────
describe('episodic writer', () => {
  it('accepts valid kebab slugs and rejects invalid/traversal ones', () => {
    expect(isValidTopicSlug('pr-status')).toBe(true);
    expect(isValidTopicSlug('deploy-2026')).toBe(true);
    expect(isValidTopicSlug('a')).toBe(true);
    expect(isValidTopicSlug('')).toBe(false);
    expect(isValidTopicSlug('Has-Upper')).toBe(false);
    expect(isValidTopicSlug('has_underscore')).toBe(false);
    expect(isValidTopicSlug('../escape')).toBe(false);
    expect(isValidTopicSlug('a/b')).toBe(false);
    expect(isValidTopicSlug('trailing-')).toBe(false);
    expect(isValidTopicSlug('x'.repeat(65))).toBe(false);
  });

  it('confines the resolved path under <ws>/<dir> and rejects escapes', () => {
    const ws = tmpWs();
    const ok = resolveEpisodicPath(ws, 'memory', 'pr-status');
    expect(ok).toBe(path.join(ws, 'memory', 'pr-status.md'));
    expect(resolveEpisodicPath(ws, 'memory', '../../etc/passwd')).toBeNull();
    expect(resolveEpisodicPath(ws, 'memory', 'sub/topic')).toBeNull();
  });

  it('appends a dated bullet, creates the file, and collapses internal newlines', () => {
    const ws = tmpWs();
    const r1 = appendEpisodicNote(ws, 'memory', 'pr-status', 'PR #1\nmerged today', NOW);
    expect(r1.ok).toBe(true);
    const body = read(path.join(ws, 'memory', 'pr-status.md'));
    expect(body).toContain('# pr-status');
    expect(body).toContain('- [2024-12-18] PR #1 merged today'); // newline collapsed
    // Second append keeps the first and adds a new bullet (no header dup).
    appendEpisodicNote(ws, 'memory', 'pr-status', 'PR #2 closed', NOW);
    const body2 = read(path.join(ws, 'memory', 'pr-status.md'));
    expect(body2.match(/# pr-status/g)?.length).toBe(1);
    expect(body2).toContain('- [2024-12-18] PR #2 closed');
  });

  it('rejects a bad slug or empty content without writing', () => {
    const ws = tmpWs();
    expect(appendEpisodicNote(ws, 'memory', 'Bad Slug', 'x', NOW).ok).toBe(false);
    expect(appendEpisodicNote(ws, 'memory', 'ok-slug', '   ', NOW).ok).toBe(false);
    expect(fs.existsSync(path.join(ws, 'memory'))).toBe(false);
  });
});

// ── reviewer — routing gate + tier-aware coercion ────────────────────────────
describe('reviewer routing', () => {
  const baseInput = { transcript: 't', currentMemory: '', currentUser: '' };

  it('injects the tier contract into the prompt only when writeRouting is on', () => {
    expect(buildDreamPrompt({ ...baseInput, writeRouting: true })).toContain('MEMORY TIERS');
    expect(buildDreamPrompt({ ...baseInput, writeRouting: false })).not.toContain('MEMORY TIERS');
    expect(buildDreamPrompt(baseInput)).not.toContain('MEMORY TIERS'); // absent ⇒ off
  });

  it('coerces a valid episodic op (add + slug + content)', () => {
    const r = coerceReview(
      { summary: 's', proposals: [{ op: 'add', tier: 'episodic', topic: 'pr-log', content: 'x', score: 0.9 }] },
      0,
    );
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ tier: 'episodic', topic: 'pr-log', content: 'x' });
    expect(r.proposals[0].file).toBeUndefined();
  });

  it('drops an episodic op with a bad slug, non-add op, or missing content', () => {
    const r = coerceReview(
      {
        proposals: [
          { op: 'add', tier: 'episodic', topic: 'Bad Slug', content: 'x' },
          { op: 'remove', tier: 'episodic', topic: 'pr-log', content: 'x' },
          { op: 'add', tier: 'episodic', topic: 'pr-log' },
        ],
      },
      0,
    );
    expect(r.proposals).toHaveLength(0);
  });

  it('leaves the durable path unchanged (file required, tier stamped durable)', () => {
    const r = coerceReview(
      { proposals: [{ op: 'add', file: 'MEMORY.md', content: 'fact', score: 0.8 }] },
      0,
    );
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ tier: 'durable', file: 'MEMORY.md', content: 'fact' });
    // A "durable" op with no valid file is still rejected.
    expect(coerceReview({ proposals: [{ op: 'add', content: 'x' }] }, 0).proposals).toHaveLength(0);
  });
});

// ── applier — episodic pass routes to memory/<topic>.md ──────────────────────
describe('applier episodic tier', () => {
  it('routes an episodic add to memory/<topic>.md and never into MEMORY.md', () => {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# Long-term Memory\n\n## Facts\n- keep me\n');
    const proposals: DreamProposal[] = [
      { op: 'add', tier: 'durable', file: 'MEMORY.md', content: '- a durable fact', reason: '', score: 1, recallCount: 0 },
      { op: 'add', tier: 'episodic', topic: 'pr-log', content: 'PR #9 merged', reason: '', score: 1, recallCount: 0 },
    ];
    const res = applyDreamProposals(ws, proposals, { memoryBudgetChars: 8000, userBudgetChars: 3000, episodicArchiveDir: 'memory' }, NOW);
    expect(res.totalApplied).toBe(2);
    expect(res.episodic).toHaveLength(1);
    expect(res.episodic[0].ok).toBe(true);
    const mem = read(path.join(ws, 'MEMORY.md'));
    expect(mem).toContain('a durable fact'); // durable landed
    expect(mem).not.toContain('PR #9 merged'); // episodic did NOT
    expect(read(path.join(ws, 'memory', 'pr-log.md'))).toContain('PR #9 merged');
  });

  it('ignores episodic ops when episodicArchiveDir is omitted (back-compat)', () => {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# M\n');
    const res = applyDreamProposals(
      ws,
      [{ op: 'add', tier: 'episodic', topic: 'pr-log', content: 'x', reason: '', score: 1, recallCount: 0 }],
      { memoryBudgetChars: 8000, userBudgetChars: 3000 },
      NOW,
    );
    expect(res.totalApplied).toBe(0);
    expect(res.episodic).toHaveLength(0);
    expect(fs.existsSync(path.join(ws, 'memory'))).toBe(false);
  });
});

// ── workspace-loader — MEMORY_RULE tier contract gate ────────────────────────
describe('MEMORY_RULE tier contract', () => {
  function wsWithFiles(): string {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# Agent\nrole');
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# Long-term Memory\n- x');
    return ws;
  }

  it('injects the tier contract only when writeRouting is on', async () => {
    const on = await loadWorkspace(wsWithFiles(), { memoryBudget: { writeRouting: true } });
    expect(on.systemPrompt).toContain('Memory Tiers');
    const off = await loadWorkspace(wsWithFiles(), { memoryBudget: { writeRouting: false } });
    expect(off.systemPrompt).not.toContain('Memory Tiers');
    const def = await loadWorkspace(wsWithFiles(), {});
    expect(def.systemPrompt).not.toContain('Memory Tiers'); // default off
  });

  it('resolveMemoryBudget defaults writeRouting to false', () => {
    expect(resolveMemoryBudget(undefined).writeRouting).toBe(false);
    expect(resolveMemoryBudget({ writeRouting: true }).writeRouting).toBe(true);
  });
});

// ── migration — terminal sweep + gated route-out + pinned exclusion ──────────
describe('migrateMemory', () => {
  const MEMORY = [
    '# Long-term Memory',
    '',
    '## User',
    '- Timezone: UTC+7',
    '',
    '## Feedback',
    '- Always ask before commit',
    '',
    '## Active work',
    '- PR #100 shipped the login flow, reviewed and deployed',
    '- Investigating the cache bug in checkout',
    '',
    '### #42 — old task MERGED into main last week',
  ].join('\n');

  function seed(): string {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), MEMORY);
    return ws;
  }

  it('propose mode writes a plan and does not move episodic blocks', async () => {
    const ws = seed();
    const routeOut = (): DreamProposal[] => [
      { op: 'add', tier: 'episodic', topic: 'active-work', content: 'PR #100 shipped the login flow',
        target: '- PR #100 shipped the login flow, reviewed and deployed', reason: 'task-log', score: 1, recallCount: 0 },
    ];
    const res = await migrateMemory(ws, { mode: 'propose', routeOut, now: NOW });
    expect(res.episodicPlanned).toBe(1);
    expect(res.episodicMoved).toBe(0);
    expect(res.planPath && read(res.planPath)).toContain('active-work');
    // MEMORY.md still has the block (propose mutates only via the deterministic sweep).
    expect(read(path.join(ws, 'MEMORY.md'))).toContain('PR #100 shipped the login flow');
  });

  it('apply mode: terminal sweep + episodic move, pinned excluded, recall preserved', async () => {
    const ws = seed();
    const routeOut = (): DreamProposal[] => [
      // legit episodic block → should move
      { op: 'add', tier: 'episodic', topic: 'active-work', content: 'PR #100 shipped the login flow',
        target: '- PR #100 shipped the login flow, reviewed and deployed', reason: 'task-log', score: 1, recallCount: 0 },
      // a PINNED block the model wrongly proposed → must be refused
      { op: 'add', tier: 'episodic', topic: 'prefs', content: 'tz',
        target: '- Timezone: UTC+7', reason: 'x', score: 1, recallCount: 0 },
    ];
    const res = await migrateMemory(ws, { mode: 'apply', routeOut, now: NOW });

    // Terminal sweep archived the "### #42 … MERGED" entry.
    expect(res.terminalArchived).toBe(1);
    expect(read(path.join(ws, 'memory', 'archive', 'completed.md'))).toContain('#42');

    // Exactly ONE episodic move applied (the pinned one refused).
    expect(res.episodicMoved).toBe(1);
    const mem = read(path.join(ws, 'MEMORY.md'));
    expect(mem).not.toContain('PR #100 shipped the login flow, reviewed and deployed'); // moved out
    expect(mem).toContain('- Timezone: UTC+7'); // pinned preserved
    expect(mem).toContain('## Feedback'); // pinned preserved

    // Recall preserved: the moved content lives in the searchable episodic file.
    expect(read(path.join(ws, 'memory', 'active-work.md'))).toContain('PR #100 shipped the login flow');
    // A backup pre-image was written before the rewrite.
    const backups = fs.readdirSync(path.join(ws, '.dreaming', 'backups'));
    expect(backups.some((b) => b.includes('migrate'))).toBe(true);
  });

  it('skips a route-out target that is missing or ambiguous', async () => {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), '## Work\n- dup line\n- dup line\n- unique task done here\n');
    const routeOut = (): DreamProposal[] => [
      { op: 'add', tier: 'episodic', topic: 'work', content: 'dup', target: '- dup line', reason: '', score: 1, recallCount: 0 }, // ambiguous
      { op: 'add', tier: 'episodic', topic: 'work', content: 'missing', target: '- not present', reason: '', score: 1, recallCount: 0 }, // gone
    ];
    const res = await migrateMemory(ws, { mode: 'apply', routeOut, now: NOW });
    expect(res.episodicMoved).toBe(0);
    expect(read(path.join(ws, 'MEMORY.md'))).toContain('- dup line');
  });
});
