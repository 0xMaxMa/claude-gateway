/**
 * parseDreamReport — turns the on-disk dream audit trail (DREAMS.md + the
 * structured promotions.jsonl) into newest-first runs for the dashboard's
 * "Nightly dreaming" tab. Verifies the ts-join, field coercion, ordering, and
 * resilience to malformed input.
 */
import { parseDreamReport } from '../../src/agent/dreaming/report';

// Two runs; the older is a propose run with 2 proposals, the newer an auto run
// with 1 applied op. iso ↔ ts must join to the matching promotions lines.
const TS_OLD = Date.parse('2026-08-17T05:19:23.664Z');
const TS_NEW = Date.parse('2026-08-18T03:00:00.000Z');

const DREAMS_MD = `## 2026-08-17T05:19:23.664Z — proposed (propose)

On-disk state validation pattern

- **add** \`MEMORY.md\` [anchor] — Recurring pattern _(score 0.85, recall 3)_
- **add** \`MEMORY.md\` [anchor2] — Workflow confirmed _(score 0.80, recall 2)_

_propose mode: proposals logged only — memory not modified._

_tokens: 6351, sessions: 2_

---

## 2026-08-18T03:00:00.000Z — proposed (auto)

Applied a consolidation

- **replace** \`MEMORY.md\` [x] — Superseded _(score 0.90, recall 4)_

_auto mode: applied 1 op(s) to memory — rollback pre-image kept in .dreaming/backups/._

_tokens: 1200, sessions: 1_

---
`;

const PROMOTIONS = [
  JSON.stringify({ ts: TS_OLD, mode: 'propose', op: 'add', file: 'MEMORY.md', target: 'anchor', content: 'full text one', reason: 'Recurring pattern', score: 0.85, recallCount: 3 }),
  JSON.stringify({ ts: TS_OLD, mode: 'propose', op: 'add', file: 'MEMORY.md', target: 'anchor2', content: 'full text two', reason: 'Workflow confirmed', score: 0.8, recallCount: 2 }),
  JSON.stringify({ ts: TS_NEW, mode: 'auto', op: 'replace', file: 'MEMORY.md', target: 'x', content: 'new text', reason: 'Superseded', score: 0.9, recallCount: 4 }),
].join('\n');

describe('parseDreamReport', () => {
  it('parses runs newest-first and joins proposals by ts', () => {
    const runs = parseDreamReport(DREAMS_MD, PROMOTIONS);
    expect(runs.map((r) => r.ts)).toEqual([TS_NEW, TS_OLD]); // newest first

    const auto = runs[0];
    expect(auto.mode).toBe('auto');
    expect(auto.outcome).toBe('proposed');
    expect(auto.applied).toBe(1);
    expect(auto.tokens).toBe(1200);
    expect(auto.sessions).toBe(1);
    expect(auto.proposals).toHaveLength(1);
    expect(auto.proposals[0]).toMatchObject({ op: 'replace', file: 'MEMORY.md', content: 'new text', score: 0.9, recallCount: 4 });

    const propose = runs[1];
    expect(propose.mode).toBe('propose');
    expect(propose.applied).toBeNull(); // propose mode → no applied count
    expect(propose.summary).toBe('On-disk state validation pattern');
    expect(propose.proposals).toHaveLength(2);
    expect(propose.proposals.map((p) => p.content)).toEqual(['full text one', 'full text two']);
  });

  it('includes no-proposal runs (from DREAMS.md) with an empty proposals array', () => {
    const md = `## 2026-08-16T03:00:00.000Z — no-changes (propose)\n\n_No changes proposed._\n\n_tokens: 900, sessions: 3_\n\n---\n`;
    const runs = parseDreamReport(md, '');
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('no-changes');
    expect(runs[0].proposals).toEqual([]);
    expect(runs[0].sessions).toBe(3);
  });

  it('skips malformed promotions lines without dropping the run', () => {
    const runs = parseDreamReport(DREAMS_MD, 'not json\n' + PROMOTIONS);
    expect(runs).toHaveLength(2);
    expect(runs[1].proposals).toHaveLength(2); // the good lines still joined
  });

  it('returns [] for empty inputs', () => {
    expect(parseDreamReport('', '')).toEqual([]);
  });

  it('assigns a per-run proposal index starting at 0', () => {
    const runs = parseDreamReport(DREAMS_MD, PROMOTIONS);
    const propose = runs[1];
    expect(propose.proposals.map((p) => p.index)).toEqual([0, 1]);
    // Every proposal defaults to not-accepted without an accepted.jsonl.
    expect(propose.proposals.every((p) => p.accepted === false)).toBe(true);
  });

  it('marks a proposal accepted when accepted.jsonl carries its ts:index', () => {
    const accepted =
      JSON.stringify({ ts: TS_OLD, index: 1, file: 'MEMORY.md', op: 'add', acceptedAt: TS_OLD }) + '\n';
    const runs = parseDreamReport(DREAMS_MD, PROMOTIONS, accepted);
    const propose = runs.find((r) => r.ts === TS_OLD)!;
    expect(propose.proposals[0].accepted).toBe(false); // index 0 not accepted
    expect(propose.proposals[1].accepted).toBe(true); // index 1 accepted
  });

  it('ignores malformed accepted.jsonl lines (no proposal marked)', () => {
    const runs = parseDreamReport(DREAMS_MD, PROMOTIONS, 'not json\n{"ts":"nope"}\n');
    expect(runs.every((r) => r.proposals.every((p) => p.accepted === false))).toBe(true);
  });
});
