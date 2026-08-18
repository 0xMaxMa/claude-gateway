/**
 * Manual accept of dreaming proposals (src/agent/dreaming/accept.ts).
 * Exercises the real applier against a tmp workspace: apply, idempotency,
 * accept-all, stale-anchor skip, and shared promotion.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acceptDreamProposals,
  loadRunProposals,
  readAcceptedKeys,
} from '../../src/agent/dreaming/accept';
import type { DreamProposal } from '../../src/agent/dreaming/types';

const TS = 1_700_000_000_000;
const BUDGETS = { memoryBudgetChars: 8_000, userBudgetChars: 3_000 };

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-accept-'));
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

function seed(files: Record<string, string>, promotions: Array<Record<string, unknown>>): void {
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(ws, name), body);
  const dir = path.join(ws, '.dreaming');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'promotions.jsonl'),
    promotions.map((p) => JSON.stringify({ ts: TS, ...p })).join('\n') + '\n',
    'utf8',
  );
}

function memory(): string {
  return fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
}

describe('acceptDreamProposals', () => {
  test('A-ACC-1: accepting an add applies it to MEMORY.md and records accepted.jsonl', () => {
    seed({ 'MEMORY.md': '# Memory\n\n- existing\n' }, [
      { op: 'add', file: 'MEMORY.md', content: '- brand new fact', reason: 'durable', score: 0.9, recallCount: 3 },
    ]);
    const res = acceptDreamProposals(ws, TS, [0], BUDGETS, TS);

    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.requested).toBe(1);
    expect(memory()).toContain('brand new fact');
    expect(memory()).toContain('existing'); // kept
    // A rollback pre-image was captured.
    expect(res.backups.length).toBe(1);
    // Idempotency record written.
    const accepted = fs.readFileSync(path.join(ws, '.dreaming', 'accepted.jsonl'), 'utf8');
    expect(accepted).toContain('"index":0');
    expect(readAcceptedKeys(ws).has(`${TS}:0`)).toBe(true);
  });

  test('A-ACC-2: re-accepting the same proposal is a no-op (idempotent, no double write)', () => {
    seed({ 'MEMORY.md': '# Memory\n' }, [
      { op: 'add', file: 'MEMORY.md', content: '- once only', reason: 'r', score: 0.9, recallCount: 3 },
    ]);
    acceptDreamProposals(ws, TS, [0], BUDGETS, TS);
    const afterFirst = memory();

    const res2 = acceptDreamProposals(ws, TS, [0], BUDGETS, TS + 1);
    expect(res2.applied).toBe(0);
    expect(res2.alreadyAccepted).toBe(1);
    expect(memory()).toBe(afterFirst); // unchanged — no second copy
    expect((memory().match(/once only/g) || []).length).toBe(1);
  });

  test('A-ACC-3: indexes=null accepts every proposal in the run', () => {
    seed({ 'MEMORY.md': '# Memory\n', 'USER.md': 'u\n' }, [
      { op: 'add', file: 'MEMORY.md', content: '- fact A', reason: 'a', score: 0.9, recallCount: 3 },
      { op: 'add', file: 'USER.md', content: '- pref B', reason: 'b', score: 0.8, recallCount: 2 },
    ]);
    const res = acceptDreamProposals(ws, TS, null, BUDGETS, TS);

    expect(res.applied).toBe(2);
    expect(memory()).toContain('fact A');
    expect(fs.readFileSync(path.join(ws, 'USER.md'), 'utf8')).toContain('pref B');
  });

  test('A-ACC-4: a stale replace anchor is skipped and NOT recorded (retryable)', () => {
    seed({ 'MEMORY.md': '# Memory\n\n- real line\n' }, [
      { op: 'replace', file: 'MEMORY.md', target: 'this text is not in the file', content: '- new', reason: 'r', score: 0.9, recallCount: 3 },
    ]);
    const res = acceptDreamProposals(ws, TS, [0], BUDGETS, TS);

    expect(res.applied).toBe(0);
    expect(res.skipped).toBe(1);
    // Not recorded as accepted, so the user can retry later.
    expect(readAcceptedKeys(ws).has(`${TS}:0`)).toBe(false);
    expect(fs.existsSync(path.join(ws, '.dreaming', 'accepted.jsonl'))).toBe(false);
  });

  test('A-ACC-5: shared promoter is called for each applied add', () => {
    seed({ 'MEMORY.md': '# Memory\n' }, [
      { op: 'add', file: 'MEMORY.md', content: '- shareable', reason: 'team', score: 0.9, recallCount: 3 },
    ]);
    const promoted: DreamProposal[] = [];
    const res = acceptDreamProposals(ws, TS, [0], { ...BUDGETS, sharedPromote: (p) => promoted.push(p) }, TS);

    expect(res.applied).toBe(1);
    expect(promoted.length).toBe(1);
    expect(promoted[0].content).toBe('- shareable');
  });

  test('A-ACC-6: requested=0 when the run has no matching proposals', () => {
    seed({ 'MEMORY.md': '# Memory\n' }, [
      { op: 'add', file: 'MEMORY.md', content: '- x', reason: 'r', score: 0.9, recallCount: 3 },
    ]);
    const res = acceptDreamProposals(ws, 999, null, BUDGETS, TS);
    expect(res.requested).toBe(0);
    expect(res.applied).toBe(0);
  });

  test('A-ACC-7: loadRunProposals keeps index alignment across an unusable line', () => {
    seed({ 'MEMORY.md': '# Memory\n' }, [
      { op: 'bogus', file: 'MEMORY.md', content: '- skip me', reason: 'r', score: 0.5, recallCount: 1 }, // index 0, unusable
      { op: 'add', file: 'MEMORY.md', content: '- keep me', reason: 'r', score: 0.9, recallCount: 3 },   // index 1, usable
    ]);
    const loaded = loadRunProposals(ws, TS);
    expect(loaded.length).toBe(1);
    expect(loaded[0].index).toBe(1); // slot for the bogus line 0 is consumed but skipped
    // Accepting index 1 applies the good one.
    const res = acceptDreamProposals(ws, TS, [1], BUDGETS, TS);
    expect(res.applied).toBe(1);
    expect(memory()).toContain('keep me');
  });
});
