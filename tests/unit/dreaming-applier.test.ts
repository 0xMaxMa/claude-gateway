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
});
