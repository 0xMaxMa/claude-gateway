import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { applyDreamProposals } from '../../src/agent/dreaming/applier';
import type { DreamProposal } from '../../src/agent/dreaming/types';

function mkWs(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-apply-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const prop = (p: Partial<DreamProposal>): DreamProposal => ({
  op: 'add',
  file: 'MEMORY.md',
  reason: 'test',
  score: 0.9,
  recallCount: 3,
  ...p,
});

const OPTS = { memoryBudgetChars: 8_000, userBudgetChars: 3_000 };
const NOW = 1_700_000_000_000;

describe('applyDreamProposals', () => {
  test('add appends content; a backup pre-image is written before mutation', () => {
    const ws = mkWs({ 'MEMORY.md': '# Memory\n\n- existing fact\n' });
    try {
      const res = applyDreamProposals(ws, [prop({ op: 'add', content: '- a brand new fact' })], OPTS, NOW);
      const mem = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
      expect(res.totalApplied).toBe(1);
      expect(mem).toContain('existing fact');
      expect(mem).toContain('a brand new fact');
      // Backup captured the ORIGINAL (no new fact).
      const bak = fs.readFileSync(path.join(ws, '.dreaming', 'backups', `MEMORY.md.${NOW}.bak`), 'utf8');
      expect(bak).toContain('existing fact');
      expect(bak).not.toContain('a brand new fact');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('replace swaps the anchor; remove deletes it', () => {
    const ws = mkWs({ 'MEMORY.md': 'alpha OLD beta\ngamma\n' });
    try {
      applyDreamProposals(ws, [prop({ op: 'replace', target: 'OLD', content: 'NEW' })], OPTS, NOW);
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).toContain('alpha NEW beta');

      applyDreamProposals(ws, [prop({ op: 'remove', target: 'gamma' })], OPTS, NOW + 1);
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).not.toContain('gamma');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('an op whose anchor is missing is skipped, not misapplied', () => {
    const ws = mkWs({ 'MEMORY.md': 'stable content here\n' });
    try {
      const res = applyDreamProposals(ws, [prop({ op: 'replace', target: 'NONEXISTENT', content: 'x' })], OPTS, NOW);
      expect(res.files.find((f) => f.file === 'MEMORY.md')!.applied).toBe(0);
      expect(res.files.find((f) => f.file === 'MEMORY.md')!.skipped).toBe(1);
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).toBe('stable content here\n'); // untouched
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('ordered apply: a later op resolves against the earlier op result', () => {
    const ws = mkWs({ 'MEMORY.md': 'keep AAA keep\n' });
    try {
      // op1 turns AAA→BBB, op2 then targets BBB (only present after op1).
      const res = applyDreamProposals(
        ws,
        [prop({ op: 'replace', target: 'AAA', content: 'BBB' }), prop({ op: 'replace', target: 'BBB', content: 'CCC' })],
        OPTS,
        NOW,
      );
      expect(res.totalApplied).toBe(2);
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).toContain('keep CCC keep');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('net-negative: when over budget, an add that would grow the file is skipped', () => {
    const big = '# Memory\n\n' + '- old fact line\n'.repeat(700); // > 8000 chars
    const ws = mkWs({ 'MEMORY.md': big });
    try {
      const res = applyDreamProposals(ws, [prop({ op: 'add', content: '- another fact' })], OPTS, NOW);
      const f = res.files.find((x) => x.file === 'MEMORY.md')!;
      expect(f.applied).toBe(0);
      expect(f.skipped).toBe(1);
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).not.toContain('another fact');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('net-negative: over budget still allows a remove (the shrink lever)', () => {
    const big = '# Memory\n\nDELETEME marker\n' + '- old fact line\n'.repeat(700);
    const ws = mkWs({ 'MEMORY.md': big });
    try {
      const res = applyDreamProposals(ws, [prop({ op: 'remove', target: 'DELETEME marker\n' })], OPTS, NOW);
      expect(res.totalApplied).toBe(1);
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).not.toContain('DELETEME');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('bounded-loss: deleting more than the max fraction falls back to append-only', () => {
    // 100-char file; a remove that deletes ~80% exceeds the 0.25 cap.
    const body = 'HEAD ' + 'x'.repeat(80) + ' TAIL';
    const ws = mkWs({ 'MEMORY.md': body });
    try {
      const res = applyDreamProposals(
        ws,
        [
          prop({ op: 'remove', target: 'x'.repeat(80) }), // destructive
          prop({ op: 'add', content: 'SAFE ADDITION' }), // additive
        ],
        { memoryBudgetChars: 0, userBudgetChars: 0 }, // budget off so the add isn't net-negative-blocked
        NOW,
      );
      const f = res.files.find((x) => x.file === 'MEMORY.md')!;
      expect(f.mode).toBe('append-fallback');
      const mem = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
      expect(mem).toContain('x'.repeat(80)); // destructive remove was NOT applied
      expect(mem).toContain('SAFE ADDITION'); // additive op was
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('validation: never turns a previously-non-empty file empty', () => {
    const ws = mkWs({ 'MEMORY.md': 'ONLY CONTENT' });
    try {
      const res = applyDreamProposals(
        ws,
        [prop({ op: 'remove', target: 'ONLY CONTENT' })],
        { memoryBudgetChars: 0, userBudgetChars: 0 },
        NOW,
      );
      // The remove would empty the file → rejected; file kept.
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).toBe('ONLY CONTENT');
      expect(res.files.find((f) => f.file === 'MEMORY.md')!.mode).not.toBe('rewrite');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('USER.md routes to the user budget; leaves no temp files behind', () => {
    const ws = mkWs({ 'USER.md': '# User\n\n- prefers dark mode\n', 'MEMORY.md': '# Memory\n' });
    try {
      const res = applyDreamProposals(ws, [prop({ file: 'USER.md', op: 'add', content: '- timezone UTC+7' })], OPTS, NOW);
      expect(res.totalApplied).toBe(1);
      expect(fs.readFileSync(path.join(ws, 'USER.md'), 'utf8')).toContain('timezone UTC+7');
      expect(fs.readdirSync(ws).some((f) => f.startsWith('.tmp-dream-'))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  // ── Review-fix regressions (PR #330) ──────────────────────────────────────

  test('H1: `$` sequences in replace content are inserted literally, not as patterns', () => {
    const ws = mkWs({ 'MEMORY.md': 'price is PLACEHOLDER today\n' });
    try {
      const res = applyDreamProposals(
        ws,
        [prop({ op: 'replace', target: 'PLACEHOLDER', content: '$5 for $$ and $& and $` end' })],
        OPTS,
        NOW,
      );
      expect(res.totalApplied).toBe(1);
      // With String.replace, `$&`/`` $` ``/`$$` would expand against the match; the
      // index-splice keeps them literal.
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).toContain(
        'price is $5 for $$ and $& and $` end today',
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('H2: a remove+add consolidation that nets ~0 length is rejected (gross loss, not net)', () => {
    // 500 'A' original + tail; remove all A's (gross 98% delete) then add 500 'B'.
    const original = 'A'.repeat(500) + 'KEEPTAIL';
    const ws = mkWs({ 'MEMORY.md': original });
    try {
      const res = applyDreamProposals(
        ws,
        [prop({ op: 'remove', target: 'A'.repeat(500) }), prop({ op: 'add', content: 'B'.repeat(500) })],
        { memoryBudgetChars: 0, userBudgetChars: 0 }, // budget off so the add isn't net-negative-blocked
        NOW,
      );
      const f = res.files.find((x) => x.file === 'MEMORY.md')!;
      // Under the OLD net-length guard this passed as a full rewrite (net loss ≈ 0);
      // the gross guard rejects it → append-only fallback preserves the original.
      expect(f.mode).toBe('append-fallback');
      const mem = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
      expect(mem).toContain('A'.repeat(500)); // original block preserved
      expect(mem).toContain('B'.repeat(500)); // the safe add still appended
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('ambiguous anchor: a target occurring more than once is skipped, not applied to the first', () => {
    // Large filler so removing one 14-char anchor is a tiny fraction — the ONLY thing
    // that should prevent the mutation is the ambiguity guard, not bounded-loss.
    const filler = 'padding content line\n'.repeat(200);
    const ws = mkWs({ 'MEMORY.md': `## Important\nStatus: active\n${filler}## Stale\nStatus: active\n` });
    try {
      const res = applyDreamProposals(ws, [prop({ op: 'remove', target: 'Status: active' })], OPTS, NOW);
      const f = res.files.find((x) => x.file === 'MEMORY.md')!;
      expect(f.applied).toBe(0);
      expect(f.skipped).toBe(1);
      const mem = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
      expect(mem.match(/Status: active/g)!.length).toBe(2); // both occurrences untouched
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('shrink cliff: over budget, a single large legitimate removal (>25%) IS applied', () => {
    const stale = 'STALE '.repeat(800); // 4800 chars
    const original = stale + 'KEEP '.repeat(1200); // ~10800 > 8000 budget
    const ws = mkWs({ 'MEMORY.md': original });
    try {
      const res = applyDreamProposals(ws, [prop({ op: 'remove', target: stale })], OPTS, NOW);
      const f = res.files.find((x) => x.file === 'MEMORY.md')!;
      expect(f.mode).toBe('rewrite');
      expect(f.applied).toBe(1);
      const mem = fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8');
      expect(mem).not.toContain('STALE');
      expect(mem).toContain('KEEP');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('over budget: a replace whose new content is longer than its target is skipped', () => {
    const ws = mkWs({ 'MEMORY.md': 'TAG ' + 'x'.repeat(9000) }); // over 8000 budget
    try {
      const res = applyDreamProposals(
        ws,
        [prop({ op: 'replace', target: 'TAG', content: 'TAG' + 'y'.repeat(500) })],
        OPTS,
        NOW,
      );
      const f = res.files.find((x) => x.file === 'MEMORY.md')!;
      expect(f.applied).toBe(0);
      expect(f.skipped).toBe(1);
      expect(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8')).not.toContain('yyyyy');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('rollback backups are pruned to the retention cap (no unbounded disk creep)', () => {
    const ws = mkWs({ 'MEMORY.md': 'seed\n' });
    try {
      for (let i = 0; i < 25; i++) {
        applyDreamProposals(ws, [prop({ op: 'add', content: `- fact ${i}` })], OPTS, NOW + i);
      }
      const baks = fs
        .readdirSync(path.join(ws, '.dreaming', 'backups'))
        .filter((n) => n.startsWith('MEMORY.md.') && n.endsWith('.bak'));
      expect(baks.length).toBe(20);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('appliedProposals lists only the ops actually written (skipped ops excluded)', () => {
    const ws = mkWs({ 'MEMORY.md': 'hello world\n' });
    try {
      const res = applyDreamProposals(
        ws,
        [
          prop({ op: 'add', content: '- kept add' }),
          prop({ op: 'replace', target: 'NOPE', content: 'x' }), // anchor gone → skipped
        ],
        OPTS,
        NOW,
      );
      expect(res.appliedProposals.length).toBe(1);
      expect(res.appliedProposals[0].op).toBe('add');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('no-op run writes NO backup (backup is lazy — only on real mutation)', () => {
    const ws = mkWs({ 'MEMORY.md': 'stable\n' });
    try {
      applyDreamProposals(ws, [prop({ op: 'replace', target: 'GONE', content: 'x' })], OPTS, NOW);
      const backupsPath = path.join(ws, '.dreaming', 'backups');
      const baks = fs.existsSync(backupsPath) ? fs.readdirSync(backupsPath) : [];
      expect(baks.length).toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
